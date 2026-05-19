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
  const paragraphAutoLeadingRatio = text.paragraphStyle?.autoLeading
    ?? text.paragraphStyleRuns?.[0]?.style?.autoLeading
    ?? 1.2;
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
        resolvedLeading = text.shapeType === 'box' ? scaledFontSize * paragraphAutoLeadingRatio : null;
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
      resolvedLeading = text.shapeType === 'box' ? scaledFontSize * paragraphAutoLeadingRatio : null;
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

  const result: SerializedTextData = { text: fullText, horizontalAlignment: alignment, styles, transformScale: txScale, rotation, docBoundsY, docBboxCenterX };

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
  return layer.effects.stroke.filter(s => s.enabled && s.fillType === 'color');
}

interface DropShadowCompositeInfo {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  r: number;
  g: number;
  b: number;
  opacity: number;
}

function getEnabledDropShadows(layer: Layer): DropShadowCompositeInfo[] {
  if (!layer.effects || layer.effects.disabled || !layer.effects.dropShadow) return [];
  const result: DropShadowCompositeInfo[] = [];
  for (const ds of layer.effects.dropShadow) {
    if (!ds.enabled) continue;
    const angle = ((ds.angle ?? 120) * Math.PI) / 180;
    const distance = ds.distance?.value ?? 0;
    const c = ds.color;
    const size = ds.size?.value ?? 0;
    const chokePct = (ds.choke?.value ?? 0) / 100;
    result.push({
      offsetX: Math.round(Math.cos(angle) * distance),
      offsetY: Math.round(Math.sin(angle) * distance),
      blur: size * (1 - chokePct),
      spread: size * chokePct,
      r: Math.round(('r' in (c ?? {})) ? (c as { r: number }).r : 0),
      g: Math.round(('g' in (c ?? {})) ? (c as { g: number }).g : 0),
      b: Math.round(('b' in (c ?? {})) ? (c as { b: number }).b : 0),
      opacity: (ds as { opacity?: number }).opacity ?? 1,
    });
  }
  return result;
}

function computeShadowExpansion(shadows: DropShadowCompositeInfo[]): number {
  let expand = 0;
  for (const s of shadows) {
    const reach = s.blur + s.spread + Math.max(Math.abs(s.offsetX), Math.abs(s.offsetY));
    expand = Math.max(expand, Math.ceil(reach));
  }
  return expand;
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

interface GradientOverlayInfo {
  angle: number;
  reverse: boolean;
  colorStops: GradientStop[];
  opacityStops: GradientOpacityStop[];
  opacity: number;
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

function getEnabledGradientOverlay(layer: Layer): GradientOverlayInfo | null {
  if (!layer.effects || layer.effects.disabled) return null;
  const overlays = (layer.effects as any).gradientOverlay;
  if (!Array.isArray(overlays)) return null;
  for (const go of overlays) {
    if (!go.enabled || !go.gradient) continue;
    const g = go.gradient;
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
    };
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

function applyGradientOverlayToPixels(
  pixels: Uint8ClampedArray,
  w: number, h: number,
  grad: GradientOverlayInfo
): void {
  const angleRad = grad.angle * Math.PI / 180;
  const dx = Math.cos(angleRad);
  const dy = -Math.sin(angleRad);
  const cx = w / 2, cy = h / 2;
  const halfLen = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (pixels[idx + 3] === 0) continue;

      const px = x - cx, py = y - cy;
      const proj = px * dx + py * dy;
      let t = halfLen === 0 ? 0.5 : (proj + halfLen) / (2 * halfLen);
      if (grad.reverse) t = 1 - t;
      t = Math.max(0, Math.min(1, t));

      const c = interpolateGradientColor(grad.colorStops, t);
      const opac = interpolateGradientOpacity(grad.opacityStops, t) * grad.opacity;

      if (opac >= 1) {
        pixels[idx] = c.r;
        pixels[idx + 1] = c.g;
        pixels[idx + 2] = c.b;
      } else {
        pixels[idx] = Math.round(pixels[idx] * (1 - opac) + c.r * opac);
        pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - opac) + c.g * opac);
        pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - opac) + c.b * opac);
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

async function compositeLayerEffects(
  imageData: { data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array; width: number; height: number },
  strokes: LayerEffectStroke[],
  fillOpacity: number,
  solidFill?: ColorOverlayInfo | null,
  gradientOverlay?: GradientOverlayInfo | null,
  dropShadows?: DropShadowCompositeInfo[],
): Promise<{ png: Uint8Array; expand: number }> {
  const srcW = imageData.width;
  const srcH = imageData.height;
  const strokeExpand = computeStrokeExpansion(strokes);
  const shadowExpand = dropShadows ? computeShadowExpansion(dropShadows) : 0;
  const expand = Math.max(strokeExpand, shadowExpand);
  const dstW = srcW + expand * 2;
  const dstH = srcH + expand * 2;

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

  if (solidFill) {
    applyColorOverlayToPixels(srcPixels, srcW, srcH, solidFill);
  }
  if (gradientOverlay) {
    applyGradientOverlayToPixels(srcPixels, srcW, srcH, gradientOverlay);
  }

  const dstPixels = new Uint8ClampedArray(dstW * dstH * 4);

  if (dropShadows && dropShadows.length > 0) {
    const paddedAlpha = new Uint8Array(dstW * dstH);
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        paddedAlpha[(y + expand) * dstW + (x + expand)] = origAlpha[y * srcW + x];
      }
    }

    for (const shadow of dropShadows) {
      let shadowAlpha: Uint8Array;

      if (shadow.spread > 0) {
        shadowAlpha = dilateAlpha(paddedAlpha, dstW, dstH, Math.ceil(shadow.spread));
      } else {
        shadowAlpha = new Uint8Array(paddedAlpha);
      }

      if (shadow.blur > 0) {
        const passes = 3;
        const passRadius = shadow.blur / passes;
        for (let p = 0; p < passes; p++) {
          shadowAlpha = boxBlurAlpha(shadowAlpha, dstW, dstH, passRadius);
        }
      }

      for (let y = 0; y < dstH; y++) {
        for (let x = 0; x < dstW; x++) {
          const srcX = x - shadow.offsetX;
          const srcY = y - shadow.offsetY;
          if (srcX < 0 || srcX >= dstW || srcY < 0 || srcY >= dstH) continue;
          const a = Math.round(shadowAlpha[srcY * dstW + srcX] * shadow.opacity);
          if (a <= 0) continue;
          const idx = (y * dstW + x) * 4;
          const dstA = dstPixels[idx + 3];
          if (dstA === 0) {
            dstPixels[idx] = shadow.r;
            dstPixels[idx + 1] = shadow.g;
            dstPixels[idx + 2] = shadow.b;
            dstPixels[idx + 3] = a;
          } else {
            const outA = a + dstA * (1 - a / 255);
            dstPixels[idx] = Math.round((shadow.r * a + dstPixels[idx] * dstA * (1 - a / 255)) / outA);
            dstPixels[idx + 1] = Math.round((shadow.g * a + dstPixels[idx + 1] * dstA * (1 - a / 255)) / outA);
            dstPixels[idx + 2] = Math.round((shadow.b * a + dstPixels[idx + 2] * dstA * (1 - a / 255)) / outA);
            dstPixels[idx + 3] = Math.round(outA);
          }
        }
      }
    }
  }

  for (const s of strokes) {
    const sw = s.size?.value ?? 0;
    if (sw <= 0) continue;
    const c = s.color;
    const sr = Math.round(('r' in (c ?? {})) ? (c as { r: number }).r : 0);
    const sg = Math.round(('g' in (c ?? {})) ? (c as { g: number }).g : 0);
    const sb = Math.round(('b' in (c ?? {})) ? (c as { b: number }).b : 0);
    const sOpacity = s.opacity ?? 1;

    let strokeAlpha: Uint8Array;

    if (s.position === 'outside') {
      const dilatedW = srcW + expand * 2;
      const dilatedH = srcH + expand * 2;
      const paddedAlpha = new Uint8Array(dilatedW * dilatedH);
      for (let y = 0; y < srcH; y++) {
        for (let x = 0; x < srcW; x++) {
          paddedAlpha[(y + expand) * dilatedW + (x + expand)] = origAlpha[y * srcW + x];
        }
      }
      const dilated = dilateAlpha(paddedAlpha, dilatedW, dilatedH, sw);
      strokeAlpha = new Uint8Array(dstW * dstH);
      for (let i = 0; i < dstW * dstH; i++) {
        const da = dilated[i];
        const oa = paddedAlpha[i];
        strokeAlpha[i] = Math.max(0, da - oa);
      }
    } else if (s.position === 'inside') {
      const eroded = erodeAlpha(origAlpha, srcW, srcH, sw);
      strokeAlpha = new Uint8Array(dstW * dstH);
      for (let y = 0; y < srcH; y++) {
        for (let x = 0; x < srcW; x++) {
          const oa = origAlpha[y * srcW + x];
          const ea = eroded[y * srcW + x];
          strokeAlpha[(y + expand) * dstW + (x + expand)] = Math.max(0, oa - ea);
        }
      }
    } else {
      const halfOuter = Math.ceil(sw / 2);
      const halfInner = Math.floor(sw / 2);
      const paddedAlpha = new Uint8Array(dstW * dstH);
      for (let y = 0; y < srcH; y++) {
        for (let x = 0; x < srcW; x++) {
          paddedAlpha[(y + expand) * dstW + (x + expand)] = origAlpha[y * srcW + x];
        }
      }
      const dilated = dilateAlpha(paddedAlpha, dstW, dstH, halfOuter);
      const eroded = erodeAlpha(paddedAlpha, dstW, dstH, halfInner);
      strokeAlpha = new Uint8Array(dstW * dstH);
      for (let i = 0; i < dstW * dstH; i++) {
        strokeAlpha[i] = Math.max(0, dilated[i] - eroded[i]);
      }
    }

    for (let i = 0; i < dstW * dstH; i++) {
      const a = Math.round(strokeAlpha[i] * sOpacity);
      if (a <= 0) continue;
      const idx = i * 4;
      const dstA = dstPixels[idx + 3];
      if (dstA === 0) {
        dstPixels[idx] = sr;
        dstPixels[idx + 1] = sg;
        dstPixels[idx + 2] = sb;
        dstPixels[idx + 3] = a;
      } else {
        const outA = a + dstA * (1 - a / 255);
        dstPixels[idx] = Math.round((sr * a + dstPixels[idx] * dstA * (1 - a / 255)) / outA);
        dstPixels[idx + 1] = Math.round((sg * a + dstPixels[idx + 1] * dstA * (1 - a / 255)) / outA);
        dstPixels[idx + 2] = Math.round((sb * a + dstPixels[idx + 2] * dstA * (1 - a / 255)) / outA);
        dstPixels[idx + 3] = Math.round(outA);
      }
    }
  }

  const hasFullCoverageOverlay = !!(solidFill && solidFill.opacity >= 1) ||
    !!(gradientOverlay && gradientOverlay.opacity >= 1 &&
       gradientOverlay.opacityStops.every(s => s.opacity >= 1));

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

    const solidFills = layer.effects?.solidFill;
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

    logger.info(`Layer "${layer.name}": text, font="${layer.text.style?.font?.name ?? 'unknown'}"`);
  }

  if (type !== 'text' && layer.imageData && layer.imageData.width > 0 && layer.imageData.height > 0) {
    onProgress({ percent: 0, message: `Encoding image: ${layer.name}` });
    try {
      const maskedData = applyLayerMask(layer.imageData, layer);
      const effectiveImageData = maskedData ?? layer.imageData;

      const enabledStrokes = getEnabledStrokes(layer);
      const enabledDropShadows = getEnabledDropShadows(layer);
      const layerFillOpacity = (layer as any).fillOpacity ?? 1;
      const solidFill = getEnabledSolidFill(layer);
      const gradOverlay = getEnabledGradientOverlay(layer);
      const needsComposite = enabledStrokes.length > 0 || layerFillOpacity < 1 || !!solidFill || !!gradOverlay || enabledDropShadows.length > 0;

      if (needsComposite) {
        const { png, expand } = await compositeLayerEffects(effectiveImageData, enabledStrokes, layerFillOpacity, solidFill, gradOverlay, enabledDropShadows);
        serialized.imageIndex = images.length;
        images.push(png);
        if (expand > 0) {
          serialized.expandOffset = expand;
        }
        serialized.strokes = [];
        if (enabledDropShadows.length > 0) {
          serialized.effects = serialized.effects.filter(e => e.type !== 'drop');
        }
        logger.info(`Layer "${layer.name}": composited with ${enabledStrokes.length} strokes, ${enabledDropShadows.length} shadows, fillOpacity=${layerFillOpacity}, expand=${expand} (${serialized.width}x${serialized.height})`);
      } else {
        const png = await imageDataToPng(effectiveImageData);
        serialized.imageIndex = images.length;
        images.push(png);
        logger.info(`Layer "${layer.name}": encoded imageData (${effectiveImageData.width}x${effectiveImageData.height})`);
      }
    } catch (e) {
      logger.warn(`Failed to encode imageData for "${layer.name}": ${e instanceof Error ? e.message : e}`);
    }
  } else if (type !== 'text' && layer.canvas) {
    onProgress({ percent: 0, message: `Encoding canvas: ${layer.name}` });
    try {
      const cvs = layer.canvas as HTMLCanvasElement;
      const cctx = cvs.getContext('2d')!;
      const rawCanvasData = cctx.getImageData(0, 0, cvs.width, cvs.height);
      const maskedCanvasData = applyLayerMask(rawCanvasData, layer);
      const effectiveCanvasData = maskedCanvasData ?? rawCanvasData;

      const enabledStrokes = getEnabledStrokes(layer);
      const enabledDropShadowsC = getEnabledDropShadows(layer);
      const layerFillOpacity = (layer as any).fillOpacity ?? 1;
      const solidFill = getEnabledSolidFill(layer);
      const gradOverlay = getEnabledGradientOverlay(layer);
      const needsComposite = enabledStrokes.length > 0 || layerFillOpacity < 1 || !!solidFill || !!gradOverlay || enabledDropShadowsC.length > 0;

      if (needsComposite && cvs.width > 0 && cvs.height > 0) {
        const { png, expand } = await compositeLayerEffects(effectiveCanvasData, enabledStrokes, layerFillOpacity, solidFill, gradOverlay, enabledDropShadowsC);
        serialized.imageIndex = images.length;
        images.push(png);
        if (expand > 0) {
          serialized.expandOffset = expand;
        }
        serialized.strokes = [];
        if (enabledDropShadowsC.length > 0) {
          serialized.effects = serialized.effects.filter(e => e.type !== 'drop');
        }
        logger.info(`Layer "${layer.name}": composited canvas with ${enabledStrokes.length} strokes, ${enabledDropShadowsC.length} shadows, fillOpacity=${layerFillOpacity}, expand=${expand} (${serialized.width}x${serialized.height})`);
      } else {
        const png = maskedCanvasData ? await imageDataToPng(effectiveCanvasData) : await canvasToPng(cvs);
        serialized.imageIndex = images.length;
        images.push(png);
        logger.info(`Layer "${layer.name}": encoded canvas${maskedCanvasData ? ' (masked)' : ''}`);
      }
    } catch (e) {
      logger.warn(`Failed to encode canvas for "${layer.name}": ${e instanceof Error ? e.message : e}`);
    }
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
    layers,
    images: base64Images,
  };
}
