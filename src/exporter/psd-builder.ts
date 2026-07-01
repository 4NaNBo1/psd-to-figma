import { writePsd } from 'ag-psd';
import type { Psd, Layer, BlendMode, LayerEffectShadow, LayerEffectSolidFill, LayerEffectGradientOverlay, LayerEffectStroke, ColorStop, OpacityStop } from 'ag-psd';
import type { ExportNodeData, ExportFillInfo, SerializedColor } from '../types/psd-types';
import { encodeNineSliceLayerName, parseNineSliceSettingsJson } from './nine-slice-collapse';

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

// Restore export TextCase to PSD fontCaps: UPPER→2 (all caps), SMALL_CAPS→1, else 0.
function textCaseToFontCaps(tc: string | undefined): number {
  if (tc === 'UPPER') return 2;
  if (tc === 'SMALL_CAPS') return 1;
  return 0;
}

function toPostScriptName(family: string, style: string): string {
  const cleanFamily = family.replace(/\s+/g, '');
  if (!style || style === 'Regular') return cleanFamily;
  const cleanStyle = style.replace(/\s+/g, '');
  return `${cleanFamily}-${cleanStyle}`;
}

// 智能对象完整还原收集器：buildLayer 把带滤镜智能对象的「内嵌源 + 文档级滤镜蒙版」收集到这里，
// 在 buildAndDownloadPsd 写 PSD 前注入到文档根(psd.linkedFiles / psd.filterEffectsMasks)。
// 文档级数据 + 图层级 placedLayer/filter 一起，让 PS 完整还原智能滤镜(经纯往返验证无损)。
let collectedLinkedFiles: { id: string; name: string; type: string; data: Uint8Array }[] = [];
let collectedFilterEffectsMasks: any[] = [];

// 还原 serializePlacedLayer 序列化的 placedLayer({__u8:base64} → Uint8Array)。
function deserializePlacedLayer(obj: any): any {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(deserializePlacedLayer);
  if (typeof obj === 'object') {
    if (typeof obj.__u8 === 'string') return base64ToUint8Array(obj.__u8);
    const out: any = {};
    for (const k of Object.keys(obj)) out[k] = deserializePlacedLayer(obj[k]);
    return out;
  }
  return obj;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

/**
 * 解码 node-serializer 传来的 psd_patterns JSON（SerializedPattern[]），还原为
 * ag-psd PatternInfo[]（data 从 base64 还原为 Uint8Array）。供写回 psd.patterns。
 */
/** 校验内嵌智能对象源(PSD/PSB)结构是否完整，拒绝 pluginData 截断后的残缺字节。 */
function isValidEmbeddedPsdData(data: Uint8Array): boolean {
  if (data.length < 30) return false;
  if (data[0] !== 0x38 || data[1] !== 0x42 || data[2] !== 0x50 || data[3] !== 0x53) return false;
  const readU32 = (off: number) =>
    ((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) >>> 0;
  let pos = 26;
  if (pos + 4 > data.length) return false;
  const colorModeLen = readU32(pos);
  pos += 4 + colorModeLen;
  if (colorModeLen % 2) pos++;
  if (pos + 4 > data.length) return false;
  const imgResLen = readU32(pos);
  pos += 4 + imgResLen;
  if (imgResLen % 2) pos++;
  if (pos + 4 > data.length) return false;
  const layerMaskLen = readU32(pos);
  const expectedEnd = pos + 4 + layerMaskLen;
  // layer info 声明 0 但尾部仍有大段孤儿数据 ⇒ 典型截断残片（如恰好 1MB 上限）。
  if (layerMaskLen === 0 && data.length > expectedEnd + 64) return false;
  if (expectedEnd > data.length) return false;
  return true;
}

function decodePsdPatterns(json: string | undefined): { id: string; name: string; x: number; y: number; bounds: { x: number; y: number; w: number; h: number }; data: Uint8Array }[] | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    const out = arr.map((p: any) => ({
      id: p.id,
      name: p.name ?? '',
      x: p.x ?? 0,
      y: p.y ?? 0,
      bounds: { x: p.bounds?.x ?? 0, y: p.bounds?.y ?? 0, w: p.bounds.w, h: p.bounds.h },
      data: base64ToUint8Array(p.dataB64),
    }));
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function nodeIdToGuid(nodeId: string): string {
  const hex = nodeId.replace(/[^0-9a-fA-F]/g, '').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
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

/** 等比放大后居中裁切到目标尺寸（避免非等比拉伸导致圆角变形）。 */
function fitCanvasCoverCrop(source: HTMLCanvasElement, targetW: number, targetH: number): HTMLCanvasElement {
  const tw = Math.max(1, Math.round(targetW));
  const th = Math.max(1, Math.round(targetH));
  if (source.width === tw && source.height === th) return source;
  const scale = Math.max(tw / source.width, th / source.height);
  const dw = source.width * scale;
  const dh = source.height * scale;
  const ox = (tw - dw) / 2;
  const oy = (th - dh) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0, source.width, source.height, ox, oy, dw, dh);
  return canvas;
}

/** 从较大源图居中裁切到 layer bbox（9-slice 源图含圆角保护区，写入 PSD 时裁回逻辑尺寸）。 */
function centerCropCanvas(source: HTMLCanvasElement, targetW: number, targetH: number): HTMLCanvasElement {
  const tw = Math.max(1, Math.round(targetW));
  const th = Math.max(1, Math.round(targetH));
  if (source.width === tw && source.height === th) return source;
  const cropped = document.createElement('canvas');
  cropped.width = tw;
  cropped.height = th;
  const ctx = cropped.getContext('2d')!;
  const ox = Math.max(0, Math.floor((source.width - tw) / 2));
  const oy = Math.max(0, Math.floor((source.height - th) / 2));
  ctx.drawImage(source, ox, oy, tw, th, 0, 0, tw, th);
  return cropped;
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
function decodeRawPsdVectorData(raw: string): { vectorMask?: any; vectorFill?: any; vectorOrigination?: any; vectorStroke?: any } | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return decodeBinBase64Fields(parsed);
  } catch { return null; }
}

/**
 * 由平台节点提取到的简化阴影（仅 color/offset/blur/spread）生成一个 PSD 合法的
 * dropShadow/innerShadow 描述。必须补齐 contour/present/showInDialog/useGlobalLight/
 * antialiased/layerConceals 等字段：缺少 contour curve 时 PS 打开会报
 * “settings in the file are invalid”。
 * 仅在 rawEffects 底子没有对应阴影（即设计工具新加的阴影）时调用。
 */
function makeShadow(e: { color: { r: number; g: number; b: number; a: number }; offsetX: number; offsetY: number; blur: number; spread: number; blendMode?: string }): LayerEffectShadow {
  return {
    enabled: true,
    present: true,
    showInDialog: true,
    color: toRGBA(e.color),
    opacity: e.color.a,
    useGlobalLight: false,
    // 与导入端 effect-converter 对称：导入用 offsetX=cos(angle)*d、offsetY=sin(angle)*d，
    // 故导出须用 angle=atan2(offsetY, offsetX)。原先用 -offsetY 会把 PSD 90° round-trip 成 -90°（投影方向翻转）。
    angle: Math.round(Math.atan2(e.offsetY, e.offsetX) * (180 / Math.PI)),
    distance: { units: 'Pixels' as const, value: Math.round(Math.sqrt(e.offsetX ** 2 + e.offsetY ** 2)) },
    size: { units: 'Pixels' as const, value: Math.round(e.blur) },
    choke: { units: 'Pixels' as const, value: Math.round(e.spread) },
    // 用节点 effect 的真实混合模式，缺失时回退 multiply（PS 投影默认）。原先一律硬编码 multiply 会把 normal 等丢失。
    blendMode: (e.blendMode ? toBlendMode(e.blendMode) : 'multiply') as BlendMode,
    noise: 0,
    antialiased: false,
    contour: { name: '线性', curve: [{ x: 0, y: 0 }, { x: 255, y: 255 }] },
    layerConceals: true,
  } as LayerEffectShadow;
}

/**
 * 过滤 result.patternOverlay：
 *   1. pattern.id 不在「实际可写回的 pattern 资源集合」内的引用一律剔除——
 *      否则 PS 打开找不到 pattern 资源会报 program error（悬空引用，常见于 disabled 引用）。
 *   2. 「纯 patternOverlay 烤前像素」场景(usedPrePattern) 保留 enabled 引用；
 *      否则（烤后像素）剔除 enabled 引用，避免「烤后像素 + 再叠加 pattern」双重叠加。
 * patternOverlay 在 ag-psd 中是单对象（非数组），单对象为主、数组兜底。
 */
function filterPatternOverlay(result: any, node: ExportNodeData, availablePatternIds?: Set<string>): void {
  if (!result.patternOverlay) return;
  const ids = availablePatternIds ?? new Set<string>();
  const usedPrePattern = !!node.rawPsdPrePatternImage;
  const arr = Array.isArray(result.patternOverlay) ? result.patternOverlay : [result.patternOverlay];
  const kept = arr.filter((po: any) => {
    const id = po?.pattern?.id;
    if (!id || !ids.has(id)) return false;
    return po.enabled === false || usedPrePattern;
  });
  if (kept.length === 0) {
    delete result.patternOverlay;
  } else {
    result.patternOverlay = Array.isArray(result.patternOverlay) ? kept : kept[0];
  }
}

function buildEffects(node: ExportNodeData, availablePatternIds?: Set<string>): {
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
    // ag-psd 把 bevel 写到 group（section divider）上会产生 PS 无法解析的块，PS 打开报
    // "program error reading layers"（数据驱动定位：原始/导出 bevel 数据逐字段一致，且同一 bevel
    // 写在普通图层上正常、仅写在 group 上触发；实测也仅 bevel 触发，其它图层样式在 group 上均正常）。
    // 这些 group bevel 绝大多数是 enabled:false 的禁用样式槽、不可见，剔除对画面零影响。
    // 仅容器节点剔除；普通图层/文本的 bevel 写入正常，予以保留。
    if (isContainerNode && result.bevel) delete result.bevel;
    // 容器/文本早退路径也必须过滤悬空 patternOverlay，否则 Patt 资源缺失时 PS 无法保存。
    filterPatternOverlay(result, node, availablePatternIds);
    return Object.keys(result).length > 0 ? result : undefined;
  }

  // figma/mastergo 上能提取到的字段优先覆盖（用户在设计工具上的编辑生效）。
  // 这些字段未被提取到时（即 figma/mastergo 上空），保留原始数据（如果有）。
  //
  // 关键约束（防 round-trip 伪投影 + settings invalid）：
  //   1. 若 rawEffects 底子里已有 dropShadow，**信任底子**，不用平台节点的简化投影覆盖。
  //      因为底子是从 PSD 直读的完整合法结构（含 contour/present/useGlobalLight 等 PS 必需字段），
  //      而平台节点上的投影很可能是 MasterGo createRectangle 自带的默认黑投影残留
  //      （底子里该 dropShadow 是 enabled:false 时尤其如此）——覆盖会同时引入伪投影并丢失合法字段。
  //   2. 仅当底子完全没有 dropShadow（纯设计工具创建的节点）时，才用平台节点投影生成，
  //      且必须补齐 contour 等字段，否则 PS 打开报 “settings in the file are invalid”。
  // 当本层 effects 是「从 pass-through 父组下放来的」副本（inheritedGroupEffects）且本层自身没有
  // rawEffects 底子时，node.effects 里的 dropShadow/innerShadow 全是组下放的伪影——本层原始并无可见
  // 阴影（若有会走合成路径并存下 rawEffects）。不写回 PSD，组 effect 由组自身的 rawEffectsData 还原。
  const suppressInheritedShadow = !!node.inheritedGroupEffects && !rawEffects;

  const drops = suppressInheritedShadow ? [] : node.effects.filter(e => e.type === 'DROP_SHADOW' && e.visible);
  if (drops.length > 0 && !(Array.isArray(result.dropShadow) && result.dropShadow.length > 0)) {
    result.dropShadow = drops.map(e => makeShadow(e));
  }

  const inners = suppressInheritedShadow ? [] : node.effects.filter(e => e.type === 'INNER_SHADOW' && e.visible);
  if (inners.length > 0 && !(Array.isArray(result.innerShadow) && result.innerShadow.length > 0)) {
    result.innerShadow = inners.map(e => makeShadow(e));
  }

  const solidFills = node.fills.filter(f => f.type === 'SOLID' && f.visible && f.color);
  // PSD 的 solidFill (Color Overlay) effect 会用纯色覆盖整个 layer 的内容，
  // 对 group/frame 而言会覆盖 children 视觉。仅对 leaf 节点才使用此 effect。
  const hasChildren = !!(node.children && node.children.length > 0);
  const fillBakedInRaster = !!(
    node.imageBase64 &&
    !node.rawPsdOriginalImage &&
    !node.rawPsdPrePatternImage &&
    !node.rawPsdLayerMaskImage &&
    !node.rawPsdSmartObject
  );
  // 纯色填充：即使像素已烘焙进 imageBase64，仍写 solidFill 作 PS 兼容兜底（与 raster 同色同透明度时不重复显色）。
  // passThroughBaked 像素已含穿透叠加层合成，不可再写 solidFill。
  if (solidFills.length > 0 && node.type !== 'text' && !hasChildren && !node.passThroughBaked) {
    result.solidFill = solidFills.map(f => ({
      enabled: true,
      color: toRGBA(f.color!),
      opacity: f.opacity ?? 1,
      blendMode: 'normal' as BlendMode,
    }));
  }

  const gradients = node.fills.filter(f => f.type.startsWith('GRADIENT_') && f.visible);
  if (gradients.length > 0 && !fillBakedInRaster && !node.passThroughBaked) {
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

  // 同理：下放来的 stroke 副本在本层无 rawEffects 兜底时不写回（组 stroke 由组自身还原）。
  const suppressInheritedStroke = !!node.inheritedGroupStrokes && !rawEffects;
  const visibleStrokes = suppressInheritedStroke ? [] : node.strokes.filter(s => s.visible);
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

  filterPatternOverlay(result, node, availablePatternIds);

  return Object.keys(result).length > 0 ? result : undefined;
}

async function buildLayer(node: ExportNodeData, parentClipRect?: { x: number; y: number; width: number; height: number; cornerRadii?: { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number } } | null, availablePatternIds?: Set<string>): Promise<Layer | Layer[]> {
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
      // 旋转还原：原始 transform = [sx·cosθ, sx·sinθ, -sy·sinθ, sy·cosθ, tx, ty]，θ=-rotation。
      // 把 boundingBox 四角经此矩阵变换到文档坐标，取 AABB 作为 layer bbox。
      // 旋转时若仍用轴对齐 bbox（sx·left ... sy·bottom），bbox 会小于旋转后的实际像素范围，
      // 导致 PS 渲染裁剪。无旋转时（θ=0）此公式退化为原来的轴对齐结果。
      const rotDeg = tiForBbox.rotation != null && Number.isFinite(tiForBbox.rotation) ? tiForBbox.rotation : 0;
      const theta = (-rotDeg * Math.PI) / 180;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const mA = sx * cosT, mB = sx * sinT, mC = -sx * sinT, mD = sy * cosT;
      const bbL = bboxForLayer.left, bbR = bboxForLayer.right;
      const bbT = bboxForLayer.top, bbB = bboxForLayer.bottom;
      const corners: Array<[number, number]> = [
        [bbL, bbT], [bbR, bbT], [bbR, bbB], [bbL, bbB],
      ];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [u, v] of corners) {
        const dx = effTxBase + mA * u + mC * v;
        const dy = effTy + mB * u + mD * v;
        if (dx < minX) minX = dx;
        if (dx > maxX) maxX = dx;
        if (dy < minY) minY = dy;
        if (dy > maxY) maxY = dy;
      }
      layerTop = Math.floor(minY);
      layerBottom = Math.ceil(maxY);
      layerLeft = Math.floor(minX);
      layerRight = Math.ceil(maxX);
    } else {
      // box text: 用 bounds.top 算 ty (与原代码一致)
      const ty = node.y - (tiForBbox.bounds?.top ?? -fontSize * 0.097) * sy;
      layerTop = Math.floor(ty + bboxForLayer.top * sy);
      layerBottom = Math.ceil(ty + bboxForLayer.bottom * sy);
      layerLeft = Math.floor(node.x + bboxForLayer.left * sx);
      layerRight = Math.ceil(node.x + bboxForLayer.right * sx);
    }
  }

  // PS 不支持叶子层 pass through；容器组若保留 pass through，子层会与组外下层处于同一
  // 穿透叠放上下文，兄弟组（如 handcards 内多张 card）的帧级层序会错乱。
  // 容器组改用 normal，使整组先合成再与兄弟组按层序叠放（与 MasterGo/Figma 帧隔离一致）。
  let effectiveBlendMode = node.blendMode;
  const isGroupForBM = !!(node.children && node.children.length > 0);
  if (effectiveBlendMode === 'PASS_THROUGH') {
    effectiveBlendMode = 'NORMAL';
  }

  const layer: Layer = {
    name: encodeNineSliceLayerName(node.name, node.nineSliceSettings),
    top: layerTop,
    left: layerLeft,
    bottom: layerBottom,
    right: layerRight,
    blendMode: toBlendMode(effectiveBlendMode),
    opacity: node.opacity,
    hidden: !node.visible,
    clipping: node.isMask,
  };

  const effects = buildEffects(node, availablePatternIds);
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
      if (vectorData.vectorStroke) (layer as any).vectorStroke = vectorData.vectorStroke;
    }
  }

  const isTextLayer = !!(node.textInfo && node.textInfo.characters);
  const hasPsdTextMetadata = isTextLayer && (node.textInfo!.bounds != null || node.textInfo!.boundingBox != null);
  const isMultilineNoMeta = isTextLayer && !hasPsdTextMetadata && (() => {
    const fs = node.textInfo!.styles?.[0]?.fontSize ?? 16;
    const estCW = Math.max(1, fs * 0.6 * node.textInfo!.characters.length);
    return estCW > node.width * 1.1;
  })();
  const shouldUseTextCanvas = isTextLayer && (hasPsdTextMetadata || isMultilineNoMeta);
  // round-trip 最高优先级：文本未被编辑时，用导入时保存的原始 PSD 文本栅格像素 + 原始文档坐标，
  // 规避 MasterGo/Figma 与 PS 同名字体（如 Asap SemiBold）字形度量差异导致的导出像素偏小/裁剪。
  // engineData（transform/boundingBox/font）仍在下方照常写回，保持文本可编辑。
  let usedRawTextImage = false;
  const rawTextImage = isTextLayer ? node.textInfo!.rawImage : undefined;
  if (rawTextImage && rawTextImage.base64) {
    try {
      const rawPng = base64ToUint8Array(rawTextImage.base64);
      layer.canvas = await pngToCanvas(rawPng);
      // 用原始 PSD 文档绝对坐标定位（绕过 boundingBox 估算与 MasterGo renderBounds 偏移）
      layerLeft = rawTextImage.left;
      layerTop = rawTextImage.top;
      layerRight = rawTextImage.left + rawTextImage.width;
      layerBottom = rawTextImage.top + rawTextImage.height;
      layer.left = layerLeft;
      layer.top = layerTop;
      layer.right = layerRight;
      layer.bottom = layerBottom;
      usedRawTextImage = true;
    } catch {
      // 解码失败：回退到下方常规像素逻辑（平台重渲染像素）
      usedRawTextImage = false;
    }
  }

  // round-trip：智能对象（带模糊滤镜，导入时已重渲染清晰像素）的兜底数据。
  // 导出时优先用存储的原始模糊 channel data 还原图层位图，并用存储的 transform 重建 placedLayer。
  let smartObjData: {
    origImageB64?: string; transform?: number[]; nonAffineTransform?: number[]; resolution?: any;
    soId?: string; placed?: string; width?: number; height?: number;
    warp?: any;
    filter?: any;
    filterEffectsMasks?: Array<{
      id: string; top: number; left: number; bottom: number; right: number; depth: number;
      channels: ({ compressionMode: number; data: string } | null)[];
      extra?: { top: number; left: number; bottom: number; right: number; compressionMode: number; data: string };
    }>;
    linkedSrcB64?: string;
    docFilterEffectsMasks?: Array<{
      id: string; top: number; left: number; bottom: number; right: number; depth: number;
      channels: ({ compressionMode: number; data: string } | null)[];
      extra?: { top: number; left: number; bottom: number; right: number; compressionMode: number; data: string };
    }>;
    fullPlacedLayer?: any;
    referencePoint?: { x: number; y: number };
    layerId?: number;
    blendingRanges?: any;
  } | null = null;
  if (node.rawPsdSmartObject) {
    try { smartObjData = JSON.parse(node.rawPsdSmartObject); } catch { smartObjData = null; }
  }

  // 带滤镜智能对象的两条导出路径：
  //  - 完整还原(有内嵌源 linkedSrcB64)：写回 源+placedLayer(原始 transform)+filter(enabled)+文档级蒙版，
  //    PS 实时渲染 = 与原始 1:1。图层位图用 origImageB64(原始模糊 channel data，即 PS 的图层缓存)，
  //    与纯往返一致(PS 会用源重渲染覆盖它，缓存只是预览)。
  //  - 降级(无内嵌源)：退化为普通栅格层，用 node.imageBase64(导入重渲染的清晰币像素)避免光斑/报错。
  let linkedSrcValid = false;
  if (smartObjData?.linkedSrcB64) {
    try {
      const linkedBytes = base64ToUint8Array(smartObjData.linkedSrcB64);
      linkedSrcValid = isValidEmbeddedPsdData(linkedBytes);
    } catch {
      linkedSrcValid = false;
    }
  }
  const smartObjFullRestore = !!(smartObjData && smartObjData.filter && linkedSrcValid && smartObjData.fullPlacedLayer);
  const smartObjDowngrade = !!(smartObjData && smartObjData.filter && !smartObjFullRestore);
  // round-trip：基底层若带「烘焙调整前原始像素」，用它替换烘焙后的位图。
  const effectiveImageBase64 = smartObjFullRestore
    ? (smartObjData!.origImageB64 ?? node.imageBase64)
    : smartObjDowngrade
      ? node.imageBase64
      : (node.rawPsdPrePatternImage ?? node.rawPsdChannelImage ?? node.rawPsdOriginalImage ?? smartObjData?.origImageB64 ?? node.rawPsdLayerMaskImage ?? node.imageBase64);
  // round-trip 原始像素来源（prePattern/origImage/smartObjOrig/layerMask）保存的是「未扩展」的原始
  // layer bbox 像素；只有合成图 imageBase64 在导入时被 expandOffset 扩展过。
  // 完整还原用 origImageB64(未扩展)；降级用 node.imageBase64(已 expand，不算 unexpanded)。
  const usingUnexpandedRawImage = smartObjFullRestore
    ? true
    : (!smartObjDowngrade &&
      !!(node.rawPsdPrePatternImage || node.rawPsdChannelImage || node.rawPsdOriginalImage || smartObjData?.origImageB64 || node.rawPsdLayerMaskImage));
  if (!usedRawTextImage && effectiveImageBase64 && !(isTextLayer && !shouldUseTextCanvas)) {
    try {
      const pngBytes = base64ToUint8Array(effectiveImageBase64);
      const rawCanvas = await pngToCanvas(pngBytes);
      if (isTextLayer) {
        const intendedW = Math.max(1, layerRight - layerLeft);
        const intendedH = Math.max(1, layerBottom - layerTop);
        if (isMultilineNoMeta) {
          // MasterGo exportAsync 返回的 PNG 基于 absoluteRenderBounds（实际字符墨水范围），
          // 它的左上角 = absoluteRenderBounds.{x,y} = node.{x,y} + {dx,dy}
          const rbo = node.textInfo?.renderBoundsOffset;
          layer.canvas = rawCanvas;
          if (rbo) {
            const canvasLeft = Math.round(node.x + rbo.dx);
            const canvasTop = Math.round(node.y + rbo.dy);
            layerLeft = canvasLeft;
            layerTop = canvasTop;
            layerRight = canvasLeft + rawCanvas.width;
            layerBottom = canvasTop + rawCanvas.height;
            layer.left = layerLeft;
            layer.top = layerTop;
            layer.right = layerRight;
            layer.bottom = layerBottom;
          } else {
            layerRight = layerLeft + rawCanvas.width;
            layerBottom = layerTop + rawCanvas.height;
            layer.right = layerRight;
            layer.bottom = layerBottom;
          }
        } else {
          const trimmed = trimCanvasTransparent(rawCanvas).canvas;
          if (trimmed.width === intendedW && trimmed.height === intendedH) {
            layer.canvas = trimmed;
          } else {
            const padded = document.createElement('canvas');
            padded.width = intendedW;
            padded.height = intendedH;
            const pctx = padded.getContext('2d')!;
            const offsetX = Math.max(0, Math.floor((intendedW - trimmed.width) / 2));
            const offsetY = Math.max(0, Math.floor((intendedH - trimmed.height) / 2));
            pctx.drawImage(trimmed, offsetX, offsetY);
            layer.canvas = padded;
          }
        }
      } else if (!usingUnexpandedRawImage && node.psdExpandOffset != null && node.psdExpandOffset > 0) {
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
        const targetW = Math.max(1, Math.round(layerRight - layerLeft));
        const targetH = Math.max(1, Math.round(layerBottom - layerTop));
        if (rawCanvas.width !== targetW || rawCanvas.height !== targetH) {
          // 9-slice 元数据里的 imageSize 大于 layer bbox；若误入大图，居中裁切，禁止 coverCrop 压扁圆角。
          layer.canvas = node.nineSliceSettings
            ? centerCropCanvas(rawCanvas, targetW, targetH)
            : fitCanvasCoverCrop(rawCanvas, targetW, targetH);
        } else {
          layer.canvas = rawCanvas;
        }
      }
    } catch { /* leave without image data */ }
  }

  // 隐藏节点若 exportAsync 失败（没有 canvas），创建与原始尺寸一致的透明 placeholder
  // ag-psd 会用 canvas.width/height 重写 right/bottom，所以必须匹配原始尺寸。
  if (!layer.canvas && layer.hidden && node.width > 0 && node.height > 0) {
    const placeholder = document.createElement('canvas');
    placeholder.width = Math.round(node.width);
    placeholder.height = Math.round(node.height);
    layer.canvas = placeholder;
  }

  if (parentClipRect && layer.canvas) {
    const clipLeft = parentClipRect.x;
    const clipTop = parentClipRect.y;
    const clipRight = parentClipRect.x + parentClipRect.width;
    const clipBottom = parentClipRect.y + parentClipRect.height;
    const canvasLeft = layerLeft;
    const canvasTop = layerTop;
    const canvasRight = layerLeft + layer.canvas.width;
    const canvasBottom = layerTop + layer.canvas.height;
    const needsClip = canvasLeft < clipLeft || canvasTop < clipTop ||
      canvasRight > clipRight || canvasBottom > clipBottom;
    const cr = parentClipRect.cornerRadii;
    const hasRoundedCorners = cr && (cr.topLeft > 0 || cr.topRight > 0 || cr.bottomLeft > 0 || cr.bottomRight > 0);
    if (needsClip || hasRoundedCorners) {
      const newLeft = Math.max(canvasLeft, clipLeft);
      const newTop = Math.max(canvasTop, clipTop);
      const newRight = Math.min(canvasRight, clipRight);
      const newBottom = Math.min(canvasBottom, clipBottom);
      const newW = Math.max(0, newRight - newLeft);
      const newH = Math.max(0, newBottom - newTop);
      if (newW > 0 && newH > 0) {
        const clipped = document.createElement('canvas');
        clipped.width = newW;
        clipped.height = newH;
        const cctx = clipped.getContext('2d')!;
        if (hasRoundedCorners) {
          const rx = newLeft - clipLeft;
          const ry = newTop - clipTop;
          const rw = parentClipRect.width;
          const rh = parentClipRect.height;
          const tl = cr!.topLeft, tr = cr!.topRight, bl = cr!.bottomLeft, br = cr!.bottomRight;
          cctx.beginPath();
          cctx.moveTo(-rx + tl, -ry);
          cctx.lineTo(-rx + rw - tr, -ry);
          cctx.arcTo(-rx + rw, -ry, -rx + rw, -ry + tr, tr);
          cctx.lineTo(-rx + rw, -ry + rh - br);
          cctx.arcTo(-rx + rw, -ry + rh, -rx + rw - br, -ry + rh, br);
          cctx.lineTo(-rx + bl, -ry + rh);
          cctx.arcTo(-rx, -ry + rh, -rx, -ry + rh - bl, bl);
          cctx.lineTo(-rx, -ry + tl);
          cctx.arcTo(-rx, -ry, -rx + tl, -ry, tl);
          cctx.closePath();
          cctx.clip();
        }
        const srcX = newLeft - canvasLeft;
        const srcY = newTop - canvasTop;
        cctx.drawImage(layer.canvas as any, srcX, srcY, newW, newH, 0, 0, newW, newH);
        layer.canvas = clipped;
        layerLeft = newLeft;
        layerTop = newTop;
        layerRight = newRight;
        layerBottom = newBottom;
        layer.left = newLeft;
        layer.top = newTop;
        layer.right = newRight;
        layer.bottom = newBottom;
      } else {
        delete layer.canvas;
        layer.hidden = true;
      }
    }
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

    // 优先用原始 PSD shapeType 判定 point/box（栅格化文本的 textAutoResize 被强制设为 NONE，
    // 不能据此判定，否则 point 文本误走 box 分支丢缩放/旋转）。无 shapeType 时回退 textAutoResize。
    const isPointText = ti.shapeType === 'point' ||
      (ti.shapeType == null && ti.textAutoResize === 'WIDTH_AND_HEIGHT');
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
      fontCaps: textCaseToFontCaps(firstStyle.textCase),
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

      // 旋转还原：原始 PSD transform = [sx·cosθ, sx·sinθ, -sx·sinθ, sy·cosθ, tx, ty]。
      // import 时 rotation = atan2(c, a) ≈ -θ（PS 约定正=逆时针），故 θ = -rotation。
      // 注意 b 与 c 都用 sx（PS 标准：单一旋转角，缩放沿轴；|b|=|c|=sx·sinθ），
      // d 用 sy。若 c 误用 sy 会有约 0.2% 偏差，导致字符位置轻微偏移。
      // 不还原旋转会让 transform 退化为 [sx,0,0,sy]，PS 中文本不旋转且 layer bbox（轴对齐）
      // 比旋转后的实际像素范围小，导致渲染被裁剪。
      const rotDeg = ti.rotation != null && Number.isFinite(ti.rotation) ? ti.rotation : 0;
      const theta = (-rotDeg * Math.PI) / 180;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const mA = sx * cosT;
      const mB = sx * sinT;
      const mC = -sx * sinT;
      const mD = sy * cosT;

      layer.text = {
        text: ti.characters,
        transform: [mA, mB, mC, mD, txAdjusted, ty],
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
      const hasMetadata = ti.bounds != null || ti.boundingBox != null;
      // 估算字符总宽度（CJK / 数字 / 拉丁混合按 fontSize * 0.6 估算单字符宽度）
      const estCharWidth = Math.max(1, fontSize * 0.6 * ti.characters.length);
      // 是否需要换行：估算总宽度超过文本框宽度（含 stretch 文本除外）
      const needsWrap = !hasMetadata && estCharWidth > node.width * 1.1;
      if (!hasMetadata && !needsWrap) {
        // 单行文本：使用 point 文本（shapeType='point'）
        // - 不依赖 boxBounds，避免 PS update 后基于 box 重算位置漂移
        // - PS 对 point 文本按 paragraphStyle.justification 解读 transform.tx：
        //   CENTER 时 tx 是字符水平中心；LEFT 时 tx 是字符左边；RIGHT 时 tx 是字符右边
        let anchorX = node.x;
        if (ti.alignment === 'CENTER') {
          anchorX = node.x + node.width / 2;
        } else if (ti.alignment === 'RIGHT') {
          anchorX = node.x + node.width;
        }
        const halfW = estCharWidth / 2;
        // MasterGo 中文本节点 wh 表示文本框可视尺寸，字符视觉垂直居中在 bbox 内。
        // PSD point 文本 transform.ty 是 baseline 位置：
        //   baseline = node.y + node.height/2 + fontSize*0.357
        // 其中 0.357 来自 PSD 默认字体度量 (ascent≈0.857, descent≈0.143)：
        //   字符高度 ≈ fontSize（cap top 到 baseline 之间），字符视觉中心到 baseline ≈ fontSize*0.357
        const ascent = fontSize * 0.857;
        const anchorY = node.y + node.height / 2 + fontSize * 0.357;
        let boundsLeft = -halfW, boundsRight = halfW;
        if (ti.alignment === 'LEFT' || ti.alignment === 'JUSTIFIED') {
          boundsLeft = 0; boundsRight = estCharWidth;
        } else if (ti.alignment === 'RIGHT') {
          boundsLeft = -estCharWidth; boundsRight = 0;
        }
        layer.text = {
          text: ti.characters,
          transform: [1, 0, 0, 1, anchorX, anchorY],
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
            top: { units: 'Points' as any, value: -fontSize * 0.857 },
            left: { units: 'Points' as any, value: boundsLeft },
            right: { units: 'Points' as any, value: boundsRight },
            bottom: { units: 'Points' as any, value: fontSize * 0.514 },
          },
          boundingBox: {
            top: { units: 'Points' as any, value: -fontSize * 0.776 },
            left: { units: 'Points' as any, value: boundsLeft },
            right: { units: 'Points' as any, value: boundsRight },
            bottom: { units: 'Points' as any, value: fontSize * 0.240 },
          },
          style: baseStyle,
          paragraphStyle: fullParagraphStyle,
        };
      } else if (!hasMetadata && needsWrap) {
        // 多行文本：使用 MasterGo 渲染的 PNG canvas，跳过矢量 layer.text
        // 避免 PS 字体不匹配（如 Noto Sans 缺少 Regular 字重）导致换行/行间距与 MasterGo 不一致
      } else {
        // 有 PSD 元数据时走原 box 文本路径（保留 PSD import 还原能力）
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
    }

    if (ti.textIndex != null && layer.text) {
      layer.text.index = ti.textIndex;
    }

    // PSD 文本弯曲（warp）往返还原：Figma/MasterGo 画布上无法表达弧形弯曲，
    // 但导入时已把原始 warp 存入节点 pluginData，这里写回 layer.text.warp，
    // 使 PS 重新打开导出的 PSD 时弯曲效果完整恢复。
    if (ti.warp && ti.warp.style && ti.warp.style !== 'none' && layer.text) {
      const w: any = { style: ti.warp.style };
      if (typeof ti.warp.value === 'number') w.value = ti.warp.value;
      if (Array.isArray(ti.warp.values)) w.values = ti.warp.values.slice();
      if (typeof ti.warp.perspective === 'number') w.perspective = ti.warp.perspective;
      if (typeof ti.warp.perspectiveOther === 'number') w.perspectiveOther = ti.warp.perspectiveOther;
      w.rotate = ti.warp.rotate === 'vertical' ? 'vertical' : 'horizontal';
      layer.text.warp = w;
    }

    if (ti.styles.length > 1 && layer.text) {
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
            fontCaps: textCaseToFontCaps(s.textCase),
          },
        };
      });
    }

  }

  if (smartObjData && Array.isArray(smartObjData.transform) && smartObjData.transform.length >= 8 && !(node.children && node.children.length > 0)) {
    if (smartObjFullRestore) {
      // 完整还原(带滤镜 + 有内嵌源)：写回原始 placedLayer(原始 transform/filter/warp/源关联)，
      // 并把内嵌源 + 文档级滤镜蒙版收集起来(buildAndDownloadPsd 注入文档根)。
      // PS 用「源 + filter + 蒙版」实时渲染 = 与原始 1:1(经纯往返验证无损)，可变换、参数齐全。
      // 原样还原完整原始 placedLayer(含 crop/comp/compInfo/frameCount/warp/filter 等所有字段)。
      // 逐字段重建永远难以等于原始，任一元字段缺失都可能让 PS 渲染异常(光斑)，故整体还原。
      layer.placedLayer = deserializePlacedLayer(smartObjData.fullPlacedLayer) as any;
      if (smartObjData.referencePoint) (layer as any).referencePoint = smartObjData.referencePoint;
      // 关键：写回原始图层 id(lyid)。PS 的智能滤镜蒙版(FEid)按图层 id 关联，缺失则蒙版失效 →
      // 全白蒙版 → motion blur 应用到整层 → 光斑(已二分定位:删 id 必模糊，删其他字段不影响)。
      if (smartObjData.layerId != null) (layer as any).id = smartObjData.layerId;
      if (smartObjData.blendingRanges) (layer as any).blendingRanges = smartObjData.blendingRanges;
      // 文档 composite 预览用「清晰币」(node.imageBase64)而非图层 channel data(模糊条纹)：
      // 图层 channel data 必须是原始模糊缓存(PS 用源+滤镜重渲染时的缓存)，但若 composite 也用它，
      // PS 打开时显示的文档预览(及部分场景信任的缓存)会是光斑。composite 单独用清晰币保证预览正确。
      if (node.imageBase64) {
        try {
          const clearCanvas = await pngToCanvas(base64ToUint8Array(node.imageBase64));
          (layer as any).__clearComposite = clearCanvas;
        } catch { /* ignore */ }
      }
      // 收集内嵌源(去重，按 id)。
      const soId = smartObjData.soId || (layer.placedLayer as any).id;
      if (smartObjData.linkedSrcB64 && soId && !collectedLinkedFiles.some(f => f.id === soId)) {
        collectedLinkedFiles.push({ id: soId, name: `${soId}.psb`, type: '8BPB', data: base64ToUint8Array(smartObjData.linkedSrcB64) });
      }
      // 收集文档级滤镜蒙版栅格(去重，按 mask id = placed instance id)。
      if (smartObjData.docFilterEffectsMasks) {
        for (const m of smartObjData.docFilterEffectsMasks) {
          if (collectedFilterEffectsMasks.some((x: any) => x.id === m.id)) continue;
          const decodedMask = {
            id: m.id, top: m.top, left: m.left, bottom: m.bottom, right: m.right, depth: m.depth,
            channels: m.channels.map(ch => ch ? { compressionMode: ch.compressionMode, data: base64ToUint8Array(ch.data) } : undefined),
            extra: m.extra ? { top: m.extra.top, left: m.extra.left, bottom: m.extra.bottom, right: m.extra.right, compressionMode: m.extra.compressionMode, data: base64ToUint8Array(m.extra.data) } : undefined,
          };
          collectedFilterEffectsMasks.push(decodedMask);
        }
      }
    }
    // 无有效内嵌源时不写 placedLayer，仅保留上方 canvas 栅格；否则 PS Save/Export As 会因缺少 lnk2 报 disk error。
  }

  if (node.children && node.children.length > 0) {
    const isClipGroup = node.name.endsWith('(clip group)');

    if (isClipGroup) {
      // clip group 在 PSD 中不是 folder，而是 base 层 + 带 clipping 标记的平铺层。
      // 返回子层数组，由调用方展开插入父层。
      const flatLayers: Layer[] = [];
      for (let i = 0; i < node.children.length; i++) {
        const childNode = node.children[i];
        // 跳过导入时为 alpha 裁剪拆出的 baseMask 副本（isMask，名字带 " (mask)"）。
        // 它仅用于平台内裁剪显示，PSD clip 直接用 base 层 alpha 即可；若也展平回去会
        // 多出一层 "(mask)"，破坏与原始 PSD 的层级对称。base(i=0)、被剪贴层(i>0)照常展平。
        if (childNode.isMask) continue;
        const result = await buildLayer(childNode, null, availablePatternIds);
        const childLayers = Array.isArray(result) ? result : [result];
        for (const cl of childLayers) {
          if (i > 0) cl.clipping = true;
          flatLayers.push(cl);
        }
      }
      return flatLayers;
    }

    // ag-psd 不允许同时有 canvas 和 children，展开为 group 时清除 canvas/placedLayer
    if (layer.canvas) delete layer.canvas;
    if (layer.placedLayer) delete layer.placedLayer;

    layer.children = [];
    for (const child of node.children) {
      const result = await buildLayer(child, null, availablePatternIds);
      if (Array.isArray(result)) {
        layer.children.push(...result);
      } else {
        layer.children.push(result);
      }
    }
    layer.opened = true;

    // PSD 标准：group layer 自身不渲染图像，bbox 应为 [0,0,0,0]。
    layer.left = 0;
    layer.top = 0;
    layer.right = 0;
    layer.bottom = 0;

    // 还原组的矩形图层蒙版（滚动视口裁剪）：白色实心矩形 = 可见区域，框外按
    // defaultColor（通常 0=透明）裁掉。node.x/node.y 是组的绝对画布坐标，
    // groupMaskRect 的 left/top 相对组 frame（导入时恒为 0）。mask 独立于 layer
    // bbox，上面把 bbox 清零不影响它。
    if (node.rawPsdGroupMask) {
      try {
        const gm = JSON.parse(node.rawPsdGroupMask) as {
          left: number; top: number; width: number; height: number; defaultColor: number;
        };
        const mw = Math.round(gm.width), mh = Math.round(gm.height);
        if (mw > 0 && mh > 0) {
          const absLeft = Math.round(node.x + gm.left);
          const absTop = Math.round(node.y + gm.top);
          const mcanvas = document.createElement('canvas');
          mcanvas.width = mw;
          mcanvas.height = mh;
          const mctx = mcanvas.getContext('2d')!;
          const mimg = mctx.createImageData(mw, mh);
          for (let i = 0; i < mw * mh; i++) {
            mimg.data[i * 4] = 255;
            mimg.data[i * 4 + 1] = 255;
            mimg.data[i * 4 + 2] = 255;
            mimg.data[i * 4 + 3] = 255;
          }
          mctx.putImageData(mimg, 0, 0);
          (layer as any).mask = {
            left: absLeft,
            top: absTop,
            right: absLeft + mw,
            bottom: absTop + mh,
            defaultColor: gm.defaultColor ?? 0,
            canvas: mcanvas,
          };
        }
      } catch { /* group mask restore failed, leave without mask */ }
    }
  }

  // round-trip：还原普通光栅层的可编辑 layer mask。导入时 mask 已烘焙进像素 alpha，
  // 导出端 effectiveImageBase64 已优先用未烘焙的 rawPsdLayerMaskImage 作 canvas，这里把 mask
  // 重建为独立的 layer.mask，PS 渲染 canvas×mask = 原始效果（既可编辑又不双重裁剪）。
  // group 不会有此字段（组用 rawPsdGroupMask）；clip group 子层展平后各自在此还原 mask。
  if (node.rawPsdLayerMask) {
    try {
      const lm = JSON.parse(node.rawPsdLayerMask) as {
        left: number; top: number; width: number; height: number; defaultColor: number; dataB64: string;
      };
      const mw = Math.round(lm.width), mh = Math.round(lm.height);
      if (mw > 0 && mh > 0 && lm.dataB64) {
        const single = base64ToUint8Array(lm.dataB64);
        const mcanvas = document.createElement('canvas');
        mcanvas.width = mw;
        mcanvas.height = mh;
        const mctx = mcanvas.getContext('2d')!;
        const mimg = mctx.createImageData(mw, mh);
        // PSD 蒙版为灰度：写入 RGB=alpha 值、A=255，ag-psd 据此回写单通道蒙版。
        for (let i = 0; i < mw * mh; i++) {
          const v = single[i];
          mimg.data[i * 4] = v;
          mimg.data[i * 4 + 1] = v;
          mimg.data[i * 4 + 2] = v;
          mimg.data[i * 4 + 3] = 255;
        }
        mctx.putImageData(mimg, 0, 0);
        // lm.left/top 是相对图层 bbox 左上的偏移；叠加图层最终坐标 layerLeft/layerTop 还原绝对位置，
        // 使 mask 与 canvas 同步（不受视口裁剪改写坐标 / 平台坐标往返舍入偏差影响）。
        (layer as any).mask = {
          left: layerLeft + lm.left,
          top: layerTop + lm.top,
          right: layerLeft + lm.left + mw,
          bottom: layerTop + lm.top + mh,
          defaultColor: lm.defaultColor ?? 255,
          canvas: mcanvas,
        };
      }
    } catch { /* layer mask restore failed, leave without mask */ }
  }

  // 如果 base 层有关联的 PSD 调整图层数据，在其后插入调整图层（带 clipping 标记）
  if (node.rawPsdAdjustments) {
    try {
      type AdjMaskData = { left: number; top: number; width: number; height: number; defaultColor: number; dataB64: string; empty?: boolean };
      const adjList: Array<{ name: string; hidden: boolean; adjustment: any; mask?: AdjMaskData | null }> = JSON.parse(node.rawPsdAdjustments);
      // 基底层已用「烘焙调整前原始像素」(rawPsdOriginalImage)，因此把所有调整图层
      // 原样加回（带 clipping 标记），PS 应用一次 = 与原始 PSD 完全一致，
      // 图层面板结构也与原始一致。
      // 若没有原始像素兜底（旧数据/编码失败），基底像素是烘焙过的，重叠加会双重应用，
      // 此时跳过已烘焙类型以优先保证视觉正确。
      const BAKED_ADJUSTMENT_TYPES = new Set(['hue/saturation', 'brightness/contrast', 'vibrance']);
      const hasOriginalPixels = !!node.rawPsdOriginalImage;
      const layers: Layer[] = [layer];
      for (const adj of adjList) {
        if (!hasOriginalPixels && adj.adjustment && BAKED_ADJUSTMENT_TYPES.has(adj.adjustment.type)) continue;
        const adjLayer: Layer = {
          name: adj.name,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          hidden: adj.hidden,
          clipping: true,
          adjustment: adj.adjustment,
        };
        // 空蒙版(全白/全黑 defaultColor，无栅格)：原样还原为空蒙版，使 PS 图层面板结构与原始一致
        // (调整层旁带蒙版缩略图，即「和一个空页面连接」的样子)。ag-psd 据 defaultColor 写空蒙版。
        if (adj.mask && adj.mask.empty) {
          (adjLayer as any).mask = {
            left: adj.mask.left, top: adj.mask.top, right: adj.mask.left, bottom: adj.mask.top,
            defaultColor: adj.mask.defaultColor,
          };
        }
        // 还原调整图层的真实空间蒙版（PS 中调整通过蒙版局部生效）。
        else if (adj.mask && adj.mask.width > 0 && adj.mask.height > 0 && adj.mask.dataB64) {
          try {
            const single = base64ToUint8Array(adj.mask.dataB64);
            const mw = adj.mask.width, mh = adj.mask.height;
            const mcanvas = document.createElement('canvas');
            mcanvas.width = mw;
            mcanvas.height = mh;
            const mctx = mcanvas.getContext('2d')!;
            const mimg = mctx.createImageData(mw, mh);
            // PSD 蒙版为灰度：写入 RGB=alpha 值、A=255，ag-psd 据此回写单通道蒙版。
            for (let i = 0; i < mw * mh; i++) {
              const v = single[i];
              mimg.data[i * 4] = v;
              mimg.data[i * 4 + 1] = v;
              mimg.data[i * 4 + 2] = v;
              mimg.data[i * 4 + 3] = 255;
            }
            mctx.putImageData(mimg, 0, 0);
            (adjLayer as any).mask = {
              left: adj.mask.left,
              top: adj.mask.top,
              right: adj.mask.left + mw,
              bottom: adj.mask.top + mh,
              defaultColor: adj.mask.defaultColor,
              canvas: mcanvas,
            };
          } catch { /* mask restore failed, leave without mask */ }
        }
        layers.push(adjLayer);
      }
      return layers;
    } catch { /* parse error, skip */ }
  }

  return layer;
}

function attachImageDataToLeafLayers(layers: Layer[]): void {
  for (const layer of layers) {
    if (layer.children && layer.children.length > 0) {
      attachImageDataToLeafLayers(layer.children);
      continue;
    }
    const canvas = layer.canvas as HTMLCanvasElement | undefined;
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) continue;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    layer.imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    delete layer.canvas;
  }
}

export async function buildAndDownloadPsd(
  nodes: ExportNodeData[],
  width: number,
  height: number,
  fileName: string,
  onProgress: (percent: number, message: string) => void,
  engineData?: string,
  patterns?: string,
): Promise<void> {
  onProgress(65, '构建 PSD 图层结构...');

  // 重置智能对象完整还原收集器(每次导出独立)。
  collectedLinkedFiles = [];
  collectedFilterEffectsMasks = [];

  // 解码根 section 上的 pattern 资源表，构造「实际可写回的 pattern id 集合」，
  // 供 buildEffects → filterPatternOverlay 剔除悬空引用 / 双重叠加。
  const decodedPatterns = decodePsdPatterns(patterns);
  const availablePatternIds = new Set<string>((decodedPatterns ?? []).map(p => p.id));

  const children: Layer[] = [];
  for (let i = 0; i < nodes.length; i++) {
    onProgress(
      65 + Math.round(((i + 1) / nodes.length) * 20),
      `构建图层 ${i + 1}/${nodes.length}: ${nodes[i].name}`,
    );
    const result = await buildLayer(nodes[i], undefined, availablePatternIds);
    if (Array.isArray(result)) {
      children.push(...result);
    } else {
      children.push(result);
    }
  }

  onProgress(88, '生成 PSD 文件...');

  attachImageDataToLeafLayers(children);

  // 手动按 layer 顺序叠加生成 composite，让 PS 打开时显示正确的预览
  // ag-psd 不会从 layers 自动合成，必须显式提供
  const compCanvas = document.createElement('canvas');
  compCanvas.width = width;
  compCanvas.height = height;
  const compCtx = compCanvas.getContext('2d')!;
  function paintLayerToComposite(layers: Layer[]): void {
    for (const l of layers) {
      if (l.hidden) continue;
      if (l.children && l.children.length > 0) {
        paintLayerToComposite(l.children);
      } else if (((l as any).__clearComposite || (l as any).canvas || l.imageData) && (l.left != null) && (l.top != null)) {
        // 完整还原智能对象用清晰币画 composite 预览(__clearComposite)，其余用图层 canvas/imageData。
        compCtx.globalAlpha = l.opacity ?? 1;
        if ((l as any).__clearComposite) {
          compCtx.drawImage((l as any).__clearComposite, l.left, l.top);
        } else if ((l as any).canvas) {
          compCtx.drawImage((l as any).canvas, l.left, l.top);
        } else if (l.imageData) {
          const tmp = document.createElement('canvas');
          tmp.width = l.imageData.width;
          tmp.height = l.imageData.height;
          tmp.getContext('2d')!.putImageData(l.imageData, 0, 0);
          compCtx.drawImage(tmp, l.left, l.top);
        }
        compCtx.globalAlpha = 1;
      }
    }
  }
  paintLayerToComposite(children);

  const psd: Psd = {
    width,
    height,
    children,
    canvas: compCanvas,
  };

  // Preserve the original PSD's engineData (Txt2 block, base64) so PS can correctly associate
  // each text layer (via text.index) with the global TextFrameSet and render with correct font sizes.
  if (engineData) {
    psd.engineData = engineData;
  }

  // 写回 PSD 全局 pattern 资源表，让 patternOverlay 引用能在 PS 中找到对应像素，
  // 避免悬空引用导致的 program error。
  if (decodedPatterns && decodedPatterns.length) {
    (psd as any).patterns = decodedPatterns;
  }

  // 智能对象完整还原：注入文档级内嵌源 + 滤镜蒙版栅格，让 PS 用「源+filter+蒙版」实时渲染
  // 智能滤镜(motion blur 等)= 与原始 1:1，可变换、参数齐全(经纯往返验证无损)。
  if (collectedLinkedFiles.length) {
    (psd as any).linkedFiles = collectedLinkedFiles;
  }
  if (collectedFilterEffectsMasks.length) {
    (psd as any).filterEffectsMasks = collectedFilterEffectsMasks;
  }

  const arrayBuffer = writePsd(psd, {
    generateThumbnail: true,
    // 禁用 ag-psd 内部 trim：我们已经在 buildLayer 中精确控制了 canvas 尺寸
    //   - 位图层: 用 psdExpandOffset 裁掉 expand 边框，canvas 尺寸 = 原始 layer bbox
    //   - 文本层: pad 字符像素到 intended bbox 尺寸
    // 让 ag-psd 自动 trim 会去掉我们故意 pad 的透明像素，导致文本 layer bbox 变小（位置抖动）。
    trimImageData: false,
    // 强制为每层写入透明度通道，提升 PS 对部分图层的兼容性。
    noBackground: true,
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
