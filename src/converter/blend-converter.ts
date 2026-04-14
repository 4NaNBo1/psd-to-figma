const BLEND_MODE_MAP: Record<string, string> = {
  'pass through': 'PASS_THROUGH',
  'normal': 'NORMAL',
  'dissolve': 'NORMAL',
  'darken': 'DARKEN',
  'multiply': 'MULTIPLY',
  'color burn': 'COLOR_BURN',
  'linear burn': 'LINEAR_BURN',
  'darker color': 'DARKEN',
  'lighten': 'LIGHTEN',
  'screen': 'SCREEN',
  'color dodge': 'COLOR_DODGE',
  'linear dodge': 'LINEAR_DODGE',
  'lighter color': 'LIGHTEN',
  'overlay': 'OVERLAY',
  'soft light': 'SOFT_LIGHT',
  'hard light': 'HARD_LIGHT',
  'vivid light': 'HARD_LIGHT',
  'linear light': 'HARD_LIGHT',
  'pin light': 'HARD_LIGHT',
  'hard mix': 'HARD_LIGHT',
  'difference': 'DIFFERENCE',
  'exclusion': 'EXCLUSION',
  'subtract': 'EXCLUSION',
  'divide': 'NORMAL',
  'hue': 'HUE',
  'saturation': 'SATURATION',
  'color': 'COLOR',
  'luminosity': 'LUMINOSITY',
};

export function convertBlendMode(psdBlendMode: string | undefined): string {
  if (!psdBlendMode) return 'NORMAL';
  return BLEND_MODE_MAP[psdBlendMode] ?? 'NORMAL';
}
