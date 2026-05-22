import { writePsd } from 'ag-psd';
import type { Psd, Layer, BlendMode, LayerEffectShadow, LayerEffectSolidFill, LayerEffectGradientOverlay, LayerEffectStroke, ColorStop, OpacityStop } from 'ag-psd';
import type { ExportNodeData, ExportFillInfo, SerializedColor } from '../types/psd-types';

const BLEND_MODE_MAP: Record<string, BlendMode> = {
  'PASS_THROUGH': 'pass through',
  'NORMAL': 'normal',
  'DARKEN': 'darken',
  'MULTIPLY': 'multiply',
  'COLOR_BURN': 'color burn',
  'LINEAR_BURN': 'linear burn',
  'LIGHTEN': 'lighten',
  'SCREEN': 'screen',
  'COLOR_DODGE': 'color dodge',
  'LINEAR_DODGE': 'linear dodge',
  'OVERLAY': 'overlay',
  'SOFT_LIGHT': 'soft light',
  'HARD_LIGHT': 'hard light',
  'DIFFERENCE': 'difference',
  'EXCLUSION': 'exclusion',
  'HUE': 'hue',
  'SATURATION': 'saturation',
  'COLOR': 'color',
  'LUMINOSITY': 'luminosity',
};

function toBlendMode(mode: string): BlendMode {
  return BLEND_MODE_MAP[mode] ?? 'normal';
}

function toRGBA(c: SerializedColor): { r: number; g: number; b: number; a: number } {
  return {
    r: Math.round(c.r * 255),
    g: Math.round(c.g * 255),
    b: Math.round(c.b * 255),
    a: Math.round(c.a * 255),
  };
}

function toPostScriptName(family: string, style: string): string {
  const cleanFamily = family.replace(/\s+/g, '');
  if (!style || style === 'Regular') return cleanFamily;
  const cleanStyle = style.replace(/\s+/g, '');
  return `${cleanFamily}-${cleanStyle}`;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function pngToCanvas(pngBytes: Uint8Array): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([pngBytes as BlobPart], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode PNG'));
    };
    img.src = url;
  });
}

/**
 * Trims transparent pixels from canvas edges and returns the cropped canvas.
 * Used for text layer bitmaps so ag-psd's internal trim doesn't shift our layer.top/left.
 */
function trimCanvasTransparent(srcCanvas: HTMLCanvasElement): { canvas: HTMLCanvasElement } {
  const ctx = srcCanvas.getContext('2d')!;
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let top = 0, left = 0, right = w, bottom = h;
  outer1: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] !== 0) { top = y; break outer1; }
    }
  }
  outer2: for (let y = h - 1; y >= top; y--) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] !== 0) { bottom = y + 1; break outer2; }
    }
  }
  outer3: for (let x = 0; x < w; x++) {
    for (let y = top; y < bottom; y++) {
      if (data[(y * w + x) * 4 + 3] !== 0) { left = x; break outer3; }
    }
  }
  outer4: for (let x = w - 1; x >= left; x--) {
    for (let y = top; y < bottom; y++) {
      if (data[(y * w + x) * 4 + 3] !== 0) { right = x + 1; break outer4; }
    }
  }
  const newW = right - left;
  const newH = bottom - top;
  if (newW <= 0 || newH <= 0 || (newW === w && newH === h)) {
    return { canvas: srcCanvas };
  }
  const out = document.createElement('canvas');
  out.width = newW;
  out.height = newH;
  out.getContext('2d')!.drawImage(srcCanvas, -left, -top);
  return { canvas: out };
}

function buildEffects(node: ExportNodeData): {
  dropShadow?: LayerEffectShadow[];
  innerShadow?: LayerEffectShadow[];
  solidFill?: LayerEffectSolidFill[];
  gradientOverlay?: LayerEffectGradientOverlay[];
  stroke?: LayerEffectStroke[];
} | undefined {
  const hasEffects = node.effects.length > 0 || node.fills.length > 0 || node.strokes.length > 0;
  if (!hasEffects) return undefined;

  const result: NonNullable<ReturnType<typeof buildEffects>> = {};

  const drops = node.effects.filter(e => e.type === 'DROP_SHADOW' && e.visible);
  if (drops.length > 0) {
    result.dropShadow = drops.map(e => ({
      enabled: true,
      color: toRGBA(e.color),
      opacity: e.color.a,
      angle: Math.round(Math.atan2(-e.offsetY, e.offsetX) * (180 / Math.PI)),
      distance: { units: 'Pixels' as const, value: Math.round(Math.sqrt(e.offsetX ** 2 + e.offsetY ** 2)) },
      size: { units: 'Pixels' as const, value: Math.round(e.blur) },
      choke: { units: 'Pixels' as const, value: Math.round(e.spread) },
      blendMode: 'multiply' as BlendMode,
    }));
  }

  const inners = node.effects.filter(e => e.type === 'INNER_SHADOW' && e.visible);
  if (inners.length > 0) {
    result.innerShadow = inners.map(e => ({
      enabled: true,
      color: toRGBA(e.color),
      opacity: e.color.a,
      angle: Math.round(Math.atan2(-e.offsetY, e.offsetX) * (180 / Math.PI)),
      distance: { units: 'Pixels' as const, value: Math.round(Math.sqrt(e.offsetX ** 2 + e.offsetY ** 2)) },
      size: { units: 'Pixels' as const, value: Math.round(e.blur) },
      choke: { units: 'Pixels' as const, value: Math.round(e.spread) },
      blendMode: 'multiply' as BlendMode,
    }));
  }

  const solidFills = node.fills.filter(f => f.type === 'SOLID' && f.visible && f.color);
  if (solidFills.length > 0 && node.type !== 'text') {
    result.solidFill = solidFills.map(f => ({
      enabled: true,
      color: toRGBA(f.color!),
      opacity: f.opacity ?? 1,
      blendMode: 'normal' as BlendMode,
    }));
  }

  const gradients = node.fills.filter(f => f.type.startsWith('GRADIENT_') && f.visible);
  if (gradients.length > 0) {
    result.gradientOverlay = gradients.map(f => {
      const stops = f.gradientStops ?? [];
      const colorStops: ColorStop[] = stops.map(s => ({
        color: toRGBA(s.color),
        location: Math.round(s.position * 4096),
        midpoint: 50,
      }));
      const opacityStops: OpacityStop[] = stops.map(s => ({
        opacity: s.color.a,
        location: Math.round(s.position * 4096),
        midpoint: 50,
      }));

      let gradType: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond' = 'linear';
      if (f.type === 'GRADIENT_RADIAL') gradType = 'radial';
      else if (f.type === 'GRADIENT_ANGULAR') gradType = 'angle';
      else if (f.type === 'GRADIENT_DIAMOND') gradType = 'diamond';

      return {
        enabled: true,
        blendMode: 'normal',
        opacity: f.opacity ?? 1,
        type: gradType,
        angle: f.gradientAngle ?? 90,
        gradient: {
          name: 'Custom',
          type: 'solid' as const,
          colorStops,
          opacityStops,
        },
      };
    });
  }

  const visibleStrokes = node.strokes.filter(s => s.visible);
  if (visibleStrokes.length > 0) {
    result.stroke = visibleStrokes.map(s => ({
      enabled: true,
      size: { units: 'Pixels' as const, value: s.weight },
      position: s.align.toLowerCase() as 'inside' | 'center' | 'outside',
      fillType: 'color' as const,
      color: toRGBA(s.color),
      opacity: s.opacity,
      blendMode: 'normal' as BlendMode,
    }));
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

async function buildLayer(node: ExportNodeData): Promise<Layer> {
  let layerTop = Math.round(node.y);
  let layerLeft = Math.round(node.x);
  let layerBottom = Math.round(node.y + node.height);
  let layerRight = Math.round(node.x + node.width);

  // For text layers, set layer bbox to match PSD A's character pixel range
  // (= transform + boundingBox), so PS sees correct boundaries.
  const tiForBbox = node.textInfo;
  const bboxForLayer = tiForBbox?.boundingBox;
  if (tiForBbox && tiForBbox.characters && bboxForLayer) {
    const firstStyle = tiForBbox.styles[0];
    const fontSize = firstStyle?.fontSize ?? 16;
    const isPointText = tiForBbox.textAutoResize === 'WIDTH_AND_HEIGHT';

    if (isPointText) {
      const centerX = node.x + node.width / 2;
      const tx = centerX + (tiForBbox.txOffsetX ?? 0);
      const ty = node.y + fontSize * 0.857;
      layerTop = Math.round(ty + bboxForLayer.top);
      layerBottom = Math.round(ty + bboxForLayer.bottom);
      layerLeft = Math.round(tx + bboxForLayer.left);
      layerRight = Math.round(tx + bboxForLayer.right);
    } else {
      const ty = node.y - (tiForBbox.bounds?.top ?? -fontSize * 0.097);
      layerTop = Math.round(ty + bboxForLayer.top);
      layerBottom = Math.round(ty + bboxForLayer.bottom);
      layerLeft = Math.round(node.x + bboxForLayer.left);
      layerRight = Math.round(node.x + bboxForLayer.right);
    }
  }

  const layer: Layer = {
    name: node.name,
    top: layerTop,
    left: layerLeft,
    bottom: layerBottom,
    right: layerRight,
    blendMode: toBlendMode(node.blendMode),
    opacity: node.opacity,
    hidden: !node.visible,
    clipping: node.isMask,
  };

  const effects = buildEffects(node);
  if (effects) {
    layer.effects = effects;
  }

  const isTextLayer = !!(node.textInfo && node.textInfo.characters);
  if (node.imageBase64) {
    try {
      const pngBytes = base64ToUint8Array(node.imageBase64);
      const rawCanvas = await pngToCanvas(pngBytes);
      if (isTextLayer) {
        // Pre-trim transparent edges so ag-psd's internal trim doesn't shift our layer.top/left.
        layer.canvas = trimCanvasTransparent(rawCanvas).canvas;
      } else {
        layer.canvas = rawCanvas;
      }
    } catch { /* leave without image data */ }
  }

  if (node.textInfo && node.textInfo.characters) {
    const ti = node.textInfo;
    const firstStyle = ti.styles.length > 0 ? ti.styles[0] : null;

    const justificationMap: Record<string, string> = {
      'LEFT': 'left',
      'CENTER': 'center',
      'RIGHT': 'right',
      'JUSTIFIED': 'justify-all',
    };

    const isPointText = ti.textAutoResize === 'WIDTH_AND_HEIGHT';
    const fontSize = firstStyle?.fontSize ?? 16;

    const centerX = node.x + node.width / 2;
    const centerY = node.y + node.height / 2;

    const hasExplicitLeading = firstStyle?.lineHeight != null && firstStyle.lineHeight > 0;
    const baseStyle = firstStyle ? {
      font: { name: toPostScriptName(firstStyle.fontFamily, firstStyle.fontStyle) },
      fontSize: firstStyle.fontSize,
      fauxBold: firstStyle.fontStyle === 'Bold' || firstStyle.fontStyle === 'Bold Italic',
      fauxItalic: firstStyle.fontStyle === 'Italic' || firstStyle.fontStyle === 'Bold Italic',
      autoLeading: !hasExplicitLeading,
      leading: hasExplicitLeading ? firstStyle.lineHeight! : 0,
      horizontalScale: 1,
      verticalScale: 1,
      tracking: firstStyle.fontSize > 0 ? Math.round((firstStyle.letterSpacing / firstStyle.fontSize) * 1000) : 0,
      autoKerning: true,
      kerning: 0,
      baselineShift: 0,
      fontCaps: 0,
      fontBaseline: 0,
      underline: false,
      strikethrough: false,
      ligatures: true,
      dLigatures: false,
      language: 0,
      fillColor: toRGBA(firstStyle.color),
      yUnderline: 1,
      hindiNumbers: false,
      kashida: 1,
      diacriticPos: 2,
    } : undefined;

    const fullParagraphStyle = {
      justification: (justificationMap[ti.alignment] ?? 'left') as any,
      firstLineIndent: 0,
      startIndent: 0,
      endIndent: 0,
      spaceBefore: 0,
      spaceAfter: 0,
      autoHyphenate: false,
      hyphenatedWordSize: 6,
      preHyphen: 2,
      postHyphen: 2,
      consecutiveHyphens: 8,
      zone: 36,
      wordSpacing: [0.8, 1, 1.33] as [number, number, number],
      letterSpacing: [0, 0, 0] as [number, number, number],
      glyphSpacing: [1, 1, 1] as [number, number, number],
      autoLeading: 1.2,
      leadingType: 0,
      hanging: false,
      burasagari: false,
      kinsokuOrder: 0,
      everyLineComposer: false,
    };

    if (isPointText) {
      const ascent = fontSize * 0.857;
      const ty = node.y + ascent;
      const halfW = node.width / 2;
      const txAdjusted = centerX + (ti.txOffsetX ?? 0);

      const boundsTop = ti.bounds?.top ?? -fontSize * 0.857;
      const boundsBottom = ti.bounds?.bottom ?? fontSize * 0.514;
      const boundsLeft = ti.bounds?.left ?? -halfW;
      const boundsRight = ti.bounds?.right ?? halfW;
      const bboxTop = ti.boundingBox?.top ?? -fontSize * 0.776;
      const bboxBottom = ti.boundingBox?.bottom ?? fontSize * 0.240;
      const bboxLeft = ti.boundingBox?.left ?? -halfW;
      const bboxRight = ti.boundingBox?.right ?? halfW;

      layer.text = {
        text: ti.characters,
        transform: [1, 0, 0, 1, txAdjusted, ty],
        orientation: 'horizontal',
        antiAlias: 'sharp',
        gridding: 'none',
        shapeType: 'point',
        pointBase: [0, 0],
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        bounds: {
          top: { units: 'Points' as any, value: boundsTop },
          left: { units: 'Points' as any, value: boundsLeft },
          right: { units: 'Points' as any, value: boundsRight },
          bottom: { units: 'Points' as any, value: boundsBottom },
        },
        boundingBox: {
          top: { units: 'Points' as any, value: bboxTop },
          left: { units: 'Points' as any, value: bboxLeft },
          right: { units: 'Points' as any, value: bboxRight },
          bottom: { units: 'Points' as any, value: bboxBottom },
        },
        style: baseStyle,
        paragraphStyle: fullParagraphStyle,
      };
    } else {
      const boxBoundsTop = ti.bounds?.top ?? -fontSize * 0.097;
      const ty = node.y - boxBoundsTop;
      const boundsBottom = ti.bounds?.bottom ?? node.height;
      const boundsLeft = ti.bounds?.left ?? 0;
      const boundsRight = ti.bounds?.right ?? node.width;
      const bboxTop = ti.boundingBox?.top ?? -fontSize * 0.016;
      const bboxBottom = ti.boundingBox?.bottom ?? fontSize * 1.97;
      const bboxLeft = ti.boundingBox?.left ?? 0;
      const bboxRight = ti.boundingBox?.right ?? node.width;
      layer.text = {
        text: ti.characters,
        transform: [1, 0, 0, 1, node.x, ty],
        orientation: 'horizontal',
        antiAlias: 'sharp',
        left: node.x,
        top: ty,
        right: node.x + node.width,
        bottom: ty + node.height,
        gridding: 'none',
        shapeType: 'box',
        boxBounds: [0, 0, node.width, node.height],
        bounds: {
          top: { units: 'Points' as any, value: boxBoundsTop },
          left: { units: 'Points' as any, value: boundsLeft },
          right: { units: 'Points' as any, value: boundsRight },
          bottom: { units: 'Points' as any, value: boundsBottom },
        },
        boundingBox: {
          top: { units: 'Points' as any, value: bboxTop },
          left: { units: 'Points' as any, value: bboxLeft },
          right: { units: 'Points' as any, value: bboxRight },
          bottom: { units: 'Points' as any, value: bboxBottom },
        },
        style: baseStyle,
        paragraphStyle: fullParagraphStyle,
      };
    }

    if (ti.textIndex != null) {
      layer.text.index = ti.textIndex;
    }

    if (ti.styles.length > 1) {
      layer.text.styleRuns = ti.styles.map(s => {
        const sHasLeading = s.lineHeight != null && s.lineHeight > 0;
        return {
          length: s.end - s.start,
          style: {
            font: { name: toPostScriptName(s.fontFamily, s.fontStyle) },
            fontSize: s.fontSize,
            fillColor: toRGBA(s.color),
            tracking: s.fontSize > 0 ? Math.round((s.letterSpacing / s.fontSize) * 1000) : 0,
            leading: sHasLeading ? s.lineHeight! : 0,
            autoLeading: !sHasLeading,
            autoKerning: true,
            fauxBold: s.fontStyle === 'Bold' || s.fontStyle === 'Bold Italic',
            fauxItalic: s.fontStyle === 'Italic' || s.fontStyle === 'Bold Italic',
          },
        };
      });
    }

  }

  if (node.isInstance && node.imageBase64) {
    const id = `smart-${node.id}`;
    layer.placedLayer = {
      id,
      type: 'raster',
      transform: [
        node.x, node.y,
        node.x + node.width, node.y,
        node.x + node.width, node.y + node.height,
        node.x, node.y + node.height,
      ],
      width: node.width,
      height: node.height,
    };
  }

  if (node.children && node.children.length > 0) {
    layer.children = [];
    for (const child of node.children) {
      layer.children.push(await buildLayer(child));
    }
    layer.opened = true;

    if (node.width < 1 || node.height < 1) {
      let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
      for (const ch of layer.children) {
        if (ch.left !== undefined && ch.left < cMinX) cMinX = ch.left;
        if (ch.top !== undefined && ch.top < cMinY) cMinY = ch.top;
        if (ch.right !== undefined && ch.right > cMaxX) cMaxX = ch.right;
        if (ch.bottom !== undefined && ch.bottom > cMaxY) cMaxY = ch.bottom;
      }
      if (cMinX < Infinity) {
        layer.left = cMinX;
        layer.top = cMinY;
        layer.right = cMaxX;
        layer.bottom = cMaxY;
      }
    }
  }

  return layer;
}

export async function buildAndDownloadPsd(
  nodes: ExportNodeData[],
  width: number,
  height: number,
  fileName: string,
  onProgress: (percent: number, message: string) => void,
  engineData?: string,
): Promise<void> {
  onProgress(65, '构建 PSD 图层结构...');

  const children: Layer[] = [];
  for (let i = 0; i < nodes.length; i++) {
    onProgress(
      65 + Math.round(((i + 1) / nodes.length) * 20),
      `构建图层 ${i + 1}/${nodes.length}: ${nodes[i].name}`,
    );
    children.push(await buildLayer(nodes[i]));
  }

  onProgress(88, '生成 PSD 文件...');

  const psd: Psd = {
    width,
    height,
    children,
  };

  // Preserve the original PSD's engineData (Txt2 block, base64) so PS can correctly associate
  // each text layer (via text.index) with the global TextFrameSet and render with correct font sizes.
  if (engineData) {
    psd.engineData = engineData;
  }

  const arrayBuffer = writePsd(psd, {
    generateThumbnail: true,
    trimImageData: true,
  });

  onProgress(95, '准备下载...');

  const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.psd') ? fileName : `${fileName}.psd`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 5000);

  onProgress(100, '导出完成！');
}
