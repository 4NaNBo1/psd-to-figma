import type { IRNode, IRFill, IRShadow, IRStroke, IRCornerRadii, IRTextProps, IRTextRange, IRGradientFill, IRSolidFill } from '../ir/types';
import type { PlatformRenderer, LogFn, ProgressFn, RenderOptions } from './types';
import { writeNineSlicePluginDataForImport } from '../exporter/nine-slice-collapse';
import { countIRNodes } from '../ir/builder';

const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' };

// radius=0 的纯 spread 阴影在部分平台渲染不出，给一个极小可见 radius 兜底（与 MasterGo 端对称，见 applyEffects）。
const MIN_VISIBLE_SHADOW_RADIUS = 0.01;

const STYLE_VARIANT_GROUPS: string[][] = [
  ['Thin', '100', 'Hairline'],
  ['ExtraLight', 'Extra Light', 'UltraLight', 'Ultra Light', '200'],
  ['Light', '300'],
  ['Regular', 'Normal', 'Book', '400'],
  ['Medium', '500'],
  ['SemiBold', 'Semibold', 'Semi Bold', 'DemiBold', 'Demi Bold', 'Demi', '600'],
  ['Bold', '700'],
  ['ExtraBold', 'Extra Bold', 'UltraBold', 'Ultra Bold', '800'],
  ['Black', 'Heavy', '900'],
];

// 给定一个 style 名，返回同字重的所有常见拼写候选（含自身）。用于字体加载失败时跨厂商
// 命名兜底，避免直接退到 Regular 丢失字重。无法归类的 style 原样返回。
function styleVariants(style: string): string[] {
  const trimmed = (style || '').trim();
  const norm = trimmed.replace(/[\s-]+/g, '').toLowerCase();
  const isItalic = /italic|oblique/.test(norm);
  const weightKey = norm.replace(/italic|oblique/g, '') || 'regular';
  let group: string[] | null = null;
  for (const g of STYLE_VARIANT_GROUPS) {
    if (g.some(name => name.replace(/[\s-]+/g, '').toLowerCase() === weightKey)) { group = g; break; }
  }
  if (!group) return [trimmed];
  if (isItalic) {
    const out: string[] = [];
    for (const w of group) out.push(`${w} Italic`, `${w}Italic`);
    if (weightKey === 'regular' || weightKey === 'normal' || weightKey === 'book') out.push('Italic');
    return out;
  }
  return [...group];
}

async function tryLoadFont(family: string, style: string): Promise<FontName | null> {
  try {
    const fontName: FontName = { family, style };
    await figma.loadFontAsync(fontName);
    return fontName;
  } catch {
    return null;
  }
}

async function loadBestFont(rawFamily: string, rawStyle: string, onLog: LogFn, layerName: string): Promise<FontName> {
  const direct = await tryLoadFont(rawFamily, rawStyle);
  if (direct) return direct;

  // 不同字体厂商对同一字重的 style 命名不一致（如 Semibold/SemiBold/Semi Bold/DemiBold/600）。
  // builder 已把 PSD 字重归一（如 SemiBold→Semibold），但平台字体库可能用别的拼写，
  // 直接匹配失败若直接退到 Regular 会导致「文字变细」。先尝试同字重的其它常见拼写，保住字重。
  for (const variant of styleVariants(rawStyle)) {
    if (variant === rawStyle) continue;
    const alt = await tryLoadFont(rawFamily, variant);
    if (alt) {
      onLog('warn', `Font "${rawFamily} ${rawStyle}" not found for "${layerName}", using equivalent style "${variant}"`);
      return alt;
    }
  }

  if (rawStyle !== 'Regular') {
    const regular = await tryLoadFont(rawFamily, 'Regular');
    if (regular) {
      onLog('warn', `Font "${rawFamily} ${rawStyle}" not found for "${layerName}", using "${rawFamily} Regular"`);
      return regular;
    }
  }

  onLog('warn', `Font "${rawFamily}" not available for "${layerName}", using fallback "${FALLBACK_FONT.family} ${FALLBACK_FONT.style}"`);
  try {
    await figma.loadFontAsync(FALLBACK_FONT);
    return FALLBACK_FONT;
  } catch {
    return FALLBACK_FONT;
  }
}

function applyCornerRadii(node: RectangleNode | FrameNode, radii: IRCornerRadii | undefined): void {
  if (!radii) return;
  const { topLeft, topRight, bottomLeft, bottomRight } = radii;
  if (topLeft === topRight && topRight === bottomLeft && bottomLeft === bottomRight) {
    node.cornerRadius = topLeft;
  } else {
    node.topLeftRadius = topLeft;
    node.topRightRadius = topRight;
    node.bottomLeftRadius = bottomLeft;
    node.bottomRightRadius = bottomRight;
  }
}

function applyEffects(node: SceneNode, effects: IRShadow[]): void {
  // effects 为空时显式清空：与 MasterGo 端对称（MasterGo 新建节点自带默认投影，
  // 不清空会在 round-trip 导出时残留为伪投影）。Figma 默认 effects 为空，此处无害且防御其它来源。
  if (effects.length === 0) {
    try { (node as SceneNode & { effects: readonly Effect[] }).effects = []; } catch { /* 只读则忽略 */ }
    return;
  }
  const figmaEffects: Effect[] = effects.map((e) => ({
    type: e.type,
    color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a },
    offset: { x: e.offset.x, y: e.offset.y },
    // radius=0（PSD choke=100 的纯实色外扩阴影，如紧贴文字的描边状投影）在部分平台
    // 渲染不出，给一个极小 radius 兜底让其可见——视觉上 0 与 0.01 不可分。与 MasterGo 端对称。
    radius: e.radius === 0 && e.spread > 0 ? MIN_VISIBLE_SHADOW_RADIUS : e.radius,
    spread: e.spread,
    visible: e.visible,
    blendMode: e.blendMode as BlendMode,
  } as DropShadowEffect | InnerShadowEffect));
  (node as SceneNode & { effects: readonly Effect[] }).effects = figmaEffects;
}

function applyInheritedFxMarkers(node: SceneNode, irNode: IRNode): void {
  // 标记「从父组下放来的」effect/stroke，导出端据此剔除冗余副本（见 psd-parser 下放逻辑）。
  if (irNode.inheritedGroupEffects) {
    try { node.setPluginData('psd_inherited_group_fx', '1'); } catch { /* ignore */ }
  }
  if (irNode.inheritedGroupStrokes) {
    try { node.setPluginData('psd_inherited_group_stroke', '1'); } catch { /* ignore */ }
  }
}

function applySingleStroke(node: SceneNode, stroke: IRStroke): void {
  if (!('strokes' in node)) return;
  const figmaStrokes: Paint[] = stroke.fills.map((s) => ({
    type: 'SOLID' as const,
    color: { r: s.color.r, g: s.color.g, b: s.color.b },
    opacity: s.opacity ?? s.color.a,
  }));
  const gm = node as GeometryMixin;
  gm.strokes = figmaStrokes;
  gm.strokeWeight = stroke.weight;
  gm.strokeAlign = stroke.align as 'INSIDE' | 'OUTSIDE' | 'CENTER';
  try { (gm as { strokeJoin: StrokeJoin }).strokeJoin = 'ROUND'; } catch (_e) { /* ignore */ }
}

function applyStrokes(node: SceneNode, strokes: IRStroke[], onLog?: LogFn, nodeName?: string): void {
  if (strokes.length === 0) return;
  // 形状/frame 节点受 figma 单节点限制只能渲染一个 stroke
  if (onLog && strokes.length > 1) {
    onLog('warn', `Node "${nodeName ?? '?'}" has ${strokes.length} strokes; only strokes[0] applied (platform limitation)`);
  }
  applySingleStroke(node, strokes[0]);
}

function applySolidFills(node: MinimalFillsMixin, fills: IRSolidFill[]): void {
  node.fills = fills.map((f) => ({
    type: 'SOLID' as const,
    color: { r: f.color.r, g: f.color.g, b: f.color.b },
    opacity: f.opacity ?? f.color.a,
  }));
}

/** 把单个 IRFill 转成 Figma Paint。IMAGE 需异步 createImage，返回 null 表示失败由调用方处理。 */
function irFillToPaint(fill: IRFill, onLog: LogFn, name: string): Paint | null {
  if (fill.type === 'IMAGE') {
    try {
      const image = figma.createImage(fill.imageBytes);
      return { type: 'IMAGE', imageHash: image.hash, scaleMode: fill.scaleMode };
    } catch (e) {
      onLog('warn', `Failed to apply image on "${name}": ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }
  if (fill.type === 'SOLID') {
    return {
      type: 'SOLID',
      color: { r: fill.color.r, g: fill.color.g, b: fill.color.b },
      opacity: fill.opacity ?? fill.color.a,
    };
  }
  // GRADIENT_LINEAR
  return {
    type: 'GRADIENT_LINEAR',
    gradientStops: fill.stops.map((s) => ({
      position: s.position,
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    })),
    gradientTransform: fill.transform,
  };
}

async function applyFills(node: RectangleNode | FrameNode, fills: IRFill[], onLog: LogFn, name: string): Promise<void> {
  if (fills.length === 0) {
    node.fills = [];
    return;
  }
  // 支持 IMAGE fill 之上叠加 color/gradient overlay fill（整层原生化的 overlay）。
  // Figma fills 数组靠后的在视觉上层，与 IR 中 [IMAGE, ...overlays] 顺序一致。
  const paints: Paint[] = [];
  for (const fill of fills) {
    const paint = irFillToPaint(fill, onLog, name);
    if (paint) paints.push(paint);
  }
  node.fills = paints;
}

// 创建并样式化一个文本节点；strokeOverride 决定本节点承载的 stroke（undefined = 不画 stroke）
async function createStyledTextNode(
  irNode: IRNode,
  parent: FrameNode | PageNode | SectionNode,
  onLog: LogFn,
  strokeOverride: IRStroke | undefined,
  nameSuffix: string
): Promise<TextNode> {
  const text = figma.createText();
  text.name = irNode.name + nameSuffix;
  text.visible = irNode.visible;
  if (irNode.opacity !== 1) text.opacity = irNode.opacity;
  text.blendMode = irNode.blendMode as BlendMode;
  parent.appendChild(text);
  text.x = irNode.x;
  text.y = irNode.y;

  const tp = irNode.textProps;
  if (!tp) return text;

  const firstRange = tp.ranges.length > 0 ? tp.ranges[0] : null;
  let defaultFont: FontName;
  if (firstRange) {
    defaultFont = await loadBestFont(firstRange.fontFamily, firstRange.fontStyle, onLog, irNode.name);
  } else {
    await figma.loadFontAsync(FALLBACK_FONT);
    defaultFont = FALLBACK_FONT;
  }

  text.fontName = defaultFont;

  const isBoxText = tp.shapeType === 'box' && (tp.width > 0 || tp.height > 0);
  if (isBoxText) {
    text.textAutoResize = 'HEIGHT';
    text.resize(tp.width, tp.height);
  } else {
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  text.characters = tp.characters;
  text.textAlignHorizontal = tp.alignment;

  if (isBoxText) {
    text.textAutoResize = 'NONE';
    text.resize(tp.width, tp.height);
  }

  for (const range of tp.ranges) {
    const start = range.start;
    const end = Math.min(range.end, tp.characters.length);
    if (start >= end) continue;

    try {
      const fontName = await loadBestFont(range.fontFamily, range.fontStyle, onLog, irNode.name);
      text.setRangeFontName(start, end, fontName);

      if (range.fontSize > 0) {
        text.setRangeFontSize(start, end, range.fontSize);
        if (range.lineHeight != null && range.lineHeight > 0) {
          text.setRangeLineHeight(start, end, { value: range.lineHeight, unit: 'PIXELS' });
        } else {
          text.setRangeLineHeight(start, end, { value: range.fontSize, unit: 'PIXELS' });
        }
      }

      // rasterized 文本：合成图由兄弟 rectangle 承载显示，本占位 TextNode 须不可见，
      // 否则可见字符会盖住合成图（白字遮橙边）。设字符 fill 为透明 alpha=0，
      // 字体/字号/letterSpacing 仍正常设置以保留导出所需度量。
      if (tp.rasterized) {
        text.setRangeFills(start, end, [{
          type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0,
        }]);
      } else if (range.fills.length > 0) {
        const f = range.fills[0];
        if (f.type === 'SOLID') {
          text.setRangeFills(start, end, [{
            type: 'SOLID',
            color: { r: f.color.r, g: f.color.g, b: f.color.b },
            opacity: f.opacity ?? f.color.a,
          }]);
        }
      }

      // 无论 letterSpacing 是否为 0 都显式设置：避免节点保留字体级 default letterSpacing,
      // 与 mastergo 端保持一致（platform parity）。
      text.setRangeLetterSpacing(start, end, { value: range.letterSpacing, unit: 'PIXELS' });

      // PSD fontCaps（全大写/小型大写）：PSD 把原始字符存为混合大小写，靠 fontCaps 显示为大写。
      // figma TextCase 支持 SMALL_CAPS，故保留原始语义（与 mastergo 行为差异：mastergo 无 SMALL_CAPS 降级为 UPPER）。
      if (range.textCase && range.textCase !== 'ORIGINAL') {
        text.setRangeTextCase(start, end, range.textCase);
      }
    } catch (e) {
      onLog('warn', `Failed to apply text style range [${start}:${end}] for "${irNode.name}": ${e instanceof Error ? e.message : e}`);
    }
  }

  // 文本像素准确显示（tp.rasterized）：节点仍是 TextNode（保 characters 供导出
  // 识别为文本层），但画布显示改用合成图 IMAGE fill（已含字形+spread 阴影/描边/warp 等平台渲染不出
  // 的效果）。跳过 gradientOverlay / applyEffects / stroke / alignTextPosition（合成图已包含），
  // resize 到 IR 尺寸（含 expand）使合成图铺满。round-trip 元数据照常写入（见下方 setPluginData）。
  if (tp.rasterized) {
    // 占位 TextNode：字符已透明（见上方 range fills），自身不显示像素（fills 置空）。
    // 合成图改由同 parent 的兄弟 rectangle 承载显示（见下方），避免可见字符/字框度量干扰合成图。
    // 文本节点仍保 characters + 全部 pluginData 供导出识别为文本层。
    text.fills = [];
    // 位置/尺寸对齐合成图（去掉字框自适应度量的漂移），与 companion rectangle 完全重合，
    // 并锁定避免用户误选/误移（不可见 + 锁定，仅作导出文本层的载体）。
    text.textAutoResize = 'NONE';
    text.x = irNode.x;
    text.y = irNode.y;
    text.resize(Math.max(1, irNode.width), Math.max(1, irNode.height));
    try { text.locked = true; } catch { /* ignore */ }
    applyInheritedFxMarkers(text, irNode);
    if (tp.rotation) {
      text.rotation = tp.rotation;
    }
    try { text.setPluginData('psd_text_rasterized', '1'); } catch { /* ignore */ }
    // 栅格化为对齐 companion 把 textAutoResize 强制设为 NONE，会污染导出端 isPointText 判定
    // （psd-builder 据 textAutoResize 选 point/box 分支）。单独存原始 shapeType，导出端据此还原：
    // point 文本走 point 分支保留原始 sx/sy 缩放 + 旋转 transform（如 Piggy Pop sy≈2.167），
    // 否则走 box 分支会丢缩放/旋转，文本字号位置错。
    if (tp.shapeType) {
      try { text.setPluginData('psd_shape_type', tp.shapeType); } catch { /* ignore */ }
    }

    // 兄弟 rectangle 承载合成图显示（含字形+spread 阴影/描边）。几何 = IR 文本几何（含 expand），
    // 标记 psd_raster_companion 让导出端跳过（不进 PSD，由透明文本节点导出文本层）。
    if (irNode.visible && irNode.fills.length > 0) {
      const paints: Paint[] = [];
      for (const fill of irNode.fills) {
        const paint = irFillToPaint(fill, onLog, irNode.name);
        if (paint) paints.push(paint);
      }
      if (paints.length > 0) {
        const companion = figma.createRectangle();
        companion.name = irNode.name + ' (raster)';
        parent.appendChild(companion);
        companion.x = irNode.x;
        companion.y = irNode.y;
        companion.resize(Math.max(1, irNode.width), Math.max(1, irNode.height));
        companion.fills = paints;
        companion.visible = irNode.visible;
        if (irNode.opacity !== 1) companion.opacity = irNode.opacity;
        companion.blendMode = irNode.blendMode as BlendMode;
        if (tp.rotation) companion.rotation = tp.rotation;
        try { companion.setPluginData('psd_raster_companion', '1'); } catch { /* ignore */ }
      }
    }
  } else {
    if (tp.gradientOverlay) {
      const go = tp.gradientOverlay;
      text.fills = [{
        type: 'GRADIENT_LINEAR',
        gradientStops: go.stops.map((s) => ({
          position: s.position,
          color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
        })),
        gradientTransform: go.transform,
      }];
    }

    applyEffects(text, irNode.effects);
    applyInheritedFxMarkers(text, irNode);
    if (strokeOverride) {
      applySingleStroke(text, strokeOverride);
    }

    alignTextPosition(text, irNode, onLog);
    if (tp.rotation) {
      text.rotation = tp.rotation;
    }
  }

  // 与 mastergo 端保持对等：把 PSD 转 figma 时丢失的关键元数据存到 plugin data
  // 让 figma → PSD 导出时能精确还原位置/字号/transform 等。
  if (tp.txOffsetX != null && Number.isFinite(tp.txOffsetX)) {
    try { text.setPluginData('psd_tx_offset_x', String(tp.txOffsetX)); } catch { /* ignore */ }
  }
  if (tp.bounds) {
    try { text.setPluginData('psd_bounds', JSON.stringify(tp.bounds)); } catch { /* ignore */ }
  }
  if (tp.boundingBox) {
    try { text.setPluginData('psd_bounding_box', JSON.stringify(tp.boundingBox)); } catch { /* ignore */ }
  }
  // round-trip 兜底：保存原始 PSD 文本栅格像素 + 原始文本内容。导出端在文本未被编辑时优先写回这份
  // 原始像素，规避平台与 PS 同名字体字形度量差异导致的导出裁剪（详见 IRTextProps.rawImage）。
  if (tp.rawImage && tp.rawImage.base64) {
    try { text.setPluginData('psd_raw_text_image', JSON.stringify(tp.rawImage)); } catch { /* ignore */ }
    if (tp.originalText != null) {
      try { text.setPluginData('psd_text_original', tp.originalText); } catch { /* ignore */ }
    }
  }
  if (tp.textIndex != null && Number.isFinite(tp.textIndex)) {
    try { text.setPluginData('psd_text_index', String(tp.textIndex)); } catch { /* ignore */ }
  }
  if (tp.transformScale != null && Number.isFinite(tp.transformScale) && tp.transformScale !== 1) {
    try { text.setPluginData('psd_transform_scale', String(tp.transformScale)); } catch { /* ignore */ }
  }
  if (tp.transformScaleX != null && Number.isFinite(tp.transformScaleX) && tp.transformScaleX !== 1) {
    try { text.setPluginData('psd_transform_scale_x', String(tp.transformScaleX)); } catch { /* ignore */ }
  }
  // PSD 文本弯曲（warp）：Figma 不支持可编辑文本的弧形弯曲，画布上无法还原其外观。
  // 保存原始 warp 数据用于导出 PSD 时写回 layer.text.warp（往返保真），并提示用户。
  if (tp.warp && tp.warp.style && tp.warp.style !== 'none') {
    try { text.setPluginData('psd_warp', JSON.stringify(tp.warp)); } catch { /* ignore */ }
    onLog('warn', `Text "${irNode.name}" has PSD warp (${tp.warp.style}); Figma cannot render curved text — appearance is flattened, but warp is preserved for PSD export`);
  }
  // 文本层保存原始 PSD effects 元数据（含 disabled 配置）
  if (irNode.rawPsdEffects) {
    try { text.setPluginData('psd_raw_effects', irNode.rawPsdEffects); } catch { /* ignore */ }
  }
  // 保存 anchor + 原始 PSD transform.tx/ty 用于 export 时精确还原（避开亚像素精度损失）
  try { text.setPluginData('psd_anchor_node_y', String(text.y)); } catch { /* ignore */ }
  try { text.setPluginData('psd_anchor_node_x', String(text.x)); } catch { /* ignore */ }
  if (tp.transformTy != null && Number.isFinite(tp.transformTy)) {
    try { text.setPluginData('psd_transform_ty', String(tp.transformTy)); } catch { /* ignore */ }
  }
  if (tp.transformTx != null && Number.isFinite(tp.transformTx)) {
    try { text.setPluginData('psd_transform_tx', String(tp.transformTx)); } catch { /* ignore */ }
  }

  return text;
}

async function renderTextNode(
  irNode: IRNode,
  parent: FrameNode | PageNode | SectionNode,
  onLog: LogFn
): Promise<TextNode> {
  const strokes = irNode.strokes;

  if (strokes.length <= 1) {
    return createStyledTextNode(irNode, parent, onLog, strokes[0], '');
  }

  // 多 stroke：PSD 中 stroke[0] 在最上层。figma 单节点只能有一个
  // strokeWeight/strokeAlign，所以拆成多个相同字符的文本副本叠加，每个
  // 承载一个 stroke。
  //
  // 对齐策略：先创建顶层 (stroke[0]) 拿到对齐后的 text.x/text.y，再创建
  // 底层副本时把同样的 x/y 强制套用到副本上，保证字符 baseline 完全重合
  // （即使 figma 在不同 strokeWeight 下计算的 text.width/height 略有差异）。
  //
  // 另外给所有副本写入 psd_multi_stroke_group_id / index / total，
  // 让 figma → PSD 导出时能识别同组节点并合并成单文本节点 + 多 stroke，
  // 保持 PSD 文件结构与原始一致。
  const groupId = `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const totalStrokes = strokes.length;
  const top = await createStyledTextNode(irNode, parent, onLog, strokes[0], '');
  const sharedX = top.x;
  const sharedY = top.y;
  try {
    top.setPluginData('psd_multi_stroke_group_id', groupId);
    top.setPluginData('psd_multi_stroke_index', '0');
    top.setPluginData('psd_multi_stroke_total', String(totalStrokes));
  } catch { /* ignore */ }

  for (let i = 1; i < strokes.length; i++) {
    const suffix = ` (stroke ${i + 1})`;
    const clone = await createStyledTextNode(irNode, parent, onLog, strokes[i], suffix);
    clone.x = sharedX;
    clone.y = sharedY;
    try {
      clone.setPluginData('psd_multi_stroke_group_id', groupId);
      clone.setPluginData('psd_multi_stroke_index', String(i));
      clone.setPluginData('psd_multi_stroke_total', String(totalStrokes));
    } catch { /* ignore */ }
    // 将副本移到顶层节点之前（更下层），保证 stroke[0] 在最上、stroke[N-1] 在最下
    try {
      const topIdx = parent.children.indexOf(top);
      if (topIdx >= 0) {
        parent.insertChild(topIdx, clone);
      }
    } catch (e) {
      onLog('warn', `Failed to reorder multi-stroke text "${clone.name}": ${e instanceof Error ? e.message : e}`);
    }
  }

  return top;
}

function alignTextPosition(text: TextNode, irNode: IRNode, onLog: LogFn): void {
  const tp = irNode.textProps!;

  // 旋转文本：目标是让节点视觉中心落在 PSD 旋转后 boundingBox 中心 (docRotatedCenterX/Y)。
  // 平台差异——Figma 的 rotation 绕「节点左上角」旋转（与 MasterGo 绕中心不同），故不能直接
  // 把中心设为 x/y。设左上角 P，旋转后视觉中心 = P + R(θ)·(w/2, h/2)，令其 = 目标中心反推 P。
  // θ 用 Figma 屏幕系角度（=后续 text.rotation 设的 tp.rotation，正=逆时针，屏幕 Y 向下故矩阵取负 sin）。
  if (tp.rotation && tp.docRotatedCenterX != null && tp.docRotatedCenterY != null) {
    const w = text.width, h = text.height;
    const rad = (tp.rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // Figma 屏幕系（Y 向下）旋转矩阵：[[cos, sin], [-sin, cos]]，正角=逆时针视觉
    const offX = cos * (w / 2) + sin * (h / 2);
    const offY = -sin * (w / 2) + cos * (h / 2);
    text.x = tp.docRotatedCenterX - offX;
    text.y = tp.docRotatedCenterY - offY;
    try { text.setPluginData('psd_line_padding_y', '0'); } catch { /* ignore */ }
    return;
  }

  const hasPrecise = tp.docBoundsY != null || tp.docBboxCenterX != null;

  if (hasPrecise) {
    if (tp.docBboxCenterX != null) {
      text.x = tp.docBboxCenterX - text.width / 2;
    } else {
      text.x = irNode.x + irNode.width / 2 - text.width / 2;
    }
    if (tp.docBoundsY != null) {
      text.y = tp.docBoundsY;
    } else {
      text.y = irNode.y + irNode.height / 2 - text.height / 2;
    }
  } else {
    const psCenterX = irNode.x + irNode.width / 2;
    const psCenterY = irNode.y + irNode.height / 2;
    text.x = psCenterX - text.width / 2;
    text.y = psCenterY - text.height / 2;
    onLog('info', `Text "${irNode.name}" align (fallback): original(${irNode.x.toFixed(2)}, ${irNode.y.toFixed(2)}) -> final(${text.x.toFixed(2)}, ${text.y.toFixed(2)})`);
  }

  // 与 mastergo 端保持对称：figma 端没有 absoluteRenderBounds 后处理，linePadding=0
  try { text.setPluginData('psd_line_padding_y', '0'); } catch { /* ignore */ }
}

async function renderNode(
  irNode: IRNode,
  parent: FrameNode | PageNode | SectionNode,
  onLog: LogFn,
  onNodeCreated: () => void
): Promise<SceneNode | null> {
  try {
    let node: SceneNode;

    switch (irNode.type) {
      case 'section': {
        const section = figma.createSection();
        section.name = irNode.name;
        section.fills = [];
        parent.appendChild(section);
        section.resizeWithoutConstraints(irNode.width, irNode.height);

        if (irNode.psdEngineData) {
          try { section.setPluginData('psd_engine_data', irNode.psdEngineData); } catch { /* ignore */ }
        }
        if (irNode.psdPatterns) {
          try { section.setPluginData('psd_patterns', irNode.psdPatterns); } catch { /* ignore */ }
        }

        if (irNode.children) {
          for (const child of irNode.children) {
            await renderNode(child, section, onLog, onNodeCreated);
          }
        }
        onNodeCreated();
        node = section;
        break;
      }

      case 'frame': {
        const frame = figma.createFrame();
        frame.resize(irNode.width, irNode.height);
        frame.clipsContent = irNode.clipsContent;
        await applyFills(frame, irNode.fills, onLog, irNode.name);
        frame.name = irNode.name;
        frame.visible = irNode.visible;
        if (irNode.opacity !== 1) frame.opacity = irNode.opacity;
        frame.blendMode = irNode.blendMode as BlendMode;
        parent.appendChild(frame);
        frame.x = irNode.x;
        frame.y = irNode.y;

        applyEffects(frame, irNode.effects);
        applyInheritedFxMarkers(frame, irNode);
        applyStrokes(frame, irNode.strokes, onLog, irNode.name);
        applyCornerRadii(frame, irNode.cornerRadii);
        if (irNode.rawPsdEffects) {
          try { frame.setPluginData('psd_raw_effects', irNode.rawPsdEffects); } catch { /* ignore */ }
        }
        if (irNode.psdGroupMask) {
          try { frame.setPluginData('psd_group_mask', irNode.psdGroupMask); } catch { /* ignore */ }
        }
        if (irNode.isRootFrame) {
          try { frame.setPluginData('psd_root_frame', '1'); } catch { /* ignore */ }
        }

        if (irNode.children) {
          for (const child of irNode.children) {
            await renderNode(child, frame, onLog, onNodeCreated);
          }
        }
        onNodeCreated();
        node = frame;
        break;
      }

      case 'text': {
        const text = await renderTextNode(irNode, parent, onLog);
        onNodeCreated();
        node = text;
        break;
      }

      case 'rectangle':
      default: {
        const rect = figma.createRectangle();
        rect.resize(irNode.width, irNode.height);
        rect.name = irNode.name;
        rect.visible = irNode.visible;
        if (irNode.opacity !== 1) rect.opacity = irNode.opacity;
        rect.blendMode = irNode.blendMode as BlendMode;
        parent.appendChild(rect);
        rect.x = irNode.x;
        rect.y = irNode.y;

        await applyFills(rect, irNode.fills, onLog, irNode.name);
        applyEffects(rect, irNode.effects);
        applyInheritedFxMarkers(rect, irNode);
        applyStrokes(rect, irNode.strokes, onLog, irNode.name);
        applyCornerRadii(rect, irNode.cornerRadii);
        if (irNode.rawPsdEffects) {
          try { rect.setPluginData('psd_raw_effects', irNode.rawPsdEffects); } catch { /* ignore */ }
        }
        if (irNode.psdExpandOffset != null && irNode.psdExpandOffset > 0) {
          try { rect.setPluginData('psd_expand_offset', String(irNode.psdExpandOffset)); } catch { /* ignore */ }
        }
        if (irNode.rawPsdVectorData) {
          try { rect.setPluginData('psd_vector_data', irNode.rawPsdVectorData); } catch { /* ignore */ }
        }
        if (irNode.rawPsdAdjustments) {
          try { rect.setPluginData('psd_adjustments', irNode.rawPsdAdjustments); } catch { /* ignore */ }
        }
        if (irNode.rawPsdOriginalImage) {
          try { rect.setPluginData('psd_original_image', irNode.rawPsdOriginalImage); } catch { /* ignore */ }
        }
        if (irNode.rawPsdChannelImage) {
          try { rect.setPluginData('psd_channel_image', irNode.rawPsdChannelImage); } catch { /* ignore */ }
        }
        if (irNode.rawPsdPrePatternImage) {
          try { rect.setPluginData('psd_pre_pattern_image', irNode.rawPsdPrePatternImage); } catch { /* ignore */ }
        }
        if (irNode.rawPsdSmartObject) {
          try { rect.setPluginData('psd_smart_object', irNode.rawPsdSmartObject); } catch { /* ignore */ }
        }
        if (irNode.psdLayerMask) {
          try { rect.setPluginData('psd_layer_mask', irNode.psdLayerMask); } catch { /* ignore */ }
        }
        if (irNode.rawPsdLayerMaskImage) {
          try { rect.setPluginData('psd_layer_mask_image', irNode.rawPsdLayerMaskImage); } catch { /* ignore */ }
        }
        if (irNode.nineSliceSettings) {
          try {
            writeNineSlicePluginDataForImport(rect, irNode.nineSliceSettings);
          } catch { /* ignore */ }
        }
        if (irNode.psdClipping != null) {
          try { rect.setPluginData('psd_clipping', irNode.psdClipping ? '1' : '0'); } catch { /* ignore */ }
        }

        onNodeCreated();
        node = rect;
        break;
      }
    }

    // PSD 剪贴蒙版的基底副本（baseMask）：设为 ALPHA 蒙版，按图片 alpha 形状裁剪
    // clip group 内排在其后的被剪贴兄弟节点（保留圆角等不规则形状）。基底自身的显示
    // 由前面的 baseDisplay 承载（与 MasterGo 端 isMaskVisible=false 语义对齐）。
    if (irNode.isMask && node) {
      try {
        const m = node as SceneNode & { isMask: boolean; maskType: MaskType };
        m.isMask = true;
        m.maskType = 'ALPHA';
      } catch (e) {
        onLog('warn', `Failed to set mask on "${irNode.name}": ${e instanceof Error ? e.message : e}`);
      }
    }

    if (irNode.isImportHelper && node) {
      try { node.setPluginData('psd_import_helper', '1'); } catch { /* ignore */ }
    }

    return node;
  } catch (e) {
    onLog('error', `Failed to create node "${irNode.name}" (${irNode.type}): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export class FigmaRenderer implements PlatformRenderer {
  async render(tree: IRNode, onProgress: ProgressFn, onLog: LogFn, options?: RenderOptions): Promise<void> {
    const page = figma.currentPage;
    const totalNodes = countIRNodes(tree);
    let processed = 0;

    const onNodeCreated = () => {
      processed++;
      onProgress(
        Math.round((processed / totalNodes) * 100),
        `Creating layers... (${processed}/${totalNodes})`
      );
    };

    const sectionNode = await renderNode(tree, page, onLog, onNodeCreated);

    if (sectionNode) {
      // 多文件场景：把根 section 平移到 placement，避免堆在原点
      const placement = options?.placement;
      if (placement && (sectionNode.x !== placement.x || sectionNode.y !== placement.y)) {
        try {
          sectionNode.x = placement.x;
          sectionNode.y = placement.y;
        } catch (e) {
          onLog('warn', `Failed to place section at (${placement.x}, ${placement.y}): ${e instanceof Error ? e.message : e}`);
        }
      }

      figma.currentPage.selection = [sectionNode];
      // 仅在批次末尾聚焦视口，避免多文件互相把视口拽走
      const isBatchTail = options?.isBatchTail !== false;
      if (isBatchTail) {
        figma.viewport.scrollAndZoomIntoView([sectionNode]);
      }
    }
  }
}
