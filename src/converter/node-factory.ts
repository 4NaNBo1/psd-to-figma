import type { SerializedLayer, SerializedPsd, SerializedShadow, SerializedStroke, SerializedCornerRadii } from '../types/psd-types';
import { applyTextProperties } from './text-converter';
import { createImageFill } from './image-converter';

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

function applyCornerRadii(node: RectangleNode | FrameNode, radii: SerializedCornerRadii | undefined, onLog: LogFn, layerName: string): void {
  if (!radii) return;
  try {
    const { topLeft, topRight, bottomLeft, bottomRight } = radii;
    if (topLeft === topRight && topRight === bottomLeft && bottomLeft === bottomRight) {
      node.cornerRadius = Math.round(topLeft);
    } else {
      node.topLeftRadius = Math.round(topLeft);
      node.topRightRadius = Math.round(topRight);
      node.bottomLeftRadius = Math.round(bottomLeft);
      node.bottomRightRadius = Math.round(bottomRight);
    }
  } catch (e) {
    onLog('warn', `Failed to apply corner radius on "${layerName}": ${e instanceof Error ? e.message : e}`);
  }
}

function toFigmaBlendMode(mode: string): BlendMode {
  const valid: BlendMode[] = [
    'PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN',
    'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE',
    'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION',
    'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY',
  ];
  return (valid.includes(mode as BlendMode) ? mode : 'NORMAL') as BlendMode;
}

function applyEffects(node: SceneNode & MinimalFillsMixin, effects: SerializedShadow[], onLog: LogFn, layerName: string): void {
  if (!effects || effects.length === 0) return;

  try {
    const figmaEffects: Effect[] = effects.map((e) => {
      if (e.type === 'drop') {
        return {
          type: 'DROP_SHADOW',
          color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a },
          offset: { x: e.offsetX, y: e.offsetY },
          radius: e.blur,
          spread: e.spread,
          visible: e.visible,
          blendMode: toFigmaBlendMode(e.blendMode),
        } as DropShadowEffect;
      }
      return {
        type: 'INNER_SHADOW',
        color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a },
        offset: { x: e.offsetX, y: e.offsetY },
        radius: e.blur,
        spread: e.spread,
        visible: e.visible,
        blendMode: toFigmaBlendMode(e.blendMode),
      } as InnerShadowEffect;
    });

    (node as SceneNode & { effects: readonly Effect[] }).effects = figmaEffects;
  } catch (e) {
    onLog('warn', `Failed to apply effects on "${layerName}": ${e instanceof Error ? e.message : e}`);
  }
}

function applyStrokes(node: SceneNode, strokes: SerializedStroke[], onLog: LogFn, layerName: string): void {
  if (!strokes || strokes.length === 0) return;
  try {
    const figmaStrokes: Paint[] = strokes.map((s) => ({
      type: 'SOLID' as const,
      color: { r: s.color.r, g: s.color.g, b: s.color.b },
      opacity: s.color.a * s.opacity,
    }));
    if ('strokes' in node) {
      (node as GeometryMixin).strokes = figmaStrokes;
      (node as GeometryMixin).strokeWeight = strokes[0].width;
      const posMap: Record<string, StrokeAlign> = {
        'outside': 'OUTSIDE',
        'inside': 'INSIDE',
        'center': 'CENTER',
      };
      (node as GeometryMixin).strokeAlign = posMap[strokes[0].position] || 'OUTSIDE';
    }
  } catch (e) {
    onLog('warn', `Failed to apply strokes on "${layerName}": ${e instanceof Error ? e.message : e}`);
  }
}

function alignTextRenderBoundsToLayer(
  text: TextNode,
  layer: SerializedLayer,
  _parent: FrameNode | PageNode,
  onLog: LogFn
): void {
  const td = layer.textData;
  const hasPrecise = td && (td.docBoundsY != null || td.docBboxCenterX != null);

  if (hasPrecise) {
    if (td!.docBboxCenterX != null) {
      text.x = td!.docBboxCenterX - text.width / 2;
    } else {
      text.x = layer.x + layer.width / 2 - text.width / 2;
    }

    if (td!.docBoundsY != null) {
      text.y = td!.docBoundsY;
    } else {
      text.y = layer.y + layer.height / 2 - text.height / 2;
    }

  } else {
    const psCenterX = layer.x + layer.width / 2;
    const psCenterY = layer.y + layer.height / 2;

    text.x = psCenterX - text.width / 2;
    text.y = psCenterY - text.height / 2;

    onLog('info', `Text "${layer.name}" align (fallback): PS(${layer.x.toFixed(2)}, ${layer.y.toFixed(2)}) -> Figma(${text.x.toFixed(2)}, ${text.y.toFixed(2)})`);
  }
}

function applyBaseProperties(node: SceneNode, layer: SerializedLayer): void {
  node.name = layer.name;
  node.visible = layer.visible;

  if ('opacity' in node) {
    (node as SceneNode & BlendMixin).opacity = layer.opacity;
  }
  if ('blendMode' in node) {
    (node as SceneNode & BlendMixin).blendMode = toFigmaBlendMode(layer.blendMode);
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bufferLength = (base64.length * 3) >>> 2;
  if (base64[base64.length - 1] === '=') bufferLength--;
  if (base64[base64.length - 2] === '=') bufferLength--;

  const bytes = new Uint8Array(bufferLength);
  let p = 0;

  for (let i = 0; i < base64.length; i += 4) {
    const a = lookup.indexOf(base64[i]);
    const b = lookup.indexOf(base64[i + 1]);
    const c = lookup.indexOf(base64[i + 2]);
    const d = lookup.indexOf(base64[i + 3]);

    bytes[p++] = (a << 2) | (b >> 4);
    if (c !== -1 && base64[i + 2] !== '=') bytes[p++] = ((b & 15) << 4) | (c >> 2);
    if (d !== -1 && base64[i + 3] !== '=') bytes[p++] = ((c & 3) << 6) | d;
  }

  return bytes;
}

function applyImageToNode(
  node: RectangleNode | FrameNode,
  images: string[],
  imageIndex: number | undefined,
  onLog: LogFn,
  layerName: string,
): boolean {
  if (imageIndex === undefined || !images[imageIndex]) return false;
  try {
    const base64 = images[imageIndex];
    if (!base64 || base64.length === 0) return false;
    const bytes = base64ToUint8Array(base64);
    if (bytes.length === 0) return false;
    createImageFill(bytes, node);
    return true;
  } catch (e) {
    onLog('warn', `Failed to apply image on "${layerName}": ${e instanceof Error ? e.message : e}`);
    node.fills = [];
    return false;
  }
}

function resizeFrameToFitChildren(frame: FrameNode, psdW: number, psdH: number): void {
  if (frame.children.length === 0) return;

  let maxR = psdW;
  let maxB = psdH;

  for (const child of frame.children) {
    if (!child.visible) continue;
    const childRight = child.x + ('width' in child ? child.width : 0);
    const childBottom = child.y + ('height' in child ? child.height : 0);
    if (childRight > maxR) maxR = childRight;
    if (childBottom > maxB) maxB = childBottom;
  }

  if (maxR > psdW || maxB > psdH) {
    frame.resize(Math.max(psdW, maxR), Math.max(psdH, maxB));
  }
}

async function createChildrenWithClipping(
  children: SerializedLayer[],
  images: string[],
  parent: FrameNode | PageNode,
  onProgress: (msg: string) => void,
  onLog: LogFn,
  depth: number
): Promise<void> {
  let i = 0;
  while (i < children.length) {
    const child = children[i];

    const clippedLayers: SerializedLayer[] = [];
    let j = i + 1;
    while (j < children.length && children[j].clipped) {
      clippedLayers.push(children[j]);
      j++;
    }

    if (clippedLayers.length > 0) {
      const baseNode = await createLayerNode(child, images, parent, onProgress, onLog, depth);
      if (baseNode && 'width' in baseNode) {
        const clipFrame = figma.createFrame();
        clipFrame.name = child.name + ' (clip group)';
        clipFrame.resize(baseNode.width, baseNode.height);
        clipFrame.x = baseNode.x;
        clipFrame.y = baseNode.y;
        clipFrame.clipsContent = true;
        clipFrame.fills = [];

        if ('cornerRadius' in baseNode) {
          const br = baseNode as RectangleNode | FrameNode;
          if (br.cornerRadius !== figma.mixed) {
            clipFrame.cornerRadius = br.cornerRadius as number;
          } else {
            clipFrame.topLeftRadius = br.topLeftRadius;
            clipFrame.topRightRadius = br.topRightRadius;
            clipFrame.bottomLeftRadius = br.bottomLeftRadius;
            clipFrame.bottomRightRadius = br.bottomRightRadius;
          }
        }

        parent.insertChild(parent.children.indexOf(baseNode), clipFrame);
        baseNode.x = 0;
        baseNode.y = 0;
        clipFrame.appendChild(baseNode);

        for (const clippedLayer of clippedLayers) {
          const clippedNode = await createLayerNode(clippedLayer, images, clipFrame, onProgress, onLog, depth);
          if (clippedNode) {
            clippedNode.x = clippedLayer.x - child.x;
            clippedNode.y = clippedLayer.y - child.y;
          }
        }

      }
      i = j;
    } else {
      await createLayerNode(child, images, parent, onProgress, onLog, depth);
      i++;
    }
  }
}

async function createLayerNode(
  layer: SerializedLayer,
  images: string[],
  parent: FrameNode | PageNode,
  onProgress: (msg: string) => void,
  onLog: LogFn,
  depth: number
): Promise<SceneNode | null> {
  try {
    const w = layer.isSubGroup ? layer.width : Math.max(1, layer.width);
    const h = layer.isSubGroup ? layer.height : Math.max(1, layer.height);

    let node: SceneNode;

    switch (layer.type) {
      case 'group': {
        const frame = figma.createFrame();
        frame.resize(w, h);
        frame.clipsContent = (depth === 0);
        frame.fills = [];
        applyBaseProperties(frame, layer);
        parent.appendChild(frame);
        frame.x = layer.x;
        frame.y = layer.y;

        if (layer.imageIndex !== undefined) {
          applyImageToNode(frame, images, layer.imageIndex, onLog, layer.name);
        }

        applyEffects(frame, layer.effects, onLog, layer.name);
        applyStrokes(frame, layer.strokes, onLog, layer.name);
        applyCornerRadii(frame, layer.cornerRadii, onLog, layer.name);

        if (layer.children) {
          await createChildrenWithClipping(layer.children, images, frame, onProgress, onLog, depth + 1);
        }

        if (!layer.isArtboard && !layer.isSubGroup) {
          resizeFrameToFitChildren(frame, w, h);
        }

        onLog('info', `Created group: "${layer.name}" (${frame.width}x${frame.height}, ${layer.children?.length ?? 0} children)`);
        node = frame;
        break;
      }

      case 'text': {
        const text = figma.createText();
        applyBaseProperties(text, layer);
        parent.appendChild(text);
        text.x = layer.x;
        text.y = layer.y;

        try {
          await applyTextProperties(text, layer, onLog);
        } catch (e) {
          onLog('warn', `Could not fully apply text for "${layer.name}": ${e instanceof Error ? e.message : e}`);
        }

        applyEffects(text, layer.effects, onLog, layer.name);
        applyStrokes(text, layer.strokes, onLog, layer.name);

        if (layer.textData?.rotation) {
          text.x = layer.x;
          text.y = layer.y;
          text.rotation = layer.textData.rotation;
        } else {
          alignTextRenderBoundsToLayer(text, layer, parent, onLog);
        }

        onLog('info', `Created text: "${layer.name}"`);
        node = text;
        break;
      }

      case 'image':
      case 'shape':
      case 'smartObject':
      default: {
        const expand = layer.expandOffset ?? 0;
        const rectW = Math.max(1, w + expand * 2);
        const rectH = Math.max(1, h + expand * 2);

        const rect = figma.createRectangle();
        rect.resize(rectW, rectH);
        applyBaseProperties(rect, layer);
        parent.appendChild(rect);
        rect.x = layer.x - expand;
        rect.y = layer.y - expand;

        if (layer.imageIndex !== undefined) {
          applyImageToNode(rect, images, layer.imageIndex, onLog, layer.name);
        } else {
          rect.fills = [];
        }

        applyEffects(rect, layer.effects, onLog, layer.name);
        applyStrokes(rect, layer.strokes, onLog, layer.name);
        applyCornerRadii(rect, layer.cornerRadii, onLog, layer.name);

        onLog('info', `Created ${layer.type}: "${layer.name}" (${rectW}x${rectH}${expand > 0 ? `, expand=${expand}` : ''})`);
        node = rect;
        break;
      }
    }

    return node;
  } catch (e) {
    onLog('error', `Failed to create layer "${layer.name}" (${layer.type}): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function buildFigmaTree(
  psd: SerializedPsd,
  onProgress: (percent: number, msg: string) => void,
  onLog: LogFn
): Promise<void> {
  const page = figma.currentPage;

  const section = figma.createSection();
  section.name = psd.name || 'PSD Import';
  section.fills = [];
  page.appendChild(section);

  const rootFrame = figma.createFrame();
  rootFrame.name = 'Frame';
  rootFrame.resize(psd.width, psd.height);
  rootFrame.clipsContent = true;
  rootFrame.fills = [];
  section.appendChild(rootFrame);
  section.resizeWithoutConstraints(psd.width, psd.height);

  onLog('info', `Created root section "${section.name}" with frame ${psd.width}x${psd.height}`);

  const totalLayers = countLayers(psd.layers);
  let processed = 0;

  onLog('info', `Total layers to process: ${totalLayers}`);

  const progressCb = (msg: string) => {
    onProgress(Math.round((processed / totalLayers) * 100), msg);
  };

  for (let i = 0; i < psd.layers.length; i++) {
    await createLayerNode(psd.layers[i], psd.images, rootFrame, progressCb, onLog, 0);
    processed++;
    onProgress(
      Math.round((processed / totalLayers) * 100),
      'Creating layers... (' + processed + '/' + totalLayers + ')'
    );
  }

  figma.currentPage.selection = [section];
  figma.viewport.scrollAndZoomIntoView([section]);
}

function countLayers(layers: SerializedLayer[]): number {
  let count = 0;
  for (const l of layers) {
    count++;
    if (l.children) count += countLayers(l.children);
  }
  return count;
}
