---
name: psd-brightness-contrast-uselegacy
description: "PS 亮度/对比度调整图层 useLegacy=false 须用端点保护曲线烘焙,旧版线性公式会削平亮部致发糊"
metadata: 
  node_type: memory
  type: project
  originSessionId: b95b50ee-a27d-42b5-99ab-a62c2feda8a3
---

PS「亮度/对比度」调整图层有两套算法,由 `adjustment.useLegacy` 区分。CS3+ 默认 `useLegacy:false`(新版)。

**Why:** 旧版线性公式 `v = (v+brightness-128)*factor+128` 对集中在中高调的图像(如金属高光的 coin,亮度 mean≈158)会把亮部大面积 clip 到 255 —— 实测 brightness=17 时 23.6% 通道被削平,丢层次,视觉发白发糊。

**How to apply:**
- `applyBrightnessContrast`(psd-parser.ts ~117)按 `useLegacy` 分流 brightness:
  - `useLegacy=true`:`v + brightness`(线性平移,旧版)。
  - `useLegacy=false`:向端点收敛 —— `brightness>=0` 用 `v + (255-v)*(b/255)`(255 端不动,亮部提升递减),`brightness<0` 用 `v + v*(b/255)`(0 端不动)。实测 clip 从 23.6% 降到 1.3%,中调提升对等(128→137)。
- contrast 暂统一用 legacy 绕 128 缩放(contrast=0 时 factor=1 无影响);若遇 useLegacy=false 且 contrast≠0 再细分。
- 这是平台无关的像素烘焙逻辑,Figma/MasterGo 共用同一 parser,改一处两端生效。
- **导出端不需要改**:coin 用 `rawPsdOriginalImage`(烘焙前原始像素)+ 把原始调整图层(含完整 `adjustment` 对象,带 useLegacy)作为 clipping 层加回 PSD(psd-builder ~1152),PS 重开时用它自己的新版算法重算 → round-trip 无损。烘焙仅影响画布显示。

注意:node 环境下 parser 的 imageData 编码不产出(images count=0、imageIndex=undefined),无法在 node 验证烘焙像素;算法正确性靠纯像素数值测试验证。
