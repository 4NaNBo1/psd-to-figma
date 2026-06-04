import type { SerializedLayer, SerializedPsd, SerializedShadow, SerializedStroke, SerializedCornerRadii } from '../types/psd-types';
import type { IRNode, IRFill, IRShadow, IRStroke, IRCornerRadii, IRTextProps, IRTextRange, IRGradientFill, IRSolidFill, IRColor } from './types';

const POSTSCRIPT_TO_FAMILY: Record<string, string> = {
  'PingFangSC': 'PingFang SC',
  'PingFangTC': 'PingFang TC',
  'PingFangHK': 'PingFang HK',
  'STHeitiSC': 'Heiti SC',
  'STHeitiTC': 'Heiti TC',
  'STSongti': 'Songti SC',
  'STSongtiSC': 'Songti SC',
  'STSongtiTC': 'Songti TC',
  'STKaitiSC': 'Kaiti SC',
  'STKaitiTC': 'Kaiti TC',
  'STFangsongSC': 'STFangsong',
  'HiraginoSans': 'Hiragino Sans',
  'HiraginoSansGB': 'Hiragino Sans GB',
  'YuGothic': 'Yu Gothic',
  'YuMincho': 'Yu Mincho',
  'MicrosoftYaHei': 'Microsoft YaHei',
  'MicrosoftJhengHei': 'Microsoft JhengHei',
  'SimSun': 'SimSun',
  'SimHei': 'SimHei',
  'NotoSansSC': 'Noto Sans SC',
  'NotoSansTC': 'Noto Sans TC',
  'NotoSansCJKsc': 'Noto Sans CJK SC',
  'NotoSerifSC': 'Noto Serif SC',
  'NotoSerifCJKsc': 'Noto Serif CJK SC',
  'SourceHanSansSC': 'Source Han Sans SC',
  'SourceHanSansTC': 'Source Han Sans TC',
  'SourceHanSerifSC': 'Source Han Serif SC',
  'SourceHanSerifTC': 'Source Han Serif TC',
  'AdobeHeitiStd': 'Adobe Heiti Std',
  'AdobeSongStd': 'Adobe Song Std',
  'AdobeKaitiStd': 'Adobe Kaiti Std',
  'AdobeFangsongStd': 'Adobe Fangsong Std',
  'Helvetica': 'Helvetica',
  'HelveticaNeue': 'Helvetica Neue',
  'TimesNewRoman': 'Times New Roman',
  'ArialMT': 'Arial',
  'Arial': 'Arial',
  'Roboto': 'Roboto',
  'SFProText': 'SF Pro Text',
  'SFProDisplay': 'SF Pro Display',
  'SFProRounded': 'SF Pro Rounded',
};

const STYLE_MAP: Record<string, string> = {
  'Bold': 'Bold',
  'Italic': 'Italic',
  'BoldItalic': 'Bold Italic',
  'Bold Italic': 'Bold Italic',
  'Regular': 'Regular',
  'Light': 'Light',
  'Thin': 'Thin',
  'Ultralight': 'Ultralight',
  'Medium': 'Medium',
  'Semibold': 'Semibold',
  'SemiBold': 'Semibold',
  'Heavy': 'Heavy',
  'Black': 'Black',
  'ExtraBold': 'ExtraBold',
  'ExtraLight': 'ExtraLight',
  'DemiBold': 'Semibold',
  'Book': 'Book',
  'Roman': 'Regular',
  'Normal': 'Regular',
  'W3': 'W3',
  'W6': 'W6',
  'W9': 'W9',
};

const ALIGNMENT_MAP: Record<string, 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'> = {
  'left': 'LEFT',
  'center': 'CENTER',
  'right': 'RIGHT',
  'justify-left': 'JUSTIFIED',
  'justify-center': 'JUSTIFIED',
  'justify-right': 'JUSTIFIED',
  'justify-all': 'JUSTIFIED',
};

const VALID_BLEND_MODES = [
  'PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN',
  'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE',
  'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION',
  'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY',
];

function normalizeBlendMode(mode: string): string {
  return VALID_BLEND_MODES.includes(mode) ? mode : 'NORMAL';
}

export function parseFontName(rawName: string): { family: string; style: string } {
  const cleaned = rawName.replace(/^\s+|\s+$/g, '');

  const lastDash = cleaned.lastIndexOf('-');
  if (lastDash > 0) {
    const prefix = cleaned.substring(0, lastDash);
    const suffix = cleaned.substring(lastDash + 1);

    const mappedFamily = POSTSCRIPT_TO_FAMILY[prefix];
    const mappedStyle = STYLE_MAP[suffix];

    if (mappedFamily) {
      return { family: mappedFamily, style: mappedStyle || suffix || 'Regular' };
    }

    if (mappedStyle) {
      const family = prefix
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      return { family, style: mappedStyle };
    }

    const family = prefix
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return { family, style: suffix || 'Regular' };
  }

  const mapped = POSTSCRIPT_TO_FAMILY[cleaned];
  if (mapped) {
    return { family: mapped, style: 'Regular' };
  }

  const spaced = cleaned
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return { family: spaced, style: 'Regular' };
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

function convertEffects(effects: SerializedShadow[]): IRShadow[] {
  if (!effects || effects.length === 0) return [];
  return effects.map((e) => ({
    type: e.type === 'drop' ? 'DROP_SHADOW' as const : 'INNER_SHADOW' as const,
    color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a },
    offset: { x: e.offsetX, y: e.offsetY },
    radius: e.blur,
    spread: e.spread,
    visible: e.visible,
    blendMode: normalizeBlendMode(e.blendMode),
  }));
}

function convertStrokes(strokes: SerializedStroke[]): IRStroke[] {
  if (!strokes || strokes.length === 0) return [];

  const posMap: Record<string, 'INSIDE' | 'OUTSIDE' | 'CENTER'> = {
    'outside': 'OUTSIDE',
    'inside': 'INSIDE',
    'center': 'CENTER',
  };

  // PSD 允许同一图层有多个 stroke，每个有独立的颜色/宽度/位置。
  // mastergo/Figma 单节点的 strokeWeight/strokeAlign 只能有一个值，
  // 所以 IR 层保留多个独立 IRStroke，由 renderer 决定如何呈现：
  //   - 文本节点：克隆叠加，每个副本承载一个 stroke
  //   - 形状节点：受平台限制，仅渲染第一个
  return strokes.map((s) => ({
    fills: [{
      type: 'SOLID' as const,
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: 1 },
      opacity: s.color.a * s.opacity,
    }],
    weight: s.width,
    align: posMap[s.position] || 'OUTSIDE',
  }));
}

function convertCornerRadii(radii: SerializedCornerRadii | undefined): IRCornerRadii | undefined {
  if (!radii) return undefined;
  return {
    topLeft: Math.round(radii.topLeft),
    topRight: Math.round(radii.topRight),
    bottomLeft: Math.round(radii.bottomLeft),
    bottomRight: Math.round(radii.bottomRight),
  };
}

function buildImageFill(images: string[], imageIndex: number | undefined): IRFill[] {
  if (imageIndex === undefined || !images[imageIndex]) return [];
  const base64 = images[imageIndex];
  if (!base64 || base64.length === 0) return [];
  const bytes = base64ToUint8Array(base64);
  if (bytes.length === 0) return [];
  return [{
    type: 'IMAGE' as const,
    imageBytes: bytes,
    scaleMode: 'FILL' as const,
  }];
}

function buildTextProps(layer: SerializedLayer): IRTextProps | undefined {
  const td = layer.textData;
  if (!td || !td.text) return undefined;

  const alignment = ALIGNMENT_MAP[td.horizontalAlignment] || 'LEFT';
  const boxW = td.boxBounds?.width ?? 0;
  const boxH = td.boxBounds?.height ?? 0;
  const isBoxText = td.shapeType === 'box' && (boxW > 0 || (layer.width > 0 && layer.height > 0));
  const resizeW = boxW > 0 ? boxW : layer.width;
  const resizeH = boxH > 0 ? boxH : layer.height;

  let autoResize: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
  if (isBoxText) {
    autoResize = 'NONE';
  } else {
    autoResize = 'WIDTH_AND_HEIGHT';
  }

  const ranges: IRTextRange[] = td.styles.map((style) => {
    const parsed = parseFontName(style.fontFamily);
    const c = style.color;
    const range: IRTextRange = {
      start: style.start,
      end: style.end,
      fontFamily: parsed.family,
      fontStyle: parsed.style,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      fills: [{
        type: 'SOLID' as const,
        color: { r: c.r, g: c.g, b: c.b, a: 1 },
        opacity: c.a,
      }],
    };
    if (style.textCase) {
      range.textCase = style.textCase;
    }
    return range;
  });

  let gradientOverlay: IRGradientFill | undefined;
  if (td.gradientOverlay && td.gradientOverlay.type === 'linear') {
    const go = td.gradientOverlay;
    const angleRad = ((go.angle + 180) * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const cx = 0.5, cy = 0.5;
    const stops = go.reverse ? [...go.stops].reverse() : go.stops;

    gradientOverlay = {
      type: 'GRADIENT_LINEAR',
      stops: stops.map((s) => ({
        position: go.reverse ? 1 - s.position : s.position,
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: (s.color.a ?? 1) * go.opacity },
      })),
      transform: [
        [cos, sin, cx - cos * cx - sin * cy],
        [-sin, cos, cy + sin * cx - cos * cy],
      ],
      angle: go.angle,
    };
  }

  return {
    characters: td.text,
    alignment,
    autoResize,
    width: resizeW,
    height: resizeH,
    ranges,
    gradientOverlay,
    rotation: td.rotation,
    position: { x: layer.x, y: layer.y },
    shapeType: td.shapeType,
    docBoundsY: td.docBoundsY,
    docBboxCenterX: td.docBboxCenterX,
    txOffsetX: td.txOffsetX,
    bounds: td.bounds,
    boundingBox: td.boundingBox,
    textIndex: td.textIndex,
    transformScale: td.transformScale,
    transformScaleX: td.transformScaleX,
    transformTx: td.transformTx,
    transformTy: td.transformTy,
  };
}

function buildLayerNode(
  layer: SerializedLayer,
  images: string[],
  depth: number
): IRNode {
  const blendMode = normalizeBlendMode(layer.blendMode);

  switch (layer.type) {
    case 'group':
      return buildGroupNode(layer, images, depth);
    case 'text':
      return buildTextNode(layer, images, depth);
    default:
      return buildShapeNode(layer, images, depth);
  }
}

function buildGroupNode(
  layer: SerializedLayer,
  images: string[],
  depth: number
): IRNode {
  const w = layer.isSubGroup ? layer.width : Math.max(1, layer.width);
  const h = layer.isSubGroup ? layer.height : Math.max(1, layer.height);
  const fills = buildImageFill(images, layer.imageIndex);

  const children = layer.children
    ? buildChildrenWithClipping(layer.children, images, depth + 1)
    : undefined;

  const clipsContent = !layer.isSubGroup;

  return {
    type: 'frame',
    name: layer.name,
    x: layer.x,
    y: layer.y,
    width: w,
    height: h,
    opacity: layer.opacity,
    blendMode: normalizeBlendMode(layer.blendMode),
    visible: layer.visible,
    clipsContent,
    fills,
    effects: convertEffects(layer.effects),
    strokes: convertStrokes(layer.strokes),
    cornerRadii: convertCornerRadii(layer.cornerRadii),
    children,
    rawPsdEffects: layer.rawEffectsData,
  };
}

function buildTextNode(
  layer: SerializedLayer,
  _images: string[],
  _depth: number
): IRNode {
  const textProps = buildTextProps(layer);
  const irStrokes = convertStrokes(layer.strokes);
  const irEffects = convertEffects(layer.effects);
  return {
    type: 'text',
    name: layer.name,
    x: layer.x,
    y: layer.y,
    width: Math.max(1, layer.width),
    height: Math.max(1, layer.height),
    opacity: layer.opacity,
    blendMode: normalizeBlendMode(layer.blendMode),
    visible: layer.visible,
    clipsContent: false,
    fills: [],
    effects: irEffects,
    strokes: irStrokes,
    textProps,
    rawPsdEffects: layer.rawEffectsData,
  };
}

function buildShapeNode(
  layer: SerializedLayer,
  images: string[],
  _depth: number
): IRNode {
  const expand = layer.expandOffset ?? 0;
  const w = layer.isSubGroup ? layer.width : Math.max(1, layer.width);
  const h = layer.isSubGroup ? layer.height : Math.max(1, layer.height);
  const rectW = Math.max(1, w + expand * 2);
  const rectH = Math.max(1, h + expand * 2);
  const fills = buildImageFill(images, layer.imageIndex);

  return {
    type: 'rectangle',
    name: layer.name,
    x: layer.x - expand,
    y: layer.y - expand,
    width: rectW,
    height: rectH,
    opacity: layer.opacity,
    blendMode: normalizeBlendMode(layer.blendMode),
    visible: layer.visible,
    clipsContent: false,
    fills,
    effects: convertEffects(layer.effects),
    strokes: convertStrokes(layer.strokes),
    cornerRadii: convertCornerRadii(layer.cornerRadii),
    rawPsdEffects: layer.rawEffectsData,
    psdExpandOffset: expand > 0 ? expand : undefined,
    rawPsdVectorData: layer.rawVectorData,
    rawPsdAdjustments: layer.rawPsdAdjustments,
    rawPsdOriginalImage: layer.rawPsdOriginalImage,
  };
}

function buildChildrenWithClipping(
  children: SerializedLayer[],
  images: string[],
  depth: number
): IRNode[] {
  const result: IRNode[] = [];
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
      const baseNode = buildLayerNode(child, images, depth);
      const clipChildren: IRNode[] = [baseNode];

      const baseExpand = child.expandOffset ?? 0;
      for (const clippedLayer of clippedLayers) {
        const clippedNode = buildLayerNode(clippedLayer, images, depth);
        clippedNode.x = clippedLayer.x - child.x + baseExpand;
        clippedNode.y = clippedLayer.y - child.y + baseExpand;
        clipChildren.push(clippedNode);
      }

      const clipFrame: IRNode = {
        type: 'frame',
        name: child.name + ' (clip group)',
        x: baseNode.x,
        y: baseNode.y,
        width: baseNode.width,
        height: baseNode.height,
        opacity: 1,
        blendMode: 'PASS_THROUGH',
        visible: true,
        clipsContent: true,
        fills: [],
        effects: [],
        strokes: [],
        cornerRadii: baseNode.cornerRadii,
        children: clipChildren,
      };

      // Base node position is relative to clip frame
      clipChildren[0] = { ...baseNode, x: 0, y: 0 };

      result.push(clipFrame);
      i = j;
    } else {
      result.push(buildLayerNode(child, images, depth));
      i++;
    }
  }

  return result;
}

export function buildIRTree(psd: SerializedPsd): IRNode {
  const children = buildChildrenWithClipping(psd.layers, psd.images, 1);

  const rootFrame: IRNode = {
    type: 'frame',
    name: 'Frame',
    x: 0,
    y: 0,
    width: psd.width,
    height: psd.height,
    opacity: 1,
    blendMode: 'NORMAL',
    visible: true,
    clipsContent: true,
    fills: [],
    effects: [],
    strokes: [],
    children,
    isRootFrame: true,
  };

  const section: IRNode = {
    type: 'section',
    name: psd.name || 'PSD Import',
    x: 0,
    y: 0,
    width: psd.width,
    height: psd.height,
    opacity: 1,
    blendMode: 'NORMAL',
    visible: true,
    clipsContent: false,
    fills: [],
    effects: [],
    strokes: [],
    children: [rootFrame],
    psdEngineData: psd.engineData,
  };

  return section;
}

export function countIRNodes(node: IRNode): number {
  let count = 1;
  if (node.children) {
    for (const child of node.children) {
      count += countIRNodes(child);
    }
  }
  return count;
}
