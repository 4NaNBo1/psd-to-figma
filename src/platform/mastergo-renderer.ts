import type { IRNode, IRFill, IRShadow, IRStroke, IRCornerRadii, IRTextProps, IRTextRange, IRGradientFill, IRSolidFill, IRImageFill } from '../ir/types';
import type { PlatformRenderer, LogFn, ProgressFn } from './types';
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

function applyStrokes(node: any, strokes: IRStroke[]): void {
  if (strokes.length === 0) return;
  const stroke = strokes[0];
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

async function renderTextNode(
  irNode: IRNode,
  parent: any,
  onLog: LogFn
): Promise<any> {
  const text = mg.createText();
  text.name = irNode.name;
  text.visible = irNode.visible;
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

      if (range.letterSpacing !== 0) {
        text.setRangeLetterSpacing(start, end, { value: range.letterSpacing, unit: 'PIXELS' });
      }
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
  applyStrokes(text, irNode.strokes);

  alignTextPosition(text, irNode, onLog);
  if (tp.rotation) {
    text.rotation = tp.rotation;
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

  return text;
}

function alignTextPosition(text: any, irNode: IRNode, onLog: LogFn): void {
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

  try {
    const renderBoundsY = text.absoluteRenderBounds?.y;
    const boundingBoxY = text.absoluteBoundingBox?.y;
    if (Number.isFinite(renderBoundsY) && Number.isFinite(boundingBoxY)) {
      const linePadding = renderBoundsY - boundingBoxY;
      text.y = targetY - linePadding;
    }
  } catch { /* keep targetY */ }
}

async function renderNode(
  irNode: IRNode,
  parent: any,
  onLog: LogFn,
  onNodeCreated: () => void
): Promise<any> {
  if (!irNode.visible) {
    return null;
  }

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
        frame.visible = irNode.visible;
        if (irNode.opacity !== 1) frame.opacity = irNode.opacity;
        frame.blendMode = irNode.blendMode;
        parent.appendChild(frame);
        frame.x = irNode.x;
        frame.y = irNode.y;

        applyEffects(frame, irNode.effects);
        applyStrokes(frame, irNode.strokes);
        applyCornerRadii(frame, irNode.cornerRadii);

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
        rect.visible = irNode.visible;
        if (irNode.opacity !== 1) rect.opacity = irNode.opacity;
        rect.blendMode = irNode.blendMode;
        parent.appendChild(rect);
        rect.x = irNode.x;
        rect.y = irNode.y;

        await applyFills(rect, irNode.fills, onLog, irNode.name);
        applyEffects(rect, irNode.effects);
        applyStrokes(rect, irNode.strokes);
        applyCornerRadii(rect, irNode.cornerRadii);

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
  async render(tree: IRNode, onProgress: ProgressFn, onLog: LogFn): Promise<void> {
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
      mg.document.currentPage.selection = [sectionNode];
      onLog('info', 'Selection set');
    }

    mg.commitUndo();
    onLog('info', 'MasterGoRenderer complete');
  }
}
