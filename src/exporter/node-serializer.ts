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
    return { characters, alignment, styles };
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

  return { characters, alignment, styles };
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

async function exportNodeImage(node: any): Promise<string | undefined> {
  if (typeof node.exportAsync !== 'function') return undefined;

  const w = node.width ?? 0;
  const h = node.height ?? 0;
  if (w <= 0 || h <= 0) return undefined;

  let scale = 1;
  if (w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION) {
    scale = MAX_IMAGE_DIMENSION / Math.max(w, h);
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

  const absX = node.absoluteTransform?.[0]?.[2] ?? node.x ?? 0;
  const absY = node.absoluteTransform?.[1]?.[2] ?? node.y ?? 0;
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
    data.fills = extractFills(node);
    data.strokes = extractStrokes(node);
    data.effects = extractEffects(node);
    data.imageBase64 = await exportNodeImage(node);
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

  return data;
}

export async function serializeSelection(
  onLog: LogFn,
  onProgress: ProgressFn,
): Promise<{ nodes: ExportNodeData[]; width: number; height: number }> {
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

  return {
    nodes,
    width: Math.max(1, Math.round(maxX - minX)),
    height: Math.max(1, Math.round(maxY - minY)),
  };
}
