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
    const blob = new Blob([pngBytes], { type: 'image/png' });
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
  const layer: Layer = {
    name: node.name,
    top: Math.round(node.y),
    left: Math.round(node.x),
    bottom: Math.round(node.y + node.height),
    right: Math.round(node.x + node.width),
    blendMode: toBlendMode(node.blendMode),
    opacity: node.opacity,
    hidden: !node.visible,
    clipping: node.isMask,
  };

  const effects = buildEffects(node);
  if (effects) {
    layer.effects = effects;
  }

  if (node.imageBase64) {
    try {
      const pngBytes = base64ToUint8Array(node.imageBase64);
      layer.canvas = await pngToCanvas(pngBytes);
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

    const baselineFix = (firstStyle?.fontSize ?? 16) * 0.143;
    layer.text = {
      text: ti.characters,
      transform: [1, 0, 0, 1, node.x, node.y + baselineFix],
      orientation: 'horizontal',
      antiAlias: 'smooth',
      left: node.x,
      top: node.y + baselineFix,
      right: node.x + node.width,
      bottom: node.y + node.height + baselineFix,
      gridding: 'none',
      shapeType: 'box',
      boxBounds: [0, 0, node.width, node.height],
      style: firstStyle ? {
        font: { name: toPostScriptName(firstStyle.fontFamily, firstStyle.fontStyle) },
        fontSize: firstStyle.fontSize,
        fillColor: toRGBA(firstStyle.color),
        tracking: Math.round((firstStyle.letterSpacing / firstStyle.fontSize) * 1000),
        leading: firstStyle.lineHeight ?? undefined,
        autoKerning: true,
      } : undefined,
      paragraphStyle: {
        justification: (justificationMap[ti.alignment] ?? 'left') as any,
      },
    };

    if (ti.styles.length > 1) {
      layer.text.styleRuns = ti.styles.map(s => ({
        length: s.end - s.start,
        style: {
          font: { name: toPostScriptName(s.fontFamily, s.fontStyle) },
          fontSize: s.fontSize,
          fillColor: toRGBA(s.color),
          tracking: s.fontSize > 0 ? Math.round((s.letterSpacing / s.fontSize) * 1000) : 0,
          leading: s.lineHeight ?? undefined,
          autoKerning: true,
          fauxBold: s.fontStyle === 'Bold' || s.fontStyle === 'Bold Italic',
          fauxItalic: s.fontStyle === 'Italic' || s.fontStyle === 'Bold Italic',
        },
      }));
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

  const arrayBuffer = writePsd(psd, {
    generateThumbnail: true,
    trimImageData: true,
    invalidateTextLayers: true,
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
