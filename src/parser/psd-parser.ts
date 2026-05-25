import { readPsd } from 'ag-psd';
import type { Psd, Layer, LayerTextData, Color, LayerEffectStroke, LayerEffectShadow } from 'ag-psd';
import type {
  SerializedPsd,
  SerializedLayer,
  SerializedTextData,
  SerializedTextStyle,
  SerializedColor,
  LayerType,
} from '../types/psd-types';
import { convertEffects, convertStrokes } from '../converter/effect-converter';
import { convertBlendMode } from '../converter/blend-converter';
import { logger } from '../logger';

export interface ParseProgress {
  percent: number;
  message: string;
}

function toColor(c: Color | undefined): SerializedColor {
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  if ('r' in c && 'a' in c) {
    return {
      r: (c as { r: number }).r / 255,
      g: (c as { g: number }).g / 255,
      b: (c as { b: number }).b / 255,
      a: ((c as { a: number }).a ?? 255) / 255,
    };
  }
  if ('r' in c) {
    return {
      r: (c as { r: number }).r / 255,
      g: (c as { g: number }).g / 255,
      b: (c as { b: number }).b / 255,
      a: 1,
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function determineLayerType(layer: Layer): LayerType {
  if (layer.children && layer.children.length > 0) return 'group';
  if (layer.text) return 'text';
  if (layer.placedLayer) return 'smartObject';
  if (layer.vectorMask || layer.vectorFill) return 'shape';
  return 'image';
}

function convertTextData(text: LayerTextData): SerializedTextData {
  const styles: SerializedTextStyle[] = [];
  const fullText = text.text ?? '';

  let alignment = 'left';
  if (text.paragraphStyle?.justification) {
    alignment = text.paragraphStyle.justification;
  } else if (text.paragraphStyleRuns && text.paragraphStyleRuns.length > 0) {
    alignment = text.paragraphStyleRuns[0].style.justification ?? 'left';
  }

  // ag-psd deduplicates common style values from styleRuns into text.style,
  // so we must use text.style as fallback for any undefined properties in each run.
  const base = text.style;
  const baseFontName = base?.font?.name ?? 'Arial';
  const baseFontSize = base?.fontSize ?? 16;
  const baseFauxBold = base?.fauxBold ?? false;
  const baseFauxItalic = base?.fauxItalic ?? false;
  const baseTracking = base?.tracking ?? 0;
  const baseLeading = base?.leading;
  const baseAutoLeading = base?.autoLeading ?? false;
  const baseFillColor = base?.fillColor;
  const baseStrokeColor = base?.strokeColor;

  const txScale = (text.transform && text.transform.length >= 4)
    ? Math.sqrt(text.transform[1] * text.transform[1] + text.transform[3] * text.transform[3])
    : 1;

  if (text.styleRuns && text.styleRuns.length > 0) {
    let offset = 0;
    for (const run of text.styleRuns) {
      const end = offset + run.length;
      const s = run.style;

      const fontName = s.font?.name ?? baseFontName;
      const fontSize = s.fontSize ?? baseFontSize;
      const fauxBold = s.fauxBold ?? baseFauxBold;
      const fauxItalic = s.fauxItalic ?? baseFauxItalic;
      const tracking = s.tracking ?? baseTracking;
      const leading = s.leading ?? baseLeading;
      const autoLeading = s.autoLeading ?? baseAutoLeading;
      const fillColor = s.fillColor ?? baseFillColor;
      const strokeColor = s.strokeColor ?? baseStrokeColor;

      const scaledFontSize = fontSize * txScale;
      let resolvedLeading: number | null;
      if (autoLeading && (!leading || leading === 0)) {
        resolvedLeading = null;
      } else {
        resolvedLeading = leading != null ? leading * txScale : null;
      }
      const style: SerializedTextStyle = {
        fontFamily: fontName,
        fontStyle: fauxBold ? 'Bold' : fauxItalic ? 'Italic' : 'Regular',
        fontSize: scaledFontSize,
        color: toColor(fillColor),
        letterSpacing: (tracking / 1000) * scaledFontSize,
        lineHeight: resolvedLeading,
        start: offset,
        end,
      };
      if (strokeColor) {
        style.strokeColor = toColor(strokeColor);
      }
      styles.push(style);
      offset = end;
    }
  } else {
    const scaledFontSize = baseFontSize * txScale;
    let resolvedLeading: number | null;
    if (baseAutoLeading && (!baseLeading || baseLeading === 0)) {
      resolvedLeading = null;
    } else {
      resolvedLeading = baseLeading != null ? baseLeading * txScale : null;
    }
    const style: SerializedTextStyle = {
      fontFamily: baseFontName,
      fontStyle: baseFauxBold ? 'Bold' : baseFauxItalic ? 'Italic' : 'Regular',
      fontSize: scaledFontSize,
      color: toColor(baseFillColor),
      letterSpacing: (baseTracking / 1000) * scaledFontSize,
      lineHeight: resolvedLeading,
      start: 0,
      end: fullText.length,
    };
    if (baseStrokeColor) {
      style.strokeColor = toColor(baseStrokeColor);
    }
    styles.push(style);
  }

  let docBoundsY: number | undefined;
  let docBboxCenterX: number | undefined;
  let txOffsetX: number | undefined;

  if (text.transform && text.transform.length >= 6) {
    const [a, b, c, d, tx, ty] = text.transform;
    const sx = Math.sqrt(a * a + c * c);
    const sy = Math.sqrt(b * b + d * d);
    const isRotated = Math.abs(b) > 0.001 || Math.abs(c) > 0.001;

    if (isRotated) {
      if (text.boundingBox) {
        const bbL = text.boundingBox.left.value;
        const bbR = text.boundingBox.right.value;
        const bbT = text.boundingBox.top.value;
        docBboxCenterX = (a * bbL + c * bbT + tx + a * bbR + c * bbT + tx) / 2;
        docBoundsY = b * bbL + d * bbT + ty;
      } else if (text.bounds) {
        const bT = text.bounds.top.value;
        const bL = text.bounds.left.value;
        const bR = text.bounds.right.value;
        docBboxCenterX = (a * bL + c * bT + tx + a * bR + c * bT + tx) / 2;
        docBoundsY = b * bL + d * bT + ty;
      }
    } else {
      if (text.bounds) {
        const bT = text.bounds.top.value;
        docBoundsY = sy * bT + ty;
      }
      if (text.boundingBox) {
        const bbL = text.boundingBox.left.value;
        const bbR = text.boundingBox.right.value;
        const docBboxL = sx * bbL + tx;
        const docBboxR = sx * bbR + tx;
        docBboxCenterX = (docBboxL + docBboxR) / 2;
        txOffsetX = tx - docBboxCenterX;
      }
    }

  }

  let rotation: number | undefined;
  if (text.transform && text.transform.length >= 4) {
    const angleDeg = Math.atan2(text.transform[2], text.transform[0]) * (180 / Math.PI);
    if (Math.abs(angleDeg) > 0.1) {
      rotation = angleDeg;
    }
  }

  const result: SerializedTextData = { text: fullText, horizontalAlignment: alignment, styles, transformScale: txScale, rotation, docBoundsY, docBboxCenterX, txOffsetX, textIndex: text.index };

  if (text.bounds) {
    result.bounds = {
      top: text.bounds.top.value,
      left: text.bounds.left.value,
      right: text.bounds.right.value,
      bottom: text.bounds.bottom.value,
    };
  }
  if (text.boundingBox) {
    result.boundingBox = {
      top: text.boundingBox.top.value,
      left: text.boundingBox.left.value,
      right: text.boundingBox.right.value,
      bottom: text.boundingBox.bottom.value,
    };
  }

  if (text.shapeType) {
    result.shapeType = text.shapeType;
  }
  if (text.shapeType === 'box' && text.boxBounds && text.boxBounds.length >= 4) {
    const [left, top, right, bottom] = text.boxBounds;
    result.boxBounds = { width: (right - left) * txScale, height: (bottom - top) * txScale };
  }

  return result;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to encode PNG'))), 'image/png');
  });
  const arrayBuf = await blob.arrayBuffer();
  return new Uint8Array(arrayBuf);
}

const FIGMA_MAX_IMAGE_DIMENSION = 4096;

async function imageDataToPng(
  imageData: { data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array; width: number; height: number }
): Promise<Uint8Array> {
  if (imageData.width === 0 || imageData.height === 0) {
    throw new Error('Empty imageData');
  }

  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d')!;

  const pixelCount = imageData.width * imageData.height * 4;
  const cloned = new Uint8ClampedArray(pixelCount);

  const srcData = imageData.data;
  if (srcData instanceof Uint8ClampedArray) {
    cloned.set(srcData.subarray(0, pixelCount));
  } else if (srcData instanceof Uint8Array) {
    cloned.set(srcData.subarray(0, pixelCount));
  } else {
    for (let i = 0; i < pixelCount; i++) {
      cloned[i] = Math.min(255, Math.max(0, Math.round(Number(srcData[i]))));
    }
  }

  const imgData = new ImageData(cloned, imageData.width, imageData.height);
  ctx.putImageData(imgData, 0, 0);


  if (imageData.width <= FIGMA_MAX_IMAGE_DIMENSION && imageData.height <= FIGMA_MAX_IMAGE_DIMENSION) {
    return canvasToPng(canvas);
  }

  const scale = Math.min(
    FIGMA_MAX_IMAGE_DIMENSION / imageData.width,
    FIGMA_MAX_IMAGE_DIMENSION / imageData.height,
  );
  const dstW = Math.round(imageData.width * scale);
  const dstH = Math.round(imageData.height * scale);

  const downscaled = document.createElement('canvas');
  downscaled.width = dstW;
  downscaled.height = dstH;
  const dctx = downscaled.getContext('2d')!;
  dctx.drawImage(canvas, 0, 0, dstW, dstH);

  logger.warn(`Image ${imageData.width}x${imageData.height} exceeds Figma limit, downscaled to ${dstW}x${dstH}`);
  return canvasToPng(downscaled);
}

function applyLayerMask(
  imageData: { data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array; width: number; height: number },
  layer: Layer
): { data: Uint8ClampedArray; width: number; height: number } | null {
  const mask = layer.mask;
  if (!mask || mask.disabled) return null;
  if (!mask.imageData && !mask.canvas) return null;

  const layerLeft = layer.left ?? 0;
  const layerTop = layer.top ?? 0;
  const imgW = imageData.width;
  const imgH = imageData.height;

  let maskPixels: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array;
  let maskW: number;
  let maskH: number;

  if (mask.imageData) {
    maskPixels = mask.imageData.data;
    maskW = mask.imageData.width;
    maskH = mask.imageData.height;
  } else {
    const cvs = mask.canvas as HTMLCanvasElement;
    const ctx = cvs.getContext('2d')!;
    const mData = ctx.getImageData(0, 0, cvs.width, cvs.height);
    maskPixels = mData.data;
    maskW = cvs.width;
    maskH = cvs.height;
  }

  const maskLeft = mask.left ?? 0;
  const maskTop = mask.top ?? 0;
  const defaultColor = mask.defaultColor ?? 255;

  const isSingleChannel = maskPixels.length === maskW * maskH;
  const maskStride = isSingleChannel ? 1 : 4;

  const pixelCount = imgW * imgH * 4;
  const result = new Uint8ClampedArray(pixelCount);
  const srcData = imageData.data;
  if (srcData instanceof Uint8ClampedArray || srcData instanceof Uint8Array) {
    result.set(srcData.subarray(0, pixelCount));
  } else {
    for (let i = 0; i < pixelCount; i++) {
      result[i] = Math.min(255, Math.max(0, Math.round(Number(srcData[i]))));
    }
  }

  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < imgW; x++) {
      const docX = layerLeft + x;
      const docY = layerTop + y;

      let maskAlpha: number;
      const mxLocal = docX - maskLeft;
      const myLocal = docY - maskTop;

      if (mxLocal >= 0 && mxLocal < maskW && myLocal >= 0 && myLocal < maskH) {
        const mIdx = (myLocal * maskW + mxLocal) * maskStride;
        maskAlpha = Math.round(Number(maskPixels[mIdx]));
      } else {
        maskAlpha = defaultColor;
      }

      const pIdx = (y * imgW + x) * 4;
      result[pIdx + 3] = Math.round((result[pIdx + 3] * maskAlpha) / 255);
    }
  }

  return { data: result, width: imgW, height: imgH };
}

function getLayerBounds(layer: Layer): { left: number; top: number; right: number; bottom: number } {
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  const right = layer.right ?? left;
  const bottom = layer.bottom ?? top;
  return { left, top, right, bottom };
}

function collectLeafBounds(
  layer: Layer,
  out: { minL: number; minT: number; maxR: number; maxB: number }
): void {
  if (!layer.children || layer.children.length === 0) {
    if (layer.hidden) return;
    const cb = getLayerBounds(layer);
    if (cb.right <= cb.left || cb.bottom <= cb.top) return;
    out.minL = Math.min(out.minL, cb.left);
    out.minT = Math.min(out.minT, cb.top);
    out.maxR = Math.max(out.maxR, cb.right);
    out.maxB = Math.max(out.maxB, cb.bottom);
    return;
  }
  for (const child of layer.children) {
    collectLeafBounds(child, out);
  }
}

function computeGroupBounds(layer: Layer): { left: number; top: number; right: number; bottom: number } {
  const own = getLayerBounds(layer);

  if (!layer.children || layer.children.length === 0) {
    return own;
  }

  const acc = { minL: Infinity, minT: Infinity, maxR: -Infinity, maxB: -Infinity };

  for (const child of layer.children) {
    if (child.hidden) continue;
    if (child.children && child.children.length > 0) {
      collectLeafBounds(child, acc);
    } else {
      const cb = getLayerBounds(child);
      if (cb.right <= cb.left || cb.bottom <= cb.top) continue;
      acc.minL = Math.min(acc.minL, cb.left);
      acc.minT = Math.min(acc.minT, cb.top);
      acc.maxR = Math.max(acc.maxR, cb.right);
      acc.maxB = Math.max(acc.maxB, cb.bottom);
    }
  }

  if (!isFinite(acc.minL)) {
    return own;
  }

  return { left: acc.minL, top: acc.minT, right: acc.maxR, bottom: acc.maxB };
}

function getArtboardBounds(layer: Layer): { left: number; top: number; right: number; bottom: number } | null {
  const artboard = (layer as Record<string, unknown>)['artboard'] as
    { rect?: { top: number; left: number; bottom: number; right: number } } | undefined;
  if (artboard?.rect) {
    return { left: artboard.rect.left, top: artboard.rect.top, right: artboard.rect.right, bottom: artboard.rect.bottom };
  }
  return null;
}

function getEnabledStrokes(layer: Layer): LayerEffectStroke[] {
  if (!layer.effects || layer.effects.disabled || !layer.effects.stroke) return [];
  // 接受所有 enabled stroke（包含 color/gradient/pattern fillType）；
  // 合成管线会按 fillType 选择对应的着色源
  return layer.effects.stroke.filter(s => s.enabled);
}

interface ShadowCompositeInfo {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  r: number;
  g: number;
  b: number;
  opacity: number;
}

// 兼容旧名（外部调用点）
type DropShadowCompositeInfo = ShadowCompositeInfo;

function readShadowList(items: { enabled?: boolean; angle?: number; distance?: { value?: number }; size?: { value?: number }; choke?: { value?: number }; color?: any; opacity?: number }[] | undefined): ShadowCompositeInfo[] {
  if (!items) return [];
  const result: ShadowCompositeInfo[] = [];
  for (const s of items) {
    if (!s.enabled) continue;
    const angle = ((s.angle ?? 120) * Math.PI) / 180;
    const distance = s.distance?.value ?? 0;
    const c = s.color;
    const size = s.size?.value ?? 0;
    const chokePct = (s.choke?.value ?? 0) / 100;
    result.push({
      offsetX: Math.round(Math.cos(angle) * distance),
      offsetY: Math.round(Math.sin(angle) * distance),
      blur: size * (1 - chokePct),
      spread: size * chokePct,
      r: Math.round(('r' in (c ?? {})) ? (c as { r: number }).r : 0),
      g: Math.round(('g' in (c ?? {})) ? (c as { g: number }).g : 0),
      b: Math.round(('b' in (c ?? {})) ? (c as { b: number }).b : 0),
      opacity: s.opacity ?? 1,
    });
  }
  return result;
}

function getEnabledDropShadows(layer: Layer): ShadowCompositeInfo[] {
  if (!layer.effects || layer.effects.disabled) return [];
  return readShadowList(layer.effects.dropShadow);
}

function getEnabledInnerShadows(layer: Layer): ShadowCompositeInfo[] {
  if (!layer.effects || layer.effects.disabled) return [];
  return readShadowList(layer.effects.innerShadow);
}

// Outer/Inner Glow: 没有 angle/distance（即偏移=0），用 size 当 blur+spread，choke 当 spread
function readGlow(g: { enabled?: boolean; size?: { value?: number }; choke?: { value?: number }; color?: any; opacity?: number } | undefined): ShadowCompositeInfo | null {
  if (!g || !g.enabled) return null;
  const size = g.size?.value ?? 0;
  const chokePct = (g.choke?.value ?? 0) / 100;
  const c = g.color;
  return {
    offsetX: 0,
    offsetY: 0,
    blur: size * (1 - chokePct),
    spread: size * chokePct,
    r: Math.round(('r' in (c ?? {})) ? (c as { r: number }).r : 0),
    g: Math.round(('g' in (c ?? {})) ? (c as { g: number }).g : 0),
    b: Math.round(('b' in (c ?? {})) ? (c as { b: number }).b : 0),
    opacity: g.opacity ?? 1,
  };
}

function getEnabledOuterGlow(layer: Layer): ShadowCompositeInfo | null {
  if (!layer.effects || layer.effects.disabled) return null;
  return readGlow(layer.effects.outerGlow);
}

function getEnabledInnerGlow(layer: Layer): ShadowCompositeInfo | null {
  if (!layer.effects || layer.effects.disabled) return null;
  return readGlow(layer.effects.innerGlow);
}

function computeShadowExpansion(shadows: ShadowCompositeInfo[]): number {
  let expand = 0;
  for (const s of shadows) {
    const reach = s.blur + s.spread + Math.max(Math.abs(s.offsetX), Math.abs(s.offsetY));
    expand = Math.max(expand, Math.ceil(reach));
  }
  return expand;
}

interface BevelInfo {
  /** 主样式：决定 highlight/shadow 的位置（"inner bevel"|"outer bevel"|"emboss"|"pillow emboss"|"stroke emboss"） */
  style: string;
  /** size：影响等高线宽度（描述斜面有多宽） */
  size: number;
  /** soften：在 size 上额外的模糊 */
  soften: number;
  /** angle / altitude（度）：光照方向 */
  angle: number;
  altitude: number;
  /** direction：'up' = highlight 在亮面，'down' = 反转 */
  direction: 'up' | 'down';
  /** strength：高光/阴影强度（0~100 → 0~1） */
  strength: number;
  highlightR: number; highlightG: number; highlightB: number; highlightOpacity: number;
  shadowR: number; shadowG: number; shadowB: number; shadowOpacity: number;
}

function getEnabledBevel(layer: Layer): BevelInfo | null {
  if (!layer.effects || layer.effects.disabled || !layer.effects.bevel) return null;
  const b: any = layer.effects.bevel;
  if (!b.enabled) return null;
  const hc = b.highlightColor ?? { r: 255, g: 255, b: 255 };
  const sc = b.shadowColor ?? { r: 0, g: 0, b: 0 };
  return {
    style: String(b.style ?? 'inner bevel'),
    size: b.size?.value ?? 0,
    soften: b.soften?.value ?? 0,
    angle: b.angle ?? 120,
    altitude: b.altitude ?? 30,
    direction: (b.direction === 'down' ? 'down' : 'up'),
    strength: Math.max(0, Math.min(1, (b.strength ?? 100) / 100)),
    highlightR: Math.round(hc.r ?? 255),
    highlightG: Math.round(hc.g ?? 255),
    highlightB: Math.round(hc.b ?? 255),
    highlightOpacity: b.highlightOpacity ?? 0.75,
    shadowR: Math.round(sc.r ?? 0),
    shadowG: Math.round(sc.g ?? 0),
    shadowB: Math.round(sc.b ?? 0),
    shadowOpacity: b.shadowOpacity ?? 0.75,
  };
}

interface SatinInfo {
  r: number; g: number; b: number;
  opacity: number;
  size: number;
  distance: number;
  angle: number;
  invert: boolean;
}

function getEnabledSatin(layer: Layer): SatinInfo | null {
  if (!layer.effects || layer.effects.disabled || !layer.effects.satin) return null;
  const s: any = layer.effects.satin;
  if (!s.enabled) return null;
  const c = s.color ?? { r: 0, g: 0, b: 0 };
  return {
    r: Math.round(c.r ?? 0),
    g: Math.round(c.g ?? 0),
    b: Math.round(c.b ?? 0),
    opacity: s.opacity ?? 0.5,
    size: s.size?.value ?? 0,
    distance: s.distance?.value ?? 0,
    angle: s.angle ?? 19,
    invert: !!s.invert,
  };
}

interface PatternOverlayInfo {
  /** pattern 像素数据：RGBA 8bit, length = w*h*4 */
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  scale: number;
  opacity: number;
  phaseX: number;
  phaseY: number;
}

/**
 * 在 layer.patterns / psd.patterns 中按 id 查找模式，把其内嵌图片解码为 RGBA。
 * 这是异步因为我们要用 Image / blob URL（PSD 中的 pattern.data 已经是 PNG bytes）。
 */
async function resolvePatternData(
  patternId: string | undefined,
  layer: Layer,
  psdPatterns: { id: string; bounds: { w: number; h: number }; data: Uint8Array }[] | undefined
): Promise<{ rgba: Uint8ClampedArray; w: number; h: number } | null> {
  if (!patternId) return null;
  const candidates: { id: string; bounds: { w: number; h: number }; data: Uint8Array }[] = [];
  const layerPatterns = (layer as any).patterns as typeof candidates | undefined;
  if (Array.isArray(layerPatterns)) candidates.push(...layerPatterns);
  if (Array.isArray(psdPatterns)) candidates.push(...psdPatterns);
  const match = candidates.find(p => p.id === patternId);
  if (!match || !match.data || match.data.length === 0) return null;

  const w = match.bounds?.w ?? 0;
  const h = match.bounds?.h ?? 0;
  const pixelCount = w * h;
  if (pixelCount <= 0) return null;

  const raw = match.data;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  if (raw.length === pixelCount * 4) {
    // 假定 ag-psd 已经把模式像素返回为 RGBA8
    rgba.set(raw);
  } else if (raw.length === pixelCount * 3) {
    for (let i = 0; i < pixelCount; i++) {
      rgba[i * 4] = raw[i * 3];
      rgba[i * 4 + 1] = raw[i * 3 + 1];
      rgba[i * 4 + 2] = raw[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else if (raw.length === pixelCount) {
    // 单通道：当 alpha mask 处理
    for (let i = 0; i < pixelCount; i++) {
      rgba[i * 4] = 128;
      rgba[i * 4 + 1] = 128;
      rgba[i * 4 + 2] = 128;
      rgba[i * 4 + 3] = raw[i];
    }
  } else {
    return null;
  }
  return { rgba, w, h };
}

function getPatternOverlayMeta(layer: Layer): { id: string; scale: number; opacity: number; phaseX: number; phaseY: number } | null {
  if (!layer.effects || layer.effects.disabled || !layer.effects.patternOverlay) return null;
  const p: any = layer.effects.patternOverlay;
  if (!p.enabled || !p.pattern?.id) return null;
  return {
    id: p.pattern.id,
    scale: (p.scale ?? 1),
    opacity: p.opacity ?? 1,
    phaseX: p.phase?.x ?? 0,
    phaseY: p.phase?.y ?? 0,
  };
}

function boxBlurAlpha(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return src;
  const r = Math.ceil(radius);
  const dst1 = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      const xMin = Math.max(0, x - r), xMax = Math.min(w - 1, x + r);
      for (let nx = xMin; nx <= xMax; nx++) {
        sum += src[y * w + nx];
        count++;
      }
      dst1[y * w + x] = Math.round(sum / count);
    }
  }
  const dst2 = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0, count = 0;
      const yMin = Math.max(0, y - r), yMax = Math.min(h - 1, y + r);
      for (let ny = yMin; ny <= yMax; ny++) {
        sum += dst1[ny * w + x];
        count++;
      }
      dst2[y * w + x] = Math.round(sum / count);
    }
  }
  return dst2;
}

interface ColorOverlayInfo {
  r: number; g: number; b: number; opacity: number;
}

interface GradientStop { location: number; midpoint: number; r: number; g: number; b: number; }
interface GradientOpacityStop { location: number; midpoint: number; opacity: number; }

type GradientStyleKind = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

interface GradientOverlayInfo {
  angle: number;
  reverse: boolean;
  colorStops: GradientStop[];
  opacityStops: GradientOpacityStop[];
  opacity: number;
  style: GradientStyleKind;
  scale: number;
}

interface GradientStrokeInfo extends GradientOverlayInfo {
  // 占位以便和 GradientOverlayInfo 区分类型
}

function getEnabledSolidFill(layer: Layer): ColorOverlayInfo | null {
  if (!layer.effects || layer.effects.disabled) return null;
  const fills = (layer.effects as any).solidFill;
  if (!Array.isArray(fills)) return null;
  for (const sf of fills) {
    if (sf.enabled && sf.color) {
      return {
        r: Math.round(sf.color.r ?? 0),
        g: Math.round(sf.color.g ?? 0),
        b: Math.round(sf.color.b ?? 0),
        opacity: sf.opacity ?? 1,
      };
    }
  }
  return null;
}

function normalizeGradientStyle(s: string | undefined): GradientStyleKind {
  if (s === 'radial' || s === 'angle' || s === 'reflected' || s === 'diamond') return s;
  return 'linear';
}

function readGradientFromEffect(go: any): GradientOverlayInfo | null {
  if (!go || !go.gradient) return null;
  const g = go.gradient;
  // 只处理 solid gradient（noise gradient 暂不支持还原）
  if (g.type !== 'solid' && g.type !== undefined) return null;
  const colorStops: GradientStop[] = (g.colorStops || []).map((s: any) => ({
    location: s.location ?? 0,
    midpoint: s.midpoint ?? 0.5,
    r: Math.round(s.color?.r ?? 0),
    g: Math.round(s.color?.g ?? 0),
    b: Math.round(s.color?.b ?? 0),
  }));
  const opacityStops: GradientOpacityStop[] = (g.opacityStops || []).map((s: any) => ({
    location: s.location ?? 0,
    midpoint: s.midpoint ?? 0.5,
    opacity: s.opacity ?? 1,
  }));
  return {
    angle: go.angle ?? 90,
    reverse: go.reverse ?? false,
    colorStops,
    opacityStops,
    opacity: go.opacity ?? 1,
    style: normalizeGradientStyle(go.type),
    scale: go.scale ?? 1,
  };
}

function getEnabledGradientOverlay(layer: Layer): GradientOverlayInfo | null {
  if (!layer.effects || layer.effects.disabled) return null;
  const overlays = (layer.effects as any).gradientOverlay;
  if (!Array.isArray(overlays)) return null;
  for (const go of overlays) {
    if (!go.enabled) continue;
    const info = readGradientFromEffect(go);
    if (info) return info;
  }
  return null;
}

function interpolateGradientColor(stops: GradientStop[], t: number): { r: number; g: number; b: number } {
  if (stops.length === 0) return { r: 0, g: 0, b: 0 };
  if (stops.length === 1) return { r: stops[0].r, g: stops[0].g, b: stops[0].b };
  if (t <= stops[0].location) return { r: stops[0].r, g: stops[0].g, b: stops[0].b };
  if (t >= stops[stops.length - 1].location) {
    const last = stops[stops.length - 1];
    return { r: last.r, g: last.g, b: last.b };
  }
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].location && t <= stops[i + 1].location) {
      const range = stops[i + 1].location - stops[i].location;
      const f = range === 0 ? 0 : (t - stops[i].location) / range;
      return {
        r: Math.round(stops[i].r + (stops[i + 1].r - stops[i].r) * f),
        g: Math.round(stops[i].g + (stops[i + 1].g - stops[i].g) * f),
        b: Math.round(stops[i].b + (stops[i + 1].b - stops[i].b) * f),
      };
    }
  }
  const last = stops[stops.length - 1];
  return { r: last.r, g: last.g, b: last.b };
}

function interpolateGradientOpacity(stops: GradientOpacityStop[], t: number): number {
  if (stops.length === 0) return 1;
  if (stops.length === 1) return stops[0].opacity;
  if (t <= stops[0].location) return stops[0].opacity;
  if (t >= stops[stops.length - 1].location) return stops[stops.length - 1].opacity;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].location && t <= stops[i + 1].location) {
      const range = stops[i + 1].location - stops[i].location;
      const f = range === 0 ? 0 : (t - stops[i].location) / range;
      return stops[i].opacity + (stops[i + 1].opacity - stops[i].opacity) * f;
    }
  }
  return stops[stops.length - 1].opacity;
}

function applyColorOverlayToPixels(
  pixels: Uint8ClampedArray,
  w: number, h: number,
  overlay: ColorOverlayInfo
): void {
  const oA = Math.round(overlay.opacity * 255);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    const srcA = pixels[idx + 3];
    if (srcA === 0) continue;
    if (oA >= 255) {
      pixels[idx] = overlay.r;
      pixels[idx + 1] = overlay.g;
      pixels[idx + 2] = overlay.b;
    } else {
      const f = oA / 255;
      pixels[idx] = Math.round(pixels[idx] * (1 - f) + overlay.r * f);
      pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - f) + overlay.g * f);
      pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - f) + overlay.b * f);
    }
  }
}

/**
 * 计算坐标 (x,y) 在不同梯度类型下的归一化参数 t ∈ [0,1]。
 * PSD 角度：0° = 左→右，90° = 底→上（Cartesian，y up）。
 * 这里 y 是图像坐标 down，所以 dy = -sin(angle)。
 */
function gradientParamAt(
  x: number, y: number,
  w: number, h: number,
  grad: GradientOverlayInfo
): number {
  const cx = w / 2, cy = h / 2;
  const px = x - cx, py = y - cy;
  const angleRad = grad.angle * Math.PI / 180;
  const dx = Math.cos(angleRad);
  const dy = -Math.sin(angleRad);
  const scale = grad.scale > 0 ? grad.scale : 1;

  switch (grad.style) {
    case 'radial': {
      const half = Math.min(w, h) / 2 * scale;
      const dist = Math.sqrt(px * px + py * py);
      return half === 0 ? 0 : Math.max(0, Math.min(1, dist / half));
    }
    case 'angle': {
      // PS angle gradient：从 angle 起，逆时针 360°
      let theta = Math.atan2(-py, px) * 180 / Math.PI; // 0=右, 90=上
      let t = (grad.angle - theta) / 360;
      t = t - Math.floor(t); // wrap [0,1)
      return t;
    }
    case 'reflected': {
      const halfLen = (Math.abs(dx) * w + Math.abs(dy) * h) / 2 * scale;
      const proj = Math.abs(px * dx + py * dy);
      return halfLen === 0 ? 0 : Math.max(0, Math.min(1, proj / halfLen));
    }
    case 'diamond': {
      const halfLen = Math.max(w, h) / 2 * scale;
      // 旋转坐标系
      const rx = px * dx + py * dy;
      const ry = -px * dy + py * dx;
      const dist = Math.abs(rx) + Math.abs(ry);
      return halfLen === 0 ? 0 : Math.max(0, Math.min(1, dist / halfLen));
    }
    case 'linear':
    default: {
      const halfLen = (Math.abs(dx) * w + Math.abs(dy) * h) / 2 * scale;
      const proj = px * dx + py * dy;
      return halfLen === 0 ? 0.5 : Math.max(0, Math.min(1, (proj + halfLen) / (2 * halfLen)));
    }
  }
}

function sampleGradient(grad: GradientOverlayInfo, tIn: number): { r: number; g: number; b: number; a: number } {
  let t = tIn;
  if (grad.reverse) t = 1 - t;
  const c = interpolateGradientColor(grad.colorStops, t);
  const a = interpolateGradientOpacity(grad.opacityStops, t) * grad.opacity;
  return { r: c.r, g: c.g, b: c.b, a };
}

function applyGradientOverlayToPixels(
  pixels: Uint8ClampedArray,
  w: number, h: number,
  grad: GradientOverlayInfo
): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (pixels[idx + 3] === 0) continue;

      const t = gradientParamAt(x, y, w, h, grad);
      const s = sampleGradient(grad, t);
      const opac = s.a;

      if (opac >= 1) {
        pixels[idx] = s.r;
        pixels[idx + 1] = s.g;
        pixels[idx + 2] = s.b;
      } else {
        pixels[idx] = Math.round(pixels[idx] * (1 - opac) + s.r * opac);
        pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - opac) + s.g * opac);
        pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - opac) + s.b * opac);
      }
    }
  }
}

/**
 * 在 RGBA pixels（与图层同尺寸）上铺设 pattern，乘以原 alpha 掩膜来确定影响范围。
 * 用 phaseX/phaseY 决定 pattern 的原点偏移。
 */
function applyPatternOverlayToPixels(
  pixels: Uint8ClampedArray,
  w: number, h: number,
  pat: PatternOverlayInfo
): void {
  const pw = pat.w;
  const ph = pat.h;
  if (pw <= 0 || ph <= 0) return;
  const scale = pat.scale > 0 ? pat.scale : 1;
  const effW = Math.max(1, pw * scale);
  const effH = Math.max(1, ph * scale);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (pixels[idx + 3] === 0) continue;

      const u = ((x - pat.phaseX) / effW);
      const v = ((y - pat.phaseY) / effH);
      const fu = u - Math.floor(u);
      const fv = v - Math.floor(v);
      const sx = Math.min(pw - 1, Math.max(0, Math.floor(fu * pw)));
      const sy = Math.min(ph - 1, Math.max(0, Math.floor(fv * ph)));
      const pi = (sy * pw + sx) * 4;
      const pr = pat.rgba[pi];
      const pg = pat.rgba[pi + 1];
      const pb = pat.rgba[pi + 2];
      const pa = pat.rgba[pi + 3];
      const opac = (pa / 255) * pat.opacity;
      if (opac <= 0) continue;
      if (opac >= 1) {
        pixels[idx] = pr;
        pixels[idx + 1] = pg;
        pixels[idx + 2] = pb;
      } else {
        pixels[idx] = Math.round(pixels[idx] * (1 - opac) + pr * opac);
        pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - opac) + pg * opac);
        pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - opac) + pb * opac);
      }
    }
  }
}

function computeStrokeExpansion(strokes: LayerEffectStroke[]): number {
  let expand = 0;
  for (const s of strokes) {
    const w = s.size?.value ?? 0;
    if (s.position === 'outside') expand = Math.max(expand, w);
    else if (s.position === 'center') expand = Math.max(expand, Math.ceil(w / 2));
  }
  return expand;
}

function extractAlpha(
  srcData: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array,
  w: number, h: number
): Uint8Array {
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    alpha[i] = Math.min(255, Math.max(0, Math.round(Number(srcData[i * 4 + 3]))));
  }
  return alpha;
}

function dilateAlpha(alpha: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return alpha;
  const out = new Uint8Array(w * h);
  const r2 = radius * radius;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let maxA = 0;
      const yMin = Math.max(0, y - radius);
      const yMax = Math.min(h - 1, y + radius);
      const xMin = Math.max(0, x - radius);
      const xMax = Math.min(w - 1, x + radius);
      for (let ny = yMin; ny <= yMax; ny++) {
        const dy = ny - y;
        for (let nx = xMin; nx <= xMax; nx++) {
          const dx = nx - x;
          if (dx * dx + dy * dy <= r2) {
            const a = alpha[ny * w + nx];
            if (a > maxA) maxA = a;
          }
        }
      }
      out[y * w + x] = maxA;
    }
  }
  return out;
}

function erodeAlpha(alpha: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return alpha;
  const out = new Uint8Array(w * h);
  const r2 = radius * radius;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let minA = 255;
      const yMin = Math.max(0, y - radius);
      const yMax = Math.min(h - 1, y + radius);
      const xMin = Math.max(0, x - radius);
      const xMax = Math.min(w - 1, x + radius);
      for (let ny = yMin; ny <= yMax; ny++) {
        const dy = ny - y;
        for (let nx = xMin; nx <= xMax; nx++) {
          const dx = nx - x;
          if (dx * dx + dy * dy <= r2) {
            const a = alpha[ny * w + nx];
            if (a < minA) minA = a;
          }
        }
      }
      out[y * w + x] = minA;
    }
  }
  return out;
}

/**
 * 计算到形状边缘的 Chamfer 距离场（基于 alpha 0/255 阈值）。
 * 形状内的像素返回正距离，形状外的像素返回 0。
 * 用两遍扫描的近似距离变换（成本远低于精确 EDT）。
 */
function insideDistanceField(alpha: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    dist[i] = alpha[i] >= 128 ? INF : 0;
  }
  // 正向扫描
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let m = dist[i];
      if (x > 0) m = Math.min(m, dist[i - 1] + 1);
      if (y > 0) m = Math.min(m, dist[i - w] + 1);
      if (x > 0 && y > 0) m = Math.min(m, dist[i - w - 1] + Math.SQRT2);
      if (x < w - 1 && y > 0) m = Math.min(m, dist[i - w + 1] + Math.SQRT2);
      dist[i] = m;
    }
  }
  // 反向扫描
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let m = dist[i];
      if (x < w - 1) m = Math.min(m, dist[i + 1] + 1);
      if (y < h - 1) m = Math.min(m, dist[i + w] + 1);
      if (x < w - 1 && y < h - 1) m = Math.min(m, dist[i + w + 1] + Math.SQRT2);
      if (x > 0 && y < h - 1) m = Math.min(m, dist[i + w - 1] + Math.SQRT2);
      dist[i] = m;
    }
  }
  return dist;
}

function outsideDistanceField(alpha: Uint8Array, w: number, h: number): Float32Array {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = alpha[i] >= 128 ? 0 : 255;
  return insideDistanceField(inv, w, h);
}

/**
 * 将带 sigma 的高斯模糊近似为 3 次 box blur。
 */
function blurFloat(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return src;
  let current = src;
  const passes = 3;
  const r = Math.max(1, Math.round(radius / passes));
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        const xMin = Math.max(0, x - r), xMax = Math.min(w - 1, x + r);
        for (let nx = xMin; nx <= xMax; nx++) {
          sum += current[y * w + nx];
          count++;
        }
        tmp[y * w + x] = sum / count;
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let sum = 0, count = 0;
        const yMin = Math.max(0, y - r), yMax = Math.min(h - 1, y + r);
        for (let ny = yMin; ny <= yMax; ny++) {
          sum += tmp[ny * w + x];
          count++;
        }
        out[y * w + x] = sum / count;
      }
    }
    current = out;
  }
  return current;
}

/**
 * 基于内部距离场计算 PS 风格的 Bevel/Emboss 高度场（0~1，边缘=0，中心或外缘=1，
 * 通过 size 控制斜面宽度）。
 */
function bevelHeightField(
  alpha: Uint8Array, w: number, h: number, size: number, style: string
): Float32Array {
  const height = new Float32Array(w * h);
  const insideD = insideDistanceField(alpha, w, h);
  const outsideD = outsideDistanceField(alpha, w, h);
  for (let i = 0; i < w * h; i++) {
    const di = insideD[i];
    const dout = outsideD[i];
    if (style === 'outer bevel') {
      // 外斜面：形状外靠近边缘的环带升起
      if (alpha[i] >= 128) {
        height[i] = 1;
      } else {
        height[i] = Math.max(0, 1 - dout / size);
      }
    } else if (style === 'emboss') {
      // 浮雕：内/外都对称地形成斜面
      if (alpha[i] >= 128) {
        height[i] = Math.min(1, di / size);
      } else {
        height[i] = -Math.max(0, 1 - dout / size);
      }
    } else if (style === 'pillow emboss') {
      if (alpha[i] >= 128) {
        height[i] = Math.min(1, di / size);
      } else {
        height[i] = -Math.min(1, dout / size);
      }
    } else {
      // inner bevel 默认
      if (alpha[i] >= 128) {
        height[i] = Math.min(1, di / size);
      }
    }
  }
  return height;
}

/**
 * 直接基于高度场计算光照（Phong-like），返回每像素 (highlight, shadow) 强度 ∈ [0,1]。
 * 这里 light direction 由 bevel.angle + altitude 决定。
 */
function bevelLighting(
  height: Float32Array, w: number, h: number, angleDeg: number, altitudeDeg: number, direction: 'up' | 'down'
): { highlight: Float32Array; shadow: Float32Array } {
  const a = angleDeg * Math.PI / 180;
  const alt = altitudeDeg * Math.PI / 180;
  // 光源方向：在屏幕平面上 angle 决定 x/y 投影，altitude 决定 z
  const lx = Math.cos(a) * Math.cos(alt);
  const ly = -Math.sin(a) * Math.cos(alt);
  const lz = Math.sin(alt);
  const dirSign = direction === 'up' ? 1 : -1;

  const highlight = new Float32Array(w * h);
  const shadow = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // 中心差分计算法线 (nx, ny, nz)，z=1
      const xL = x > 0 ? height[i - 1] : height[i];
      const xR = x < w - 1 ? height[i + 1] : height[i];
      const yT = y > 0 ? height[i - w] : height[i];
      const yB = y < h - 1 ? height[i + w] : height[i];
      let nx = (xL - xR) * dirSign;
      let ny = (yT - yB) * dirSign;
      const nz = 1.0;
      // 归一化
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len;
      const nzN = nz / len;
      const dot = nx * lx + ny * ly + nzN * lz;
      if (dot > 0) {
        highlight[i] = Math.min(1, dot);
      } else {
        shadow[i] = Math.min(1, -dot);
      }
    }
  }
  return { highlight, shadow };
}

/**
 * 把 Bevel 的高光/阴影应用到 RGBA 像素（在合成 fill 之上、stroke 之前）。
 * Bevel 只在 alpha>0 的区域可见（对 inner bevel/emboss/pillow），outer bevel 会扩展到外缘。
 */
function applyBevelToPixels(
  pixels: Uint8ClampedArray, w: number, h: number, alpha: Uint8Array,
  bevel: BevelInfo
): void {
  if (bevel.size <= 0) return;
  let height = bevelHeightField(alpha, w, h, bevel.size, bevel.style);
  if (bevel.soften > 0) {
    height = blurFloat(height, w, h, bevel.soften);
  }
  const { highlight, shadow } = bevelLighting(height, w, h, bevel.angle, bevel.altitude, bevel.direction);

  const hOp = bevel.highlightOpacity * bevel.strength;
  const sOp = bevel.shadowOpacity * bevel.strength;

  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    if (pixels[idx + 3] === 0 && bevel.style !== 'outer bevel') continue;
    const hAmt = highlight[i] * hOp;
    if (hAmt > 0) {
      const f = hAmt;
      pixels[idx] = Math.round(pixels[idx] * (1 - f) + bevel.highlightR * f);
      pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - f) + bevel.highlightG * f);
      pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - f) + bevel.highlightB * f);
    }
    const sAmt = shadow[i] * sOp;
    if (sAmt > 0) {
      const f = sAmt;
      pixels[idx] = Math.round(pixels[idx] * (1 - f) + bevel.shadowR * f);
      pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - f) + bevel.shadowG * f);
      pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - f) + bevel.shadowB * f);
    }
  }
}

/**
 * Satin 效果：对 alpha 双向偏移取差，得到内部"光泽带"形状。
 */
function applySatinToPixels(
  pixels: Uint8ClampedArray, w: number, h: number, origAlpha: Uint8Array,
  satin: SatinInfo
): void {
  const ang = satin.angle * Math.PI / 180;
  const dx = Math.round(Math.cos(ang) * satin.distance);
  const dy = Math.round(-Math.sin(ang) * satin.distance);
  // 计算前向/反向偏移 alpha
  const fwd = new Uint8Array(w * h);
  const bwd = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = x - dx, fy = y - dy;
      const bx = x + dx, by = y + dy;
      fwd[y * w + x] = (fx >= 0 && fx < w && fy >= 0 && fy < h) ? origAlpha[fy * w + fx] : 0;
      bwd[y * w + x] = (bx >= 0 && bx < w && by >= 0 && by < h) ? origAlpha[by * w + bx] : 0;
    }
  }
  // 取与/绝对差 + 模糊
  const result = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = origAlpha[i];
    if (a === 0) continue;
    const f = fwd[i], b = bwd[i];
    // PS 公式近似：|f - b| / 255
    const diff = Math.abs(f - b) / 255;
    result[i] = satin.invert ? (1 - diff) : diff;
  }
  const blurred = satin.size > 0 ? blurFloat(result, w, h, satin.size) : result;

  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    if (pixels[idx + 3] === 0) continue;
    // 仅作用在 alpha>0 区域，用 origAlpha 作为掩膜
    const mask = origAlpha[i] / 255;
    const f = blurred[i] * satin.opacity * mask;
    if (f <= 0) continue;
    const ff = Math.min(1, f);
    pixels[idx] = Math.round(pixels[idx] * (1 - ff) + satin.r * ff);
    pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - ff) + satin.g * ff);
    pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - ff) + satin.b * ff);
  }
}

/** 收集合成所需的完整图层效果信息 */
interface LayerEffectBundle {
  strokes: LayerEffectStroke[];
  fillOpacity: number;
  solidFill: ColorOverlayInfo | null;
  gradientOverlay: GradientOverlayInfo | null;
  patternOverlay: PatternOverlayInfo | null;
  bevel: BevelInfo | null;
  satin: SatinInfo | null;
  dropShadows: ShadowCompositeInfo[];
  innerShadows: ShadowCompositeInfo[];
  outerGlow: ShadowCompositeInfo | null;
  innerGlow: ShadowCompositeInfo | null;
}

function hasAnyEffect(b: LayerEffectBundle): boolean {
  return b.strokes.length > 0 || b.fillOpacity < 1 || !!b.solidFill || !!b.gradientOverlay ||
    !!b.patternOverlay || !!b.bevel || !!b.satin || b.dropShadows.length > 0 ||
    b.innerShadows.length > 0 || !!b.outerGlow || !!b.innerGlow;
}

function copyAlphaToPadded(alpha: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number, expand: number): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      out[(y + expand) * dstW + (x + expand)] = alpha[y * srcW + x];
    }
  }
  return out;
}

/** 在 dstPixels 上叠加给定颜色 + alpha 蒙版 */
function blendColorOnto(
  dstPixels: Uint8ClampedArray, dstW: number, dstH: number,
  alphaMask: Uint8Array, r: number, g: number, b: number, opacity: number
): void {
  for (let i = 0; i < dstW * dstH; i++) {
    const a = Math.round(alphaMask[i] * opacity);
    if (a <= 0) continue;
    const idx = i * 4;
    const dstA = dstPixels[idx + 3];
    if (dstA === 0) {
      dstPixels[idx] = r;
      dstPixels[idx + 1] = g;
      dstPixels[idx + 2] = b;
      dstPixels[idx + 3] = a;
    } else {
      const outA = a + dstA * (1 - a / 255);
      dstPixels[idx] = Math.round((r * a + dstPixels[idx] * dstA * (1 - a / 255)) / outA);
      dstPixels[idx + 1] = Math.round((g * a + dstPixels[idx + 1] * dstA * (1 - a / 255)) / outA);
      dstPixels[idx + 2] = Math.round((b * a + dstPixels[idx + 2] * dstA * (1 - a / 255)) / outA);
      dstPixels[idx + 3] = Math.round(outA);
    }
  }
}

/** 在 dstPixels 上叠加任意 RGBA 着色源（按像素），用 alphaMask（0~255）作为额外掩膜 */
function blendRgbaOnto(
  dstPixels: Uint8ClampedArray, dstW: number, dstH: number,
  rgba: Uint8ClampedArray, alphaMask: Uint8Array, opacity: number
): void {
  for (let i = 0; i < dstW * dstH; i++) {
    const m = alphaMask[i];
    if (m === 0) continue;
    const idx = i * 4;
    const a = Math.round(((rgba[idx + 3] * m) / 255) * opacity);
    if (a <= 0) continue;
    const dstA = dstPixels[idx + 3];
    if (dstA === 0) {
      dstPixels[idx] = rgba[idx];
      dstPixels[idx + 1] = rgba[idx + 1];
      dstPixels[idx + 2] = rgba[idx + 2];
      dstPixels[idx + 3] = a;
    } else {
      const outA = a + dstA * (1 - a / 255);
      dstPixels[idx] = Math.round((rgba[idx] * a + dstPixels[idx] * dstA * (1 - a / 255)) / outA);
      dstPixels[idx + 1] = Math.round((rgba[idx + 1] * a + dstPixels[idx + 1] * dstA * (1 - a / 255)) / outA);
      dstPixels[idx + 2] = Math.round((rgba[idx + 2] * a + dstPixels[idx + 2] * dstA * (1 - a / 255)) / outA);
      dstPixels[idx + 3] = Math.round(outA);
    }
  }
}

/** 计算单个 stroke 在 padded dst 空间下的覆盖 alpha（与原 shape 比较的环带） */
function computeStrokeAlpha(
  origAlpha: Uint8Array, srcW: number, srcH: number,
  dstW: number, dstH: number, expand: number,
  size: number, position: 'inside' | 'center' | 'outside'
): Uint8Array {
  const paddedAlpha = copyAlphaToPadded(origAlpha, srcW, srcH, dstW, dstH, expand);
  const out = new Uint8Array(dstW * dstH);

  if (position === 'outside') {
    const dilated = dilateAlpha(paddedAlpha, dstW, dstH, size);
    for (let i = 0; i < dstW * dstH; i++) {
      out[i] = Math.max(0, dilated[i] - paddedAlpha[i]);
    }
  } else if (position === 'inside') {
    const eroded = erodeAlpha(paddedAlpha, dstW, dstH, size);
    for (let i = 0; i < dstW * dstH; i++) {
      out[i] = Math.max(0, paddedAlpha[i] - eroded[i]);
    }
  } else {
    const halfOuter = Math.ceil(size / 2);
    const halfInner = Math.floor(size / 2);
    const dilated = dilateAlpha(paddedAlpha, dstW, dstH, halfOuter);
    const eroded = erodeAlpha(paddedAlpha, dstW, dstH, halfInner);
    for (let i = 0; i < dstW * dstH; i++) {
      out[i] = Math.max(0, dilated[i] - eroded[i]);
    }
  }
  return out;
}

/** 在 dst 空间下，根据 stroke 的 fillType 生成对应 RGBA 着色源（同 dstW×dstH） */
function buildStrokeColorSource(
  dstW: number, dstH: number, expand: number,
  s: LayerEffectStroke
): Uint8ClampedArray | { type: 'solid'; r: number; g: number; b: number } {
  if (!s.fillType || s.fillType === 'color') {
    const c = s.color;
    return {
      type: 'solid',
      r: Math.round(('r' in (c ?? {})) ? (c as { r: number }).r : 0),
      g: Math.round(('g' in (c ?? {})) ? (c as { g: number }).g : 0),
      b: Math.round(('b' in (c ?? {})) ? (c as { b: number }).b : 0),
    };
  }
  // gradient stroke：按 stroke 的 angle/style 在整个 dst 空间生成渐变像素
  if (s.fillType === 'gradient' && s.gradient) {
    const info = readGradientFromEffect({
      enabled: true,
      gradient: s.gradient,
      angle: s.gradient.angle ?? 0,
      type: s.gradient.style ?? 'linear',
      reverse: s.gradient.reverse ?? false,
      opacity: 1,
      scale: s.gradient.scale ?? 1,
    });
    if (!info) {
      return { type: 'solid', r: 0, g: 0, b: 0 };
    }
    const rgba = new Uint8ClampedArray(dstW * dstH * 4);
    // 渐变在内层 srcW×srcH 区域上生成；外缘按边界外推
    const innerW = dstW - 2 * expand;
    const innerH = dstH - 2 * expand;
    for (let y = 0; y < dstH; y++) {
      for (let x = 0; x < dstW; x++) {
        const ix = x - expand;
        const iy = y - expand;
        const cx = Math.max(0, Math.min(innerW - 1, ix));
        const cy = Math.max(0, Math.min(innerH - 1, iy));
        const t = gradientParamAt(cx, cy, innerW, innerH, info);
        const samp = sampleGradient(info, t);
        const idx = (y * dstW + x) * 4;
        rgba[idx] = samp.r;
        rgba[idx + 1] = samp.g;
        rgba[idx + 2] = samp.b;
        rgba[idx + 3] = Math.round(samp.a * 255);
      }
    }
    return rgba;
  }
  // pattern stroke：暂用近似纯色 fallback（未提供 patternId 时返回黑）
  return { type: 'solid', r: 0, g: 0, b: 0 };
}

async function compositeLayerEffects(
  imageData: { data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array; width: number; height: number },
  fillOpacity: number,
  effects: LayerEffectBundle,
  patternOverlayMeta: { id: string; scale: number; opacity: number; phaseX: number; phaseY: number } | null,
  resolvedPattern: { rgba: Uint8ClampedArray; w: number; h: number } | null,
): Promise<{ png: Uint8Array; expand: number }> {
  const srcW = imageData.width;
  const srcH = imageData.height;
  const strokes = effects.strokes;

  // 计算总 expand：strokes + dropShadows + outerGlow + bevel(outer)
  const strokeExpand = computeStrokeExpansion(strokes);
  const shadowExpand = computeShadowExpansion(effects.dropShadows);
  const outerGlowExpand = effects.outerGlow ? Math.ceil(effects.outerGlow.blur + effects.outerGlow.spread) : 0;
  const bevelOuterExpand = (effects.bevel && (effects.bevel.style === 'outer bevel' || effects.bevel.style === 'emboss' || effects.bevel.style === 'pillow emboss'))
    ? Math.ceil(effects.bevel.size + effects.bevel.soften) : 0;
  const expand = Math.max(strokeExpand, shadowExpand, outerGlowExpand, bevelOuterExpand);
  const dstW = srcW + expand * 2;
  const dstH = srcH + expand * 2;

  // 准备 srcPixels（与原图同尺寸）
  const pixelCount = srcW * srcH * 4;
  const srcPixels = new Uint8ClampedArray(pixelCount);
  const srcData = imageData.data;
  if (srcData instanceof Uint8ClampedArray || srcData instanceof Uint8Array) {
    srcPixels.set(srcData.subarray(0, pixelCount));
  } else {
    for (let i = 0; i < pixelCount; i++) {
      srcPixels[i] = Math.min(255, Math.max(0, Math.round(Number(srcData[i]))));
    }
  }
  const origAlpha = extractAlpha(srcPixels, srcW, srcH);

  // 在 src 空间应用各 overlay（顺序：Pattern → Gradient → Color → Satin）
  if (effects.patternOverlay) {
    applyPatternOverlayToPixels(srcPixels, srcW, srcH, effects.patternOverlay);
  } else if (patternOverlayMeta && resolvedPattern) {
    applyPatternOverlayToPixels(srcPixels, srcW, srcH, {
      rgba: resolvedPattern.rgba,
      w: resolvedPattern.w,
      h: resolvedPattern.h,
      scale: patternOverlayMeta.scale,
      opacity: patternOverlayMeta.opacity,
      phaseX: patternOverlayMeta.phaseX,
      phaseY: patternOverlayMeta.phaseY,
    });
  }
  if (effects.gradientOverlay) {
    applyGradientOverlayToPixels(srcPixels, srcW, srcH, effects.gradientOverlay);
  }
  if (effects.solidFill) {
    applyColorOverlayToPixels(srcPixels, srcW, srcH, effects.solidFill);
  }
  if (effects.satin) {
    applySatinToPixels(srcPixels, srcW, srcH, origAlpha, effects.satin);
  }
  // Bevel 在 fill 之上、stroke 之前
  if (effects.bevel) {
    applyBevelToPixels(srcPixels, srcW, srcH, origAlpha, effects.bevel);
  }

  const dstPixels = new Uint8ClampedArray(dstW * dstH * 4);

  // 1. Drop Shadow（在最下层）
  for (const shadow of effects.dropShadows) {
    let shadowAlpha = copyAlphaToPadded(origAlpha, srcW, srcH, dstW, dstH, expand);
    if (shadow.spread > 0) {
      shadowAlpha = dilateAlpha(shadowAlpha, dstW, dstH, Math.ceil(shadow.spread));
    }
    if (shadow.blur > 0) {
      const passes = 3;
      const passRadius = shadow.blur / passes;
      for (let p = 0; p < passes; p++) {
        shadowAlpha = boxBlurAlpha(shadowAlpha, dstW, dstH, passRadius);
      }
    }
    // 偏移
    const offsetAlpha = new Uint8Array(dstW * dstH);
    for (let y = 0; y < dstH; y++) {
      for (let x = 0; x < dstW; x++) {
        const sx = x - shadow.offsetX;
        const sy = y - shadow.offsetY;
        if (sx < 0 || sx >= dstW || sy < 0 || sy >= dstH) continue;
        offsetAlpha[y * dstW + x] = shadowAlpha[sy * dstW + sx];
      }
    }
    blendColorOnto(dstPixels, dstW, dstH, offsetAlpha, shadow.r, shadow.g, shadow.b, shadow.opacity);
  }

  // 2. Outer Glow（在 fill 下）
  if (effects.outerGlow) {
    const g = effects.outerGlow;
    let glowAlpha = copyAlphaToPadded(origAlpha, srcW, srcH, dstW, dstH, expand);
    if (g.spread > 0) glowAlpha = dilateAlpha(glowAlpha, dstW, dstH, Math.ceil(g.spread));
    if (g.blur > 0) {
      const passes = 3;
      const passRadius = g.blur / passes;
      for (let p = 0; p < passes; p++) glowAlpha = boxBlurAlpha(glowAlpha, dstW, dstH, passRadius);
    }
    blendColorOnto(dstPixels, dstW, dstH, glowAlpha, g.r, g.g, g.b, g.opacity);
  }

  // 3. 合成 fill（含 overlays/satin/bevel）到 dst
  const hasFullCoverageOverlay = !!(effects.solidFill && effects.solidFill.opacity >= 1) ||
    !!(effects.gradientOverlay && effects.gradientOverlay.opacity >= 1 &&
       effects.gradientOverlay.opacityStops.every(s => s.opacity >= 1));
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const si = (y * srcW + x) * 4;
      const di = ((y + expand) * dstW + (x + expand)) * 4;
      const srcR = srcPixels[si], srcG = srcPixels[si + 1], srcB = srcPixels[si + 2];
      const rawA = srcPixels[si + 3];
      const srcA = hasFullCoverageOverlay ? rawA : Math.round(rawA * fillOpacity);
      if (srcA <= 0) continue;
      const dstA = dstPixels[di + 3];
      if (dstA === 0) {
        dstPixels[di] = srcR;
        dstPixels[di + 1] = srcG;
        dstPixels[di + 2] = srcB;
        dstPixels[di + 3] = srcA;
      } else {
        const outA = srcA + dstA * (1 - srcA / 255);
        dstPixels[di] = Math.round((srcR * srcA + dstPixels[di] * dstA * (1 - srcA / 255)) / outA);
        dstPixels[di + 1] = Math.round((srcG * srcA + dstPixels[di + 1] * dstA * (1 - srcA / 255)) / outA);
        dstPixels[di + 2] = Math.round((srcB * srcA + dstPixels[di + 2] * dstA * (1 - srcA / 255)) / outA);
        dstPixels[di + 3] = Math.round(outA);
      }
    }
  }

  // 4. Inner Shadow（在 fill 之上，但只在 alpha>0 区域可见）
  for (const inner of effects.innerShadows) {
    let invAlpha = new Uint8Array(srcW * srcH);
    for (let i = 0; i < srcW * srcH; i++) invAlpha[i] = 255 - origAlpha[i];
    let paddedInv = copyAlphaToPadded(invAlpha, srcW, srcH, dstW, dstH, expand);
    // 偏移
    const offsetInv = new Uint8Array(dstW * dstH);
    for (let y = 0; y < dstH; y++) {
      for (let x = 0; x < dstW; x++) {
        const sx = x - inner.offsetX;
        const sy = y - inner.offsetY;
        if (sx < 0 || sx >= dstW || sy < 0 || sy >= dstH) continue;
        offsetInv[y * dstW + x] = paddedInv[sy * dstW + sx];
      }
    }
    let shadowField: Uint8Array = offsetInv;
    if (inner.spread > 0) shadowField = dilateAlpha(shadowField, dstW, dstH, Math.ceil(inner.spread));
    if (inner.blur > 0) {
      const passes = 3;
      const passRadius = inner.blur / passes;
      for (let p = 0; p < passes; p++) shadowField = boxBlurAlpha(shadowField, dstW, dstH, passRadius);
    }
    // 用 origAlpha 限定在 fill 内部
    const paddedOrig = copyAlphaToPadded(origAlpha, srcW, srcH, dstW, dstH, expand);
    const final = new Uint8Array(dstW * dstH);
    for (let i = 0; i < dstW * dstH; i++) {
      final[i] = Math.round((shadowField[i] * paddedOrig[i]) / 255);
    }
    blendColorOnto(dstPixels, dstW, dstH, final, inner.r, inner.g, inner.b, inner.opacity);
  }

  // 5. Inner Glow（沿内边缘）
  if (effects.innerGlow) {
    const g = effects.innerGlow;
    // 计算到形状边缘的内部距离场，转为 0~255 envelope
    const insideD = insideDistanceField(origAlpha, srcW, srcH);
    const reach = Math.max(1, g.blur + g.spread);
    const env = new Uint8Array(srcW * srcH);
    for (let i = 0; i < srcW * srcH; i++) {
      if (origAlpha[i] < 128) continue;
      const d = insideD[i];
      // d=0 在边缘 → 255；d>=reach → 0
      const t = Math.max(0, Math.min(1, 1 - d / reach));
      env[i] = Math.round(t * 255);
    }
    let envPadded = copyAlphaToPadded(env, srcW, srcH, dstW, dstH, expand);
    if (g.blur > 0) {
      const passes = 3;
      const passRadius = g.blur / passes;
      for (let p = 0; p < passes; p++) envPadded = boxBlurAlpha(envPadded, dstW, dstH, passRadius);
    }
    // 用 origAlpha 限定在 fill 内部
    const paddedOrig = copyAlphaToPadded(origAlpha, srcW, srcH, dstW, dstH, expand);
    const final = new Uint8Array(dstW * dstH);
    for (let i = 0; i < dstW * dstH; i++) {
      final[i] = Math.round((envPadded[i] * paddedOrig[i]) / 255);
    }
    blendColorOnto(dstPixels, dstW, dstH, final, g.r, g.g, g.b, g.opacity);
  }

  // 6. Strokes（按 PSD 顺序，stroke[0] 在最上 → 反向遍历后让 stroke[0] 最后画）
  // 注：PSD stroke 数组的语义：第一个是 UI 最顶层。所以应先画 [N-1] 最后画 [0]。
  const reversedStrokes = [...strokes].reverse();
  for (const s of reversedStrokes) {
    const sw = s.size?.value ?? 0;
    if (sw <= 0) continue;
    const sOpacity = s.opacity ?? 1;
    const strokeAlpha = computeStrokeAlpha(
      origAlpha, srcW, srcH, dstW, dstH, expand, sw,
      (s.position ?? 'outside') as 'inside' | 'center' | 'outside'
    );
    const colorSrc = buildStrokeColorSource(dstW, dstH, expand, s);
    if (Array.isArray(colorSrc) || colorSrc instanceof Uint8ClampedArray) {
      blendRgbaOnto(dstPixels, dstW, dstH, colorSrc as Uint8ClampedArray, strokeAlpha, sOpacity);
    } else {
      blendColorOnto(dstPixels, dstW, dstH, strokeAlpha, colorSrc.r, colorSrc.g, colorSrc.b, sOpacity);
    }
  }

  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = dstW;
  dstCanvas.height = dstH;
  const ctx = dstCanvas.getContext('2d')!;
  ctx.putImageData(new ImageData(dstPixels, dstW, dstH), 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    dstCanvas.toBlob(b => b ? resolve(b) : reject(new Error('Failed to encode composite PNG')), 'image/png');
  });
  const buf = await blob.arrayBuffer();
  return { png: new Uint8Array(buf), expand };
}

async function serializeLayer(
  layer: Layer,
  images: Uint8Array[],
  onProgress: (p: ParseProgress) => void,
  depth: number,
  parentLeft: number,
  parentTop: number,
  rootLeft?: number,
  rootTop?: number
): Promise<SerializedLayer> {
  const type = determineLayerType(layer);

  const bounds = getLayerBounds(layer);
  let absX: number, absY: number, width: number, height: number;

  let isArtboard = false;
  if (type === 'group') {
    const ab = getArtboardBounds(layer);
    isArtboard = !!ab;
    if (ab) {
      absX = ab.left;
      absY = ab.top;
      width = ab.right - ab.left;
      height = ab.bottom - ab.top;
    } else {
      absX = bounds.left;
      absY = bounds.top;
      const gb = computeGroupBounds(layer);
      width = Math.max(gb.right - bounds.left, bounds.right - bounds.left, 0);
      height = Math.max(gb.bottom - bounds.top, bounds.bottom - bounds.top, 0);
    }
  } else {
    absX = bounds.left;
    absY = bounds.top;
    width = bounds.right - bounds.left;
    height = bounds.bottom - bounds.top;
  }

  const isSubGroup = type === 'group' && depth > 0 && !isArtboard;
  const effectiveRootLeft = rootLeft ?? absX;
  const effectiveRootTop = rootTop ?? absY;

  let relX: number, relY: number;
  if (isSubGroup) {
    relX = 0;
    relY = 0;
  } else {
    relX = absX - parentLeft;
    relY = absY - parentTop;
  }

  const serialized: SerializedLayer = {
    id: `layer-${images.length}-${depth}-${layer.name ?? 'unnamed'}`,
    name: layer.name ?? 'Unnamed Layer',
    type,
    x: relX,
    y: relY,
    width: isSubGroup ? 0.01 : Math.max(0, width),
    height: isSubGroup ? 0.01 : Math.max(0, height),
    opacity: layer.opacity ?? 1,
    blendMode: convertBlendMode(layer.blendMode),
    visible: !layer.hidden,
    clipped: !!layer.clipping,
    isArtboard,
    isSubGroup: isSubGroup || undefined,
    effects: convertEffects(layer.effects),
    strokes: convertStrokes(layer.effects),
  };


  if (layer.vectorOrigination) {
    for (const desc of layer.vectorOrigination.keyDescriptorList) {
      if (desc.keyOriginRRectRadii) {
        const r = desc.keyOriginRRectRadii;
        serialized.cornerRadii = {
          topLeft: r.topLeft.value,
          topRight: r.topRight.value,
          bottomLeft: r.bottomLeft.value,
          bottomRight: r.bottomRight.value,
        };
        break;
      }
    }
  }

  if (type === 'text' && layer.text) {
    serialized.textData = convertTextData(layer.text);

    if (serialized.textData.docBboxCenterX != null) {
      serialized.textData.docBboxCenterX -= parentLeft;
    }
    if (serialized.textData.docBoundsY != null) {
      serialized.textData.docBoundsY -= parentTop;
    }

    const solidFills = (layer.effects as any)?.solidFill;
    if (solidFills && serialized.textData) {
      for (const sf of solidFills) {
        if (sf.enabled && sf.color) {
          const overlayColor = toColor(sf.color);
          const overlayOpacity = sf.opacity ?? 1;
          for (const style of serialized.textData.styles) {
            style.color = { ...overlayColor, a: overlayColor.a * overlayOpacity };
          }
          break;
        }
      }
    }

    const gradOverlays = layer.effects?.gradientOverlay;
    if (gradOverlays && serialized.textData) {
      for (const go of gradOverlays) {
        if (!go.enabled) continue;
        const grad = go.gradient;
        if (!grad || grad.type !== 'solid') continue;

        const typeMap: Record<string, 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond'> = {
          'linear': 'linear', 'radial': 'radial', 'angle': 'angle',
          'reflected': 'reflected', 'diamond': 'diamond',
        };
        const stops = grad.colorStops.map(cs => ({
          color: toColor(cs.color),
          position: cs.location,
        }));

        serialized.textData.gradientOverlay = {
          type: typeMap[go.type ?? 'linear'] ?? 'linear',
          angle: go.angle ?? 90,
          stops,
          reverse: go.reverse ?? false,
          opacity: go.opacity ?? 1,
        };
        break;
      }
    }

    const textHasStroke = getEnabledStrokes(layer).length > 0;
    const textHasGradOverlay = !!getEnabledGradientOverlay(layer);
    logger.info(`Layer "${layer.name}": text (stroke=${textHasStroke}, gradient=${textHasGradOverlay}), font="${layer.text.style?.font?.name ?? 'unknown'}"`);
  }

  // 收集图层效果 bundle（用于位图合成分支）
  const layerFillOpacity = (layer as any).fillOpacity ?? 1;
  const effectBundle: LayerEffectBundle = {
    strokes: getEnabledStrokes(layer),
    fillOpacity: layerFillOpacity,
    solidFill: getEnabledSolidFill(layer),
    gradientOverlay: getEnabledGradientOverlay(layer),
    patternOverlay: null,
    bevel: getEnabledBevel(layer),
    satin: getEnabledSatin(layer),
    dropShadows: getEnabledDropShadows(layer),
    innerShadows: getEnabledInnerShadows(layer),
    outerGlow: getEnabledOuterGlow(layer),
    innerGlow: getEnabledInnerGlow(layer),
  };
  const patternOverlayMeta = getPatternOverlayMeta(layer);
  let resolvedPatternData: { rgba: Uint8ClampedArray; w: number; h: number } | null = null;
  if (patternOverlayMeta) {
    resolvedPatternData = await resolvePatternData(patternOverlayMeta.id, layer, undefined);
  }

  if (serialized.type !== 'text' && layer.imageData && layer.imageData.width > 0 && layer.imageData.height > 0) {
    onProgress({ percent: 0, message: `Encoding image: ${layer.name}` });
    try {
      const maskedData = applyLayerMask(layer.imageData, layer);
      const effectiveImageData = maskedData ?? layer.imageData;
      const needsComposite = hasAnyEffect(effectBundle) || !!patternOverlayMeta;

      if (needsComposite) {
        const { png, expand } = await compositeLayerEffects(effectiveImageData, layerFillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData);
        serialized.imageIndex = images.length;
        images.push(png);
        if (expand > 0) {
          serialized.expandOffset = expand;
        }
        serialized.strokes = [];
        // 已合成到位图的 effects 从 IR 中去除，避免重复
        serialized.effects = [];
        logger.info(`Layer "${layer.name}": composited with ${effectBundle.strokes.length} strokes, ${effectBundle.dropShadows.length} shadows, fillOpacity=${layerFillOpacity}, expand=${expand} (${serialized.width}x${serialized.height})`);
      } else {
        const png = await imageDataToPng(effectiveImageData);
        serialized.imageIndex = images.length;
        images.push(png);
        logger.info(`Layer "${layer.name}": encoded imageData (${effectiveImageData.width}x${effectiveImageData.height})`);
      }
    } catch (e) {
      logger.warn(`Failed to encode imageData for "${layer.name}": ${e instanceof Error ? e.message : e}`);
    }
  } else if (serialized.type !== 'text' && layer.canvas) {
    onProgress({ percent: 0, message: `Encoding canvas: ${layer.name}` });
    try {
      const cvs = layer.canvas as HTMLCanvasElement;
      const cctx = cvs.getContext('2d')!;
      const rawCanvasData = cctx.getImageData(0, 0, cvs.width, cvs.height);
      const maskedCanvasData = applyLayerMask(rawCanvasData, layer);
      const effectiveCanvasData = maskedCanvasData ?? rawCanvasData;
      const needsComposite = hasAnyEffect(effectBundle) || !!patternOverlayMeta;

      if (needsComposite && cvs.width > 0 && cvs.height > 0) {
        const { png, expand } = await compositeLayerEffects(effectiveCanvasData, layerFillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData);
        serialized.imageIndex = images.length;
        images.push(png);
        if (expand > 0) {
          serialized.expandOffset = expand;
        }
        serialized.strokes = [];
        serialized.effects = [];
        logger.info(`Layer "${layer.name}": composited canvas with ${effectBundle.strokes.length} strokes, ${effectBundle.dropShadows.length} shadows, fillOpacity=${layerFillOpacity}, expand=${expand} (${serialized.width}x${serialized.height})`);
      } else {
        const png = maskedCanvasData ? await imageDataToPng(effectiveCanvasData) : await canvasToPng(cvs);
        serialized.imageIndex = images.length;
        images.push(png);
        logger.info(`Layer "${layer.name}": encoded canvas${maskedCanvasData ? ' (masked)' : ''}`);
      }
    } catch (e) {
      logger.warn(`Failed to encode canvas for "${layer.name}": ${e instanceof Error ? e.message : e}`);
    }
  } else {
  }

  if (layer.children && layer.children.length > 0) {
    serialized.children = [];
    const childParentLeft = isSubGroup ? parentLeft : absX;
    const childParentTop = isSubGroup ? parentTop : absY;
    for (const child of layer.children) {
      serialized.children.push(
        await serializeLayer(child, images, onProgress, depth + 1, childParentLeft, childParentTop, effectiveRootLeft, effectiveRootTop)
      );
    }
  }

  return serialized;
}

export async function parsePsdFile(
  buffer: ArrayBuffer,
  onProgress: (p: ParseProgress) => void
): Promise<SerializedPsd> {
  logger.info('Parsing PSD structure...');
  onProgress({ percent: 5, message: 'Parsing PSD structure...' });

  const psd = readPsd(buffer, {
    useImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
    logMissingFeatures: false,
  });

  logger.info(`PSD structure parsed: ${psd.width}x${psd.height}, ${psd.children?.length ?? 0} top-level layers`);
  onProgress({ percent: 20, message: 'PSD structure parsed. Processing layers...' });

  const images: Uint8Array[] = [];
  const layers: SerializedLayer[] = [];

  if (psd.children) {
    const total = psd.children.length;


    for (let i = 0; i < psd.children.length; i++) {
      const layerName = psd.children[i].name ?? 'unnamed';
      logger.info(`Processing top-level layer ${i + 1}/${total}: "${layerName}"`);
      onProgress({
        percent: 20 + Math.round(((i + 1) / total) * 60),
        message: `Processing layer ${i + 1}/${total}: ${layerName}`,
      });

      layers.push(
        await serializeLayer(psd.children[i], images, onProgress, 0, 0, 0)
      );
    }
  }

  logger.info(`Layers processed. Total serialized layers: ${layers.length}, images: ${images.length}`);
  onProgress({ percent: 85, message: 'Layers processed. Preparing transfer...' });

  const base64Images: string[] = images.map((img) => uint8ArrayToBase64(img));

  return {
    name: '',
    width: psd.width,
    height: psd.height,
    engineData: psd.engineData,
    layers,
    images: base64Images,
  };
}
