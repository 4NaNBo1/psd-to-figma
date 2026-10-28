/**
 * ponytail: 断言 Figma 渲染器不会把 ImagePaint.scaleMode 透传成非法枚举。
 *
 * 背景：IR 的 'STRETCH'（PNG 尺寸 == 图层 bbox 时由 ir/builder.ts 标记）是 MasterGo 的能力，
 * Figma 的 ImagePaint.scaleMode 只接受 'FILL' | 'FIT' | 'CROP' | 'TILE'。一旦透传 'STRETCH'，
 * 平台会拒绝该 paint，整层图片填充失效（画布上只剩灰色空块）。
 *
 * 该脚本：(1) 校验渲染器里的降级映射；(2) 扫描构建产物，确保非法枚举没有漏出去。
 * 用法：npm run build && node scripts/self-check-scale-mode.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Figma ImagePaint.scaleMode 的合法取值，见 @figma/plugin-typings 的 ImagePaint 定义。 */
const FIGMA_LEGAL_SCALE_MODES = ['FILL', 'FIT', 'CROP', 'TILE'];

// ── 1. 渲染器里的降级映射 ────────────────────────────────────────────────
const rendererPath = resolve(root, 'src/platform/figma-renderer.ts');
const rendererSrc = readFileSync(rendererPath, 'utf8');

const allowListMatch = rendererSrc.match(/FIGMA_IMAGE_SCALE_MODES\s*=\s*\[([^\]]*)\]/);
if (!allowListMatch) {
  throw new Error('figma-renderer.ts: FIGMA_IMAGE_SCALE_MODES allow-list not found');
}
const allowList = [...allowListMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const unexpected = allowList.filter((m) => !FIGMA_LEGAL_SCALE_MODES.includes(m));
if (unexpected.length > 0) {
  throw new Error(`figma-renderer.ts: allow-list contains non-Figma scaleMode(s): ${unexpected.join(', ')}`);
}
if (allowList.length !== FIGMA_LEGAL_SCALE_MODES.length) {
  throw new Error(`figma-renderer.ts: allow-list must be exactly ${FIGMA_LEGAL_SCALE_MODES.join(' | ')}`);
}

// IMAGE fill 必须经过降级映射，而不是直接把 IR 的 scaleMode 塞进 paint。
if (!/type:\s*'IMAGE'[\s\S]{0,200}?scaleMode:\s*toFigmaScaleMode\(fill\.scaleMode/.test(rendererSrc)) {
  throw new Error('figma-renderer.ts: IMAGE paint must map scaleMode via toFigmaScaleMode()');
}

// 模拟降级：非法枚举（含 'STRETCH' 触发路径）必须落到 Figma 合法枚举内。
const mapScaleMode = (mode) => (FIGMA_LEGAL_SCALE_MODES.includes(mode) ? mode : 'FILL');
for (const input of ['STRETCH', 'FILL', 'FIT', 'CROP', 'TILE']) {
  const out = mapScaleMode(input);
  if (!FIGMA_LEGAL_SCALE_MODES.includes(out)) {
    throw new Error(`scaleMode "${input}" maps to illegal "${out}"`);
  }
}
if (mapScaleMode('STRETCH') !== 'FILL') {
  throw new Error('STRETCH must downgrade to FILL on Figma');
}

// ── 2. 构建产物不放过非法枚举 ──────────────────────────────────────────
const bundlePath = resolve(root, 'dist/code.js');
if (!existsSync(bundlePath)) {
  throw new Error('dist/code.js not found; run `npm run build` first');
}
const bundle = readFileSync(bundlePath, 'utf8');

const passedThrough = [...bundle.matchAll(/scaleMode:\s*"([A-Z_]+)"/g)]
  .map((m) => m[1])
  .filter((m) => !FIGMA_LEGAL_SCALE_MODES.includes(m));
if (passedThrough.length > 0) {
  throw new Error(`dist/code.js passes through illegal scaleMode(s): ${[...new Set(passedThrough)].join(', ')}`);
}
if (/scaleMode:\s*"STRETCH"/.test(bundle)) {
  throw new Error('dist/code.js still contains scaleMode:"STRETCH" for Figma');
}

console.log('self-check-scale-mode OK');
