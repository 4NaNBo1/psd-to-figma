/**
 * ponytail: 断言「组图层蒙版」按 PS 语义（内容 alpha × 蒙版灰度）烘焙进子层像素，
 * 而不是只把内容裁到蒙版框的矩形。
 *
 * 背景：PSD 中组上的 layer mask 常带圆角等不规则轮廓，PS 的实际语义是逐像素相乘。
 * 旧实现只按蒙版框做矩形裁剪，内容会整块留在框外、细节被拉宽。约定：
 *   - getGroupMaskRect 保留灰度像素（gray）；
 *   - parser 在序列化子层前把蒙版 alpha 乘进子层像素（applyGroupMaskToChildren）；
 *   - groupMaskRect 透传 dataB64，导出端据此重建逐像素 layer mask。
 *
 * 用法：node scripts/self-check-group-mask-alpha.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── 1. getGroupMaskRect 必须保留灰度像素 ────────────────────────────────────
const parser = read('src/parser/psd-parser.ts');
const gmrBlock = parser.match(/function getGroupMaskRect\([\s\S]*?\n\}/);
must(gmrBlock, 'psd-parser.ts: getGroupMaskRect not found');
must(
  /extractMaskGray\(mask\)/.test(gmrBlock[0]),
  'psd-parser.ts: getGroupMaskRect must keep the mask gray pixels',
);

// ── 2. parser 必须在序列化子层前把蒙版 alpha 乘进子层像素 ─────────────────────
must(
  /applyGroupMaskToChildren\(layer, groupMask\)/.test(parser),
  'psd-parser.ts: group mask must be baked into child layers via applyGroupMaskToChildren',
);
const bakeBlock = parser.match(/if \(groupMask\?\.gray && groupMask\.width > 0 && groupMask\.height > 0\) \{[\s\S]{0,400}?\n {4}\}/);
must(bakeBlock, 'psd-parser.ts: group mask bake block not found');
// 烘焙必须在子层序列化循环之前（否则子层已编码成 PNG，改不到像素）。
must(
  parser.indexOf('applyGroupMaskToChildren(layer, groupMask)') <
    parser.indexOf('for (const child of layer.children) {\n      const childSerialized'),
  'psd-parser.ts: group mask must be baked before children are serialized',
);
// 相乘必须作用于 alpha 通道，且只乘一次（不得反向相乘）。
const maskWalk = parser.match(/function applyGroupMaskToChildren\([\s\S]*?\n\}/);
must(maskWalk, 'psd-parser.ts: applyGroupMaskToChildren not found');
must(
  /data\[pIdx \+ 3\] = Math\.round\(\(data\[pIdx \+ 3\] \* maskAlpha\) \/ 255\)/.test(maskWalk[0]),
  'psd-parser.ts: group mask must multiply the alpha channel (content alpha x mask gray)',
);
must(
  /defaultAlpha/.test(maskWalk[0]) && /gray\[maskY \* maskW \+ maskX\]/.test(maskWalk[0]),
  'psd-parser.ts: group mask must sample gray inside the rect and defaultColor outside',
);

// ── 3. groupMaskRect 透传 dataB64 ──────────────────────────────────────────
must(
  /groupMask\.gray \? uint8ArrayToBase64\(groupMask\.gray\) : undefined/.test(parser),
  'psd-parser.ts: groupMaskRect must carry the mask gray as dataB64',
);
const types = read('src/types/psd-types.ts');
must(
  /dataB64\?: string;/.test(types),
  'types/psd-types.ts: groupMaskRect must declare the optional dataB64 field',
);

// ── 4. 导出端按 dataB64 重建逐像素 mask，缺失时退回全白矩形 ──────────────────
const builder = read('src/exporter/psd-builder.ts');
must(
  /gm\.dataB64 \? base64ToUint8Array\(gm\.dataB64\) : null/.test(builder),
  'exporter/psd-builder.ts: group mask must decode dataB64 when present',
);
must(
  /const v = useGray \? gray!\[i\] : 255;/.test(builder),
  'exporter/psd-builder.ts: group mask must fall back to an all-white rect without dataB64',
);

console.log('self-check-group-mask-alpha OK');
