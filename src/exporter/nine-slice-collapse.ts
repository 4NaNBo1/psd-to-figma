/** 与 9-Slice 插件 (nineSliceSettings) 对齐的九宫区域名。 */
export const NINE_SLICE_REGION_KEYS = [
  'topLeft', 'top', 'topRight',
  'left', 'center', 'right',
  'bottomLeft', 'bottom', 'bottomRight',
] as const;

export const NINE_SLICE_METADATA_KEY = 'nineSliceSettings';

/** 跨插件共享 plugin data 的 namespace（psd-to-figma 写入，9slice 读取）。 */
export const NINE_SLICE_SHARED_NAMESPACE = '9slice';

/** PSD 图层名后缀分隔符（PUA，ag-psd 往返验证可保留）。 */
export const NINE_SLICE_LAYER_NAME_DELIMITER = '\uE000';

export interface NineSliceSettingsPayload {
  version: 1;
  imageSize: { width: number; height: number };
  slices: { top: number; right: number; bottom: number; left: number };
}

export function isNineSliceComponent(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (getNineSliceMetadataFromNode(node)) return true;
  const kids = node.children;
  if (!Array.isArray(kids) || kids.length < NINE_SLICE_REGION_KEYS.length) return false;
  const names = new Set(kids.map((c: any) => c?.name));
  return NINE_SLICE_REGION_KEYS.every((key) => names.has(key));
}

/** 读取节点上的九宫元数据（含 sharedPluginData，供跨插件读取）。 */
export function getNineSliceMetadataFromNode(node: any): NineSliceSettingsPayload | undefined {
  if (!node || typeof node !== 'object') return undefined;
  try {
    if (typeof node.getSharedPluginData === 'function') {
      const shared = node.getSharedPluginData(NINE_SLICE_SHARED_NAMESPACE, NINE_SLICE_METADATA_KEY);
      const parsed = shared ? parseNineSliceSettingsJson(shared) : undefined;
      if (parsed) return parsed;
    }
  } catch { /* ignore */ }
  if (typeof node?.getPluginData === 'function') {
    try {
      const raw = node.getPluginData(NINE_SLICE_METADATA_KEY);
      if (raw) return parseNineSliceSettingsJson(raw);
    } catch { /* ignore */ }
  }
  return undefined;
}

/** @deprecated 使用 getNineSliceMetadataFromNode */
export function getNineSliceMetadata(node: any): NineSliceSettingsPayload | undefined {
  return getNineSliceMetadataFromNode(node);
}

export function parseNineSliceSettingsJson(raw: string): NineSliceSettingsPayload | undefined {
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1) return undefined;
    if (!value.imageSize || !value.slices) return undefined;
    return value as NineSliceSettingsPayload;
  } catch {
    return undefined;
  }
}

export function serializeNineSliceSettingsPayload(payload: NineSliceSettingsPayload): string {
  return JSON.stringify(payload);
}

function roundSlice(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 从九宫子节点几何推断切片（不依赖 plugin data，规避跨插件隔离）。 */
export function inferSliceSettingsFromRegionNodes(
  image: { width: number; height: number },
  nodes: Array<{ name: string; x: number; y: number; width: number; height: number }>,
): { top: number; right: number; bottom: number; left: number } | undefined {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  if (NINE_SLICE_REGION_KEYS.some((key) => !byName.has(key))) return undefined;

  const topLeft = byName.get('topLeft')!;
  const topRight = byName.get('topRight')!;
  const bottomLeft = byName.get('bottomLeft')!;
  const bottomRight = byName.get('bottomRight')!;

  const slices = {
    top: roundSlice(topLeft.height),
    right: roundSlice(topRight.width),
    bottom: roundSlice(bottomLeft.height),
    left: roundSlice(topLeft.width),
  };

  const cornersAgree =
    roundSlice(bottomLeft.width) === slices.left &&
    roundSlice(bottomRight.width) === slices.right &&
    roundSlice(topRight.height) === slices.top &&
    roundSlice(bottomRight.height) === slices.bottom;
  if (!cornersAgree) return undefined;

  if (slices.left + slices.right >= image.width || slices.top + slices.bottom >= image.height) {
    return undefined;
  }
  return slices;
}

export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined;
  const width = ((bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!) >>> 0;
  const height = ((bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!) >>> 0;
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

function base64UrlEncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 = globalThis.btoa ? globalThis.btoa(binary) : '';
  if (!b64) return '';
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeUtf8(encoded: string): string {
  let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = globalThis.atob ? globalThis.atob(b64) : '';
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeNineSliceLayerName(displayName: string, settingsJson: string | undefined): string {
  if (!settingsJson || !parseNineSliceSettingsJson(settingsJson)) return displayName;
  const encoded = base64UrlEncodeUtf8(settingsJson);
  if (!encoded) return displayName;
  return `${displayName}${NINE_SLICE_LAYER_NAME_DELIMITER}${encoded}`;
}

export function decodeNineSliceLayerName(rawName: string): { displayName: string; settingsJson?: string } {
  const idx = rawName.indexOf(NINE_SLICE_LAYER_NAME_DELIMITER);
  if (idx < 0) return { displayName: rawName };
  const displayName = rawName.slice(0, idx) || rawName;
  try {
    const settingsJson = base64UrlDecodeUtf8(rawName.slice(idx + 1));
    if (!parseNineSliceSettingsJson(settingsJson)) return { displayName: rawName };
    return { displayName, settingsJson };
  } catch {
    return { displayName: rawName };
  }
}

export function findNineSliceHiddenSource(component: any, isVisible: (node: any) => boolean): any | undefined {
  const parent = component?.parent;
  if (!Array.isArray(parent?.children)) return undefined;
  for (const sib of parent.children) {
    if (sib.id === component.id) continue;
    if (sib.name !== component.name) continue;
    if (isVisible(sib)) continue;
    if (hasPsdRoundTripMarkers(sib)) return sib;
  }
  return undefined;
}

export function prescanNineSliceHiddenSources(children: any[], skippedNodeIds: Set<string>, isVisible: (node: any) => boolean): void {
  for (const child of children) {
    if (!isNineSliceComponent(child)) continue;
    const hidden = findNineSliceHiddenSource(child, isVisible);
    if (hidden?.id) skippedNodeIds.add(hidden.id);
  }
}

export function hasPsdRoundTripMarkers(node: any): boolean {
  if (typeof node?.getPluginData !== 'function') return false;
  return !!(
    node.getPluginData('psd_raw_effects') ||
    node.getPluginData('psd_original_image') ||
    node.getPluginData('psd_pre_pattern_image') ||
    node.getPluginData('psd_layer_mask_image') ||
    node.getPluginData('psd_smart_object')
  );
}

/**
 * 解析九宫元数据：优先 plugin/shared data；否则从子节点几何 + 存储图源尺寸推断。
 * 9slice 与 psd-to-figma 的 private pluginData 互不可见，必须走推断或 PSD 图层名/共享数据。
 */
export async function resolveNineSliceMetadataForExport(
  component: any,
  hiddenSource: any | null | undefined,
  readStoredImageBytes: (node: any) => Promise<Uint8Array | undefined>,
): Promise<NineSliceSettingsPayload | undefined> {
  const fromPlugin = getNineSliceMetadataFromNode(component);
  if (fromPlugin) return fromPlugin;

  if (!Array.isArray(component?.children)) return undefined;
  const regionNodes = component.children
    .filter((c: any) => NINE_SLICE_REGION_KEYS.includes(c?.name))
    .map((c: any) => ({
      name: c.name,
      x: c.x ?? 0,
      y: c.y ?? 0,
      width: c.width ?? 0,
      height: c.height ?? 0,
    }));
  const targetW = component.width ?? 0;
  const targetH = component.height ?? 0;
  const slices = inferSliceSettingsFromRegionNodes({ width: targetW, height: targetH }, regionNodes);
  if (!slices) return undefined;

  let imageSize = { width: targetW, height: targetH };
  for (const node of [component, hiddenSource]) {
    if (!node) continue;
    const bytes = await readStoredImageBytes(node);
    const dims = bytes ? readPngDimensions(bytes) : undefined;
    if (dims) {
      imageSize = dims;
      break;
    }
  }

  return { version: 1, imageSize, slices };
}

export function writeNineSlicePluginData(node: any, settingsJson: string): void {
  if (!node || typeof settingsJson !== 'string' || !settingsJson) return;
  try {
    if (typeof node.setSharedPluginData === 'function') {
      node.setSharedPluginData(NINE_SLICE_SHARED_NAMESPACE, NINE_SLICE_METADATA_KEY, settingsJson);
    }
  } catch { /* ignore */ }
  try {
    if (typeof node.setPluginData === 'function') {
      node.setPluginData(NINE_SLICE_METADATA_KEY, settingsJson);
    }
  } catch { /* ignore */ }
}
