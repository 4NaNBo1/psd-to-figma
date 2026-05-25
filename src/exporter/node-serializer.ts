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
} from '../types/psd-types';

declare const mg: any;
const isMasterGo = typeof mg !== 'undefined';
const api: any = isMasterGo ? mg : (typeof figma !== 'undefined' ? figma : undefined);

const MIXED = typeof figma !== 'undefined' ? (figma as any).mixed : undefined;

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;
type ProgressFn = (percent: number, message: string) => void;

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
        const [[a, , ], [, , ]] = fill.gradientTransform;
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
} {
  let family = 'Arial', style = 'Regular', size = 16;
  let color: SerializedColor = { r: 0, g: 0, b: 0, a: 1 };
  let letterSpacing = 0, lineHeight: number | null = null;

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

  return { family, style, size, color, letterSpacing, lineHeight };
}

function stylesEqual(
  a: ReturnType<typeof getCharStyle>,
  b: ReturnType<typeof getCharStyle>,
): boolean {
  return a.family === b.family && a.style === b.style && a.size === b.size &&
    a.color.r === b.color.r && a.color.g === b.color.g &&
    a.color.b === b.color.b && a.color.a === b.color.a &&
    a.letterSpacing === b.letterSpacing && a.lineHeight === b.lineHeight;
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
      return {
        start: seg.start ?? 0,
        end: seg.end ?? len,
        fontFamily: fn?.family ?? 'Arial',
        fontStyle: fn?.style ?? 'Regular',
        fontSize: ts.fontSize ?? 16,
        color,
        letterSpacing,
        lineHeight,
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

  // For text layers, temporarily disable strokes/effects to get a tight character-bounded image,
  // matching PSD's native text layer canvas size (which doesn't include stroke extension).
  let savedStrokes: any[] | undefined;
  let savedEffects: any[] | undefined;
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
    } catch { /* ignore */ }
  }

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
    if (savedStrokes !== undefined) {
      try { node.strokes = savedStrokes; } catch { /* ignore */ }
    }
    if (savedEffects !== undefined) {
      try { node.effects = savedEffects; } catch { /* ignore */ }
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

async function serializeNode(
  node: any,
  parentX: number,
  parentY: number,
  onLog: LogFn,
  onProgress: ProgressFn,
  processed: { count: number },
  total: number,
  depth: number = 0,
): Promise<ExportNodeData | null> {
  if (!node || typeof node !== 'object') return null;
  if (depth > MAX_DEPTH) {
    onLog('warn', `Skipping "${node.name}": exceeded max nesting depth`);
    return null;
  }

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
    visible: node.visible !== false,
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
    onLog('info', `Text "${node.name}": ${data.textInfo?.characters.length ?? 0} chars`);
  } else if (nodeType === 'instance') {
    data.fills = extractFills(node);
    data.strokes = extractStrokes(node);
    data.effects = extractEffects(node);
    data.cornerRadii = extractCornerRadii(node);
    data.imageBase64 = await exportNodeImage(node);
    onLog('info', `Instance "${node.name}": exported as smart object`);

    if ('children' in node && node.children && Array.isArray(node.children)) {
      data.children = [];
      for (const child of node.children) {
        const childData = await serializeNode(child, absX, absY, onLog, onProgress, processed, total, depth + 1);
        if (childData) data.children.push(childData);
      }
    }
  } else if (nodeType === 'frame' || nodeType === 'group' || nodeType === 'component') {
    data.fills = extractFills(node);
    data.strokes = extractStrokes(node);
    data.effects = extractEffects(node);
    data.cornerRadii = extractCornerRadii(node);

    if ('children' in node && node.children && Array.isArray(node.children)) {
      data.children = [];
      for (const child of node.children) {
        const childData = await serializeNode(child, absX, absY, onLog, onProgress, processed, total, depth + 1);
        if (childData) data.children.push(childData);
      }
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
    if (hasImageFill) {
      data.imageBase64 = await exportNodeImage(node);
    }
  } else {
    data.imageBase64 = await exportNodeImage(node);
  }

  // 读取 import 时通过 setPluginData 写入的原始 PSD effects 元数据
  // (bevel/satin/glow/pattern/多 stroke 的 fillType=gradient 等),
  // 让 figma/mastergo → PSD 回转时能还原 figma/mastergo 无法表达的高级效果。
  try {
    if (typeof node.getPluginData === 'function') {
      const raw = node.getPluginData('psd_raw_effects');
      if (raw) {
        data.rawPsdEffects = raw;
      }
    }
  } catch { /* ignore */ }

  // 读取 psd_expand_offset：psd-parser 为了让 stroke 像素完整保留，在 import 时把
  // 位图层向四周扩展了 expand 像素；export 时这里要把这个扩展还原回去，让 PSD layer 的 bbox
  // 与原始一致（PSD effects 由 PS 重新计算 stroke 范围，不需要 expand）。
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

  // 读取 psd_vector_data：还原 PSD shape layer 的矢量形状（vectorMask/vectorFill/vectorOrigination）
  // 让 PS appearance 面板能显示 Fill/Stroke/圆角/精确坐标。
  try {
    if (typeof node.getPluginData === 'function') {
      const vec = node.getPluginData('psd_vector_data');
      if (vec) {
        data.rawPsdVectorData = vec;
      }
    }
  } catch { /* ignore */ }

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

export async function serializeSelection(
  onLog: LogFn,
  onProgress: ProgressFn,
): Promise<{ nodes: ExportNodeData[]; width: number; height: number; engineData?: string }> {
  const page = isMasterGo ? mg.document.currentPage : api.currentPage;
  const selection = page.selection;

  if (!selection || selection.length === 0) {
    throw new Error('没有选中任何节点');
  }

  let totalNodes = 0;
  for (const node of selection) {
    totalNodes += countNodes(node);
  }
  onLog('info', `Selection: ${selection.length} top-level nodes, ${totalNodes} total`);

  // Look up the original PSD engineData stored on import (in selection subtree first, then parent chain).
  let engineData: string | undefined;
  for (const node of selection) {
    engineData = findPsdEngineData(node);
    if (engineData) break;
  }
  if (!engineData) {
    for (const node of selection) {
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

  const nodes: ExportNodeData[] = [];
  const processed = { count: 0 };

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
    const nodeData = await serializeNode(node, minX, minY, onLog, onProgress, processed, totalNodes);
    if (nodeData) nodes.push(nodeData);
  }

  // 后处理：合并多 stroke 文本组的克隆节点。
  // 导入端把 PSD 单文本多 stroke 拆成多个 mastergo/figma 文本节点 (主节点 + 副本)
  // 并通过 psd_multi_stroke_group_id 标记同组。这里把它们合并回单 ExportNodeData，
  // 主节点 (index=0) 承载所有 stroke，副本节点从导出树中移除，保持 PSD 文件结构与原始一致。
  mergeMultiStrokeTextNodes(nodes, onLog);

  return {
    nodes,
    width: Math.max(1, Math.round(maxX - minX)),
    height: Math.max(1, Math.round(maxY - minY)),
    engineData,
  };
}
