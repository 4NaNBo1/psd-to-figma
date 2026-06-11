---
name: psd-export-layer-geometry-relative-coords
description: 导出端 parentClipRect 视口裁剪会改写 layerLeft；挂在层上的几何(layer mask 等)须用相对层 bbox 偏移、导出时叠加 layerLeft 还原，不能用文档绝对坐标
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4226603a-0f99-4ca2-97f0-9ae34784f70c
---

`src/exporter/psd-builder.ts` 的 `buildLayer` 里，当层处于带 clip rect 的父级（如组的矩形 mask / 滚动视口）内、且 canvas 超出 clip rect 时，`parentClipRect` 分支会裁剪 canvas 并**改写 `layerLeft`/`layerTop` → `newLeft`/`newTop`**（约 643-704 行）。此外 `layerLeft = Math.round(node.x)` 本身也可能因平台坐标往返产生 ±1 舍入偏差。

因此：**任何要挂回 PSD 层上的几何（layer mask 的 left/top/right/bottom 等），若用「文档绝对坐标」会与裁剪/舍入后的 canvas 相对错位。** 正确做法是 parser 序列化时把几何存成「相对层 bbox 左上的偏移」（`mask.left - bounds.left`），导出端用「图层最终 `layerLeft` + 偏移」还原绝对位置，使几何始终跟随 canvas 的最终位置。

落地：普通光栅层 layer mask round-trip（parser `serializeAdjustmentMask` 复用于普通层 + 存相对偏移 + 未烘焙 mask 的 `rawLayerMaskImage` 像素；导出 `effectiveImageBase64` 优先用未烘焙像素 + 重建 `layer.mask`，避免 mask 双重裁剪）。带 mask 的层几乎都是 clip group 内 `clipping:true` 的被剪贴层——已验证 ag-psd 支持 clipping+mask 共存。

注意调整层 mask（`adj.mask`，1150 行附近）用的是绝对坐标，因为调整层 bbox 是 [0,0,0,0]、不经 parentClipRect 裁剪，是特例；普通层不要照抄绝对坐标。相关坑见 [[agpsd-group-bevel-program-error]]、[[mastergo-effect-visible-false]]。
