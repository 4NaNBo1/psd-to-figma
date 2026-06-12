import { readPsd } from 'ag-psd';
import type { Psd, Layer, LayerTextData, Color, LayerEffectStroke, LayerEffectShadow } from 'ag-psd';
import type {
  SerializedPsd,
  SerializedLayer,
  SerializedTextData,
  SerializedTextStyle,
  SerializedColor,
  SerializedTextCase,
  SerializedWarp,
  SerializedPattern,
  SerializedFill,
  SerializedGradientOverlay,
  LayerType,
} from '../types/psd-types';
import { convertEffects, convertStrokes } from '../converter/effect-converter';
import { convertBlendMode } from '../converter/blend-converter';
import { logger } from '../logger';

export interface ParseProgress {
  percent: number;
  message: string;
}

// PSD 全局 pattern 资源表（Patt 块，已通过 ag-psd patch 启用解析）。
// patternOverlay 只引用 pattern id，像素数据存在这里 / layer.patterns 中。
// 在 parsePsdFile 入口设置，供 resolvePatternData 跨递归层级取用。
let globalPsdPatterns: { id: string; name?: string; x?: number; y?: number; bounds: { x?: number; y?: number; w: number; h: number }; data: Uint8Array }[] | undefined;

// PSD 智能对象内嵌源文件表（lnk2/lnkD 块）。placedLayer.id 引用其中的 linkedFile.id。
// 在 parsePsdFile 入口设置，供「智能对象带模糊滤镜时用源重渲染清晰像素」跨递归取用。
let globalPsdLinkedFiles: { id?: string; name?: string; data?: Uint8Array }[] | undefined;

// 智能对象内嵌源解码缓存（按 placedLayer.id）。多个实例（如 cions 组 4 枚 coin）常共享同一源，
// 大 PSB 解码昂贵，缓存避免重复 readPsd。null 表示该源解码失败/不可用，不再重试。
// transparentFrac：源（降采样采样）中 alpha<250 的像素占比，用于判断源是否「带白底的扁平合成」
// （占比≈0 = 不透明白底，源像素不等于该层实际像素，重渲染会得到白块，须拒绝）。
type SmartObjectSource = { canvas: HTMLCanvasElement; sw: number; sh: number; transparentFrac: number };
let globalSmartObjectSourceCache: Map<string, SmartObjectSource | null> | undefined;

/**
 * 效果原生化总开关。true：整层若所有效果都能与 PS 像素级一致地原生化，则保留为平台可编辑
 * 属性（effects/strokes/overlay fill）而非烤进位图；false：退回旧「全合成」行为。
 * 出问题时置 false 可快速回退。详见 docs / 计划文件「PSD 图层效果原生化」。
 */
const ENABLE_EFFECT_NATIVIZATION = true;

/** color/gradient overlay 原生化要求图层像素近似填满 bbox 的最小不透明覆盖率（见 canNativizeLayer 难点 2）。 */
const OVERLAY_NATIVIZE_MIN_COVERAGE = 0.98;

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

// ── 调整图层像素处理 ──────────────────────────────────
// PS 调整图层（hue/saturation, brightness/contrast, vibrance 等）通过 clipping
// 蒙版修改基底图层的像素颜色。Figma/MasterGo 不支持调整图层，因此在解析时
// 直接将调整效果应用到基底图层的 imageData 上。

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function applyHueSaturation(
  data: Uint8ClampedArray | Uint8Array, w: number, h: number,
  adj: { master?: { hue?: number; saturation?: number; lightness?: number } }
): void {
  const hueShift = ((adj.master?.hue ?? 0) / 360);
  const satShift = (adj.master?.saturation ?? 0) / 100;
  const lightShift = (adj.master?.lightness ?? 0) / 100;
  if (hueShift === 0 && satShift === 0 && lightShift === 0) return;
  for (let i = 0; i < w * h * 4; i += 4) {
    if (data[i + 3] === 0) continue;
    let [hv, sv, lv] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    hv = ((hv + hueShift) % 1 + 1) % 1;
    sv = Math.max(0, Math.min(1, sv + satShift));
    lv = Math.max(0, Math.min(1, lv + lightShift));
    const [nr, ng, nb] = hslToRgb(hv, sv, lv);
    data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
  }
}

function applyBrightnessContrast(
  data: Uint8ClampedArray | Uint8Array, w: number, h: number,
  adj: { brightness?: number; contrast?: number; useLegacy?: boolean }
): void {
  const brightness = adj.brightness ?? 0;
  const contrast = adj.contrast ?? 0;
  if (brightness === 0 && contrast === 0) return;

  // PS「亮度/对比度」分两套算法：
  //   - useLegacy=true（旧版）：brightness 线性平移 + contrast 绕 128 线性缩放。
  //   - useLegacy=false（CS3+ 新版，默认）：brightness 是「向端点收敛」的曲线——
  //     亮度提升时 255 端不动、越亮提升越小（亮部不被削平为纯白），暗度降低时 0 端不动。
  // 旧版公式对集中在中高调的图像（如金属高光的 coin）会把亮部大面积 clip 到 255，
  // 导致丢失层次、视觉发白发糊。新版按 useLegacy=false 走端点保护曲线，贴近 PS 渲染。
  const useLegacy = adj.useLegacy === true;

  // brightness 映射：legacy 为加常数；新版为向端点收敛的线性比例（b/255）。
  const bNorm = brightness / 255;
  const applyBrightness = useLegacy
    ? (v: number) => v + brightness
    : brightness >= 0
      ? (v: number) => v + (255 - v) * bNorm   // 255 端不动，亮部提升递减
      : (v: number) => v + v * bNorm;          // 0 端不动，暗部压暗递减

  // contrast 绕 128 线性缩放（contrast=0 时 factor=1，无影响）。新旧版对 contrast 的处理
  // 在本项目暂统一用此式；如遇 useLegacy=false 且 contrast≠0 的精度问题再细分。
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

  for (let i = 0; i < w * h * 4; i += 4) {
    if (data[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      let v = applyBrightness(data[i + c]);
      v = factor * (v - 128) + 128;
      data[i + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
}

function applyVibrance(
  data: Uint8ClampedArray | Uint8Array, w: number, h: number,
  adj: { vibrance?: number; saturation?: number }
): void {
  const vib = (adj.vibrance ?? 0) / 100;
  const sat = (adj.saturation ?? 0) / 100;
  if (vib === 0 && sat === 0) return;
  for (let i = 0; i < w * h * 4; i += 4) {
    if (data[i + 3] === 0) continue;
    let [hv, sv, lv] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (sat !== 0) sv = Math.max(0, Math.min(1, sv + sat));
    if (vib !== 0) {
      const boost = vib * (1 - sv);
      sv = Math.max(0, Math.min(1, sv + boost));
    }
    const [nr, ng, nb] = hslToRgb(hv, sv, lv);
    data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
  }
}

/**
 * 提取调整图层 mask 在「基底层像素坐标系」下的逐像素 alpha 查询函数。
 * 返回 null 表示无真实空间蒙版（应全图应用）。
 * baseLeft/baseTop 为基底层文档坐标原点，用于把基底像素 (x,y) 映射到 mask 像素。
 */
function getMaskAlphaLookup(
  mask: any, baseLeft: number, baseTop: number
): ((x: number, y: number) => number) | null {
  if (!mask || mask.disabled) return null;
  const md = mask.imageData;
  let maskPixels: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array | null = null;
  let maskW = 0, maskH = 0;
  if (md && md.width > 0 && md.height > 0) {
    maskPixels = md.data;
    maskW = md.width;
    maskH = md.height;
  } else if (mask.canvas && mask.canvas.width > 0) {
    const cvs = mask.canvas as HTMLCanvasElement;
    const mData = cvs.getContext('2d')!.getImageData(0, 0, cvs.width, cvs.height);
    maskPixels = mData.data;
    maskW = cvs.width;
    maskH = cvs.height;
  }
  // 无像素数据 → 退化为全图（defaultColor），不是真实空间蒙版
  if (!maskPixels || maskW === 0 || maskH === 0) return null;
  const maskLeft = mask.left ?? 0;
  const maskTop = mask.top ?? 0;
  const defaultColor = mask.defaultColor ?? 255;
  const stride = maskPixels.length === maskW * maskH ? 1 : 4;
  return (x: number, y: number): number => {
    const mx = baseLeft + x - maskLeft;
    const my = baseTop + y - maskTop;
    if (mx >= 0 && mx < maskW && my >= 0 && my < maskH) {
      return Number(maskPixels![(my * maskW + mx) * stride]);
    }
    return defaultColor;
  };
}

/**
 * 把调整图层的真实空间蒙版序列化为紧凑结构（单通道 alpha base64 + 几何）。
 * 无真实像素蒙版（空 mask / 全 defaultColor）返回 null，导出时不还原（与原始 no-op 等价）。
 */
function serializeAdjustmentMask(mask: any): {
  left: number; top: number; width: number; height: number; defaultColor: number; dataB64: string;
} | null {
  if (!mask || mask.disabled) return null;
  let pixels: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array | null = null;
  let mW = 0, mH = 0;
  if (mask.imageData && mask.imageData.width > 0 && mask.imageData.height > 0) {
    pixels = mask.imageData.data;
    mW = mask.imageData.width;
    mH = mask.imageData.height;
  } else if (mask.canvas && mask.canvas.width > 0) {
    const cvs = mask.canvas as HTMLCanvasElement;
    pixels = cvs.getContext('2d')!.getImageData(0, 0, cvs.width, cvs.height).data;
    mW = cvs.width;
    mH = cvs.height;
  }
  if (!pixels || mW === 0 || mH === 0) return null;
  const stride = pixels.length === mW * mH ? 1 : 4;
  // 抽取单通道 alpha
  const single = new Uint8Array(mW * mH);
  for (let i = 0; i < mW * mH; i++) single[i] = Math.max(0, Math.min(255, Math.round(Number(pixels[i * stride]))));
  return {
    left: mask.left ?? 0,
    top: mask.top ?? 0,
    width: mW,
    height: mH,
    defaultColor: mask.defaultColor ?? 255,
    dataB64: uint8ArrayToBase64(single),
  };
}

function applyAdjustmentLayers(baseLayer: Layer, clippedLayers: Layer[]): void {
  if (!baseLayer.imageData || baseLayer.imageData.width === 0) return;
  const data = baseLayer.imageData.data;
  if (!(data instanceof Uint8ClampedArray) && !(data instanceof Uint8Array)) return;
  const w = baseLayer.imageData.width;
  const h = baseLayer.imageData.height;
  const baseLeft = baseLayer.left ?? 0;
  const baseTop = baseLayer.top ?? 0;

  for (const clip of clippedLayers) {
    const adj = (clip as any).adjustment;
    if (!adj) continue;

    const maskAlphaAt = getMaskAlphaLookup((clip as any).mask, baseLeft, baseTop);

    // 有真实空间蒙版时：在副本上算出"全图应用"结果，再按 mask alpha 与原像素逐像素混合，
    // 使调整只在蒙版生效区域生效（与 PS 行为一致）。无蒙版时直接原地全图应用（快路径）。
    const target = maskAlphaAt ? new Uint8ClampedArray(data as Uint8ClampedArray) : (data as Uint8ClampedArray);
    switch (adj.type) {
      case 'hue/saturation':
        applyHueSaturation(target, w, h, adj);
        break;
      case 'brightness/contrast':
        applyBrightnessContrast(target, w, h, adj);
        break;
      case 'vibrance':
        applyVibrance(target, w, h, adj);
        break;
    }

    if (maskAlphaAt) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = maskAlphaAt(x, y);
          if (a >= 255) {
            // 完全生效，直接拷贝（避免取整误差）
            const i = (y * w + x) * 4;
            data[i] = target[i]; data[i + 1] = target[i + 1]; data[i + 2] = target[i + 2];
          } else if (a > 0) {
            const i = (y * w + x) * 4;
            const t = a / 255;
            data[i] = Math.round(data[i] * (1 - t) + target[i] * t);
            data[i + 1] = Math.round(data[i + 1] * (1 - t) + target[i + 1] * t);
            data[i + 2] = Math.round(data[i + 2] * (1 - t) + target[i + 2] * t);
          }
          // a === 0：不应用，保持原像素
        }
      }
    }
  }
}

function determineLayerType(layer: Layer): LayerType {
  if (layer.children && layer.children.length > 0) return 'group';
  if (layer.text) return 'text';
  if (layer.placedLayer) return 'smartObject';
  if (layer.vectorMask || layer.vectorFill) return 'shape';
  return 'image';
}

// PSD fontCaps: 0=normal, 1=small caps, 2=all caps. Map to our text case.
// undefined return means ORIGINAL (omit the field to keep payload small).
function mapFontCaps(fontCaps: number | undefined): SerializedTextCase | undefined {
  if (fontCaps === 2) return 'UPPER';
  if (fontCaps === 1) return 'SMALL_CAPS';
  return undefined;
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
  const baseFontCaps = base?.fontCaps;

  // PSD transform 矩阵 = [a, b, c, d, tx, ty]，sx = sqrt(a² + c²), sy = sqrt(b² + d²)
  // sx 和 sy 在非旋转情况下可以不同（如 Level 40 sx=1.0 sy=1.0021），
  // 后面用 sy 缩放 fontSize（垂直字号），但 export 时需要还原 sx 让水平字符位置正确。
  const txScale = (text.transform && text.transform.length >= 4)
    ? Math.sqrt(text.transform[1] * text.transform[1] + text.transform[3] * text.transform[3])
    : 1;
  const txScaleX = (text.transform && text.transform.length >= 4)
    ? Math.sqrt(text.transform[0] * text.transform[0] + text.transform[2] * text.transform[2])
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
      const fontCaps = s.fontCaps ?? baseFontCaps;

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
      const textCase = mapFontCaps(fontCaps);
      if (textCase) {
        style.textCase = textCase;
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
    const textCase = mapFontCaps(baseFontCaps);
    if (textCase) {
      style.textCase = textCase;
    }
    styles.push(style);
  }

  let docBoundsY: number | undefined;
  let docBboxCenterX: number | undefined;
  let txOffsetX: number | undefined;
  let docRotatedCenterX: number | undefined;
  let docRotatedCenterY: number | undefined;

  if (text.transform && text.transform.length >= 6) {
    const [a, b, c, d, tx, ty] = text.transform;
    const sx = Math.sqrt(a * a + c * c);
    const sy = Math.sqrt(b * b + d * d);
    const isRotated = Math.abs(b) > 0.001 || Math.abs(c) > 0.001;

    if (isRotated) {
      // 旋转文本：MasterGo/Figma 的 rotation 绕「节点中心」旋转（实测确认，非左上角）。
      // 故渲染器需要旋转后 boundingBox 中心的画布绝对坐标：transform 作用于 boundingBox
      // 几何中心 ((left+right)/2, (top+bottom)/2)。渲染时令节点中心落在此点，绕中心旋转后
      // 视觉中心不变，从而对齐 PSD。docBboxCenterX/docBoundsY 仍保留供 export 与回退路径使用。
      if (text.boundingBox) {
        const bbL = text.boundingBox.left.value;
        const bbR = text.boundingBox.right.value;
        const bbT = text.boundingBox.top.value;
        const bbB = text.boundingBox.bottom.value;
        const cx = (bbL + bbR) / 2;
        const cy = (bbT + bbB) / 2;
        docBboxCenterX = (a * bbL + c * bbT + tx + a * bbR + c * bbT + tx) / 2;
        docBoundsY = b * bbL + d * bbT + ty;
        docRotatedCenterX = a * cx + c * cy + tx;
        docRotatedCenterY = b * cx + d * cy + ty;
      } else if (text.bounds) {
        const bT = text.bounds.top.value;
        const bL = text.bounds.left.value;
        const bR = text.bounds.right.value;
        const bB = text.bounds.bottom.value;
        const cx = (bL + bR) / 2;
        const cy = (bT + bB) / 2;
        docBboxCenterX = (a * bL + c * bT + tx + a * bR + c * bT + tx) / 2;
        docBoundsY = b * bL + d * bT + ty;
        docRotatedCenterX = a * cx + c * cy + tx;
        docRotatedCenterY = b * cx + d * cy + ty;
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

  const psdTx = text.transform && text.transform.length >= 6 ? text.transform[4] : undefined;
  const psdTy = text.transform && text.transform.length >= 6 ? text.transform[5] : undefined;
  const result: SerializedTextData = { text: fullText, horizontalAlignment: alignment, styles, transformScale: txScale, transformScaleX: txScaleX, transformTx: psdTx, transformTy: psdTy, rotation, docBoundsY, docBboxCenterX, txOffsetX, docRotatedCenterX, docRotatedCenterY, textIndex: text.index };

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

  // PSD 文本弯曲（warp）：Figma/MasterGo 不支持可编辑文本弧形弯曲，但保存原始
  // warp 数据以便导出 PSD 时写回 layer.text.warp，实现往返保真。style='none' 视为无弯曲。
  if (text.warp && text.warp.style && text.warp.style !== 'none') {
    const w = text.warp;
    const warp: SerializedWarp = { style: w.style as string };
    if (typeof w.value === 'number') warp.value = w.value;
    if (Array.isArray(w.values)) warp.values = w.values.slice();
    if (typeof w.perspective === 'number') warp.perspective = w.perspective;
    if (typeof w.perspectiveOther === 'number') warp.perspectiveOther = w.perspectiveOther;
    if (w.rotate) warp.rotate = w.rotate as string;
    result.warp = warp;
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

/**
 * 序列化 PSD 全局 pattern 资源（Patt 块）为可传输结构，data 转 base64。
 * round-trip 导出时由 psd-builder 解码并写回 psd.patterns。
 */
function serializePsdPatterns(patterns: typeof globalPsdPatterns): SerializedPattern[] | undefined {
  if (!patterns || !patterns.length) return undefined;
  const out: SerializedPattern[] = [];
  for (const p of patterns) {
    if (!p?.id || !p.data || !p.bounds) continue;
    out.push({
      id: p.id,
      name: p.name ?? '',
      x: p.x ?? 0,
      y: p.y ?? 0,
      bounds: { x: p.bounds.x ?? 0, y: p.bounds.y ?? 0, w: p.bounds.w, h: p.bounds.h },
      dataB64: uint8ArrayToBase64(p.data),
    });
  }
  return out.length ? out : undefined;
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

// 模糊类智能滤镜：这类滤镜会让 PS 写入的图层 channel data（ag-psd 读到的像素）与
// merged composite 不一致——channel data 是被模糊污染的缓存，导致导入后图层发糊。
const BLUR_SMART_FILTER_TYPES = new Set([
  'motion blur', 'gaussian blur', 'lens blur', 'smart blur',
  'box blur', 'surface blur', 'radial blur', 'shape blur', 'average',
]);


/**
 * 判断智能对象（placedLayer）是否带「启用的模糊类智能滤镜」。
 * 命中则其 channel data 不可靠，应改用智能对象源 + 仿射变换重渲染清晰像素。
 */
function hasBlurSmartFilter(layer: Layer): boolean {
  const filter = (layer as any).placedLayer?.filter;
  if (!filter || filter.enabled === false) return false;
  const list = filter.list;
  if (!Array.isArray(list)) return false;
  return list.some((f: any) => f && f.enabled !== false && BLUR_SMART_FILTER_TYPES.has(f.type));
}

/**
 * 判断是否应「用源重渲染清晰像素」替换模糊缓存。
 * 仅当：带启用的模糊滤镜（hasBlurSmartFilter）+ normal 混合 + 高透明度。
 */
function shouldRerenderClearForBlur(layer: Layer): boolean {
  if (!(layer as any).placedLayer || !hasBlurSmartFilter(layer)) return false;
  const blend = (layer as any).blendMode;
  if (blend !== undefined && blend !== 'normal' && blend !== 'passThrough') return false;
  const opacity = (layer as any).opacity;
  if (typeof opacity === 'number' && opacity < 0.95) return false;
  return true;
}

/**
 * placedLayer.transform 是否为纯仿射平行四边形（无透视）。
 * transform = 8 数 [TLx,TLy, TRx,TRy, BRx,BRy, BLx,BLy]（四角点）。
 * 仿射时 BR 必满足 BR ≈ TR + (BL - TL)；若有透视/自由变形则不成立。
 * 重渲染只用 TL/TR/BL 建仿射矩阵（忽略 BR），非仿射会被错误地当平行四边形渲染而扭曲，
 * 故非仿射时一律放弃重渲染、回退原缓存像素。
 */
function isAffineParallelogram(transform: number[]): boolean {
  if (!Array.isArray(transform) || transform.length < 8) return false;
  const [TLx, TLy, TRx, TRy, BRx, BRy, BLx, BLy] = transform;
  const expBRx = TRx + (BLx - TLx);
  const expBRy = TRy + (BLy - TLy);
  const diag = Math.hypot(BRx - TLx, BRy - TLy) || 1;
  const tol = Math.max(2, diag * 0.01); // 2px 或对角线 1%
  return Math.hypot(BRx - expBRx, BRy - expBRy) <= tol;
}

/**
 * 判断是否应「用清晰源重渲染」以提升锐度（与模糊无关）。
 * 即便无模糊滤镜，智能对象（如 cions 组里无滤镜的小 coin）的 channel data 是按显示尺寸
 * 栅格化的低分辨率缓存（如 58x46），而内嵌源（138x97）分辨率更高；PS 放大时从源重渲染保持锐利，
 * 我们也应从源超采样重渲染，否则放大发糊。
 * 命中条件：placedLayer + 纯仿射 + normal/passThrough 混合 + 高透明度 + 非模糊（模糊层走 shouldRerenderClearForBlur）。
 * 是否真正有分辨率增益（源边长 > 显示边长）由 renderSmartObjectClearImage 按 scale 决定，无增益则回退缓存。
 */
function shouldRerenderClearForSharpness(layer: Layer): boolean {
  const pl = (layer as any).placedLayer;
  if (!pl || !isAffineParallelogram(pl.transform)) return false;
  if (hasBlurSmartFilter(layer)) return false;
  const blend = (layer as any).blendMode;
  if (blend !== undefined && blend !== 'normal' && blend !== 'passThrough') return false;
  const opacity = (layer as any).opacity;
  if (typeof opacity === 'number' && opacity < 0.95) return false;
  return true;
}

/** 是否需要从源重渲染（模糊清洗 或 锐度提升）。 */
function shouldRerenderClear(layer: Layer): boolean {
  return shouldRerenderClearForBlur(layer) || shouldRerenderClearForSharpness(layer);
}

/**
 * 由曲线控制点（{x,y} 升序，x/y ∈ 0..255）构建 0..255 查找表。
 * PS 曲线本身是平滑样条，控制点少时分段线性插值已足够接近，且更稳健可预测。
 */
function buildCurveLUT(points: { x: number; y: number }[]): Uint8Array {
  const lut = new Uint8Array(256);
  const pts = points.slice().sort((p, q) => p.x - q.x);
  if (pts.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  for (let i = 0; i < 256; i++) {
    let p0 = pts[0], p1 = pts[pts.length - 1];
    if (i <= pts[0].x) { p0 = pts[0]; p1 = pts[0]; }
    else if (i >= pts[pts.length - 1].x) { p0 = pts[pts.length - 1]; p1 = pts[pts.length - 1]; }
    else {
      for (let k = 0; k < pts.length - 1; k++) {
        if (i >= pts[k].x && i <= pts[k + 1].x) { p0 = pts[k]; p1 = pts[k + 1]; break; }
      }
    }
    const span = p1.x - p0.x;
    const tt = span === 0 ? 0 : (i - p0.x) / span;
    lut[i] = Math.max(0, Math.min(255, Math.round(p0.y + (p1.y - p0.y) * tt)));
  }
  return lut;
}

/**
 * 把智能对象上「启用的非模糊类智能滤镜」就地烘焙进重渲染后的像素，匹配 PS 效果。
 * 重渲染用的是干净源像素，会丢失原图层缓存里烘进去的这些滤镜（如曲线提亮），故需补回。
 * 模糊类滤镜（BLUR_SMART_FILTER_TYPES）是发糊根因，跳过不应用。
 * 当前支持 curves；其它非模糊类型暂记录警告并跳过（像素保持源渲染值，不致崩）。
 */
function applyNonBlurSmartFilters(
  data: Uint8ClampedArray,
  layer: Layer
): void {
  const list = (layer as any).placedLayer?.filter?.list;
  if (!Array.isArray(list)) return;
  for (const f of list) {
    if (!f || f.enabled === false) continue;
    if (BLUR_SMART_FILTER_TYPES.has(f.type)) continue;
    if (f.type === 'curves') {
      const adjustments = f.filter?.adjustments;
      if (!Array.isArray(adjustments)) continue;
      // 逐通道 LUT：composite/rgb 作用于 R/G/B；red/green/blue 单通道。
      let lutR: Uint8Array | null = null, lutG: Uint8Array | null = null, lutB: Uint8Array | null = null;
      for (const adj of adjustments) {
        if (!adj || !Array.isArray(adj.curve) || adj.curve.length < 2) continue;
        const lut = buildCurveLUT(adj.curve);
        const channels: string[] = Array.isArray(adj.channels) ? adj.channels : ['composite'];
        for (const ch of channels) {
          if (ch === 'composite' || ch === 'rgb') { lutR = lut; lutG = lut; lutB = lut; }
          else if (ch === 'red') lutR = lut;
          else if (ch === 'green') lutG = lut;
          else if (ch === 'blue') lutB = lut;
        }
      }
      if (lutR || lutG || lutB) {
        const opacity = typeof f.opacity === 'number' ? Math.max(0, Math.min(1, f.opacity)) : 1;
        for (let i = 0; i < data.length; i += 4) {
          if (lutR) data[i] = opacity === 1 ? lutR[data[i]] : Math.round(data[i] + (lutR[data[i]] - data[i]) * opacity);
          if (lutG) data[i + 1] = opacity === 1 ? lutG[data[i + 1]] : Math.round(data[i + 1] + (lutG[data[i + 1]] - data[i + 1]) * opacity);
          if (lutB) data[i + 2] = opacity === 1 ? lutB[data[i + 2]] : Math.round(data[i + 2] + (lutB[data[i + 2]] - data[i + 2]) * opacity);
        }
      }
    } else {
      logger.warn(`Layer "${layer.name}": smart filter "${f.type}" not baked into re-rendered clear image (unsupported non-blur filter)`);
    }
  }
}

/**
 * 超采样是否安全：重渲染后的 imageData 尺寸会大于 1x bbox，若该层还要走「按 1x 坐标对齐的蒙版」
 * （layer mask 或带真实空间蒙版的剪贴调整），尺寸不匹配会错位。这两种情况下禁用超采样（退回 1x）。
 * 仅有 alpha 形状、无空间蒙版的调整（如全图 +17 亮度）不受影响，可超采样。
 */
function supersampleSafe(layer: Layer): boolean {
  const hasRealMask = (m: any) =>
    m && !m.disabled && ((m.imageData && m.imageData.width > 0) || (m.canvas && m.canvas.width > 0));
  if (hasRealMask((layer as any).mask)) return false;
  const adjs = (layer as any).__rerenderClipAdjustments as Layer[] | undefined;
  if (Array.isArray(adjs)) {
    for (const adj of adjs) if (hasRealMask((adj as any).mask)) return false;
  }
  return true;
}

/**
 * 解码智能对象内嵌源（按 placedLayer.id 缓存，多个实例共享同一源只解码一次）。
 * 返回源 canvas 与尺寸；无源 / 解码失败返回 null（并缓存 null，不再重试）。
 */
function decodeSmartObjectSource(
  soId: string | undefined,
  layerName: string
): SmartObjectSource | null {
  if (!globalPsdLinkedFiles) return null;
  const cache = globalSmartObjectSourceCache;
  if (cache && soId !== undefined && cache.has(soId)) return cache.get(soId)!;

  // 在 64x64 降采样上估算 alpha<250 占比（足以判断「是否带不透明白底」），避免扫描大源全图。
  const computeTransparentFrac = (cv: HTMLCanvasElement): number => {
    try {
      const sN = 64;
      const sCv = document.createElement('canvas');
      sCv.width = Math.max(1, Math.min(sN, cv.width));
      sCv.height = Math.max(1, Math.min(sN, cv.height));
      const sctx = sCv.getContext('2d')!;
      sctx.drawImage(cv, 0, 0, sCv.width, sCv.height);
      const d = sctx.getImageData(0, 0, sCv.width, sCv.height).data;
      const n = sCv.width * sCv.height;
      let trans = 0;
      for (let i = 0; i < n; i++) if (d[i * 4 + 3] < 250) trans++;
      return n > 0 ? trans / n : 0;
    } catch { return 1; } // 估算失败时按「有透明」处理（不因此拒绝重渲染）
  };

  const finish = (v: SmartObjectSource | null) => {
    if (cache && soId !== undefined) cache.set(soId, v);
    return v;
  };

  const lf = globalPsdLinkedFiles.find((f) => f && f.id === soId);
  if (!lf || !lf.data) return finish(null);

  try {
    const inner = readPsd(lf.data as any, { skipThumbnail: true });
    if (inner.canvas && inner.canvas.width > 0) {
      const cv = inner.canvas as HTMLCanvasElement;
      return finish({ canvas: cv, sw: cv.width, sh: cv.height, transparentFrac: computeTransparentFrac(cv) });
    }
    if (inner.imageData && inner.imageData.width > 0) {
      const c = document.createElement('canvas');
      c.width = inner.imageData.width;
      c.height = inner.imageData.height;
      const pc = inner.imageData.width * inner.imageData.height * 4;
      const buf = new Uint8ClampedArray(pc);
      const sd = inner.imageData.data as any;
      if (sd instanceof Uint8ClampedArray || sd instanceof Uint8Array) buf.set(sd.subarray(0, pc));
      else for (let i = 0; i < pc; i++) buf[i] = Math.min(255, Math.max(0, Math.round(Number(sd[i]))));
      c.getContext('2d')!.putImageData(new ImageData(buf, inner.imageData.width, inner.imageData.height), 0, 0);
      return finish({ canvas: c, sw: c.width, sh: c.height, transparentFrac: computeTransparentFrac(c) });
    }
  } catch (e) {
    logger.warn(`Smart object source decode failed for "${layerName}": ${e instanceof Error ? e.message : e}`);
    return finish(null);
  }
  return finish(null);
}

/**
 * 取该层「重渲染所需的缓存基底」为 canvas：优先用烘焙剪贴调整前的原始像素
 * （__origImageDataBeforeAdjustment，避免与稍后重新应用的 +17 调整双重叠加），否则用当前 imageData。
 * 用途：(a) 模糊路径作拖尾底图；(b) 锐度路径作轮廓守卫的比对基准。
 */
function getRerenderBaseCache(layer: Layer): { canvas: HTMLCanvasElement; width: number; height: number } | null {
  const cache = (layer as any).__origImageDataBeforeAdjustment ?? (layer as any).imageData;
  if (!cache || !cache.data || cache.width <= 0 || cache.height <= 0) return null;
  const need = cache.width * cache.height * 4;
  if (cache.data.length < need) return null;
  const data = cache.data instanceof Uint8ClampedArray
    ? cache.data
    : new Uint8ClampedArray(cache.data.buffer ? cache.data.buffer.slice(0, need) : cache.data.subarray(0, need));
  const cv = document.createElement('canvas');
  cv.width = cache.width; cv.height = cache.height;
  cv.getContext('2d')!.putImageData(new ImageData(data, cache.width, cache.height), 0, 0);
  return { canvas: cv, width: cache.width, height: cache.height };
}

/**
 * PackBits (RLE) 解码：PSD channel data 的标准压缩格式 (compressionMode=1)。
 * 将压缩的 Uint8Array 解码为原始灰度字节。
 */
function decodePackBits(encoded: Uint8Array, expectedLength: number): Uint8Array {
  const result = new Uint8Array(expectedLength);
  let srcIdx = 0;
  let dstIdx = 0;
  while (srcIdx < encoded.length && dstIdx < expectedLength) {
    const n = (encoded[srcIdx] << 24) >> 24; // sign-extend to int8
    srcIdx++;
    if (n >= 0) {
      const count = n + 1;
      for (let i = 0; i < count && dstIdx < expectedLength && srcIdx < encoded.length; i++) {
        result[dstIdx++] = encoded[srcIdx++];
      }
    } else if (n > -128) {
      const count = 1 - n;
      const val = srcIdx < encoded.length ? encoded[srcIdx++] : 0;
      for (let i = 0; i < count && dstIdx < expectedLength; i++) {
        result[dstIdx++] = val;
      }
    }
    // n === -128: no-op (spec)
  }
  return result;
}

/**
 * 从 layer.filterEffectsMasks (FEid/FXid) 解码滤镜蒙版 alpha，映射到层 bounds 尺寸。
 * 返回 Uint8Array(W*H)，每像素一个灰度值：255=显示滤镜效果(模糊), 0=显示清晰源。
 * 无蒙版数据时返回 null。
 */
function decodeFilterEffectsMask(
  layer: Layer,
  bounds: { left: number; top: number; right: number; bottom: number }
): Uint8Array | null {
  const masks = (layer as any).filterEffectsMasks as Array<{
    id: string;
    top: number; left: number; bottom: number; right: number;
    depth: number;
    channels: ({ compressionMode: number; data: Uint8Array } | undefined)[];
    extra?: { top: number; left: number; bottom: number; right: number; compressionMode: number; data: Uint8Array };
  }> | undefined;
  if (!masks || masks.length === 0) return null;

  // 取第一个有效蒙版 entry（通常智能对象只有一个 filterEffects entry）
  const entry = masks[0];
  const mw = entry.right - entry.left;
  const mh = entry.bottom - entry.top;
  if (mw <= 0 || mh <= 0) return null;


  // 用户蒙版 channel 是 channels[maxChannels]（倒数第二个 slot）。
  // channels 长度 = maxChannels + 2，所以 user mask index = channels.length - 2。
  const userMaskIdx = entry.channels.length - 2;
  const maskCh = userMaskIdx >= 0 ? entry.channels[userMaskIdx] : undefined;
  if (!maskCh) {
    // 无 user mask channel，尝试 extra 块作为 fallback
    if (!entry.extra) return null;
    const extra = entry.extra;
    const ew = extra.right - extra.left;
    const eh = extra.bottom - extra.top;
    if (ew <= 0 || eh <= 0) return null;
    const rawLen = ew * eh;
    const decoded = extra.compressionMode === 1
      ? decodePackBits(extra.data, rawLen)
      : extra.data.length >= rawLen ? extra.data : null;
    if (!decoded) return null;
    return mapMaskToBounds(decoded, ew, eh, extra.left, extra.top, bounds);
  }

  const rawLen = mw * mh;
  const decoded = maskCh.compressionMode === 1
    ? decodePackBitsRLE(maskCh.data, mw, mh)
    : maskCh.data.length >= rawLen ? maskCh.data : null;
  if (!decoded) return null;

  return mapMaskToBounds(decoded, mw, mh, entry.left, entry.top, bounds);
}

/**
 * PackBits RLE for PSD channel: 逐行解码（每行有 2 字节行长前缀）。
 */
function decodePackBitsRLE(encoded: Uint8Array, width: number, height: number): Uint8Array | null {
  const result = new Uint8Array(width * height);
  let srcIdx = 0;

  // 跳过行长表（每行 2 字节 × height 行）
  const rowLengthsStart = srcIdx;
  srcIdx += height * 2;
  if (srcIdx > encoded.length) {
    // 没有行长表，尝试无行长表的纯 PackBits 解码
    return decodePackBits(encoded, width * height);
  }

  for (let row = 0; row < height; row++) {
    const rowLen = (encoded[rowLengthsStart + row * 2] << 8) | encoded[rowLengthsStart + row * 2 + 1];
    const rowEnd = srcIdx + rowLen;
    let dstIdx = row * width;
    const dstEnd = dstIdx + width;

    while (srcIdx < rowEnd && dstIdx < dstEnd) {
      const n = (encoded[srcIdx] << 24) >> 24;
      srcIdx++;
      if (n >= 0) {
        const count = n + 1;
        for (let i = 0; i < count && dstIdx < dstEnd && srcIdx < rowEnd; i++) {
          result[dstIdx++] = encoded[srcIdx++];
        }
      } else if (n > -128) {
        const count = 1 - n;
        const val = srcIdx < rowEnd ? encoded[srcIdx++] : 0;
        for (let i = 0; i < count && dstIdx < dstEnd; i++) {
          result[dstIdx++] = val;
        }
      }
    }
    srcIdx = rowEnd;
  }

  return result;
}

/**
 * 将解码后的蒙版灰度数据（maskW×maskH，文档坐标 maskLeft/maskTop）映射到层 bounds 区域。
 * 蒙版范围外的像素默认 0（黑=显示清晰源）。
 */
function mapMaskToBounds(
  maskData: Uint8Array, maskW: number, maskH: number,
  maskLeft: number, maskTop: number,
  bounds: { left: number; top: number; right: number; bottom: number }
): Uint8Array {
  const bw = bounds.right - bounds.left;
  const bh = bounds.bottom - bounds.top;
  const result = new Uint8Array(bw * bh); // 默认 0（黑=清晰源）

  for (let y = 0; y < bh; y++) {
    const docY = bounds.top + y;
    const my = docY - maskTop;
    if (my < 0 || my >= maskH) continue;
    for (let x = 0; x < bw; x++) {
      const docX = bounds.left + x;
      const mx = docX - maskLeft;
      if (mx < 0 || mx >= maskW) continue;
      result[y * bw + x] = maskData[my * maskW + mx];
    }
  }
  return result;
}

/**
 * 用智能对象内嵌源 + placedLayer.transform 仿射变换，渲染出与 PS merged composite 一致的像素。
 * placedLayer.transform 为 8 数（TL,TR,BR,BL 角点），对金币这类是纯仿射（平行四边形，无透视），用 setTransform 还原。
 * 两条路径：
 *  - 模糊路径（hasBlurSmartFilter）：清晰源(币主体)叠在「模糊缓存(=动感拖尾)」之上，还原「清晰币 + 拖尾」。
 *    PS 用 filterEffectsMasks 滤镜蒙版控制每个像素的拖尾强度（白=模糊效果, 黑=清晰源），实现精确的单向弱拖尾。
 *  - 锐度路径（无模糊但源分辨率更高）：纯清晰源超采样，但带轮廓守卫——源若为带不透明白底的扁平合成、
 *    或重渲染轮廓与缓存差异过大（源像素≠该层实际像素，如 backlgt 白底），返回 null 回退缓存，避免白块。
 * 失败（无源 / 解码失败 / 无 transform / 非仿射 / 无锐度增益 / 守卫未过）返回 null，调用方回退原像素。
 */
function renderSmartObjectClearImage(
  layer: Layer
): { data: Uint8ClampedArray; width: number; height: number } | null {
  const pl = (layer as any).placedLayer;
  if (!pl || !Array.isArray(pl.transform) || pl.transform.length < 8) return null;
  // 非仿射（透视 / 自由变形）时本函数会把它当平行四边形渲染而扭曲，放弃重渲染、回退缓存。
  if (!isAffineParallelogram(pl.transform)) return null;

  const src = decodeSmartObjectSource(pl.id, layer.name ?? '');
  if (!src) return null;
  const { canvas: srcCanvas, sw, sh } = src;

  const t = pl.transform as number[];
  const TLx = t[0], TLy = t[1], TRx = t[2], TRy = t[3], BLx = t[6], BLy = t[7];
  const bounds = getLayerBounds(layer);
  const bw = bounds.right - bounds.left;
  const bh = bounds.bottom - bounds.top;
  if (bw <= 0 || bh <= 0) return null;

  // 源 (0,0)=TL,(sw,0)=TR,(0,sh)=BL → 1x 仿射矩阵（平移到层 bbox 原点）。
  const a = (TRx - TLx) / sw, b = (TRy - TLy) / sw;
  const c = (BLx - TLx) / sh, d = (BLy - TLy) / sh;
  const e = TLx - bounds.left, f = TLy - bounds.top;

  // 超采样：源（如 138x97）映射到的平行四边形显示边长可能远小于源，按 bbox 烤会丢分辨率，
  // 放大后发糊（PS 智能对象保留源分辨率，放大更锐利）。按「源边长/显示边长」算倍率，
  // 让位图拿到源的完整像素；节点显示尺寸仍用 bbox（1x），平台缩放显示即可。
  // 有 layer mask / 带空间蒙版的剪贴调整时降为 1x，避免后续蒙版按 1x 坐标对齐时错位。
  const edgeU = Math.hypot(TRx - TLx, TRy - TLy);
  const edgeV = Math.hypot(BLx - TLx, BLy - TLy);
  const rawScale = (edgeU > 0 && edgeV > 0) ? Math.max(sw / edgeU, sh / edgeV) : 1;
  // 仅为提升锐度（非模糊驱动）时，若源分辨率不高于显示尺寸（无超采样增益），
  // 重渲染只会用源像素替换缓存而无收益、反而可能引入细微差异，故放弃、回退缓存。
  if (!hasBlurSmartFilter(layer) && rawScale <= 1.05) return null;
  // 强制 1x：超采样图片在 MasterGo IMAGE FILL 中会导致位置偏移（平台对大于节点的图片
  // 做居中裁剪而非等比缩放），用 1x 渲染保证图片尺寸 = bounds 尺寸，位置精确。
  // 清晰度仍优于原始缓存（源像素通过仿射映射渲染，而非低分辨率栅格）。
  const scale = 1;

  const W = Math.max(1, Math.round(bw * scale));
  const H = Math.max(1, Math.round(bh * scale));

  // 渲染清晰源到 W×H 画布。
  const sharpCv = document.createElement('canvas');
  sharpCv.width = W;
  sharpCv.height = H;
  const sctx = sharpCv.getContext('2d')!;
  sctx.imageSmoothingEnabled = true;
  (sctx as any).imageSmoothingQuality = 'high';
  sctx.setTransform(a * scale, b * scale, c * scale, d * scale, e * scale, f * scale);
  sctx.drawImage(srcCanvas, 0, 0);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  const sharpId = sctx.getImageData(0, 0, W, H);
  // 曲线等非模糊滤镜只作用于清晰源（缓存已自带这些滤镜，勿重复）。
  applyNonBlurSmartFilters(sharpId.data, layer);

  const blur = hasBlurSmartFilter(layer);

  if (!blur) {
    // 锐度路径：轮廓守卫。源为带不透明白底的扁平合成（透明占比≈0）时，重渲染必出白块 → 拒绝。
    if (src.transparentFrac < 0.02) {
      logger.warn(`Layer "${layer.name}": skip sharpness re-render — source has opaque background (transparentFrac=${src.transparentFrac.toFixed(2)}), keeping cache`);
      return null;
    }
    // 重渲染轮廓(alpha)与缓存轮廓差异过大，说明源像素≠该层实际像素 → 拒绝，回退缓存。
    const base = getRerenderBaseCache(layer);
    if (base && base.width === bw && base.height === bh) {
      const cmp = document.createElement('canvas');
      cmp.width = bw; cmp.height = bh;
      const cctx = cmp.getContext('2d')!;
      cctx.drawImage(sharpCv, 0, 0, bw, bh);
      const sa = cctx.getImageData(0, 0, bw, bh).data;
      const ca = base.canvas.getContext('2d')!.getImageData(0, 0, bw, bh).data;
      let sum = 0; const n = bw * bh;
      for (let i = 0; i < n; i++) sum += Math.abs(sa[i * 4 + 3] - ca[i * 4 + 3]);
      const meanAlphaDiff = sum / n;
      if (meanAlphaDiff > 40) {
        logger.warn(`Layer "${layer.name}": skip sharpness re-render — silhouette mismatch vs cache (meanAlphaDiff=${meanAlphaDiff.toFixed(1)}), keeping cache`);
        return null;
      }
    }
    return { data: sharpId.data, width: W, height: H };
  }

  // 模糊路径（scale=1）：清晰源 + 模糊缓存拖尾合成。
  // PS 用 filterEffectsMasks（滤镜蒙版 alpha）逐像素控制：白=显示滤镜效果(模糊拖尾)，黑=显示原始像素(清晰源)。
  // 公式：pixel = sharp × (1 - mask) + blurCache × mask
  const trail = getRerenderBaseCache(layer);
  if (!trail) {
    return { data: sharpId.data, width: W, height: H };
  }

  const filterMask = decodeFilterEffectsMask(layer, bounds);


  if (filterMask) {
    // 精确蒙版合成：逐像素按蒙版 alpha 混合。
    const trailCv = document.createElement('canvas');
    trailCv.width = W; trailCv.height = H;
    const tctx = trailCv.getContext('2d')!;
    tctx.drawImage(trail.canvas, 0, 0, trail.width, trail.height, 0, 0, W, H);
    const trailId = tctx.getImageData(0, 0, W, H);

    const out = new Uint8ClampedArray(W * H * 4);
    const sharp = sharpId.data;
    const blur = trailId.data;
    const mask = filterMask;
    for (let i = 0; i < W * H; i++) {
      const p = i * 4;
      const m = mask[i] / 255;
      const im = 1 - m;
      out[p]     = Math.round(sharp[p]     * im + blur[p]     * m);
      out[p + 1] = Math.round(sharp[p + 1] * im + blur[p + 1] * m);
      out[p + 2] = Math.round(sharp[p + 2] * im + blur[p + 2] * m);
      out[p + 3] = Math.round(sharp[p + 3] * im + blur[p + 3] * m);
    }
    logger.info(`Layer "${layer.name}": filter mask compositing (mask ${filterMask.length} px, bounds ${W}x${H})`);
    return { data: out, width: W, height: H };
  }

  // PS smart filter 渲染模型：清晰源 → motion blur → 滤镜蒙版混合。
  // 默认蒙版全白 = 完全显示模糊结果。channel data (trail) 就是 PS 的最终渲染结果。
  // 但 trail 中心是「模糊后的主体」而非清晰源，主体会比 PS merged composite 稍模糊，
  // 因为 PS 在后续合成时可能还有额外步骤。
  // 用 destination-over 在 sharp 不透明处显示清晰源（更锐利），透明处显示 trail（拖尾）。
  // sharp 已经应用了非模糊滤镜(curves)，trail 的 curves 效果在 channel data 中已内置。
  sctx.putImageData(sharpId, 0, 0);
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d')!;
  octx.drawImage(sharpCv, 0, 0);
  octx.globalCompositeOperation = 'destination-over';
  octx.drawImage(trail.canvas, 0, 0, trail.width, trail.height, 0, 0, W, H);
  octx.globalCompositeOperation = 'source-over';
  const id = octx.getImageData(0, 0, W, H);
  return { data: id.data, width: W, height: H };
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

/**
 * 提取「组上的矩形图层蒙版」的画布绝对坐标框。
 * PSD 中组的 layer mask（带像素、未禁用）常用于裁剪溢出内容（如滚动视口）。
 * Figma/MasterGo 用 frame 的 clipsContent + 蒙版框尺寸表达这种矩形裁剪。
 * 用户场景中该蒙版为规则矩形，故直接取蒙版 bbox，不校验像素是否实心。
 * 返回 null：无蒙版 / 蒙版禁用 / 无像素来源 / 面积为 0。
 */
function getGroupMaskRect(
  layer: Layer
): { left: number; top: number; right: number; bottom: number; defaultColor: number } | null {
  const mask = layer.mask;
  if (!mask || mask.disabled) return null;

  const hasImageData = !!(mask.imageData && mask.imageData.width > 0 && mask.imageData.height > 0);
  const cvs = mask.canvas as HTMLCanvasElement | undefined;
  const hasCanvas = !!(cvs && cvs.width > 0 && cvs.height > 0);
  if (!hasImageData && !hasCanvas) return null;

  const left = mask.left ?? 0;
  const top = mask.top ?? 0;
  const right = mask.right ?? left;
  const bottom = mask.bottom ?? top;
  if (right - left <= 0 || bottom - top <= 0) return null;

  return { left, top, right, bottom, defaultColor: mask.defaultColor ?? 255 };
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
    // featherAlpha 用 3-pass box(每 pass 半径 = blur·SHADOW_BLUR_PASS_FACTOR),羽化可达半径
    // ≈ passes·passRadius,比名义 blur 大。reach 须按此估算,否则辉光外圈被画布边界截断
    // (典型:低阶猪猪 拷贝 黄色辉光铺不开)。
    const featherReach = s.blur * SHADOW_BLUR_PASS_FACTOR * SHADOW_BLUR_PASSES;
    const reach = featherReach + s.spread + Math.max(Math.abs(s.offsetX), Math.abs(s.offsetY));
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
  /** PSD 原始 blendMode 字符串（如 'soft light' / 'multiply' / 'normal'）。缺省按 normal 处理。 */
  blendMode?: string;
}

/** patternOverlay 的轻量元数据（像素数据延迟解析时使用）。 */
interface PatternOverlayMeta {
  id: string;
  scale: number;
  opacity: number;
  phaseX: number;
  phaseY: number;
  blendMode?: string;
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

function getPatternOverlayMeta(layer: Layer): PatternOverlayMeta | null {
  if (!layer.effects || layer.effects.disabled || !layer.effects.patternOverlay) return null;
  const p: any = layer.effects.patternOverlay;
  if (!p.enabled || !p.pattern?.id) return null;
  return {
    id: p.pattern.id,
    scale: (p.scale ?? 1),
    opacity: p.opacity ?? 1,
    phaseX: p.phase?.x ?? 0,
    phaseY: p.phase?.y ?? 0,
    blendMode: p.blendMode,
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

/**
 * PS 投影/发光的羽化系数：把 PSD 的 size(blur 名义半径)换算成 box-blur 的每-pass 半径。
 *
 * PS 的羽化是高斯模糊,而我们用 3-pass box blur 近似。3 个全宽 (2r+1) 的 box 叠加,
 * 等效高斯 σ² = 3·((2r+1)²−1)/12。若直接用 r=blur/3(旧实现),有效 σ≈blur/3 —— 远小于
 * PS 的 size,导致辉光过窄、紧贴边缘像硬描边(典型:低阶猪猪 拷贝 的黄色辉光被压成实色边)。
 * 经低阶猪猪真实 alpha 实测,r=blur·0.55 时辉光宽度/柔和度与 PS 渲染基本吻合。
 */
const SHADOW_BLUR_PASS_FACTOR = 0.55;
const SHADOW_BLUR_PASSES = 3;

/** 用 3-pass box blur 近似 PS 高斯羽化(系数见 SHADOW_BLUR_PASS_FACTOR)。blurRadius 为 PSD 名义 size。 */
function featherAlpha(alpha: Uint8Array, w: number, h: number, blurRadius: number): Uint8Array {
  if (blurRadius <= 0) return alpha;
  const passRadius = blurRadius * SHADOW_BLUR_PASS_FACTOR;
  let out = alpha;
  for (let p = 0; p < SHADOW_BLUR_PASSES; p++) {
    out = boxBlurAlpha(out, w, h, passRadius);
  }
  return out;
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
/**
 * 单通道混合（base 为下层/图层本体，blend 为上层 overlay），输入输出均为 0..255。
 * 仅实现 PSD 图层样式 overlay 常见的几种模式，其余回退 normal（直接取 blend）。
 */
function blendChannel(mode: string | undefined, base: number, blend: number): number {
  const b = base / 255;
  const s = blend / 255;
  let r: number;
  switch (mode) {
    case 'multiply':
      r = b * s; break;
    case 'screen':
      r = b + s - b * s; break;
    case 'overlay':
      r = b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s); break;
    case 'soft light':
      // W3C/PS soft light 公式
      r = s <= 0.5
        ? b - (1 - 2 * s) * b * (1 - b)
        : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
      break;
    case 'hard light':
      r = s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s); break;
    case 'darken':
      r = Math.min(b, s); break;
    case 'lighten':
      r = Math.max(b, s); break;
    case 'linear dodge':
      r = Math.min(1, b + s); break;
    case 'normal':
    default:
      r = s; break;
  }
  return Math.round(Math.max(0, Math.min(1, r)) * 255);
}

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
  const mode = pat.blendMode;

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
      // 先按 blendMode 把 pattern 混到本体 RGB，再用 overlay 不透明度在「混合结果」与「本体」之间插值。
      const br = blendChannel(mode, pixels[idx], pr);
      const bg = blendChannel(mode, pixels[idx + 1], pg);
      const bb = blendChannel(mode, pixels[idx + 2], pb);
      if (opac >= 1) {
        pixels[idx] = br;
        pixels[idx + 1] = bg;
        pixels[idx + 2] = bb;
      } else {
        pixels[idx] = Math.round(pixels[idx] * (1 - opac) + br * opac);
        pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - opac) + bg * opac);
        pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - opac) + bb * opac);
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

/**
 * 「纯 patternOverlay 场景」(P1)：除 patternOverlay 外没有任何其它会被合成进位图的 effect。
 * 此时可保存「烤 pattern 之前」的原始像素，导出端用它 + 保留 patternOverlay effect + 写回
 * pattern 资源，PS 应用一次 pattern = 与原始一致，避免双重叠加。
 * 注：fillOpacity<1 不算「其它 effect」——纹理接管(fillOpacity≈0)正是纯 pattern 的典型形态。
 */
function isPatternOnlyLayer(b: LayerEffectBundle, patternOverlayMeta: PatternOverlayMeta | null): boolean {
  if (!patternOverlayMeta) return false;
  return b.strokes.length === 0 && !b.solidFill && !b.gradientOverlay && !b.bevel && !b.satin &&
    b.dropShadows.length === 0 && b.innerShadows.length === 0 && !b.outerGlow && !b.innerGlow;
}

// ===== 效果原生化（整层判定）=====

/** 该 effect 混合模式是否平台可像素级一致表达。缺省/undefined 视为 'normal'（与 PS 一致）。 */
function isNativizableBlendMode(bm: string | undefined): boolean {
  // 只接受 normal：平台 effect/stroke/overlay-fill 以 normal 合成到本层时与 PS 一致。
  // 其它混合模式（multiply/screen/...）平台对 effect/stroke 的支持不一致，无法保证像素级一致 → 不原生化。
  return bm == null || bm === 'normal';
}

/**
 * 等高线是否为默认线性（恒等映射）。PS 的默认等高线在不同语言环境下 name 被本地化
 * （英文 'Linear' / 中文 '线性' 等），不能靠 name 判断。改以 curve 几何判定：缺省、
 * 或 curve 为从 (0,0) 到 (255,255) 的恒等直线即视为线性，可原生化（平台均匀阴影与 PS 一致）；
 * 任何自定义曲线（点数≠2 或端点偏离恒等）都会改变阴影衰减 → 不可原生化。
 */
function isLinearContour(contour: any): boolean {
  if (!contour) return true;
  const curve = contour.curve;
  if (!Array.isArray(curve)) return true; // 无 curve 数据时保守视为默认线性
  if (curve.length !== 2) return false;
  const [a, b] = curve;
  const near = (v: number, t: number) => Math.abs(v - t) <= 1;
  return near(a.x, 0) && near(a.y, 0) && near(b.x, 255) && near(b.y, 255);
}

/** 统计图层不透明像素覆盖率（alpha>=128 的像素占比），用于判定 overlay 能否安全叠加（难点 2）。 */
function opaqueCoverageRatio(imageData: { data: ArrayLike<number>; width: number; height: number }): number {
  const { data, width, height } = imageData;
  const total = width * height;
  if (total <= 0) return 0;
  let opaque = 0;
  for (let i = 0; i < total; i++) {
    if (data[i * 4 + 3] >= 128) opaque++;
  }
  return opaque / total;
}

/**
 * 整层原生化判定（像素级一致闸门）。返回 true 表示该层所有效果都能与 PS 像素级一致地用平台
 * 原生属性表达，可整层保留为可编辑；返回 false 则整层栅格化（行为同今天）。
 * 注意：以原始 layer.effects 的 blendMode 判定（effectBundle 不携带 blendMode、合成时按 normal）。
 */
function canNativizeLayer(
  layer: Layer,
  bundle: LayerEffectBundle,
  patternOverlayMeta: PatternOverlayMeta | null,
  imageData: { data: ArrayLike<number>; width: number; height: number }
): boolean {
  // 强制栅格化项：平台无可逆像素级一致表达
  if (patternOverlayMeta) return false;
  if (bundle.bevel || bundle.satin) return false;
  if (bundle.fillOpacity < 1) return false;

  const fx: any = layer.effects;
  if (!fx) return false;

  // shadow / glow：混合模式须 normal、无 contour/noise 等平台表达不了的参数
  const shadowGroups: any[] = [
    ...(Array.isArray(fx.dropShadow) ? fx.dropShadow : []),
    ...(Array.isArray(fx.innerShadow) ? fx.innerShadow : []),
    ...(fx.outerGlow ? [fx.outerGlow] : []),
    ...(fx.innerGlow ? [fx.innerGlow] : []),
  ];
  for (const s of shadowGroups) {
    if (!s || !s.enabled) continue;
    if (!isNativizableBlendMode(s.blendMode)) return false;
    // contour 非线性 / noise / 抖动会让平台均匀阴影与 PS 不一致（按 curve 几何判定，不依赖本地化 name）
    if (!isLinearContour(s.contour)) return false;
    if (typeof s.noise === 'number' && s.noise > 0) return false;
    // glow 的 range/jitter 等非默认参数同样无法等价
    if (typeof s.jitter === 'number' && s.jitter > 0) return false;
  }

  // stroke：仅 fillType==='color'、混合模式 normal 才可原生（gradient/pattern stroke 强制栅格）
  if (Array.isArray(fx.stroke)) {
    for (const st of fx.stroke) {
      if (!st || !st.enabled) continue;
      if (st.fillType !== 'color') return false;
      if (!isNativizableBlendMode(st.blendMode)) return false;
    }
  }

  // stroke 覆盖率闸门：PSD stroke 沿像素轮廓渲染，平台 stroke 沿节点几何（矩形）渲染。
  // 当图层像素不近似填满 bbox 时（如三角形 icon），两者外观差异巨大，须退回栅格化。
  if (bundle.strokes.length > 0 && opaqueCoverageRatio(imageData) < OVERLAY_NATIVIZE_MIN_COVERAGE) {
    return false;
  }

  // color / gradient overlay：混合模式 normal + 像素填满 bbox（否则矩形色块盖透明区，难点 2）
  const hasOverlay = !!bundle.solidFill || !!bundle.gradientOverlay;
  if (hasOverlay) {
    if (Array.isArray(fx.solidFill)) {
      for (const sf of fx.solidFill) {
        if (sf && sf.enabled && !isNativizableBlendMode(sf.blendMode)) return false;
      }
    }
    if (Array.isArray(fx.gradientOverlay)) {
      for (const go of fx.gradientOverlay) {
        if (go && go.enabled && !isNativizableBlendMode(go.blendMode)) return false;
      }
    }
    // 渐变 overlay 仅支持 linear（与 builder/平台 GRADIENT_LINEAR 对齐）
    if (bundle.gradientOverlay && bundle.gradientOverlay.style !== 'linear') return false;
    if (opaqueCoverageRatio(imageData) < OVERLAY_NATIVIZE_MIN_COVERAGE) return false;
  }

  return true;
}

/**
 * 文本层效果是否「平台能渲染出来」（区别于 canNativizeLayer 的像素级一致闸门）。
 * 返回 false = 平台画布根本渲染不出（无可逆替代），需回退栅格化为合成图显示，
 * 但节点仍保持平台 TextNode 类型、保留全部 round-trip 源数据。任一满足即不可渲染：
 *  (a) dropShadow / innerShadow 含 spread>0（实色外扩硬边阴影）——MasterGo 文本节点不渲染 spread；
 *  (b) warp 弧形（style!=='none'）——两平台都不支持可编辑文本弯曲。
 * 注：spread 用 0.5 容差避浮点噪声；warp 取 serialized.textData.warp（已过滤 style==='none'）。
 */
function textEffectsRenderable(bundle: LayerEffectBundle, warp: SerializedWarp | undefined): boolean {
  for (const s of bundle.dropShadows) {
    if (s.spread > 0.5) return false;
  }
  for (const s of bundle.innerShadows) {
    if (s.spread > 0.5) return false;
  }
  if (warp && warp.style && warp.style !== 'none') return false;
  return true;
}

/**
 * 把 bundle 中的 color/gradient overlay 转为平台可叠加的 SerializedFill[]（叠在 IMAGE fill 之上）。
 * 顺序与 PS 合成一致：gradient overlay 在 color overlay 之上（PS 中 gradient 覆盖 color）。
 * 仅在 canNativizeLayer 通过时调用。
 */
function convertOverlaysToFills(bundle: LayerEffectBundle): SerializedFill[] {
  const fills: SerializedFill[] = [];
  // PS 合成顺序：color overlay 先（下），gradient overlay 后（上）。叠加 fill 数组里靠后的在视觉上层。
  if (bundle.solidFill) {
    const sf = bundle.solidFill;
    fills.push({
      type: 'SOLID',
      color: { r: sf.r / 255, g: sf.g / 255, b: sf.b / 255, a: sf.opacity },
    });
  }
  if (bundle.gradientOverlay && bundle.gradientOverlay.style === 'linear') {
    const go = bundle.gradientOverlay;
    const gradient: SerializedGradientOverlay = {
      type: 'linear',
      angle: go.angle,
      reverse: go.reverse,
      opacity: go.opacity,
      stops: go.colorStops.map((cs) => {
        // 用同位置的 opacity stop（线性插值近似：直接取最近的 location 匹配，缺省 1）
        const op = matchOpacityAtLocation(go.opacityStops, cs.location);
        return {
          color: { r: cs.r / 255, g: cs.g / 255, b: cs.b / 255, a: op },
          position: cs.location, // GradientStop.location 已是 0~1
        };
      }),
    };
    fills.push({ type: 'GRADIENT_LINEAR', gradient });
  }
  return fills;
}

/** 在 opacityStops 中按 location 取不透明度（线性插值），缺省 1。 */
function matchOpacityAtLocation(stops: { location: number; opacity: number }[], location: number): number {
  if (!stops || stops.length === 0) return 1;
  const sorted = [...stops].sort((a, b) => a.location - b.location);
  if (location <= sorted[0].location) return sorted[0].opacity;
  if (location >= sorted[sorted.length - 1].location) return sorted[sorted.length - 1].opacity;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (location >= a.location && location <= b.location) {
      const t = (location - a.location) / (b.location - a.location || 1);
      return a.opacity + (b.opacity - a.opacity) * t;
    }
  }
  return 1;
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
  patternOverlayMeta: PatternOverlayMeta | null,
  resolvedPattern: { rgba: Uint8ClampedArray; w: number; h: number } | null,
): Promise<{ png: Uint8Array; expand: number; overlayBlendMode?: string }> {
  const srcW = imageData.width;
  const srcH = imageData.height;
  const strokes = effects.strokes;

  // 「纹理接管」场景：fillOpacity≈0（图层本体填充透明）但存在不透明 patternOverlay。
  // PS 语义：本体实色不显示，可见的只有 pattern 纹理，且 pattern 以其 blendMode 相对
  // 下层（而非本体实色）混合。因此此时应让 pattern 像素本身（按 normal）成为输出 RGB，
  // 再把 pattern 的 blendMode 提升到节点级，由平台对下层做混合。
  const hasOpaquePattern =
    (!!effects.patternOverlay && effects.patternOverlay.opacity >= 1) ||
    (!!patternOverlayMeta && !!resolvedPattern && patternOverlayMeta.opacity >= 1);
  const patternTakesOver = fillOpacity <= 0.01 && hasOpaquePattern;
  const patternRawBlendMode = effects.patternOverlay?.blendMode ?? patternOverlayMeta?.blendMode;
  const overlayBlendMode = patternTakesOver ? patternRawBlendMode : undefined;

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
  // 纹理接管时 pattern 用 normal 直接成为输出 RGB（blendMode 提升到节点级，见 overlayBlendMode）。
  const patternApplyBlend = patternTakesOver ? 'normal' : patternRawBlendMode;
  if (effects.patternOverlay) {
    applyPatternOverlayToPixels(srcPixels, srcW, srcH, { ...effects.patternOverlay, blendMode: patternApplyBlend });
  } else if (patternOverlayMeta && resolvedPattern) {
    applyPatternOverlayToPixels(srcPixels, srcW, srcH, {
      rgba: resolvedPattern.rgba,
      w: resolvedPattern.w,
      h: resolvedPattern.h,
      scale: patternOverlayMeta.scale,
      opacity: patternOverlayMeta.opacity,
      phaseX: patternOverlayMeta.phaseX,
      phaseY: patternOverlayMeta.phaseY,
      blendMode: patternApplyBlend,
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

  // 1. Drop Shadow（在最下层）。
  // PS 语义：effects 列表中靠前的 dropShadow 在视觉最上层。blendColorOnto 后画的覆盖先画的，
  // 故倒序遍历（最后一个先画在最底，第 0 个最后画在最上），使列表首个投影（通常是最亮/最外圈
  // 的实色边，如 Piggy Pop 的亮橙 r212）露在最外层，匹配 PS；否则后面的深色投影会盖暗它。
  for (let si = effects.dropShadows.length - 1; si >= 0; si--) {
    const shadow = effects.dropShadows[si];
    let shadowAlpha = copyAlphaToPadded(origAlpha, srcW, srcH, dstW, dstH, expand);
    if (shadow.spread > 0) {
      shadowAlpha = dilateAlpha(shadowAlpha, dstW, dstH, Math.ceil(shadow.spread));
    }
    if (shadow.blur > 0) {
      shadowAlpha = featherAlpha(shadowAlpha, dstW, dstH, shadow.blur);
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
      glowAlpha = featherAlpha(glowAlpha, dstW, dstH, g.blur);
    }
    blendColorOnto(dstPixels, dstW, dstH, glowAlpha, g.r, g.g, g.b, g.opacity);
  }

  // 3. 合成 fill（含 overlays/satin/bevel）到 dst
  // PS 语义：fillOpacity 只影响图层本体像素，不影响图层样式（pattern/gradient/color overlay 等）。
  // 当存在不透明的 overlay 覆盖整层时，可见 RGB 完全来自 overlay，alpha 应保持原图 alpha
  // 而非乘以 fillOpacity，否则 fillOpacity=0 会把 overlay 也一起消除（典型：fillOpacity=0 + patternOverlay）。
  const hasFullCoverageOverlay = !!(effects.solidFill && effects.solidFill.opacity >= 1) ||
    !!(effects.gradientOverlay && effects.gradientOverlay.opacity >= 1 &&
      effects.gradientOverlay.opacityStops.every(s => s.opacity >= 1)) ||
    !!(effects.patternOverlay && effects.patternOverlay.opacity >= 1) ||
    !!(patternOverlayMeta && resolvedPattern && patternOverlayMeta.opacity >= 1);
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

  // 4. Inner Shadow（在 fill 之上，但只在 alpha>0 区域可见）。
  // 同 dropShadow：倒序遍历使 effects 列表首个 innerShadow 露在最上层，匹配 PS 视觉叠加顺序。
  for (let ii = effects.innerShadows.length - 1; ii >= 0; ii--) {
    const inner = effects.innerShadows[ii];
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
      shadowField = featherAlpha(shadowField, dstW, dstH, inner.blur);
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
      envPadded = featherAlpha(envPadded, dstW, dstH, g.blur);
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
  return { png: new Uint8Array(buf), expand, overlayBlendMode };
}

/**
 * 把 ag-psd 的 `layer.effects` 序列化为可存储在 figma/mastergo plugin data
 * 中的 JSON 字符串，用于 figma/mastergo → PSD 还原时不丢失任何效果信息。
 *
 * 处理几个非 JSON-friendly 的字段：
 *   - `pattern.data: Uint8Array`：直接 JSON.stringify 会变成
 *     `{ "0":1,"1":2,... }` 形式，把 200 KB 的字典膨胀到 2 MB 以上；
 *     这里改为转 base64 字符串，按需在还原侧解码。
 *   - 其它字段（color/size/distance/blendMode/...) 默认就能被 JSON 化。
 *
 * 注意：本函数只在 needsComposite 的图层上调用，调用点必须是位图/形状/智能对象
 * 这类会把 effects rasterize 到位图的图层。文本图层走另一条路径（保留 IR.strokes/effects）。
 */
function serializeRawPsdEffects(layer: Layer, fillOpacity: number): string | undefined {
  if (!layer.effects) return undefined;
  try {
    const safe: any = JSON.parse(JSON.stringify(layer.effects, (_k, v) => {
      if (v instanceof Uint8Array || v instanceof Uint8ClampedArray) {
        let bin = '';
        for (let i = 0; i < v.length; i++) bin += String.fromCharCode(v[i]);
        return { __binBase64: btoa(bin) };
      }
      return v;
    }));
    return JSON.stringify({ effects: safe, fillOpacity });
  } catch (e) {
    logger.warn(`Failed to serialize raw effects for "${layer.name}": ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

/**
 * 序列化 PSD 矢量形状数据（vectorMask + vectorFill + vectorOrigination）为 JSON，
 * 供 figma/mastergo→PSD 回转时还原矢量形状的 Fill/Stroke/圆角/精确坐标。
 * vectorMask 中的 Uint8Array 字段（如果有）也用 __binBase64 编码。
 */
function serializeRawVectorData(layer: Layer): string | undefined {
  const vm = (layer as any).vectorMask;
  const vf = (layer as any).vectorFill;
  const vo = (layer as any).vectorOrigination;
  const vs = (layer as any).vectorStroke;
  if (!vm && !vf && !vo && !vs) return undefined;
  try {
    const safe = JSON.parse(JSON.stringify({ vectorMask: vm, vectorFill: vf, vectorOrigination: vo, vectorStroke: vs }, (_k, v) => {
      if (v instanceof Uint8Array || v instanceof Uint8ClampedArray) {
        let bin = '';
        for (let i = 0; i < v.length; i++) bin += String.fromCharCode(v[i]);
        return { __binBase64: btoa(bin) };
      }
      return v;
    }));
    return JSON.stringify(safe);
  } catch (e) {
    logger.warn(`Failed to serialize raw vector data for "${layer.name}": ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

/**
 * 把基底层「烘焙调整前的原始像素」按与正常图层相同的 mask + effects 合成路径编码为 base64 PNG。
 * 用于 round-trip 导出：基底层用原始像素 + 加回调整图层，PS 应用一次 = 与原始 PSD 一致。
 * 与 serializeLayer 主编码路径使用相同的 applyLayerMask / compositeLayerEffects，保证与烘焙版逐像素对齐（仅颜色不同）。
 */
async function encodeOriginalImageBase64(
  origImageData: { data: Uint8ClampedArray; width: number; height: number },
  layer: Layer,
  fillOpacity: number,
  effectBundle: LayerEffectBundle,
  patternOverlayMeta: PatternOverlayMeta | null,
  resolvedPatternData: { rgba: Uint8ClampedArray; w: number; h: number } | null,
): Promise<string | undefined> {
  try {
    const masked = applyLayerMask(origImageData, layer);
    const effective = masked ?? origImageData;
    const needsComposite = hasAnyEffect(effectBundle) || !!patternOverlayMeta;
    let png: Uint8Array;
    if (needsComposite && origImageData.width > 0 && origImageData.height > 0) {
      png = (await compositeLayerEffects(effective, fillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData)).png;
    } else {
      png = await imageDataToPng(effective);
    }
    return uint8ArrayToBase64(png);
  } catch (e) {
    logger.warn(`Failed to encode original (pre-adjustment) image for "${layer.name}": ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
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
): Promise<SerializedLayer | null> {
  // PS 调整图层（brightness/contrast, hue/saturation, vibrance 等）在 Figma/MasterGo
  // 中无法表达。跳过序列化，避免它们作为空矩形出现在 clip group 中，
  // 导致不必要的 clipping frame 裁剪掉基底图层的 shadow 等向外延伸效果。
  if ((layer as any).adjustment) {
    return null;
  }

  const type = determineLayerType(layer);

  const bounds = getLayerBounds(layer);
  let absX: number, absY: number, width: number, height: number;

  let isArtboard = false;
  // 组上的矩形图层蒙版（滚动视口裁剪）：若存在，frame 用蒙版框做坐标/尺寸，
  // 并让该组退出 isSubGroup（subGroup 走 0.01 尺寸 + 坐标透传，无法承载裁剪框）。
  const groupMask = type === 'group' ? getGroupMaskRect(layer) : null;

  if (type === 'group') {
    const ab = getArtboardBounds(layer);
    isArtboard = !!ab;
    if (ab) {
      absX = ab.left;
      absY = ab.top;
      width = ab.right - ab.left;
      height = ab.bottom - ab.top;
    } else if (groupMask) {
      absX = groupMask.left;
      absY = groupMask.top;
      width = groupMask.right - groupMask.left;
      height = groupMask.bottom - groupMask.top;
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

  // 带矩形蒙版的组退出 subGroup，成为真实尺寸的裁剪 frame；其余组判定逻辑不变。
  const isSubGroup = type === 'group' && depth > 0 && !isArtboard && !groupMask;
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

  // 组矩形蒙版：frame 已落在蒙版框原点，蒙版相对 frame 是满框矩形（left/top 恒 0）。
  if (groupMask) {
    serialized.groupMaskRect = {
      left: 0,
      top: 0,
      width: Math.max(0, width),
      height: Math.max(0, height),
      defaultColor: groupMask.defaultColor,
    };
  }


  // 对所有有 effects 的图层（含 group 和 text）保留原始 effects 元数据，
  // 让 figma/mastergo→PSD 回转时能精确还原 contour/antialiased/range 等高级字段
  // （这些字段在简化的 SerializedShadow 中会丢失）。
  // 文本图层也需要保留，让 PS 看到完整的 effects 字段（即使有 disabled 项）以保证渲染一致。
  // 位图合成路径下方会重写这个字段（加上 fillOpacity 信息）。
  if (layer.effects && (type === 'group' || type === 'text')) {
    const layerFillOpacityForGroup = (layer as any).fillOpacity ?? 1;
    const raw = serializeRawPsdEffects(layer, layerFillOpacityForGroup);
    if (raw) {
      serialized.rawEffectsData = raw;
    }
  }

  // 矢量形状信息（vectorMask/vectorFill/vectorOrigination）— 让 PSD shape layer
  // 在 figma/mastergo→PSD 回转时能还原 Fill/Stroke/圆角/精确坐标等矢量属性
  const vectorRaw = serializeRawVectorData(layer);
  if (vectorRaw) {
    serialized.rawVectorData = vectorRaw;
  }


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
    resolvedPatternData = await resolvePatternData(patternOverlayMeta.id, layer, globalPsdPatterns);
  }

  // round-trip 兜底：文本层额外编码原始 PSD 栅格像素（PS 渲染的字形位图）+ 原始文档坐标 bounds。
  // MasterGo 与 PS 同名字体（如 Asap SemiBold）字形度量不同，exportAsync 重渲染像素会偏小/偏移
  // 导致 PS 中文本被裁剪；导出时若文本未被编辑则优先用这份原始像素，保证像素级保真。
  if (serialized.type === 'text' && serialized.textData && layer.imageData && layer.imageData.width > 0 && layer.imageData.height > 0) {
    try {
      const maskedText = applyLayerMask(layer.imageData, layer);
      const effText = maskedText ?? layer.imageData;
      const textPng = await imageDataToPng(effText);
      serialized.textData.rawImage = {
        base64: uint8ArrayToBase64(textPng),
        left: (layer as any).left ?? bounds.left,
        top: (layer as any).top ?? bounds.top,
        width: effText.width,
        height: effText.height,
      };
      serialized.textData.originalText = layer.text?.text ?? serialized.textData.text;
      logger.info(`Layer "${layer.name}": saved original text raster (${effText.width}x${effText.height}) for round-trip`);
    } catch (e) {
      logger.warn(`Failed to encode original text raster for "${layer.name}": ${e instanceof Error ? e.message : e}`);
    }
  }

  // 文本「平台不可渲染效果」回退栅格化：文本含 spread 实色外扩阴影 / warp 弧形等平台画布渲染不出
  // 的效果时（textEffectsRenderable=false），把字形+全部效果用 compositeLayerEffects 烤成合成图，
  // 由 imageIndex 指向供画布显示；但 textData / rawImage / rawEffectsData 全保留，节点仍按文本层
  // 导出（详见 builder.buildTextNode 与两个 renderer 的 rasterized 分支）。
  if (
    serialized.type === 'text' && serialized.textData &&
    layer.imageData && layer.imageData.width > 0 && layer.imageData.height > 0 &&
    hasAnyEffect(effectBundle) &&
    !textEffectsRenderable(effectBundle, serialized.textData.warp)
  ) {
    try {
      const maskedText = applyLayerMask(layer.imageData, layer);
      const effText = maskedText ?? layer.imageData;
      const { png, expand, overlayBlendMode } = await compositeLayerEffects(
        effText, layerFillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData
      );
      serialized.imageIndex = images.length;
      images.push(png);
      if (expand > 0) serialized.expandOffset = expand;
      if (overlayBlendMode) serialized.blendMode = convertBlendMode(overlayBlendMode);
      // 节点仍是文本层：保留 textData/rawImage 供导出还原可编辑文本，存 rawEffectsData 供回写 effects；
      // effects/strokes 在 IR 端按 rasterized 置空（合成图已含效果，避免平台再叠一层）。
      serialized.rawEffectsData = serializeRawPsdEffects(layer, layerFillOpacity);
      serialized.textRasterized = true;
      logger.info(`Layer "${layer.name}": text rasterized (platform-unrenderable effects: ${effectBundle.dropShadows.length} dropShadow, ${effectBundle.innerShadows.length} innerShadow, warp=${serialized.textData.warp?.style ?? 'none'}), composite ${serialized.width}x${serialized.height} expand=${expand}`);
    } catch (e) {
      logger.warn(`Failed to rasterize text effects for "${layer.name}": ${e instanceof Error ? e.message : e}`);
    }
  }

  // 智能对象（placedLayer）改用「内嵌源 + 仿射变换」渲染清晰像素（匹配 PS merged composite），两种触发：
  //  1) 带启用的模糊类智能滤镜：ag-psd 读到的 channel data 是被模糊污染的缓存（导入后发糊）；
  //  2) 无模糊但源分辨率高于显示尺寸（如 cions 组无滤镜的小 coin）：缓存是低分辨率栅格，放大发糊。
  // 同时存原始像素 + placedLayer/滤镜元信息，供 round-trip 导出还原智能对象图层。
  if (shouldRerenderClear(layer)) {
    const clear = renderSmartObjectClearImage(layer);
    if (clear) {
      try {
        const origPng = layer.imageData && layer.imageData.width > 0
          ? await imageDataToPng(layer.imageData)
          : (layer.canvas ? await canvasToPng(layer.canvas as HTMLCanvasElement) : null);
        const pl = (layer as any).placedLayer;
        const feMasks = (layer as any).filterEffectsMasks as Array<{
          id: string; top: number; left: number; bottom: number; right: number; depth: number;
          channels: ({ compressionMode: number; data: Uint8Array } | undefined)[];
          extra?: { top: number; left: number; bottom: number; right: number; compressionMode: number; data: Uint8Array };
        }> | undefined;
        const feData = feMasks ? feMasks.map(m => ({
          id: m.id, top: m.top, left: m.left, bottom: m.bottom, right: m.right, depth: m.depth,
          channels: m.channels.map(ch => ch ? { compressionMode: ch.compressionMode, data: uint8ArrayToBase64(ch.data) } : null),
          extra: m.extra ? { top: m.extra.top, left: m.extra.left, bottom: m.extra.bottom, right: m.extra.right, compressionMode: m.extra.compressionMode, data: uint8ArrayToBase64(m.extra.data) } : undefined,
        })) : undefined;
        serialized.rawPsdSmartObject = JSON.stringify({
          origImageB64: origPng ? uint8ArrayToBase64(origPng) : undefined,
          transform: pl.transform,
          soId: pl.id,
          width: pl.width,
          height: pl.height,
          filter: pl.filter,
          filterEffectsMasks: feData,
        });
      } catch (e) {
        logger.warn(`Failed to save smart-object round-trip data for "${layer.name}": ${e instanceof Error ? e.message : e}`);
      }
      // 用清晰像素覆盖，后续 mask / native / composite / plain 流程自然复用清晰像素。
      (layer as any).imageData = { data: clear.data, width: clear.width, height: clear.height };
      if ((layer as any).canvas) (layer as any).canvas = undefined;
      // 父层预处理已把剪贴调整（如 +17 亮度）烘进旧的模糊 imageData，但刚被清晰像素覆盖丢失。
      // 在清晰像素上重新应用同一批调整，使 display = 清晰源 + 曲线 + 调整层（与 PS 一致）。
      // round-trip 不受影响：rawPsdSmartObject 存的是未调整的原始模糊像素，调整层另由 rawPsdAdjustments 还原。
      const rerenderAdj = (layer as any).__rerenderClipAdjustments as Layer[] | undefined;
      if (rerenderAdj && rerenderAdj.length > 0) {
        applyAdjustmentLayers(layer, rerenderAdj);
        logger.info(`Layer "${layer.name}": re-applied ${rerenderAdj.length} clip adjustment(s) on clear image: ${rerenderAdj.map(a => (a as any).adjustment?.type).join(', ')}`);
      }
      const reason = hasBlurSmartFilter(layer) ? 'blur filter (sharp body + blur trail)' : 'sharpness (downsampled source)';
      logger.info(`Layer "${layer.name}": smart object re-rendered from source [${reason}] (${clear.width}x${clear.height})`);
    }
  }

  if (serialized.type !== 'text' && layer.imageData && layer.imageData.width > 0 && layer.imageData.height > 0) {
    onProgress({ percent: 0, message: `Encoding image: ${layer.name}` });
    try {
      const maskedData = applyLayerMask(layer.imageData, layer);
      const effectiveImageData = maskedData ?? layer.imageData;
      // 整层原生化闸门：所有效果都能与 PS 像素级一致地用平台属性表达时，保留 effects/strokes/
      // overlay fill 为可编辑、不烤进位图；否则退回栅格化（needsComposite）。二者互斥。
      const native = ENABLE_EFFECT_NATIVIZATION && hasAnyEffect(effectBundle) &&
        canNativizeLayer(layer, effectBundle, patternOverlayMeta, effectiveImageData);
      const needsComposite = !native && (hasAnyEffect(effectBundle) || !!patternOverlayMeta);

      if (native) {
        // effects/strokes 已在 serialized 初始化时由 convertEffects/convertStrokes 设置，保留即可。
        const png = await imageDataToPng(effectiveImageData);
        serialized.imageIndex = images.length;
        images.push(png);
        const overlays = convertOverlaysToFills(effectBundle);
        if (overlays.length > 0) serialized.overlayFills = overlays;
        // 不设 expandOffset、不写 rawEffectsData：效果由平台节点属性唯一承载并导出。
        logger.info(`Layer "${layer.name}": nativized effects (${serialized.effects.length} shadows, ${serialized.strokes.length} strokes, ${overlays.length} overlay fills) — kept editable`);
      } else if (needsComposite) {
        const { png, expand, overlayBlendMode } = await compositeLayerEffects(effectiveImageData, layerFillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData);
        serialized.imageIndex = images.length;
        images.push(png);
        if (expand > 0) {
          serialized.expandOffset = expand;
        }
        // 纹理接管（fillOpacity≈0 + 不透明 overlay）：把 overlay 的混合模式提升到节点级，
        // 使栅格化后的纹理相对下层正确混合（如绒布柔光纹理）。
        if (overlayBlendMode) {
          serialized.blendMode = convertBlendMode(overlayBlendMode);
        }
        serialized.rawEffectsData = serializeRawPsdEffects(layer, layerFillOpacity);
        serialized.strokes = [];
        serialized.effects = [];
        // P1 纯 pattern：保存「烤 pattern 之前」的原始像素，供导出端还原可编辑 patternOverlay。
        if (isPatternOnlyLayer(effectBundle, patternOverlayMeta)) {
          serialized.rawPsdPrePatternImage = uint8ArrayToBase64(await imageDataToPng(effectiveImageData));
          logger.info(`Layer "${layer.name}": saved pre-pattern image for round-trip`);
        }
        logger.info(`Layer "${layer.name}": composited with ${effectBundle.strokes.length} strokes, ${effectBundle.dropShadows.length} shadows, fillOpacity=${layerFillOpacity}, overlayBlend=${overlayBlendMode ?? 'none'}, expand=${expand} (${serialized.width}x${serialized.height})`);
      } else {
        const png = await imageDataToPng(effectiveImageData);
        serialized.imageIndex = images.length;
        images.push(png);
        logger.info(`Layer "${layer.name}": encoded imageData (${effectiveImageData.width}x${effectiveImageData.height})`);
      }

      // round-trip：若该基底层有「烘焙调整前的原始像素」，额外编码原始 PNG 供导出还原。
      const origData = (layer as any).__origImageDataBeforeAdjustment;
      if (origData && origData.width > 0 && origData.height > 0) {
        const origB64 = await encodeOriginalImageBase64(origData, layer, layerFillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData);
        if (origB64) {
          serialized.rawPsdOriginalImage = origB64;
          logger.info(`Layer "${layer.name}": saved pre-adjustment original image (${origData.width}x${origData.height}) for round-trip`);
        }
      }

      // round-trip：普通光栅层的 layer mask —— 存 mask 数据 + 未烘焙 mask 的原始像素，导出端还原可编辑 mask。
      // 仅在 mask 真实生效（maskedData 非 null）、且非调整基底（origData）/非纯 pattern 时：后两类已有各自
      // 的原始像素兜底，但那两份像素均已烘焙 mask，再叠加独立 layer.mask 会双重裁剪。
      if (maskedData && !origData && !isPatternOnlyLayer(effectBundle, patternOverlayMeta)) {
        const lmData = serializeAdjustmentMask(layer.mask);
        if (lmData) {
          // mask 几何存为相对层 bbox 左上的偏移（非文档绝对），导出端用「图层最终坐标 + 偏移」还原，
          // 使 mask 始终跟随 canvas 的最终位置（视口裁剪改写坐标、平台坐标往返舍入都不致错位）。
          lmData.left -= bounds.left;
          lmData.top -= bounds.top;
          // 未烘焙 mask 的原始像素：把 layer.imageData 规范化为 Uint8ClampedArray（未乘 mask alpha），
          // 走与主像素相同的 composite/encode，唯一差异即不乘 mask alpha。
          const lw = layer.imageData.width, lh = layer.imageData.height;
          const lsrc = layer.imageData.data;
          const unmasked = new Uint8ClampedArray(lw * lh * 4);
          if (lsrc instanceof Uint8ClampedArray || lsrc instanceof Uint8Array) {
            unmasked.set(lsrc.subarray(0, lw * lh * 4));
          } else {
            for (let i = 0; i < lw * lh * 4; i++) unmasked[i] = Math.min(255, Math.max(0, Math.round(Number(lsrc[i]))));
          }
          const unmaskedData = { data: unmasked, width: lw, height: lh };
          const preMaskPng = needsComposite
            ? (await compositeLayerEffects(unmaskedData, layerFillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData)).png
            : await imageDataToPng(unmaskedData);
          serialized.rawLayerMask = lmData;
          serialized.rawLayerMaskImage = uint8ArrayToBase64(preMaskPng);
          logger.info(`Layer "${layer.name}": saved layer mask (${lmData.width}x${lmData.height}) + pre-mask image for round-trip`);
        }
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
      // 整层原生化闸门（与 image 分支对称，逻辑须一致）。
      const native = ENABLE_EFFECT_NATIVIZATION && hasAnyEffect(effectBundle) && cvs.width > 0 && cvs.height > 0 &&
        canNativizeLayer(layer, effectBundle, patternOverlayMeta, effectiveCanvasData);
      const needsComposite = !native && (hasAnyEffect(effectBundle) || !!patternOverlayMeta);

      if (native) {
        // effects/strokes 已在 serialized 初始化时由 convertEffects/convertStrokes 设置，保留即可。
        const png = maskedCanvasData ? await imageDataToPng(effectiveCanvasData) : await canvasToPng(cvs);
        serialized.imageIndex = images.length;
        images.push(png);
        const overlays = convertOverlaysToFills(effectBundle);
        if (overlays.length > 0) serialized.overlayFills = overlays;
        // 不设 expandOffset、不写 rawEffectsData：效果由平台节点属性唯一承载并导出。
        logger.info(`Layer "${layer.name}": nativized effects (${serialized.effects.length} shadows, ${serialized.strokes.length} strokes, ${overlays.length} overlay fills) — kept editable`);
      } else if (needsComposite && cvs.width > 0 && cvs.height > 0) {
        const { png, expand, overlayBlendMode } = await compositeLayerEffects(effectiveCanvasData, layerFillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData);
        serialized.imageIndex = images.length;
        images.push(png);
        if (expand > 0) {
          serialized.expandOffset = expand;
        }
        // 纹理接管（fillOpacity≈0 + 不透明 overlay）：overlay 混合模式提升到节点级。
        if (overlayBlendMode) {
          serialized.blendMode = convertBlendMode(overlayBlendMode);
        }
        serialized.rawEffectsData = serializeRawPsdEffects(layer, layerFillOpacity);
        serialized.strokes = [];
        serialized.effects = [];
        // P1 纯 pattern：保存「烤 pattern 之前」的原始像素，供导出端还原可编辑 patternOverlay。
        if (isPatternOnlyLayer(effectBundle, patternOverlayMeta)) {
          serialized.rawPsdPrePatternImage = uint8ArrayToBase64(await imageDataToPng(effectiveCanvasData));
          logger.info(`Layer "${layer.name}": saved pre-pattern canvas for round-trip`);
        }
        logger.info(`Layer "${layer.name}": composited canvas with ${effectBundle.strokes.length} strokes, ${effectBundle.dropShadows.length} shadows, fillOpacity=${layerFillOpacity}, overlayBlend=${overlayBlendMode ?? 'none'}, expand=${expand} (${serialized.width}x${serialized.height})`);
      } else {
        const png = maskedCanvasData ? await imageDataToPng(effectiveCanvasData) : await canvasToPng(cvs);
        serialized.imageIndex = images.length;
        images.push(png);
        logger.info(`Layer "${layer.name}": encoded canvas${maskedCanvasData ? ' (masked)' : ''}`);
      }

      // round-trip：若该基底层有「烘焙调整前的原始像素」，额外编码原始 PNG 供导出还原。
      const origData = (layer as any).__origImageDataBeforeAdjustment;
      if (origData && origData.width > 0 && origData.height > 0) {
        const origB64 = await encodeOriginalImageBase64(origData, layer, layerFillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData);
        if (origB64) {
          serialized.rawPsdOriginalImage = origB64;
          logger.info(`Layer "${layer.name}": saved pre-adjustment original canvas (${origData.width}x${origData.height}) for round-trip`);
        }
      }

      // round-trip：普通光栅层的 layer mask —— 存 mask 数据 + 未烘焙 mask 的原始像素，导出端还原可编辑 mask。
      // rawCanvasData 来自 getImageData，已是 Uint8ClampedArray，直接走同款 composite/encode（不乘 mask alpha）。
      if (maskedCanvasData && !origData && !isPatternOnlyLayer(effectBundle, patternOverlayMeta)) {
        const lmData = serializeAdjustmentMask(layer.mask);
        if (lmData) {
          // mask 几何存为相对层 bbox 左上的偏移（见 image 分支说明）。
          lmData.left -= bounds.left;
          lmData.top -= bounds.top;
          const preMaskPng = needsComposite
            ? (await compositeLayerEffects(rawCanvasData, layerFillOpacity, effectBundle, patternOverlayMeta, resolvedPatternData)).png
            : await imageDataToPng(rawCanvasData);
          serialized.rawLayerMask = lmData;
          serialized.rawLayerMaskImage = uint8ArrayToBase64(preMaskPng);
          logger.info(`Layer "${layer.name}": saved layer mask (${lmData.width}x${lmData.height}) + pre-mask canvas for round-trip`);
        }
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

    // 预处理：将 clipping 调整图层的色彩修改应用到基底图层的 imageData 上。
    // PS 中调整图层通过 clipping 蒙版修改底层像素颜色（色相/饱和度/亮度等），
    // Figma/MasterGo 无法表达这些调整，因此在解析阶段直接修改像素。
    // 同时保存调整图层原始数据用于 round-trip 导出还原。
    const baseAdjustmentsMap = new Map<Layer, string>();
    for (let ci = 0; ci < layer.children.length; ci++) {
      const base = layer.children[ci];
      if (base.clipping) continue;
      const adjustments: Layer[] = [];
      for (let j = ci + 1; j < layer.children.length && layer.children[j].clipping; j++) {
        if ((layer.children[j] as any).adjustment) {
          adjustments.push(layer.children[j]);
        }
      }
      if (adjustments.length > 0) {
        // round-trip 方案：在烘焙调整效果到像素之前，克隆基底层原始像素。
        // 导出时基底层用这份「未烘焙原始像素」+ 加回调整图层，PS 应用一次 = 与原始一致，
        // 既保证视觉正确（不双重应用），又保留 PSD 调整图层结构。
        const bdOrig: any = base.imageData;
        if (bdOrig && bdOrig.data && bdOrig.width > 0 && bdOrig.height > 0) {
          (base as any).__origImageDataBeforeAdjustment = {
            data: new Uint8ClampedArray(bdOrig.data),
            width: bdOrig.width,
            height: bdOrig.height,
          };
        }
        applyAdjustmentLayers(base, adjustments);
        // 若该基底是「稍后会被清晰源重渲染的智能对象」（模糊清洗 或 锐度提升），其 imageData
        // 会被重渲染覆盖（丢失此处烘焙的调整）。暂存调整层引用，serializeLayer 重渲染后在清晰像素上重新应用一次。
        if (shouldRerenderClear(base)) {
          (base as any).__rerenderClipAdjustments = adjustments;
        }
        logger.info(`Applied ${adjustments.length} adjustment layers to "${base.name}": ${adjustments.map(a => (a as any).adjustment?.type).join(', ')}`);
        baseAdjustmentsMap.set(base, JSON.stringify(
          adjustments.map(a => ({
            name: (a as any).name,
            hidden: !!(a as any).hidden,
            adjustment: (a as any).adjustment,
            mask: serializeAdjustmentMask((a as any).mask),
          }))
        ));
      }
    }

    for (const child of layer.children) {
      const childSerialized = await serializeLayer(child, images, onProgress, depth + 1, childParentLeft, childParentTop, effectiveRootLeft, effectiveRootTop);
      if (childSerialized) {
        const adjJson = baseAdjustmentsMap.get(child);
        if (adjJson) {
          childSerialized.rawPsdAdjustments = adjJson;
        }
        serialized.children.push(childSerialized);
      }
    }

    // PS 中 group 的 layer effects（stroke/shadow 等）会合成到整个 group 内容的
    // 像素轮廓上。Figma/MasterGo 无法在 frame 上实现这种效果（frame stroke 只沿矩形边框）。
    // 近似方案：将 group 的 enabled strokes/effects 下发给子节点（仅用于平台内显示）。
    // round-trip 注意：组 effect 已由组自身的 rawEffectsData 完整保留并导出，下发到子层的
    // 副本是冗余的——给被下发的子层打标记，导出端（无自有 rawEffectsData 时）据此剔除，
    // 否则会被当成子层自有 effect 写回 PSD，产生伪投影/伪描边。
    if (isSubGroup && serialized.children.length > 0) {
      const groupStrokes = serialized.strokes;
      const groupEffects = serialized.effects;
      if (groupStrokes.length > 0 || groupEffects.length > 0) {
        for (const child of serialized.children) {
          if (groupStrokes.length > 0) {
            child.strokes = [...child.strokes, ...groupStrokes];
            child.inheritedGroupStrokes = true;
          }
          if (groupEffects.length > 0) {
            child.effects = [...child.effects, ...groupEffects];
            child.inheritedGroupEffects = true;
          }
        }
        serialized.strokes = [];
        serialized.effects = [];
      }
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

  globalPsdPatterns = (psd as any).patterns as typeof globalPsdPatterns;
  globalPsdLinkedFiles = (psd as any).linkedFiles as typeof globalPsdLinkedFiles;
  globalSmartObjectSourceCache = new Map();
  logger.info(`PSD structure parsed: ${psd.width}x${psd.height}, ${psd.children?.length ?? 0} top-level layers, ${globalPsdPatterns?.length ?? 0} global patterns, ${globalPsdLinkedFiles?.length ?? 0} linked files`);
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

      const serializedLayer = await serializeLayer(psd.children[i], images, onProgress, 0, 0, 0);
      if (serializedLayer) {
        layers.push(serializedLayer);
      }
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
    psdPatterns: serializePsdPatterns(globalPsdPatterns),
  };
}
