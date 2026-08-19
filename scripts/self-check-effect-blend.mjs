/** ponytail: 断言 pass through 不会进入 ag-psd 图层样式 BlnM 枚举 */
function toBlendMode(mode, map) {
  const mapped = map[mode] ?? 'normal';
  return mapped === 'pass through' ? 'normal' : mapped;
}

function sanitizeEffectBlendModes(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) sanitizeEffectBlendModes(item);
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'blendMode' && val === 'pass through') obj[key] = 'normal';
    else if (val && typeof val === 'object') sanitizeEffectBlendModes(val);
  }
}

const map = { PASS_THROUGH: 'pass through', NORMAL: 'normal', MULTIPLY: 'multiply' };
if (toBlendMode('PASS_THROUGH', map) !== 'normal') throw new Error('toBlendMode PASS_THROUGH');
if (toBlendMode('MULTIPLY', map) !== 'multiply') throw new Error('toBlendMode MULTIPLY');

const fx = { dropShadow: [{ blendMode: 'pass through' }, { blendMode: 'multiply' }] };
sanitizeEffectBlendModes(fx);
if (fx.dropShadow[0].blendMode !== 'normal') throw new Error('sanitize nested');
if (fx.dropShadow[1].blendMode !== 'multiply') throw new Error('sanitize preserve');

console.log('self-check-effect-blend OK');
