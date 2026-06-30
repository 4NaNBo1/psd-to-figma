import type {
  ExportNodeData,
  ExportNodeType,
  ExportFillInfo,
  ExportStrokeInfo,
  ExportEffectInfo,
  ExportTextInfo,
  ExportTextStyleRange,
  SerializedColor,
  SerializedCornerRadii,
  SerializedTextCase,
} from '../types/psd-types';
import {
  findNineSliceHiddenSource,
  isNineSliceComponent,
} from './nine-slice-collapse';

// Normalize platform TextCase ('UPPER'/'SMALL_CAPS'/'SMALL_CAPS_FORCED'/...) to our export case.
// figma TITLE/LOWER 与 PSD fontCaps 无对应（PSD fontCaps 只有 normal/small/all caps），按 ORIGINAL 处理。
function normalizeTextCase(tc: any): SerializedTextCase | undefined {
  if (tc === 'UPPER') return 'UPPER';
  if (tc === 'SMALL_CAPS' || tc === 'SMALL_CAPS_FORCED') return 'SMALL_CAPS';
  return undefined;
}

declare const mg: any;
const isMasterGo = typeof mg !== 'undefined';
const api: any = isMasterGo ? mg : (typeof figma !== 'undefined' ? figma : undefined);

const MIXED = typeof figma !== 'undefined' ? (figma as any).mixed : undefined;

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;
type ProgressFn = (percent: number, message: string) => void;

/**
 * MasterGo 自动布局容器可通过 itemReverseZIndex 反转画布堆叠序（true 时第一层在最上）。
 * PS children[0] 恒为栈底，仅在此情况下反转以匹配 MG 绘制顺序。
 */
function getNodeChildrenForExport(node: any): { kids: any[]; exportOrderReversed: boolean } {
  const raw = node?.children;
  if (!Array.isArray(raw) || raw.length === 0) return { kids: [], exportOrderReversed: false };
  const autoLayout = isMasterGo && node.flexMode && node.flexMode !== 'NONE';
  const exportOrderReversed = !!(autoLayout && node.itemReverseZIndex === true);
  return {
    kids: exportOrderReversed ? [...raw].reverse() : raw,
    exportOrderReversed,
  };
}

function nativeChildIndexFromExportIndex(
  exportIndex: number,
  childCount: number,
  exportOrderReversed: boolean,
): number {
  return exportOrderReversed ? childCount - 1 - exportIndex : exportIndex;
}

function setNodeVisible(node: any, visible: boolean): void {
  const prop = typeof node.isVisible === 'boolean' ? 'isVisible' : 'visible';
  try { node[prop] = visible; } catch { /* ignore */ }
}

function isNativePassThroughOverlay(data: ExportNodeData): boolean {
  if (!data.visible || data.blendMode !== 'PASS_THROUGH') return false;
  if (data.children && data.children.length > 0) return false;
  if (
    data.rawPsdEffects || data.rawPsdOriginalImage || data.rawPsdPrePatternImage ||
    data.rawPsdSmartObject || data.rawPsdVectorData
  ) {
    return false;
  }
  return true;
}

function canBakePassThroughInto(target: ExportNodeData): boolean {
  return !(target.children && target.children.length > 0);
}

async function exportParentCompositeUpToChildIndex(
  parentNode: any,
  lastChildIndex: number,
  exportOrderReversed: boolean,
): Promise<string | undefined> {
  const kids = parentNode?.children;
  if (!Array.isArray(kids) || kids.length === 0) {
    return exportNodeImage(parentNode);
  }

  const savedVisible: boolean[] = [];
  for (let i = 0; i < kids.length; i++) {
    savedVisible[i] = getNodeVisible(kids[i]);
  }
  const n = kids.length;
  for (let ei = 0; ei < n; ei++) {
    const mi = nativeChildIndexFromExportIndex(ei, n, exportOrderReversed);
    setNodeVisible(kids[mi], ei <= lastChildIndex && savedVisible[mi]);
  }
  await yieldThread();

  try {
    return await exportNodeImage(parentNode);
  } finally {
    for (let i = 0; i < kids.length; i++) {
      setNodeVisible(kids[i], savedVisible[i]);
    }
  }
}

async function bakePassThroughOverlays(
  parentNode: any,
  children: ExportNodeData[],
  onLog: LogFn,
  parentX: number,
  parentY: number,
  exportOrderReversed: boolean,
): Promise<void> {
  if (!children.length || !parentNode) return;

  const ptIndices: number[] = [];
  // 穿透叠加层：同组内叠在更底层之上的 PASS_THROUGH 叶子（index=0 的底层不算叠加层）。
  for (let i = 1; i < children.length; i++) {
    if (isNativePassThroughOverlay(children[i])) ptIndices.push(i);
  }
  if (ptIndices.length === 0) return;

  const firstPt = ptIndices[0];
  const bakeTarget = children[firstPt - 1];
  if (!canBakePassThroughInto(bakeTarget)) return;

  const contiguous = ptIndices.every((idx, k) => idx === firstPt + k);
  if (!contiguous) {
    onLog('warn', `Skipping pass-through bake: non-contiguous overlays in "${parentNode.name ?? 'group'}"`);
    return;
  }

  const lastPt = ptIndices[ptIndices.length - 1];
  const baked = await exportParentCompositeUpToChildIndex(parentNode, lastPt, exportOrderReversed);
  if (!baked) return;

  bakeTarget.imageBase64 = baked;
  bakeTarget.passThroughBaked = true;

  // 合成图来自 parentNode 整帧 exportAsync，须用父节点画布坐标/尺寸，不能沿用 bakeTarget
  // （如 card_sdw）的较小 bbox，否则 Wings 等伸出父层的内容会被裁掉，兄弟 card 叠放错乱。
  const parentAbsX = parentNode.absoluteTransform?.[0]?.[2] ?? parentNode.x ?? 0;
  const parentAbsY = parentNode.absoluteTransform?.[1]?.[2] ?? parentNode.y ?? 0;
  let bakeX = parentAbsX - parentX;
  let bakeY = parentAbsY - parentY;
  let bakeW = parentNode.width ?? bakeTarget.width;
  let bakeH = parentNode.height ?? bakeTarget.height;
  try {
    const arb = parentNode.absoluteRenderBounds;
    if (arb && Number.isFinite(arb.x) && Number.isFinite(arb.y)) {
      bakeX = arb.x - parentX;
      bakeY = arb.y - parentY;
      bakeW = arb.width;
      bakeH = arb.height;
    }
  } catch { /* ignore */ }
  bakeTarget.x = bakeX;
  bakeTarget.y = bakeY;
  bakeTarget.width = bakeW;
  bakeTarget.height = bakeH;

  // 合成已含 [0..lastPt] 全部像素，除 bakeTarget 外全部隐藏，避免双层或残层干扰叠放。
  for (let i = 0; i <= lastPt; i++) {
    if (i === firstPt - 1) continue;
    children[i].visible = false;
    children[i].imageBase64 = undefined;
  }

  const overlayNames = ptIndices.map((i) => children[i].name).join(', ');
  onLog('info', `Baked pass-through overlay(s) [${overlayNames}] into "${bakeTarget.name}"`);
}

function hasRoundTripImagePluginData(node: any): boolean {
  if (typeof node.getPluginData !== 'function') return false;
  return !!(
    node.getPluginData('psd_original_image') ||
    node.getPluginData('psd_pre_pattern_image') ||
    node.getPluginData('psd_layer_mask_image') ||
    node.getPluginData('psd_smart_object')
  );
}

function attachPsdPluginData(node: any, data: ExportNodeData): void {
  try {
    if (typeof node.getPluginData === 'function') {
      const raw = node.getPluginData('psd_raw_effects');
      if (raw) data.rawPsdEffects = raw;
    }
  } catch { /* ignore */ }

  try {
    if (typeof node.getPluginData === 'function') {
      if (node.getPluginData('psd_inherited_group_fx')) data.inheritedGroupEffects = true;
      if (node.getPluginData('psd_inherited_group_stroke')) data.inheritedGroupStrokes = true;
    }
  } catch { /* ignore */ }

  try {
    if (typeof node.getPluginData === 'function') {
      const expRaw = node.getPluginData('psd_expand_offset');
      if (expRaw) {
        const exp = parseInt(expRaw, 10);
        if (Number.isFinite(exp) && exp > 0) {
          data.x += exp;
          data.y += exp;
          data.width = Math.max(1, data.width - exp * 2);
          data.height = Math.max(1, data.height - exp * 2);
          data.psdExpandOffset = exp;
        }
      }
    }
  } catch { /* ignore */ }

  try {
    if (typeof node.getPluginData === 'function') {
      const vec = node.getPluginData('psd_vector_data');
      if (vec) data.rawPsdVectorData = vec;
    }
  } catch { /* ignore */ }

  try {
    if (typeof node.getPluginData === 'function') {
      const adj = node.getPluginData('psd_adjustments');
      if (adj) data.rawPsdAdjustments = adj;
    }
  } catch { /* ignore */ }

  try {
    if (typeof node.getPluginData === 'function') {
      const orig = node.getPluginData('psd_original_image');
      if (orig) data.rawPsdOriginalImage = orig;
    }
  } catch { /* ignore */ }

  try {
    if (typeof node.getPluginData === 'function') {
      const prePat = node.getPluginData('psd_pre_pattern_image');
      if (prePat) data.rawPsdPrePatternImage = prePat;
    }
  } catch { /* ignore */ }

  try {
    if (typeof node.getPluginData === 'function') {
      const so = node.getPluginData('psd_smart_object');
      if (so) data.rawPsdSmartObject = so;
    }
  } catch { /* ignore */ }

  try {
    if (typeof node.getPluginData === 'function') {
      const gm = node.getPluginData('psd_group_mask');
      if (gm) data.rawPsdGroupMask = gm;
    }
  } catch { /* ignore */ }

  try {
    if (typeof node.getPluginData === 'function') {
      const lm = node.getPluginData('psd_layer_mask');
      if (lm) data.rawPsdLayerMask = lm;
      const lmi = node.getPluginData('psd_layer_mask_image');
      if (lmi) data.rawPsdLayerMaskImage = lmi;
    }
  } catch { /* ignore */ }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  const binary = parts.join('');

  if (globalThis.btoa) return globalThis.btoa(binary);

  const lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const len = bytes.length;
  const pad = len % 3;
  const chunks: string[] = [];
  for (let i = 0; i < len - pad; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunks.push(lookup[n >> 18] + lookup[(n >> 12) & 63] + lookup[(n >> 6) & 63] + lookup[n & 63]);
  }
  if (pad === 1) {
    const n = bytes[len - 1];
    chunks.push(lookup[n >> 2] + lookup[(n << 4) & 63] + '==');
  } else if (pad === 2) {
    const n = (bytes[len - 2] << 8) | bytes[len - 1];
    chunks.push(lookup[n >> 10] + lookup[(n >> 4) & 63] + lookup[(n << 2) & 63] + '=');
  }
  return chunks.join('');
}

function mapNodeType(node: any): ExportNodeType {
  switch (node.type) {
    case 'FRAME': return 'frame';
    case 'GROUP': return 'group';
    case 'RECTANGLE': return 'rectangle';
    case 'ELLIPSE': return 'ellipse';
    case 'TEXT': return 'text';
    case 'VECTOR':
    case 'STAR':
    case 'POLYGON':
    case 'LINE':
    case 'BOOLEAN_OPERATION':
      return 'vector';
    case 'INSTANCE': return 'instance';
    case 'COMPONENT':
    case 'COMPONENT_SET':
      return 'component';
    default: return 'other';
  }
}

function toColor(paint: any): SerializedColor {
  const c = paint.color ?? { r: 0, g: 0, b: 0 };
  return {
    r: c.r ?? 0,
    g: c.g ?? 0,
    b: c.b ?? 0,
    a: paint.opacity ?? 1,
  };
}

function extractFills(node: any): ExportFillInfo[] {
  const fills = node.fills;
  if (!fills || isMixed(fills) || !Array.isArray(fills)) return [];
  const result: ExportFillInfo[] = [];
  for (const fill of fills) {
    const info: ExportFillInfo = {
      type: fill.type,
      visible: fill.visible !== false,
    };
    if (fill.type === 'SOLID') {
      info.color = {
        r: fill.color?.r ?? 0,
        g: fill.color?.g ?? 0,
        b: fill.color?.b ?? 0,
        a: fill.opacity ?? 1,
      };
      info.opacity = fill.opacity ?? 1;
    } else if (fill.type?.startsWith('GRADIENT_')) {
      info.gradientStops = (fill.gradientStops ?? []).map((s: any) => ({
        position: s.position,
        color: {
          r: s.color?.r ?? 0,
          g: s.color?.g ?? 0,
          b: s.color?.b ?? 0,
          a: s.color?.a ?? 1,
        },
      }));
      if (fill.gradientTransform) {
        const [[a, ,], [, ,]] = fill.gradientTransform;
        info.gradientAngle = Math.atan2(a, 1) * (180 / Math.PI);
      }
      info.opacity = fill.opacity ?? 1;
    }
    result.push(info);
  }
  return result;
}

function isMixed(val: any): boolean {
  if (val === undefined || val === null) return false;
  if (MIXED && val === MIXED) return true;
  return typeof val === 'symbol';
}

function extractStrokes(node: any): ExportStrokeInfo[] {
  const strokes = node.strokes;
  if (!strokes || isMixed(strokes) || !Array.isArray(strokes)) return [];
  const weight = isMixed(node.strokeWeight) ? 1 : (node.strokeWeight ?? 1);
  const result: ExportStrokeInfo[] = [];
  for (const stroke of strokes) {
    if (stroke.type !== 'SOLID' || stroke.visible === false) continue;
    result.push({
      color: {
        r: stroke.color?.r ?? 0,
        g: stroke.color?.g ?? 0,
        b: stroke.color?.b ?? 0,
        a: stroke.opacity ?? 1,
      },
      weight,
      align: node.strokeAlign ?? 'INSIDE',
      opacity: stroke.opacity ?? 1,
      visible: true,
    });
  }
  return result;
}

function extractEffects(node: any): ExportEffectInfo[] {
  const effects = node.effects;
  if (!effects || isMixed(effects) || !Array.isArray(effects)) return [];
  const result: ExportEffectInfo[] = [];
  for (const eff of effects) {
    if (eff.type !== 'DROP_SHADOW' && eff.type !== 'INNER_SHADOW') continue;
    result.push({
      type: eff.type,
      color: {
        r: eff.color?.r ?? 0,
        g: eff.color?.g ?? 0,
        b: eff.color?.b ?? 0,
        a: eff.color?.a ?? 1,
      },
      offsetX: eff.offset?.x ?? 0,
      offsetY: eff.offset?.y ?? 0,
      blur: eff.radius ?? 0,
      spread: eff.spread ?? 0,
      visible: eff.visible !== false,
      blendMode: typeof eff.blendMode === 'string' ? eff.blendMode : undefined,
    });
  }
  return result;
}

function extractCornerRadii(node: any): SerializedCornerRadii | undefined {
  if (node.cornerRadius === undefined && node.topLeftRadius === undefined) return undefined;
  if (typeof node.cornerRadius === 'number' && (!MIXED || node.cornerRadius !== MIXED)) {
    const r = node.cornerRadius;
    return { topLeft: r, topRight: r, bottomLeft: r, bottomRight: r };
  }
  return {
    topLeft: node.topLeftRadius ?? 0,
    topRight: node.topRightRadius ?? 0,
    bottomLeft: node.bottomLeftRadius ?? 0,
    bottomRight: node.bottomRightRadius ?? 0,
  };
}

function getCharStyle(node: any, idx: number): {
  family: string; style: string; size: number;
  color: SerializedColor; letterSpacing: number; lineHeight: number | null;
  textCase?: SerializedTextCase;
} {
  let family = 'Arial', style = 'Regular', size = 16;
  let color: SerializedColor = { r: 0, g: 0, b: 0, a: 1 };
  let letterSpacing = 0, lineHeight: number | null = null;
  let textCase: SerializedTextCase | undefined;

  try {
    const fn = node.getRangeFontName(idx, idx + 1);
    family = fn?.family ?? 'Arial';
    style = fn?.style ?? 'Regular';
  } catch { /* default */ }
  try { size = node.getRangeFontSize(idx, idx + 1) ?? 16; } catch { /* default */ }
  try {
    const fills = node.getRangeFills(idx, idx + 1);
    if (fills && fills.length > 0 && fills[0].color) {
      const c = fills[0].color;
      color = { r: c.r, g: c.g, b: c.b, a: fills[0].opacity ?? 1 };
    }
  } catch { /* default */ }
  try {
    const ls = node.getRangeLetterSpacing(idx, idx + 1);
    if (ls && ls.unit === 'PIXELS') letterSpacing = ls.value;
    else if (ls && ls.unit === 'PERCENT') letterSpacing = (ls.value / 100) * size;
  } catch { /* default */ }
  try {
    const lh = node.getRangeLineHeight(idx, idx + 1);
    if (lh && lh.unit === 'PIXELS') lineHeight = lh.value;
    else if (lh && lh.unit === 'PERCENT') lineHeight = (lh.value / 100) * size;
  } catch { /* default */ }
  try {
    if (typeof node.getRangeTextCase === 'function') {
      textCase = normalizeTextCase(node.getRangeTextCase(idx, idx + 1));
    }
  } catch { /* default */ }

  return { family, style, size, color, letterSpacing, lineHeight, textCase };
}

function stylesEqual(
  a: ReturnType<typeof getCharStyle>,
  b: ReturnType<typeof getCharStyle>,
): boolean {
  return a.family === b.family && a.style === b.style && a.size === b.size &&
    a.color.r === b.color.r && a.color.g === b.color.g &&
    a.color.b === b.color.b && a.color.a === b.color.a &&
    a.letterSpacing === b.letterSpacing && a.lineHeight === b.lineHeight &&
    a.textCase === b.textCase;
}

function extractTextInfo(node: any): ExportTextInfo | undefined {
  if (node.type !== 'TEXT') return undefined;
  const characters: string = node.characters ?? '';
  if (!characters) return undefined;

  let alignment: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED' = 'LEFT';
  const ha = node.textAlignHorizontal;
  if (ha === 'CENTER') alignment = 'CENTER';
  else if (ha === 'RIGHT') alignment = 'RIGHT';
  else if (ha === 'JUSTIFIED') alignment = 'JUSTIFIED';

  const len = characters.length;
  if (len === 0) return { characters, alignment, styles: [] };

  // MasterGo uses node.textStyles (ReadonlyArray<TextSegStyle>) instead of getRangeFontName
  const mgTextStyles: any[] | undefined = node.textStyles;
  if (mgTextStyles && Array.isArray(mgTextStyles) && mgTextStyles.length > 0) {
    const styles: ExportTextStyleRange[] = mgTextStyles.map(seg => {
      const ts = seg.textStyle ?? {};
      const fn = ts.fontName;
      const fills = seg.fills;
      let color: SerializedColor = { r: 0, g: 0, b: 0, a: 1 };
      if (fills && fills.length > 0) {
        const fill = fills[0];
        if (fill.type === 'SOLID' && fill.color) {
          const c = fill.color;
          color = { r: c.r, g: c.g, b: c.b, a: fill.alpha ?? fill.opacity ?? 1 };
        } else if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL' || fill.type === 'GRADIENT_ANGULAR') {
          color = { r: 1, g: 1, b: 1, a: 1 };
        }
      }
      let letterSpacing = 0;
      if (ts.letterSpacing) {
        if (ts.letterSpacing.unit === 'PIXELS') letterSpacing = ts.letterSpacing.value;
        else if (ts.letterSpacing.unit === 'PERCENT') letterSpacing = (ts.letterSpacing.value / 100) * (ts.fontSize ?? 16);
      }
      let lineHeight: number | null = null;
      if (ts.lineHeight && ts.lineHeight.unit !== 'AUTO') {
        if (ts.lineHeight.unit === 'PIXELS') lineHeight = ts.lineHeight.value;
        else if (ts.lineHeight.unit === 'PERCENT') lineHeight = (ts.lineHeight.value / 100) * (ts.fontSize ?? 16);
      }
      const segTextCase = normalizeTextCase(ts.textCase);
      return {
        start: seg.start ?? 0,
        end: seg.end ?? len,
        fontFamily: fn?.family ?? 'Arial',
        fontStyle: fn?.style ?? 'Regular',
        fontSize: ts.fontSize ?? 16,
        color,
        letterSpacing,
        lineHeight,
        ...(segTextCase ? { textCase: segTextCase } : {}),
      };
    });
    return { characters, alignment, styles, textAutoResize: node.textAutoResize };
  }

  // Figma: Try whole-range first -- if the entire text has uniform style, one call is enough
  const hasRangeApi = typeof node.getRangeFontName === 'function';
  if (!hasRangeApi) {
    const fn = node.fontName;
    const fs = node.fontSize;
    let color: SerializedColor = { r: 0, g: 0, b: 0, a: 1 };
    try {
      const fills = node.fills;
      if (fills && fills.length > 0 && fills[0].color) {
        const c = fills[0].color;
        color = { r: c.r, g: c.g, b: c.b, a: fills[0].opacity ?? 1 };
      }
    } catch { /* default */ }
    return {
      characters, alignment,
      styles: [{
        start: 0, end: len,
        fontFamily: fn?.family ?? 'Arial',
        fontStyle: fn?.style ?? 'Regular',
        fontSize: typeof fs === 'number' ? fs : 16,
        color, letterSpacing: 0, lineHeight: null,
      }],
      textAutoResize: node.textAutoResize,
    };
  }

  // Find style run boundaries using sampling instead of per-character iteration.
  // Check whole range first, then binary-search for boundaries if mixed.
  const styles: ExportTextStyleRange[] = [];
  let pos = 0;
  while (pos < len) {
    const runStyle = getCharStyle(node, pos);
    // Binary search for the end of this style run
    let lo = pos + 1, hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midStyle = getCharStyle(node, mid);
      if (stylesEqual(runStyle, midStyle)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    // lo might overshoot if there are multiple transitions; do a linear scan
    // near the boundary to find the exact break point
    let runEnd = Math.min(lo, len);
    if (runEnd > pos + 1 && runEnd < len) {
      const checkStart = Math.max(pos + 1, runEnd - 4);
      for (let j = checkStart; j < runEnd; j++) {
        if (!stylesEqual(runStyle, getCharStyle(node, j))) {
          runEnd = j;
          break;
        }
      }
    }

    styles.push({
      start: pos, end: runEnd,
      fontFamily: runStyle.family, fontStyle: runStyle.style,
      fontSize: runStyle.size, color: runStyle.color,
      letterSpacing: runStyle.letterSpacing, lineHeight: runStyle.lineHeight,
      ...(runStyle.textCase ? { textCase: runStyle.textCase } : {}),
    });
    pos = runEnd;
  }

  return { characters, alignment, styles, textAutoResize: node.textAutoResize };
}

const MAX_IMAGE_DIMENSION = 4096;
const EXPORT_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('exportAsync timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function yieldThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function exportNodeImage(node: any, options?: { withoutStrokesAndEffects?: boolean }): Promise<string | undefined> {
  if (typeof node.exportAsync !== 'function') return undefined;

  const w = node.width ?? 0;
  const h = node.height ?? 0;
  if (w <= 0 || h <= 0) return undefined;

  let scale = 1;
  if (w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION) {
    scale = MAX_IMAGE_DIMENSION / Math.max(w, h);
  }

  // MasterGo/Figma 对不可见节点 exportAsync 可能返回空数据，
  // 临时设为可见再导出，导出后恢复原始可见性。
  let wasHidden = false;
  const visibleProp = typeof node.isVisible === 'boolean' ? 'isVisible' : 'visible';
  if (node[visibleProp] === false) {
    wasHidden = true;
    try { node[visibleProp] = true; } catch { /* ignore */ }
    await yieldThread();
  }

  // For text layers, temporarily disable strokes/effects to get a tight character-bounded image,
  // matching PSD's native text layer canvas size (which doesn't include stroke extension).
  // 对整层原生化的位图层（IMAGE fill + 原生 effects/strokes/overlay fill），导出像素时也临时
  // 去除 effects/strokes 与叠加的 overlay fill（仅保留 IMAGE fill），使导出 PNG 只含原始像素，
  // 避免这些效果既被烤进 PNG、又由 node 属性写回 PSD（双重应用）。
  let savedStrokes: any[] | undefined;
  let savedEffects: any[] | undefined;
  let savedFills: any[] | undefined;
  if (options?.withoutStrokesAndEffects) {
    try {
      if (Array.isArray(node.strokes) && node.strokes.length > 0) {
        savedStrokes = node.strokes;
        node.strokes = [];
      }
      if (Array.isArray(node.effects) && node.effects.length > 0) {
        savedEffects = node.effects;
        node.effects = [];
      }
      // 仅当同时存在 IMAGE fill 时才去掉叠加的 SOLID/GRADIENT overlay fill；
      // 纯 SOLID/GRADIENT 形状层需保留 fill 才能导出可见像素。
      const hasImageFill = Array.isArray(node.fills) && node.fills.some((f: any) => f && f.type === 'IMAGE');
      if (hasImageFill && Array.isArray(node.fills) && node.fills.some((f: any) => f && f.type !== 'IMAGE')) {
        const imageOnly = node.fills.filter((f: any) => f && f.type === 'IMAGE');
        if (imageOnly.length !== node.fills.length) {
          savedFills = node.fills;
          node.fills = imageOnly;
        }
      }
      // 属性变更需让渲染状态落地后再 exportAsync，否则 MasterGo/Figma 可能仍按变更前的
      // 渲染缓存导出（阴影/描边/叠加 fill 被烤进 PNG，与 node 属性写回 PSD 双重应用）。
      // opacity 分支（下方）仅在 opacity<1 时 yield，原生化图标层 opacity=1 不进该分支，
      // 故此处去 effect 后必须单独 yield 一次。
      await yieldThread();
    } catch { /* ignore */ }
  }

  // exportAsync 会把节点 opacity 渲染进 PNG 的 alpha 通道；而导出端另有 node.opacity → layer.opacity
  // 单独写回图层不透明度。若 PNG 也含 opacity，PS 中会「双重透明」（如 30% 图层最终显示成 ~9%，
  // 典型：被栅格化的半透明 clipping 图层，原始格子纹理几乎看不见）。故导出像素前临时置 opacity=1，
  // 让 PNG 只保留原始像素 alpha，透明度统一由 layer.opacity 原生承载（与导入端 opacity 走 node.opacity 对称）。
  let savedOpacity: number | undefined;
  try {
    if (typeof node.opacity === 'number' && node.opacity < 1) {
      savedOpacity = node.opacity;
      node.opacity = 1;
      await yieldThread();
    }
  } catch { /* ignore */ }

  try {
    const bytes: Uint8Array = await withTimeout(
      node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } }),
      EXPORT_TIMEOUT_MS,
    );
    if (!bytes || bytes.length === 0) return undefined;
    return uint8ArrayToBase64(bytes);
  } catch {
    return undefined;
  } finally {
    if (wasHidden) {
      try { node[visibleProp] = false; } catch { /* ignore */ }
    }
    if (savedStrokes !== undefined) {
      try { node.strokes = savedStrokes; } catch { /* ignore */ }
    }
    if (savedEffects !== undefined) {
      try { node.effects = savedEffects; } catch { /* ignore */ }
    }
    if (savedFills !== undefined) {
      try { node.fills = savedFills; } catch { /* ignore */ }
    }
    if (savedOpacity !== undefined) {
      try { node.opacity = savedOpacity; } catch { /* ignore */ }
    }
  }
}

function countNodes(node: any): number {
  let count = 1;
  if ('children' in node && node.children) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}

const MAX_DEPTH = 50;

// 读取节点的"可见"属性：兼容 MasterGo (`isVisible`) 和 Figma (`visible`)。
// 两者都可能返回 undefined，此时按 true 处理（与 figma 默认值一致）。
function getNodeVisible(node: any): boolean {
  if (typeof node.isVisible === 'boolean') return node.isVisible;
  if (typeof node.visible === 'boolean') return node.visible;
  return true;
}

async function exportNineSliceStoredImage(component: any): Promise<string | undefined> {
  if (Array.isArray(component.fills)) {
    const imagePaint = component.fills.find((f: any) => f?.type === 'IMAGE' && typeof f.imageRef === 'string');
    if (imagePaint && typeof api?.getImageByHref === 'function') {
      try {
        const img = api.getImageByHref(imagePaint.imageRef);
        const bytes: Uint8Array | undefined = await img?.getBytesAsync?.();
        if (bytes?.length) return uint8ArrayToBase64(bytes);
      } catch { /* ignore */ }
    }
  }
  return exportNodeImage(component, { withoutStrokesAndEffects: true });
}

/**
 * 9-Slice 插件把单张位图拆成九宫组件；MasterGo exportAsync 对切片矩形常导出透明 PNG
 * （仅 topLeft 有像素）。导出 PSD 时折叠回单层：优先用隐藏的 PSD 导入原层（含 round-trip 元数据），
 * 否则读组件内存储的完整图源。
 */
async function serializeNineSliceCollapsed(
  component: any,
  parentX: number,
  parentY: number,
  onLog: LogFn,
  effectiveVisible: boolean,
  skippedNodeIds: Set<string>,
): Promise<ExportNodeData | null> {
  const hiddenSource = findNineSliceHiddenSource(component, getNodeVisible);
  const posNode = hiddenSource ?? component;
  const imageNode = hiddenSource ?? component;

  if (hiddenSource) skippedNodeIds.add(hiddenSource.id);

  let absX = posNode.absoluteTransform?.[0]?.[2] ?? posNode.x ?? 0;
  let absY = posNode.absoluteTransform?.[1]?.[2] ?? posNode.y ?? 0;

  const data: ExportNodeData = {
    id: component.id,
    name: component.name ?? 'Unnamed',
    type: 'rectangle',
    x: absX - parentX,
    y: absY - parentY,
    width: posNode.width ?? component.width ?? 0,
    height: posNode.height ?? component.height ?? 0,
    opacity: component.opacity ?? 1,
    blendMode: component.blendMode ?? 'NORMAL',
    visible: effectiveVisible,
    clipsContent: false,
    isMask: false,
    isInstance: false,
    fills: extractFills(component),
    strokes: extractStrokes(component),
    effects: extractEffects(component),
    cornerRadii: extractCornerRadii(component),
  };

  attachPsdPluginData(imageNode, data);

  if (hiddenSource) {
    data.imageBase64 = await exportNodeImage(hiddenSource, { withoutStrokesAndEffects: true });
  } else {
    data.imageBase64 = await exportNineSliceStoredImage(component);
  }

  onLog('info', `Collapsed 9-slice component "${component.name}" to single PSD layer${hiddenSource ? ' (from hidden PSD source)' : ''}`);
  return data;
}

async function serializeNode(
  node: any,
  parentX: number,
  parentY: number,
  onLog: LogFn,
  onProgress: ProgressFn,
  processed: { count: number },
  total: number,
  depth: number = 0,
  parentVisible: boolean = true,
  skippedNodeIds: Set<string> = new Set(),
): Promise<ExportNodeData | null> {
  if (!node || typeof node !== 'object') return null;
  if (skippedNodeIds.has(node.id)) return null;
  if (depth > MAX_DEPTH) {
    onLog('warn', `Skipping "${node.name}": exceeded max nesting depth`);
    return null;
  }
  // 栅格化文本的合成图兄弟 rectangle（renderer 创建，仅用于画布显示）：导出时跳过，
  // 由同位置的透明占位 TextNode 导出为文本层（含 rawImage 字形 + rawEffects 还原 spread 阴影/warp）。
  try {
    if (typeof node.getPluginData === 'function' && node.getPluginData('psd_raster_companion')) {
      return null;
    }
  } catch { /* ignore */ }

  const nodeType = mapNodeType(node);

  processed.count++;
  await yieldThread();

  onProgress(
    Math.round((processed.count / total) * 60),
    `导出节点 ${processed.count}/${total}: ${node.name}`,
  );

  let absX = node.absoluteTransform?.[0]?.[2] ?? node.x ?? 0;
  let absY = node.absoluteTransform?.[1]?.[2] ?? node.y ?? 0;

  if (nodeType === 'text') {
    // 检查节点是否有 anchor + psd_ty 元数据。如果有，buildLayer 会走 anchor+delta 路径
    // （直接用原始 psd ty + 用户移动量），node.y 应保持 mastergo 原始值（不加 padding）。
    // 如果没有元数据（旧节点 / 用户新建），走 fallback 路径 `ty = node.y + ascent`，
    // 需要把 linePadding 加回让 node.y = 字符 cap-height top。
    let hasAnchorMetadata = false;
    try {
      if (typeof node.getPluginData === 'function') {
        hasAnchorMetadata = !!node.getPluginData('psd_transform_ty') && !!node.getPluginData('psd_anchor_node_y');
      }
    } catch { /* ignore */ }

    if (!hasAnchorMetadata) {
      try {
        if (typeof node.getPluginData === 'function') {
          const raw = node.getPluginData('psd_line_padding_y');
          if (raw) {
            const v = parseFloat(raw);
            if (Number.isFinite(v)) {
              absY = absY + v;
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  const relX = absX - parentX;
  const relY = absY - parentY;

  // MasterGo 的可见性属性是 isVisible（Figma 是 visible）；隐藏父节点会让子树视觉上不可见
  // 但子节点的 isVisible 仍为 true，导出时必须显式继承父级 visible，否则 PSD 中所有节点都会显示。
  const selfVisible = getNodeVisible(node);
  const effectiveVisible = selfVisible && parentVisible;

  const data: ExportNodeData = {
    id: node.id,
    name: node.name ?? 'Unnamed',
    type: nodeType,
    x: relX,
    y: relY,
    width: node.width ?? 0,
    height: node.height ?? 0,
    opacity: node.opacity ?? 1,
    blendMode: node.blendMode ?? 'NORMAL',
    visible: effectiveVisible,
    clipsContent: node.clipsContent === true,
    isMask: node.isMask === true,
    isInstance: nodeType === 'instance',
    fills: [],
    strokes: [],
    effects: [],
  };
  if (nodeType === 'text') {
    data.textInfo = extractTextInfo(node);
    if (data.textInfo) {
      try {
        const getData = (key: string): string => typeof node.getPluginData === 'function' ? node.getPluginData(key) : '';
        const txOffStr = getData('psd_tx_offset_x');
        if (txOffStr) {
          const v = parseFloat(txOffStr);
          if (Number.isFinite(v)) data.textInfo.txOffsetX = v;
        }
        const boundsStr = getData('psd_bounds');
        if (boundsStr) {
          try { data.textInfo.bounds = JSON.parse(boundsStr); } catch { /* ignore */ }
        }
        const bboxStr = getData('psd_bounding_box');
        if (bboxStr) {
          try { data.textInfo.boundingBox = JSON.parse(bboxStr); } catch { /* ignore */ }
        }
        // round-trip 兜底：原始 PSD 文本栅格像素。仅当当前文本内容与导入时一致（未被编辑）才采用，
        // 否则原始像素已失效，回退到 MasterGo/Figma 重渲染像素（exportNodeImage）。
        const rawTextImgStr = getData('psd_raw_text_image');
        if (rawTextImgStr) {
          const origText = getData('psd_text_original');
          const curText = data.textInfo.characters ?? '';
          if (!origText || origText === curText) {
            try { data.textInfo.rawImage = JSON.parse(rawTextImgStr); } catch { /* ignore */ }
          }
        }
        const textIndexStr = getData('psd_text_index');
        if (textIndexStr) {
          const v = parseInt(textIndexStr, 10);
          if (Number.isFinite(v)) data.textInfo.textIndex = v;
        }
        // PSD 原始 transform 的 sy（垂直缩放系数）
        const tScaleStr = getData('psd_transform_scale');
        if (tScaleStr) {
          const v = parseFloat(tScaleStr);
          if (Number.isFinite(v) && v > 0) data.textInfo.transformScale = v;
        }
        const tScaleXStr = getData('psd_transform_scale_x');
        if (tScaleXStr) {
          const v = parseFloat(tScaleXStr);
          if (Number.isFinite(v) && v > 0) data.textInfo.transformScaleX = v;
        }
        // PSD 文本弯曲（warp）：导入时存入的原始 warp，导出 PSD 时写回 layer.text.warp。
        const warpStr = getData('psd_warp');
        if (warpStr) {
          try {
            const w = JSON.parse(warpStr);
            if (w && typeof w.style === 'string' && w.style !== 'none') data.textInfo.warp = w;
          } catch { /* ignore */ }
        }
        // 原始 PSD shapeType（栅格化文本专用）：栅格化把 textAutoResize 设为 NONE 污染了 point 判定，
        // 用此字段让 psd-builder 仍按原始 shapeType 走 point 分支，保留缩放/旋转 transform。
        const shapeTypeStr = getData('psd_shape_type');
        if (shapeTypeStr === 'point' || shapeTypeStr === 'box') {
          data.textInfo.shapeType = shapeTypeStr;
        }
        // 精确还原：anchor + 原始 PSD transform.tx/ty
        const anchorYStr = getData('psd_anchor_node_y');
        if (anchorYStr) {
          const v = parseFloat(anchorYStr);
          if (Number.isFinite(v)) data.textInfo.anchorNodeY = v;
        }
        const anchorXStr = getData('psd_anchor_node_x');
        if (anchorXStr) {
          const v = parseFloat(anchorXStr);
          if (Number.isFinite(v)) data.textInfo.anchorNodeX = v;
        }
        const psdTyStr = getData('psd_transform_ty');
        if (psdTyStr) {
          const v = parseFloat(psdTyStr);
          if (Number.isFinite(v)) data.textInfo.transformTy = v;
        }
        const psdTxStr = getData('psd_transform_tx');
        if (psdTxStr) {
          const v = parseFloat(psdTxStr);
          if (Number.isFinite(v)) data.textInfo.transformTx = v;
        }
        // 原始 PSD 旋转角（度）。用于 export 重建旋转 transform 与旋转后的 layer bbox，
        // 避免旋转文本退化为轴对齐 bbox 被 PS 裁剪。
        const rotStr = getData('psd_transform_rotation');
        if (rotStr) {
          const v = parseFloat(rotStr);
          if (Number.isFinite(v)) data.textInfo.rotation = v;
        }
        // 多 stroke 文本组标记（导入端在多 stroke 文本克隆时写入）
        const msGroup = getData('psd_multi_stroke_group_id');
        const msIdx = getData('psd_multi_stroke_index');
        const msTotal = getData('psd_multi_stroke_total');
        if (msGroup && msIdx) {
          data.textInfo.multiStrokeGroupId = msGroup;
          const idxN = parseInt(msIdx, 10);
          if (Number.isFinite(idxN)) data.textInfo.multiStrokeIndex = idxN;
          const totN = parseInt(msTotal, 10);
          if (Number.isFinite(totN)) data.textInfo.multiStrokeTotal = totN;
        }
      } catch { /* ignore */ }
    }
    data.fills = extractFills(node);
    data.strokes = extractStrokes(node);
    data.effects = extractEffects(node);
    data.imageBase64 = await exportNodeImage(node, { withoutStrokesAndEffects: true });
    try {
      const abb = node.absoluteBoundingBox;
      const arb = node.absoluteRenderBounds;
      if (abb && arb && data.textInfo) {
        data.textInfo.renderBoundsOffset = {
          dx: arb.x - abb.x,
          dy: arb.y - abb.y,
          w: arb.width,
          h: arb.height,
          nodeW: abb.width,
          nodeH: abb.height,
        };
      }
    } catch { /* ignore */ }
    onLog('info', `Text "${node.name}": ${data.textInfo?.characters.length ?? 0} chars`);
  } else if (nodeType === 'instance') {
    data.fills = extractFills(node);
    data.strokes = extractStrokes(node);
    data.effects = extractEffects(node);
    data.cornerRadii = extractCornerRadii(node);
    data.imageBase64 = await exportNodeImage(node);
    onLog('info', `Instance "${node.name}": exported as smart object`);

    if ('children' in node && node.children && Array.isArray(node.children)) {
      const { kids: exportKids, exportOrderReversed } = getNodeChildrenForExport(node);
      data.children = [];
      for (const child of exportKids) {
        // 传画布原点（parentX/Y）保持不变，让所有节点的 data.x/y 都是相对画布原点的绝对偏移。
        // PSD layer.left/top 要求绝对坐标，group bbox=[0,0,0,0] 不影响子节点位置。
        const childData = await serializeNode(child, parentX, parentY, onLog, onProgress, processed, total, depth + 1, effectiveVisible, skippedNodeIds);
        if (childData) data.children.push(childData);
      }
      await bakePassThroughOverlays(node, data.children, onLog, parentX, parentY, exportOrderReversed);
    }
  } else if (nodeType === 'frame' || nodeType === 'group' || nodeType === 'component') {
    if (nodeType === 'component' && isNineSliceComponent(node)) {
      return serializeNineSliceCollapsed(node, parentX, parentY, onLog, effectiveVisible, skippedNodeIds);
    }

    data.fills = extractFills(node);
    data.strokes = extractStrokes(node);
    data.effects = extractEffects(node);
    data.cornerRadii = extractCornerRadii(node);

    if ('children' in node && node.children && Array.isArray(node.children)) {
      const { kids: exportKids, exportOrderReversed } = getNodeChildrenForExport(node);
      data.children = [];
      for (const child of exportKids) {
        const childData = await serializeNode(child, parentX, parentY, onLog, onProgress, processed, total, depth + 1, effectiveVisible, skippedNodeIds);
        if (childData) data.children.push(childData);
      }
      await bakePassThroughOverlays(node, data.children, onLog, parentX, parentY, exportOrderReversed);
    }

    if (data.fills.some(f => f.type === 'IMAGE' && f.visible)) {
      data.imageBase64 = await exportNodeImage(node);
    }
  } else if (nodeType === 'vector' || nodeType === 'ellipse') {
    data.fills = extractFills(node);
    data.strokes = extractStrokes(node);
    data.effects = extractEffects(node);
    data.cornerRadii = extractCornerRadii(node);
    data.imageBase64 = await exportNodeImage(node);
    onLog('info', `Vector "${node.name}": exported as raster`);
  } else if (nodeType === 'rectangle') {
    data.fills = extractFills(node);
    data.strokes = extractStrokes(node);
    data.effects = extractEffects(node);
    data.cornerRadii = extractCornerRadii(node);

    const hasImageFill = data.fills.some(f => f.type === 'IMAGE' && f.visible);
    const hasRoundTripImage = hasRoundTripImagePluginData(node);
    const hasVisiblePaintFill = data.fills.some(f =>
      f.visible && (f.type === 'SOLID' || (f.type && f.type.startsWith('GRADIENT_')))
    );
    const willExportImage = hasImageFill || !effectiveVisible || (hasVisiblePaintFill && !hasRoundTripImage);
    if (willExportImage) {
      // 去除 node 的 effects/strokes 与叠加 overlay fill 再导出，使 PNG 只含原始像素：
      // 整层原生化的位图层这些效果由 node 属性写回 PSD，不可重复烤进 PNG（难点 4）。
      // 栅格化层的 effects/strokes 已在导入时清空、无 overlay fill，此操作对其为无副作用。
      data.imageBase64 = await exportNodeImage(node, { withoutStrokesAndEffects: true });
    }
  } else {
    data.imageBase64 = await exportNodeImage(node);
  }

  attachPsdPluginData(node, data);

  return data;
}

/**
 * 在导出树中识别并合并多 stroke 文本组的克隆节点。
 *
 * 在导入端 (mastergo/figma renderer) PSD 单文本多 stroke 被拆成多个文本节点：
 *   - 主节点 (index=0)：承载 PSD stroke[0]（最上层）
 *   - 副本 (index=1..N-1)：每个承载一个 stroke
 *   - 所有节点共享 psd_multi_stroke_group_id 和 psd_multi_stroke_total
 *
 * 这里在递归的导出树中找到同组节点，按 index 排序，把所有 stroke 合并到主节点的
 * data.strokes 数组中（PSD 顺序：stroke[0] 在最前），删除副本节点；
 * 同时把主节点的 textInfo 的 multiStroke* 字段保留以便后续诊断。
 */
function mergeMultiStrokeTextNodes(nodes: ExportNodeData[], onLog: LogFn): void {
  const groups = new Map<string, { parent: ExportNodeData | { children: ExportNodeData[] }; nodes: ExportNodeData[] }>();
  const fakeRoot = { children: nodes };
  collectMultiStrokeGroups(fakeRoot, groups);

  let mergedCount = 0;
  for (const [groupId, group] of groups) {
    const sorted = [...group.nodes].sort((a, b) => (a.textInfo?.multiStrokeIndex ?? 0) - (b.textInfo?.multiStrokeIndex ?? 0));
    const main = sorted[0];
    if (!main) continue;
    // 把所有副本的第一个 stroke 按 index 升序追加到主节点 strokes
    // sorted[0] 自身的 strokes 已经在前，副本（sorted[1..]）的 strokes 追加在后
    for (let i = 1; i < sorted.length; i++) {
      const cloneStrokes = sorted[i].strokes ?? [];
      for (const s of cloneStrokes) main.strokes.push(s);
    }
    // 从父节点 children 中删除副本
    const parentChildren = (group.parent as { children: ExportNodeData[] }).children;
    for (let i = 1; i < sorted.length; i++) {
      const idx = parentChildren.indexOf(sorted[i]);
      if (idx >= 0) parentChildren.splice(idx, 1);
    }
    mergedCount++;
  }
  if (mergedCount > 0) {
    onLog('info', `Merged ${mergedCount} multi-stroke text group(s) before PSD export`);
  }
}

function collectMultiStrokeGroups(
  parent: { children?: ExportNodeData[] } | ExportNodeData,
  groups: Map<string, { parent: ExportNodeData | { children: ExportNodeData[] }; nodes: ExportNodeData[] }>,
): void {
  const children = (parent as { children?: ExportNodeData[] }).children;
  if (!children) return;
  for (const child of children) {
    const gid = child.textInfo?.multiStrokeGroupId;
    if (gid && child.type === 'text') {
      let bucket = groups.get(gid);
      if (!bucket) {
        bucket = { parent: parent as ExportNodeData | { children: ExportNodeData[] }, nodes: [] };
        groups.set(gid, bucket);
      }
      bucket.nodes.push(child);
    }
    if (child.children && child.children.length > 0) {
      collectMultiStrokeGroups(child, groups);
    }
  }
}

function findPsdEngineData(node: any): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  try {
    if (typeof node.getPluginData === 'function') {
      const v = node.getPluginData('psd_engine_data');
      if (v) return v;
    }
  } catch { /* ignore */ }
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      const r = findPsdEngineData(child);
      if (r) return r;
    }
  }
  return undefined;
}

// 递归查找根 Section 上的 psd_patterns plugin data（PSD 全局 pattern 资源表 JSON）。
function findPsdPatterns(node: any): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  try {
    if (typeof node.getPluginData === 'function') {
      const v = node.getPluginData('psd_patterns');
      if (v) return v;
    }
  } catch { /* ignore */ }
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      const r = findPsdPatterns(child);
      if (r) return r;
    }
  }
  return undefined;
}

// 识别 importer 凭空添加的「根外壳」节点：
//   - Section：带 psd_engine_data plugin data（PSD 文件名画板）
//   - Frame：带 psd_root_frame='1' plugin data（isRootFrame 提供画布裁切的容器）
// 这两层在 PSD 顶层并不存在，导出时拍平到 children，让 PSD 顶层与原 PS 一致。
function isImportWrapper(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  try {
    if (typeof node.getPluginData !== 'function') return false;
    if (node.type === 'SECTION' && node.getPluginData('psd_engine_data')) return true;
    if (node.type === 'FRAME' && node.getPluginData('psd_root_frame') === '1') return true;
  } catch { /* ignore */ }
  return false;
}

function expandImportWrappers(selection: any[]): any[] {
  const out: any[] = [];
  for (const node of selection) {
    if (isImportWrapper(node)) {
      const children: any[] = Array.isArray(node.children) ? node.children : [];
      if (children.length > 0) {
        for (const child of expandImportWrappers(children)) {
          out.push(child);
        }
      }
    } else {
      out.push(node);
    }
  }
  return out;
}

export async function serializeSelection(
  onLog: LogFn,
  onProgress: ProgressFn,
): Promise<{ nodes: ExportNodeData[]; width: number; height: number; engineData?: string; patterns?: string }> {
  const page = isMasterGo ? mg.document.currentPage : api.currentPage;
  const rawSelection = page.selection;

  if (!rawSelection || rawSelection.length === 0) {
    throw new Error('没有选中任何节点');
  }

  // engineData 查找必须在「展开外壳」之前进行：psd_engine_data plugin data
  // 写在 Section 节点本身，展开后 Section 不再进入序列化树，需要先把它读出来。
  let engineData: string | undefined;
  for (const node of rawSelection) {
    engineData = findPsdEngineData(node);
    if (engineData) break;
  }
  if (!engineData) {
    for (const node of rawSelection) {
      let cursor: any = node;
      while (cursor && typeof cursor === 'object') {
        try {
          if (typeof cursor.getPluginData === 'function') {
            const v = cursor.getPluginData('psd_engine_data');
            if (v) { engineData = v; break; }
          }
        } catch { /* ignore */ }
        cursor = cursor.parent;
      }
      if (engineData) break;
    }
  }

  // pattern 资源同样写在 Section 上，须在展开外壳前读出。
  let patterns: string | undefined;
  for (const node of rawSelection) {
    patterns = findPsdPatterns(node);
    if (patterns) break;
  }
  if (!patterns) {
    for (const node of rawSelection) {
      let cursor: any = node;
      while (cursor && typeof cursor === 'object') {
        try {
          if (typeof cursor.getPluginData === 'function') {
            const v = cursor.getPluginData('psd_patterns');
            if (v) { patterns = v; break; }
          }
        } catch { /* ignore */ }
        cursor = cursor.parent;
      }
      if (patterns) break;
    }
  }

  // 展开 importer 凭空添加的根外壳（Section / isRootFrame Frame），让 PSD 顶层结构
  // 与原始 PS 文件一致（不带这两层包裹）。展开后 totalNodes / bbox / serializeNode
  // 都基于展开后的 selection 计算。
  // 在展开之前记住 root frame 的画布尺寸（原始 PSD 的 width/height）。
  let psdCanvasWidth = 0;
  let psdCanvasHeight = 0;
  for (const node of rawSelection) {
    try {
      if (typeof node.getPluginData === 'function') {
        if (node.type === 'SECTION' && node.getPluginData('psd_engine_data')) {
          const rootFrame = Array.isArray(node.children) ? node.children.find((c: any) =>
            typeof c.getPluginData === 'function' && c.getPluginData('psd_root_frame') === '1'
          ) : null;
          if (rootFrame) {
            psdCanvasWidth = rootFrame.width ?? 0;
            psdCanvasHeight = rootFrame.height ?? 0;
          }
        } else if (node.type === 'FRAME' && node.getPluginData('psd_root_frame') === '1') {
          psdCanvasWidth = node.width ?? 0;
          psdCanvasHeight = node.height ?? 0;
        }
      }
    } catch { /* ignore */ }
  }
  const selection = expandImportWrappers(rawSelection);
  if (selection.length === 0) {
    throw new Error('选中的节点展开后为空');
  }
  const expandedCount = selection.length - rawSelection.length;
  if (expandedCount !== 0) {
    onLog('info', `Expanded import wrappers: ${rawSelection.length} -> ${selection.length} top-level nodes`);
  }

  let totalNodes = 0;
  for (const node of selection) {
    totalNodes += countNodes(node);
  }
  onLog('info', `Selection: ${selection.length} top-level nodes, ${totalNodes} total`);

  const nodes: ExportNodeData[] = [];
  const processed = { count: 0 };
  const skippedNodeIds = new Set<string>();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of selection) {
    const ax = node.absoluteTransform?.[0]?.[2] ?? node.x ?? 0;
    const ay = node.absoluteTransform?.[1]?.[2] ?? node.y ?? 0;
    minX = Math.min(minX, ax);
    minY = Math.min(minY, ay);
    maxX = Math.max(maxX, ax + (node.width ?? 0));
    maxY = Math.max(maxY, ay + (node.height ?? 0));
  }

  for (const node of selection) {
    const nodeData = await serializeNode(node, minX, minY, onLog, onProgress, processed, totalNodes, 0, true, skippedNodeIds);
    if (nodeData) nodes.push(nodeData);
  }

  // 后处理：合并多 stroke 文本组的克隆节点。
  // 导入端把 PSD 单文本多 stroke 拆成多个 mastergo/figma 文本节点 (主节点 + 副本)
  // 并通过 psd_multi_stroke_group_id 标记同组。这里把它们合并回单 ExportNodeData，
  // 主节点 (index=0) 承载所有 stroke，副本节点从导出树中移除，保持 PSD 文件结构与原始一致。
  mergeMultiStrokeTextNodes(nodes, onLog);

  return {
    nodes,
    width: psdCanvasWidth > 0 ? Math.round(psdCanvasWidth) : Math.max(1, Math.round(maxX - minX)),
    height: psdCanvasHeight > 0 ? Math.round(psdCanvasHeight) : Math.max(1, Math.round(maxY - minY)),
    engineData,
    patterns,
  };
}
