import type { IRNode, IRFill, IRShadow, IRStroke, IRCornerRadii, IRTextProps, IRTextRange, IRGradientFill, IRSolidFill, IRImageFill } from '../ir/types';
import type { PlatformRenderer, LogFn, ProgressFn, RenderOptions } from './types';
import { countIRNodes } from '../ir/builder';

declare const mg: any;

const FALLBACK_FONT = { family: 'Inter', style: 'Regular' };

function safeResize(node: any, w: number, h: number): void {
  if (typeof node.resize === 'function') {
    node.resize(w, h);
  } else {
    node.width = w;
    node.height = h;
  }
}

async function tryLoadFont(family: string, style: string): Promise<{ family: string; style: string } | null> {
  try {
    const fontName = { family, style };
    await mg.loadFontAsync(fontName);
    return fontName;
  } catch {
    return null;
  }
}

async function loadBestFont(rawFamily: string, rawStyle: string, onLog: LogFn, layerName: string): Promise<{ family: string; style: string }> {
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
    await mg.loadFontAsync(FALLBACK_FONT);
    return FALLBACK_FONT;
  } catch {
    return FALLBACK_FONT;
  }
}

function applyCornerRadii(node: any, radii: IRCornerRadii | undefined): void {
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

function applyEffects(node: any, effects: IRShadow[]): void {
  if (effects.length === 0) return;
  node.effects = effects.map((e) => ({
    type: e.type,
    color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a },
    offset: { x: e.offset.x, y: e.offset.y },
    radius: e.radius,
    spread: e.spread,
    visible: e.visible,
    blendMode: e.blendMode,
  }));
}

/**
 * Compute mastergo gradientHandlePositions from PSD angle (degrees).
 * PSD convention: 0° = left-to-right, 90° = bottom-to-top (standard Cartesian, y up).
 * mastergo space: top-left (0,0), bottom-right (1,1) (y down).
 */
function gradientHandlesFromPsdAngle(angleDeg: number): { x: number; y: number }[] {
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    { x: 0.5 - 0.5 * c, y: 0.5 + 0.5 * s },
    { x: 0.5 + 0.5 * c, y: 0.5 - 0.5 * s },
    { x: 0.5 - 0.5 * s, y: 0.5 - 0.5 * c },
  ];
}

function applySingleStroke(node: any, stroke: IRStroke): void {
  node.strokes = stroke.fills.map((s) => ({
    type: 'SOLID',
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.opacity ?? s.color.a },
    isVisible: true,
    alpha: 1,
    blendMode: 'NORMAL',
  }));
  node.strokeWeight = stroke.weight;
  node.strokeAlign = stroke.align;
  try { node.strokeJoin = 'ROUND'; } catch (_e) { /* ignore */ }
}

function applyStrokes(node: any, strokes: IRStroke[], onLog?: LogFn, nodeName?: string): void {
  if (strokes.length === 0) return;
  // 形状/frame 节点受 mastergo 单节点限制只能渲染一个 stroke
  if (onLog && strokes.length > 1) {
    onLog('warn', `Node "${nodeName ?? '?'}" has ${strokes.length} strokes; only strokes[0] applied (platform limitation)`);
  }
  applySingleStroke(node, strokes[0]);
}

async function applyImageFill(node: any, fill: IRImageFill, onLog: LogFn, name: string): Promise<void> {
  try {
    const image = await mg.createImage(fill.imageBytes);
    node.fills = [{
      type: 'IMAGE',
      imageRef: image.href,
      scaleMode: fill.scaleMode,
    }];
  } catch (e) {
    onLog('warn', `Failed to apply image on "${name}": ${e instanceof Error ? e.message : e}`);
    node.fills = [];
  }
}

async function applyFills(node: any, fills: IRFill[], onLog: LogFn, name: string): Promise<void> {
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
      color: { r: fill.color.r, g: fill.color.g, b: fill.color.b, a: fill.opacity ?? fill.color.a },
      isVisible: true,
      alpha: 1,
      blendMode: 'NORMAL',
    }];
  } else if (fill.type === 'GRADIENT_LINEAR') {
    node.fills = [{
      type: 'GRADIENT_LINEAR',
      gradientStops: fill.stops.map((s) => ({
        position: s.position,
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
      })),
      transform: fill.transform,
      gradientHandlePositions: gradientHandlesFromPsdAngle(fill.angle),
      isVisible: true,
      alpha: 1,
      blendMode: 'NORMAL',
    }];
  }
}

// 创建并样式化一个文本节点；strokeOverride 决定本节点承载的 stroke（undefined = 不画 stroke）
// 返回 { node, linePadding } - linePadding 是 alignTextPosition 实际应用的 baseline 偏移
async function createStyledTextNode(
  irNode: IRNode,
  parent: any,
  onLog: LogFn,
  strokeOverride: IRStroke | undefined,
  nameSuffix: string,
  linePaddingOverride?: number
): Promise<{ node: any; linePadding: number }> {
  const text = mg.createText();
  text.name = irNode.name + nameSuffix;
  text.isVisible = irNode.visible;
  if (irNode.opacity !== 1) text.opacity = irNode.opacity;
  text.blendMode = irNode.blendMode;
  parent.appendChild(text);
  text.x = irNode.x;
  text.y = irNode.y;

  const tp = irNode.textProps;
  if (!tp) return text;

  const firstRange = tp.ranges.length > 0 ? tp.ranges[0] : null;
  let defaultFont: { family: string; style: string };
  if (firstRange) {
    defaultFont = await loadBestFont(firstRange.fontFamily, firstRange.fontStyle, onLog, irNode.name);
  } else {
    await mg.loadFontAsync(FALLBACK_FONT);
    defaultFont = FALLBACK_FONT;
  }

  text.fontName = defaultFont;

  const isBoxText = tp.shapeType === 'box' && (tp.width > 0 || tp.height > 0);
  if (isBoxText) {
    text.textAutoResize = 'HEIGHT';
    safeResize(text, tp.width, tp.height);
  } else {
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  text.characters = tp.characters;
  text.textAlignHorizontal = tp.alignment;

  if (isBoxText) {
    text.textAutoResize = 'NONE';
    safeResize(text, tp.width, tp.height);
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
          text.setRangeLineHeight(start, end, { unit: 'AUTO' });
        }
      }

      if (range.fills.length > 0) {
        const f = range.fills[0];
        if (f.type === 'SOLID') {
          text.setRangeFills(start, end, [{
            type: 'SOLID',
            color: { r: f.color.r, g: f.color.g, b: f.color.b, a: f.opacity ?? f.color.a },
            isVisible: true,
            alpha: 1,
            blendMode: 'NORMAL',
          }]);
        }
      }

      // 无论 letterSpacing 是否为 0 都显式设置：mastergo 内部 default letterSpacing 在字体级
      // 是非 0 值（如 PingFang -0.88px），不调用 setRangeLetterSpacing(0) 会让节点保留 default,
      // 导致 export 时 PSD tracking 错误（如 0 变成 -27/-12）。
      text.setRangeLetterSpacing(start, end, { value: range.letterSpacing, unit: 'PIXELS' });
    } catch (e) {
      onLog('warn', `Failed to apply text style range [${start}:${end}] for "${irNode.name}": ${e instanceof Error ? e.message : e}`);
    }
  }

  if (tp.gradientOverlay) {
    const go = tp.gradientOverlay;
    const gradFill = {
      type: 'GRADIENT_LINEAR' as const,
      gradientStops: go.stops.map((s) => ({
        position: s.position,
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
      })),
      transform: go.transform,
      gradientHandlePositions: gradientHandlesFromPsdAngle(go.angle),
      isVisible: true,
      alpha: 1,
      blendMode: 'NORMAL',
    };
    try {
      text.setRangeFills(0, tp.characters.length, [gradFill]);
    } catch {
      text.fills = [gradFill];
    }
  }

  applyEffects(text, irNode.effects);
  if (strokeOverride) {
    applySingleStroke(text, strokeOverride);
  }

  const linePadding = alignTextPosition(text, irNode, onLog, linePaddingOverride);
  if (tp.rotation) {
    // MasterGo: 正值=顺时针；Figma/PSD: 正值=逆时针 → 取反
    text.rotation = -tp.rotation;
    // 保存原始 PSD 旋转角（度，PS 约定：正=逆时针），供 export 还原旋转 transform 与旋转后的
    // layer bbox。不保存会让旋转文本导出时退化为轴对齐 bbox，PS 中渲染会被裁剪。
    try { text.setPluginData('psd_transform_rotation', String(tp.rotation)); } catch { /* ignore */ }
  }

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
  // 文本层保存原始 PSD effects 元数据（含 disabled 配置），让 export 时 PS 读到完整 effects 状态，
  // 不被简化版（仅 enabled）的 figma 提取覆盖。
  if (irNode.rawPsdEffects) {
    try { text.setPluginData('psd_raw_effects', irNode.rawPsdEffects); } catch { /* ignore */ }
  }
  // 保存 import 时的 anchor 信息：
  //   anchor_node_y = text.y/x (mastergo 内部值，可能与理论值有亚像素精度差)
  //   psd_ty/tx = 原始 PSD 的 transform.ty/tx
  // export 时计算用户移动量 delta = current_node.y - anchor_node_y，
  // 还原 ty = psd_ty + delta。这样未移动文本 export ty 完全等于原始 PSD ty，
  // 避开 mastergo node.y 的亚像素精度损失（之前 ~0.0005 像素抖动来源）。
  try { text.setPluginData('psd_anchor_node_y', String(text.y)); } catch { /* ignore */ }
  try { text.setPluginData('psd_anchor_node_x', String(text.x)); } catch { /* ignore */ }
  if (tp.transformTy != null && Number.isFinite(tp.transformTy)) {
    try { text.setPluginData('psd_transform_ty', String(tp.transformTy)); } catch { /* ignore */ }
  }
  if (tp.transformTx != null && Number.isFinite(tp.transformTx)) {
    try { text.setPluginData('psd_transform_tx', String(tp.transformTx)); } catch { /* ignore */ }
  }

  return { node: text, linePadding };
}

async function renderTextNode(
  irNode: IRNode,
  parent: any,
  onLog: LogFn
): Promise<any> {
  const strokes = irNode.strokes;

  if (strokes.length <= 1) {
    const { node } = await createStyledTextNode(irNode, parent, onLog, strokes[0], '');
    return node;
  }

  // 多 stroke：PSD 中 stroke[0] 在最上层。mastergo 单节点只能有一个
  // strokeWeight/strokeAlign，所以拆成多个相同字符的文本副本叠加，每个
  // 承载一个 stroke。
  //
  // 对齐策略：alignTextPosition 末尾的 linePadding 修正基于 absoluteRenderBounds，
  // 而 absoluteRenderBounds 受 stroke 宽度影响，会让不同 stroke 副本的最终 text.y
  // 错位。所以先创建顶层 (stroke[0]) 节点拿到它的 linePadding，再用同一个 padding
  // 创建底层副本，保证字符 baseline 重合。
  //
  // 另外给所有副本写入 psd_multi_stroke_group_id / index / total，
  // 让 mastergo → PSD 导出时能识别同组节点并合并成单文本节点 + 多 stroke，
  // 保持 PSD 文件结构与原始一致。
  const groupId = `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const totalStrokes = strokes.length;
  const top = await createStyledTextNode(irNode, parent, onLog, strokes[0], '');
  const sharedPadding = top.linePadding;
  try {
    top.node.setPluginData('psd_multi_stroke_group_id', groupId);
    top.node.setPluginData('psd_multi_stroke_index', '0');
    top.node.setPluginData('psd_multi_stroke_total', String(totalStrokes));
  } catch { /* ignore */ }

  for (let i = 1; i < strokes.length; i++) {
    const suffix = ` (stroke ${i + 1})`;
    const { node: clone } = await createStyledTextNode(irNode, parent, onLog, strokes[i], suffix, sharedPadding);
    try {
      clone.setPluginData('psd_multi_stroke_group_id', groupId);
      clone.setPluginData('psd_multi_stroke_index', String(i));
      clone.setPluginData('psd_multi_stroke_total', String(totalStrokes));
    } catch { /* ignore */ }
    // 将副本移到顶层节点之前（更下层），保证 stroke[0] 在最上、stroke[N-1] 在最下
    try {
      const topIdx = parent.children.indexOf(top.node);
      if (typeof parent.insertChild === 'function' && topIdx >= 0) {
        parent.insertChild(topIdx, clone);
      }
    } catch (e) {
      onLog('warn', `Failed to reorder multi-stroke text "${clone.name}": ${e instanceof Error ? e.message : e}`);
    }
  }

  return top.node;
}

// 对齐文本节点位置；返回 alignment 实际应用的 linePadding（baseline 偏移），
// 用于多 stroke 副本传入 linePaddingOverride 以保证字符 baseline 完全对齐
// （否则 mastergo 的 absoluteRenderBounds 会因 stroke 宽度不同而产生位置偏差）。
function alignTextPosition(text: any, irNode: IRNode, onLog: LogFn, linePaddingOverride?: number): number {
  const tp = irNode.textProps!;
  const hasPrecise = tp.docBoundsY != null || tp.docBboxCenterX != null;

  let targetX: number, targetY: number;
  if (hasPrecise) {
    if (tp.docBboxCenterX != null) {
      targetX = tp.docBboxCenterX - text.width / 2;
    } else {
      targetX = irNode.x + irNode.width / 2 - text.width / 2;
    }
    if (tp.docBoundsY != null) {
      targetY = tp.docBoundsY;
    } else {
      targetY = irNode.y + irNode.height / 2 - text.height / 2;
    }
  } else {
    const psCenterX = irNode.x + irNode.width / 2;
    const psCenterY = irNode.y + irNode.height / 2;
    targetX = psCenterX - text.width / 2;
    targetY = psCenterY - text.height / 2;
    onLog('info', `Text "${irNode.name}" align (fallback): original(${irNode.x.toFixed(2)}, ${irNode.y.toFixed(2)}) -> final(${targetX.toFixed(2)}, ${targetY.toFixed(2)})`);
  }

  text.x = targetX;
  text.y = targetY;

  if (linePaddingOverride != null && Number.isFinite(linePaddingOverride)) {
    text.y = targetY - linePaddingOverride;
    // 把 linePadding 存到 plugin data，供 export 还原 PSD ty 时使用
    try { text.setPluginData('psd_line_padding_y', String(linePaddingOverride)); } catch { /* ignore */ }
    return linePaddingOverride;
  }

  let appliedPadding = 0;
  try {
    const renderBoundsY = text.absoluteRenderBounds?.y;
    const boundingBoxY = text.absoluteBoundingBox?.y;
    if (Number.isFinite(renderBoundsY) && Number.isFinite(boundingBoxY)) {
      appliedPadding = renderBoundsY - boundingBoxY;
      text.y = targetY - appliedPadding;
    }
  } catch { /* keep targetY */ }
  // 把 linePadding 存到 plugin data，供 export 还原 PSD ty 时使用
  try { text.setPluginData('psd_line_padding_y', String(appliedPadding)); } catch { /* ignore */ }
  return appliedPadding;
}

async function renderNode(
  irNode: IRNode,
  parent: any,
  onLog: LogFn,
  onNodeCreated: () => void
): Promise<any> {
  try {
    let node: any;

    switch (irNode.type) {
      case 'section': {
        const section = mg.createSection();
        section.name = irNode.name;
        section.fills = [];
        parent.appendChild(section);
        section.width = irNode.width;
        section.height = irNode.height;

        if (irNode.psdEngineData) {
          try { section.setPluginData('psd_engine_data', irNode.psdEngineData); } catch { /* ignore */ }
        }

        if (irNode.children) {
          for (const child of irNode.children) {
            await renderNode(child, section, onLog, onNodeCreated);
          }
        }
        onNodeCreated();
        onLog('info', `Created section: "${irNode.name}" (${irNode.width}x${irNode.height})`);
        node = section;
        break;
      }

      case 'frame': {
        const frame = mg.createFrame();
        safeResize(frame, irNode.width, irNode.height);
        frame.clipsContent = irNode.clipsContent;
        await applyFills(frame, irNode.fills, onLog, irNode.name);
        frame.name = irNode.name;
        frame.isVisible = irNode.visible;
        if (irNode.opacity !== 1) frame.opacity = irNode.opacity;
        frame.blendMode = irNode.blendMode;
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
        onLog('info', `Created frame: "${irNode.name}" (${irNode.width}x${irNode.height})`);
        node = frame;
        break;
      }

      case 'text': {
        const text = await renderTextNode(irNode, parent, onLog);
        onNodeCreated();
        onLog('info', `Created text: "${irNode.name}"`);
        node = text;
        break;
      }

      case 'rectangle':
      default: {
        const rect = mg.createRectangle();
        safeResize(rect, irNode.width, irNode.height);
        rect.name = irNode.name;
        rect.isVisible = irNode.visible;
        if (irNode.opacity !== 1) rect.opacity = irNode.opacity;
        rect.blendMode = irNode.blendMode;
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
        onLog('info', `Created rect: "${irNode.name}" (${irNode.width}x${irNode.height})`);
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

export class MasterGoRenderer implements PlatformRenderer {
  async render(tree: IRNode, onProgress: ProgressFn, onLog: LogFn, options?: RenderOptions): Promise<void> {
    onLog('info', `MasterGoRenderer start: ${tree.type} "${tree.name}"`);
    const page = mg.document.currentPage;
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

      mg.document.currentPage.selection = [sectionNode];
      onLog('info', 'Selection set');

      // 仅在批次末尾聚焦视口（保持与 figma 端对等；MasterGo 若无等价 API 则跳过）
      const isBatchTail = options?.isBatchTail !== false;
      if (isBatchTail) {
        try {
          if (mg.viewport && typeof mg.viewport.scrollAndZoomIntoView === 'function') {
            mg.viewport.scrollAndZoomIntoView([sectionNode]);
          }
        } catch (e) {
          onLog('warn', `Failed to scroll viewport into section: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    mg.commitUndo();
    onLog('info', 'MasterGoRenderer complete');
  }
}
