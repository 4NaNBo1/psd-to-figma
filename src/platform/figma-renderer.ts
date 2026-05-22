import type { IRNode, IRFill, IRShadow, IRStroke, IRCornerRadii, IRTextProps, IRTextRange, IRGradientFill, IRSolidFill, IRImageFill } from '../ir/types';
import type { PlatformRenderer, LogFn, ProgressFn } from './types';
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

function applyStrokes(node: SceneNode, strokes: IRStroke[]): void {
  if (strokes.length === 0) return;
  const stroke = strokes[0];
  const figmaStrokes: Paint[] = stroke.fills.map((s) => ({
    type: 'SOLID' as const,
    color: { r: s.color.r, g: s.color.g, b: s.color.b },
    opacity: s.opacity ?? s.color.a,
  }));
  if ('strokes' in node) {
    const gm = node as GeometryMixin;
    gm.strokes = figmaStrokes;
    gm.strokeWeight = stroke.weight;
    gm.strokeAlign = stroke.align as 'INSIDE' | 'OUTSIDE' | 'CENTER';
    try { (gm as { strokeJoin: StrokeJoin }).strokeJoin = 'ROUND'; } catch (_e) { /* ignore */ }
  }
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

async function renderTextNode(
  irNode: IRNode,
  parent: FrameNode | PageNode | SectionNode,
  onLog: LogFn
): Promise<TextNode> {
  const text = figma.createText();
  text.name = irNode.name;
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

      if (range.letterSpacing !== 0) {
        text.setRangeLetterSpacing(start, end, { value: range.letterSpacing, unit: 'PIXELS' });
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
  applyStrokes(text, irNode.strokes);

  alignTextPosition(text, irNode, onLog);
  if (tp.rotation) {
    text.rotation = tp.rotation;
  }

  return text;
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
}

async function renderNode(
  irNode: IRNode,
  parent: FrameNode | PageNode | SectionNode,
  onLog: LogFn,
  onNodeCreated: () => void
): Promise<SceneNode | null> {
  if (!irNode.visible) {
    return null;
  }

  try {
    let node: SceneNode;

    switch (irNode.type) {
      case 'section': {
        const section = figma.createSection();
        section.name = irNode.name;
        section.fills = [];
        parent.appendChild(section);
        section.resizeWithoutConstraints(irNode.width, irNode.height);

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
        applyStrokes(frame, irNode.strokes);
        applyCornerRadii(frame, irNode.cornerRadii);

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
        applyStrokes(rect, irNode.strokes);
        applyCornerRadii(rect, irNode.cornerRadii);

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
  async render(tree: IRNode, onProgress: ProgressFn, onLog: LogFn): Promise<void> {
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
      figma.currentPage.selection = [sectionNode];
      figma.viewport.scrollAndZoomIntoView([sectionNode]);
    }
  }
}
