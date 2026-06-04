import type { IRNode, IRFill, IRShadow, IRStroke, IRCornerRadii, IRTextProps, IRTextRange, IRGradientFill, IRSolidFill, IRImageFill } from '../ir/types';
import type { PlatformRenderer, LogFn, ProgressFn, RenderOptions } from './types';
import { countIRNodes } from '../ir/builder';

const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' };

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
  if (effects.length === 0) return;
  const figmaEffects: Effect[] = effects.map((e) => ({
    type: e.type,
    color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a },
    offset: { x: e.offset.x, y: e.offset.y },
    radius: e.radius,
    spread: e.spread,
    visible: e.visible,
    blendMode: e.blendMode as BlendMode,
  } as DropShadowEffect | InnerShadowEffect));
  (node as SceneNode & { effects: readonly Effect[] }).effects = figmaEffects;
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

async function applyImageFill(node: RectangleNode | FrameNode, fill: IRImageFill, onLog: LogFn, name: string): Promise<void> {
  try {
    const image = figma.createImage(fill.imageBytes);
    node.fills = [{
      type: 'IMAGE',
      imageHash: image.hash,
      scaleMode: fill.scaleMode,
    }];
  } catch (e) {
    onLog('warn', `Failed to apply image on "${name}": ${e instanceof Error ? e.message : e}`);
    node.fills = [];
  }
}

function applySolidFills(node: MinimalFillsMixin, fills: IRSolidFill[]): void {
  node.fills = fills.map((f) => ({
    type: 'SOLID' as const,
    color: { r: f.color.r, g: f.color.g, b: f.color.b },
    opacity: f.opacity ?? f.color.a,
  }));
}

async function applyFills(node: RectangleNode | FrameNode, fills: IRFill[], onLog: LogFn, name: string): Promise<void> {
  if (fills.length === 0) {
    node.fills = [];
    return;
  }
  const fill = fills[0];
  if (fill.type === 'IMAGE') {
    await applyImageFill(node, fill, onLog, name);
  } else if (fill.type === 'SOLID') {
    node.fills = [{
      type: 'SOLID',
      color: { r: fill.color.r, g: fill.color.g, b: fill.color.b },
      opacity: fill.opacity ?? fill.color.a,
    }];
  } else if (fill.type === 'GRADIENT_LINEAR') {
    node.fills = [{
      type: 'GRADIENT_LINEAR',
      gradientStops: fill.stops.map((s) => ({
        position: s.position,
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
      })),
      gradientTransform: fill.transform,
    }];
  }
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

      if (range.fills.length > 0) {
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
  if (strokeOverride) {
    applySingleStroke(text, strokeOverride);
  }

  alignTextPosition(text, irNode, onLog);
  if (tp.rotation) {
    text.rotation = tp.rotation;
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
  if (tp.textIndex != null && Number.isFinite(tp.textIndex)) {
    try { text.setPluginData('psd_text_index', String(tp.textIndex)); } catch { /* ignore */ }
  }
  if (tp.transformScale != null && Number.isFinite(tp.transformScale) && tp.transformScale !== 1) {
    try { text.setPluginData('psd_transform_scale', String(tp.transformScale)); } catch { /* ignore */ }
  }
  if (tp.transformScaleX != null && Number.isFinite(tp.transformScaleX) && tp.transformScaleX !== 1) {
    try { text.setPluginData('psd_transform_scale_x', String(tp.transformScaleX)); } catch { /* ignore */ }
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
        applyStrokes(frame, irNode.strokes, onLog, irNode.name);
        applyCornerRadii(frame, irNode.cornerRadii);
        if (irNode.rawPsdEffects) {
          try { frame.setPluginData('psd_raw_effects', irNode.rawPsdEffects); } catch { /* ignore */ }
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

        onNodeCreated();
        node = rect;
        break;
      }
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
