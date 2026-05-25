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

/**
 * 还原 plugin data 中 base64 编码的 Uint8Array 字段。
 * 配合 `__binBase64` 写入端约定使用。
 */
function decodeBinBase64Fields(obj: any): any {
  return JSON.parse(JSON.stringify(obj), (_k, v) => {
    if (v && typeof v === 'object' && typeof v.__binBase64 === 'string') {
      try {
        const bin = atob(v.__binBase64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      } catch { return v; }
    }
    return v;
  });
}

/**
 * 还原 PSD 解析时存到 figma/mastergo plugin data 的原始 `layer.effects`。
 * 配合 `serializeRawPsdEffects` 写入端使用：
 *   - `Uint8Array` 字段在写入时被替换成 `{ __binBase64: '...' }`，这里反向解码;
 *   - `fillOpacity` 与 `effects` 分别还原。
 */
function decodeRawPsdEffects(raw: string): { effects: any; fillOpacity?: number } | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const effects = decodeBinBase64Fields(parsed.effects ?? {});
    return { effects, fillOpacity: typeof parsed.fillOpacity === 'number' ? parsed.fillOpacity : undefined };
  } catch { return null; }
}

/**
 * 还原 PSD 矢量形状数据（vectorMask/vectorFill/vectorOrigination）。
 * 配合 `serializeRawVectorData` 写入端使用。
 */
function decodeRawPsdVectorData(raw: string): { vectorMask?: any; vectorFill?: any; vectorOrigination?: any } | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return decodeBinBase64Fields(parsed);
  } catch { return null; }
}

function buildEffects(node: ExportNodeData): {
  dropShadow?: LayerEffectShadow[];
  innerShadow?: LayerEffectShadow[];
  solidFill?: LayerEffectSolidFill[];
  gradientOverlay?: LayerEffectGradientOverlay[];
  stroke?: LayerEffectStroke[];
  bevel?: any;
  satin?: any;
  outerGlow?: any;
  innerGlow?: any;
  patternOverlay?: any;
} | undefined {
  // 优先使用 PSD 解析时保留的原始 effects 数据作为底子，
  // figma/mastergo 上提取到的字段（如用户编辑过的 stroke/fill/shadow）覆盖在上面（override-fallback 策略）。
  const rawDecoded = node.rawPsdEffects ? decodeRawPsdEffects(node.rawPsdEffects) : null;
  const rawEffects = rawDecoded?.effects ?? null;

  const hasEffects = node.effects.length > 0 || node.fills.length > 0 || node.strokes.length > 0 || !!rawEffects;
  if (!hasEffects) return undefined;

  // 以原始 effects 为底子（深拷贝避免 mutate），然后用 figma/mastergo 提取到的覆盖
  const result: NonNullable<ReturnType<typeof buildEffects>> = rawEffects ? JSON.parse(JSON.stringify(rawEffects, (_k, v) => {
    if (v && typeof v === 'object' && typeof v.__binBase64 === 'string') return v; // 留待下游解码（这里只是序列化深拷贝）
    return v;
  })) : {};
  // 把刚才反向解码出来的 Uint8Array 重新写回 result（深拷贝时被字符串化的 pattern data）
  if (rawEffects) {
    const restoreBinFields = (src: any, dst: any) => {
      if (!src || !dst || typeof src !== 'object') return;
      if (Array.isArray(src) && Array.isArray(dst)) {
        for (let i = 0; i < src.length; i++) restoreBinFields(src[i], dst[i]);
        return;
      }
      for (const k of Object.keys(src)) {
        if (src[k] instanceof Uint8Array || src[k] instanceof Uint8ClampedArray) {
          dst[k] = src[k];
        } else if (src[k] && typeof src[k] === 'object') {
          restoreBinFields(src[k], dst[k]);
        }
      }
    };
    restoreBinFields(rawEffects, result);
  }

  // 容器节点（group/frame）和文本节点：原始 PSD effects 包含 contour/antialiased/layerConceals 等
  // 高级字段，figma/mastergo 节点只能复制简化版 (color/offset/blur/spread)。
  // 如果用 figma 简化版覆盖，PS 读到 contour=空 等不合法字段会报 "settings invalid"。
  // 此外文本层的 effects 含 11 个字段（含 disabled 配置），完整保留可能影响 PS 渲染。
  const isContainerNode = !!(node.children && node.children.length > 0);
  const isTextWithRaw = node.type === 'text' && !!rawEffects;
  if ((isContainerNode || isTextWithRaw) && rawEffects) {
    return Object.keys(result).length > 0 ? result : undefined;
  }

  // figma/mastergo 上能提取到的字段优先覆盖（用户在设计工具上的编辑生效）。
  // 这些字段未被提取到时（即 figma/mastergo 上空），保留原始数据（如果有）。
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
    // PSD 原始 transform sy。boundingBox/bounds 的 value 是 unscaled font-space 值，
    // 需要乘以 sy 才是文档坐标下的偏移；导入时 fontSize 已被乘以 sy（即视觉字号）。
    const sy = tiForBbox.transformScale != null && Number.isFinite(tiForBbox.transformScale) && tiForBbox.transformScale > 0
      ? tiForBbox.transformScale : 1;

    // sx 用于水平字符位置（与 sy 可不同），sy 用于垂直
    const sx = tiForBbox.transformScaleX != null && Number.isFinite(tiForBbox.transformScaleX) && tiForBbox.transformScaleX > 0
      ? tiForBbox.transformScaleX : sy;

    // 计算 effective ty/tx：优先用 anchor+delta（精确还原 PSD），否则 fallback 用 node.y + ascent
    // 必须与下面 layer.text.transform 计算用同一份 ty/tx，否则 layer.bbox 与字符渲染位置不一致
    let effTy: number;
    let effTxBase: number;
    if (tiForBbox.transformTy != null && Number.isFinite(tiForBbox.transformTy) && tiForBbox.anchorNodeY != null && Number.isFinite(tiForBbox.anchorNodeY)) {
      effTy = tiForBbox.transformTy + (node.y - tiForBbox.anchorNodeY);
    } else {
      const ascentForBbox = tiForBbox.bounds?.top != null && Number.isFinite(tiForBbox.bounds.top)
        ? -tiForBbox.bounds.top * sy
        : fontSize * 0.857;
      effTy = node.y + ascentForBbox;
    }
    if (tiForBbox.transformTx != null && Number.isFinite(tiForBbox.transformTx) && tiForBbox.anchorNodeX != null && Number.isFinite(tiForBbox.anchorNodeX)) {
      effTxBase = tiForBbox.transformTx + (node.x - tiForBbox.anchorNodeX);
    } else {
      const centerX = node.x + node.width / 2;
      effTxBase = centerX + (tiForBbox.txOffsetX ?? 0);
    }

    // PSD layer.bbox 标准：包含整个字符像素覆盖区。top/left 用 floor、right/bottom 用 ceil
    // 把浮点值整数化到包含原始浮点范围的最小整数 bbox（与原始 PSD 行为一致）。
    if (isPointText) {
      layerTop = Math.floor(effTy + bboxForLayer.top * sy);
      layerBottom = Math.ceil(effTy + bboxForLayer.bottom * sy);
      layerLeft = Math.floor(effTxBase + bboxForLayer.left * sx);
      layerRight = Math.ceil(effTxBase + bboxForLayer.right * sx);
    } else {
      // box text: 用 bounds.top 算 ty (与原代码一致)
      const ty = node.y - (tiForBbox.bounds?.top ?? -fontSize * 0.097) * sy;
      layerTop = Math.floor(ty + bboxForLayer.top * sy);
      layerBottom = Math.ceil(ty + bboxForLayer.bottom * sy);
      layerLeft = Math.floor(node.x + bboxForLayer.left * sx);
      layerRight = Math.ceil(node.x + bboxForLayer.right * sx);
    }
  }

  // pass through 只在 group 上有效，应用到叶子节点会让 PS 报 "unsupported blending mode"
  let effectiveBlendMode = node.blendMode;
  const isGroupForBM = !!(node.children && node.children.length > 0);
  if (effectiveBlendMode === 'PASS_THROUGH' && !isGroupForBM) {
    effectiveBlendMode = 'NORMAL';
  }

  const layer: Layer = {
    name: node.name,
    top: layerTop,
    left: layerLeft,
    bottom: layerBottom,
    right: layerRight,
    blendMode: toBlendMode(effectiveBlendMode),
    opacity: node.opacity,
    hidden: !node.visible,
    clipping: node.isMask,
  };

  const effects = buildEffects(node);
  if (effects) {
    layer.effects = effects;
  }

  // 还原原始 PSD 的 fillOpacity（figma/mastergo 无对应概念，必须从元数据取）
  if (node.rawPsdEffects) {
    const rawDecoded = decodeRawPsdEffects(node.rawPsdEffects);
    if (rawDecoded?.fillOpacity != null && Number.isFinite(rawDecoded.fillOpacity) && rawDecoded.fillOpacity < 1) {
      (layer as any).fillOpacity = rawDecoded.fillOpacity;
    }
  }

  // 还原 PSD 矢量形状数据（vectorMask/vectorFill/vectorOrigination），
  // 让 PS appearance 面板显示 Fill/Stroke/圆角/精确坐标等矢量属性
  if (node.rawPsdVectorData) {
    const vectorData = decodeRawPsdVectorData(node.rawPsdVectorData);
    if (vectorData) {
      if (vectorData.vectorMask) (layer as any).vectorMask = vectorData.vectorMask;
      if (vectorData.vectorFill) (layer as any).vectorFill = vectorData.vectorFill;
      if (vectorData.vectorOrigination) (layer as any).vectorOrigination = vectorData.vectorOrigination;
    }
  }

  const isTextLayer = !!(node.textInfo && node.textInfo.characters);
  if (node.imageBase64) {
    try {
      const pngBytes = base64ToUint8Array(node.imageBase64);
      const rawCanvas = await pngToCanvas(pngBytes);
      if (isTextLayer) {
        // ag-psd 写 PSD 时用 canvas.width/height 重写 layer.right/bottom（忽略我们设的值）。
        // 我们已根据 transform + boundingBox 算出准确的 layerLeft/Top/Right/Bottom（floor/ceil），
        // 这里需要让 canvas 尺寸 = intendedW × intendedH，让 ag-psd 写出的 right/bottom 与我们设的一致。
        // 策略：trim 字符像素 → 创建 intended 尺寸的新 canvas → 把字符像素 padding 到中心对应位置。
        const intendedW = Math.max(1, layerRight - layerLeft);
        const intendedH = Math.max(1, layerBottom - layerTop);
        const trimmed = trimCanvasTransparent(rawCanvas).canvas;
        if (trimmed.width === intendedW && trimmed.height === intendedH) {
          layer.canvas = trimmed;
        } else {
          // 居中放置 trimmed 字符像素到 intended 尺寸 canvas
          const padded = document.createElement('canvas');
          padded.width = intendedW;
          padded.height = intendedH;
          const pctx = padded.getContext('2d')!;
          const offsetX = Math.max(0, Math.floor((intendedW - trimmed.width) / 2));
          const offsetY = Math.max(0, Math.floor((intendedH - trimmed.height) / 2));
          pctx.drawImage(trimmed, offsetX, offsetY);
          layer.canvas = padded;
        }
      } else if (node.psdExpandOffset != null && node.psdExpandOffset > 0) {
        // Import 时为容纳 stroke 像素把位图扩展了 psdExpandOffset 像素，
        // 这里裁剪掉外围 expand 边框，让 canvas 尺寸与 PSD 原始 layer bbox 一致
        // （否则 ag-psd 用 canvas.width/height 重写 layer.right/bottom，导致 bg 大 20x20）。
        const exp = node.psdExpandOffset;
        const innerW = Math.max(1, rawCanvas.width - exp * 2);
        const innerH = Math.max(1, rawCanvas.height - exp * 2);
        const cropped = document.createElement('canvas');
        cropped.width = innerW;
        cropped.height = innerH;
        const cctx = cropped.getContext('2d')!;
        cctx.drawImage(rawCanvas, exp, exp, innerW, innerH, 0, 0, innerW, innerH);
        layer.canvas = cropped;
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
      // font.type: 1 = TrueType (PSD 默认)；缺省时 ag-psd 默认 0，PS 渲染时 metric/hinting 路径不同会导致亚像素位置抖动。
      font: { name: toPostScriptName(firstStyle.fontFamily, firstStyle.fontStyle), type: 1, script: 0, synthetic: 0 },
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
      // strokeColor PSD 默认与 fillColor 同色，原始 PSD 总会写这个字段，缺失会让 PS 走 fallback 路径影响渲染。
      strokeColor: toRGBA(firstStyle.color),
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
      // 还原 PSD 原始 transform 的非对称缩放（sx, sy）：
      //   PSD 中 transform = [sx, 0, 0, sy, tx, ty]，sx 和 sy 可以不同（如 Level 40 sx=1 sy=1.0021）
      //   字符位置 = transform · (boundingBox.value)，水平方向用 sx、垂直方向用 sy
      //   如果都用 sy 会导致水平字符位置偏移（Level 40 左边偏 0.3px 视觉抖动来源）
      const sy = ti.transformScale != null && Number.isFinite(ti.transformScale) && ti.transformScale > 0
        ? ti.transformScale : 1;
      const sx = ti.transformScaleX != null && Number.isFinite(ti.transformScaleX) && ti.transformScaleX > 0
        ? ti.transformScaleX : sy;
      const fontSizeUnscaled = sy !== 1 ? fontSize / sy : fontSize;
      // 计算 tx/ty：
      //   优先用 anchor + delta 方案：ty = original_psd_ty + (current_node.y - anchor_node_y)
      //   未移动文本 export ty 完全等于原始 PSD ty（避开 mastergo node.y 亚像素精度损失）。
      //   fallback：node.y + ascent (从 bounds.top 算精确 ascent)。
      let ty: number;
      let txAdjusted: number;
      if (ti.transformTy != null && Number.isFinite(ti.transformTy) && ti.anchorNodeY != null && Number.isFinite(ti.anchorNodeY)) {
        const deltaY = node.y - ti.anchorNodeY;
        ty = ti.transformTy + deltaY;
      } else {
        const ascent = ti.bounds?.top != null && Number.isFinite(ti.bounds.top)
          ? -ti.bounds.top * sy
          : fontSize * 0.857;
        ty = node.y + ascent;
      }
      if (ti.transformTx != null && Number.isFinite(ti.transformTx) && ti.anchorNodeX != null && Number.isFinite(ti.anchorNodeX)) {
        const deltaX = node.x - ti.anchorNodeX;
        txAdjusted = ti.transformTx + deltaX;
      } else {
        txAdjusted = centerX + (ti.txOffsetX ?? 0);
      }
      const halfW = node.width / 2;

      const boundsTop = ti.bounds?.top ?? -fontSizeUnscaled * 0.857;
      const boundsBottom = ti.bounds?.bottom ?? fontSizeUnscaled * 0.514;
      const boundsLeft = ti.bounds?.left ?? -halfW;
      const boundsRight = ti.bounds?.right ?? halfW;
      const bboxTop = ti.boundingBox?.top ?? -fontSizeUnscaled * 0.776;
      const bboxBottom = ti.boundingBox?.bottom ?? fontSizeUnscaled * 0.240;
      const bboxLeft = ti.boundingBox?.left ?? -halfW;
      const bboxRight = ti.boundingBox?.right ?? halfW;

      // 字号、transform 在文本 style 里以 unscaled 形式给出；PSD transform 的 sy 应用缩放
      const unscaledBaseStyle = baseStyle ? { ...baseStyle, fontSize: fontSizeUnscaled } : undefined;

      layer.text = {
        text: ti.characters,
        transform: [sx, 0, 0, sy, txAdjusted, ty],
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
        style: unscaledBaseStyle,
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
      // styleRuns 的 fontSize 也是 unscaled（与 baseStyle 一致），由 transform 的 sy 决定视觉字号
      const syForStyles = ti.transformScale != null && Number.isFinite(ti.transformScale) && ti.transformScale > 0
        ? ti.transformScale : 1;
      layer.text.styleRuns = ti.styles.map(s => {
        const sHasLeading = s.lineHeight != null && s.lineHeight > 0;
        const sFontSize = syForStyles !== 1 ? s.fontSize / syForStyles : s.fontSize;
        const sLeading = sHasLeading ? (syForStyles !== 1 ? s.lineHeight! / syForStyles : s.lineHeight!) : 0;
        return {
          length: s.end - s.start,
          style: {
            font: { name: toPostScriptName(s.fontFamily, s.fontStyle), type: 1, script: 0, synthetic: 0 },
            fontSize: sFontSize,
            fillColor: toRGBA(s.color),
            strokeColor: toRGBA(s.color),
            tracking: s.fontSize > 0 ? Math.round((s.letterSpacing / s.fontSize) * 1000) : 0,
            leading: sLeading,
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

    // PSD 标准：group layer 自身不渲染图像（PS 用 sectionDivider 标记 group 范围），
    // group layer 的 top/left/right/bottom 字段在 PSD spec 中应为 [0,0,0,0]。
    // ag-psd 在 getLayerChannels 中对没有 canvas/imageData 的 layer 会强制 right=left, bottom=top,
    // 这就导致原本 [281,1258,797,1422] 被写成 [281,1258,281,1258]（零面积但 left/top 非零）。
    // PS 看到 group 有 effects + 非 0 起点的零面积 bbox 时会报 "settings are invalid"。
    // 与原始 PSD 一致（原始 group bbox=[0,0,0,0]）才能让 PS 正常读取。
    layer.left = 0;
    layer.top = 0;
    layer.right = 0;
    layer.bottom = 0;
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
    // 禁用 ag-psd 内部 trim：我们已经在 buildLayer 中精确控制了 canvas 尺寸
    //   - 位图层: 用 psdExpandOffset 裁掉 expand 边框，canvas 尺寸 = 原始 layer bbox
    //   - 文本层: pad 字符像素到 intended bbox 尺寸
    // 让 ag-psd 自动 trim 会去掉我们故意 pad 的透明像素，导致文本 layer bbox 变小（位置抖动）。
    trimImageData: false,
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
