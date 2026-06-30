/** 与 9-Slice 插件 (nineSliceSettings) 对齐的九宫区域名。 */
export const NINE_SLICE_REGION_KEYS = [
  'topLeft', 'top', 'topRight',
  'left', 'center', 'right',
  'bottomLeft', 'bottom', 'bottomRight',
] as const;

export const NINE_SLICE_METADATA_KEY = 'nineSliceSettings';

export function isNineSliceComponent(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (getNineSliceMetadata(node)) return true;
  const kids = node.children;
  if (!Array.isArray(kids) || kids.length < NINE_SLICE_REGION_KEYS.length) return false;
  const names = new Set(kids.map((c: any) => c?.name));
  return NINE_SLICE_REGION_KEYS.every((key) => names.has(key));
}

export function getNineSliceMetadata(node: any): { imageSize: { width: number; height: number }; slices: { top: number; right: number; bottom: number; left: number } } | undefined {
  if (typeof node?.getPluginData !== 'function') return undefined;
  try {
    const raw = node.getPluginData(NINE_SLICE_METADATA_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw);
    if (value?.version !== 1) return undefined;
    if (!value.imageSize || !value.slices) return undefined;
    return value;
  } catch {
    return undefined;
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
