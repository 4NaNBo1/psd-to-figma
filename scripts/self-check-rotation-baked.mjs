/**
 * ponytail: 断言「旋转已烘焙进栅格像素」的层不会被渲染器再转一次（双重旋转）。
 *
 * 背景：PSD 的 channel 栅格像素本身已是旋转后的结果（文本层与带栅格的矢量 shape 层）。
 * 若渲染器再按 rotation 转一次，视觉上会双重旋转（旋转文本与方形图标会歪成菱形）。
 * 约定：IR 层用 `rotationBaked` 标记这类层；旋转角仍保留在 IR 里供导出端写回 PSD transform。
 *
 * 该脚本扫描源码，确保：
 *   (1) parser 不再把带栅格像素的 vectorFill 写成 overlayFills（会被叠在 IMAGE 之上盖住整层）；
 *   (2) builder 会设置 rotationBaked；
 *   (3) Figma / MasterGo 两个渲染器都按 rotationBaked 跳过旋转赋值。
 * 用法：node scripts/self-check-rotation-baked.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── 1. parser：vectorFill 只在「无栅格像素」时兜底为 overlayFills ──────────────
const parser = read('src/parser/psd-parser.ts');
const vectorFillBlock = parser.match(/const vectorRaw = serializeRawVectorData\(layer\);[\s\S]*?\n  \}\n/);
must(vectorFillBlock, 'psd-parser.ts: vectorRaw block not found');
must(
  /hasRasterPixels[\s\S]{0,200}?if \(!hasRasterPixels\)/.test(vectorFillBlock[0]),
  'psd-parser.ts: vectorFill must only become overlayFills when the layer has no raster pixels',
);

// ── 2. builder：textRasterized 与带栅格的 shape 层都要标记 rotationBaked ────────
const builder = read('src/ir/builder.ts');
must(
  /rotationBaked:\s*textProps\?\.rotation[\s\S]{0,120}?rasterFills\.some/.test(builder),
  'ir/builder.ts: rasterized text node must set rotationBaked from rotation + IMAGE fill',
);
must(
  /rotation:\s*layer\.shapeRotation,[\s\S]{0,200}?rotationBaked:\s*layer\.shapeRotation[\s\S]{0,80}?fills\.some/.test(builder),
  'ir/builder.ts: rasterized rotated shape node must set rotationBaked',
);

// ── 3. 两个渲染器：rotationBaked 时跳过旋转赋值 ───────────────────────────────
for (const [file, negate] of [
  ['src/platform/figma-renderer.ts', '!irNode.rotationBaked'],
  ['src/platform/mastergo-renderer.ts', '!irNode.rotationBaked'],
]) {
  const src = read(file);
  // 文本/companion 分支：tp.rotation 的旋转赋值必须包在 !irNode.rotationBaked 里。
  const textGuard = src.match(/if \(tp\.rotation\) \{[\s\S]{0,600}?\n {4,8}\}/g) || [];
  must(
    textGuard.some((b) => b.includes(negate)),
    `${file}: rasterized text/companion rotation must be guarded by ${negate}`,
  );
  must(
    /irNode\.rotation != null[\s\S]{0,120}?&& !irNode\.rotationBaked/.test(src),
    `${file}: shape rect rotation must be guarded by !irNode.rotationBaked`,
  );
}

// ── 4. Figma 端补齐 psd_transform_rotation（与 MasterGo 对齐，供导出还原） ──────
must(
  /setPluginData\('psd_transform_rotation'/.test(read('src/platform/figma-renderer.ts')),
  'figma-renderer.ts: must persist psd_transform_rotation for round-trip',
);

console.log('self-check-rotation-baked OK');
