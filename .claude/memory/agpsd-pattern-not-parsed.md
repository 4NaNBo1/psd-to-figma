---
name: agpsd-pattern-not-parsed
description: ag-psd 默认不解析 PSD pattern 资源(Patt 块)，patternOverlay 拿不到像素，需 patch 启用
metadata: 
  node_type: memory
  type: project
  originSessionId: 2b325dc0-865c-4174-b7ca-a85f23fc103b
---

`ag-psd@30.1.0` 默认**不解析** PSD 全局 pattern 资源表（`Patt` 附加信息块）—— `node_modules/ag-psd/dist/additionalInfo.js` 里非 MOCK 分支的 `Patt` handler 直接 `skipBytes` + `return; // not supported yet`，解析 `readPattern` 的代码被注释掉。结果 `psd.patterns` / `layer.patterns` 恒为 `undefined`，凡是 `patternOverlay`（图案叠加）的图层都拿不到 pattern 像素，纹理完全丢失。

**Why:** 典型案例 `新手礼包商城轮播图.psd` 的 `绒布无缝贴图` 层：`fillOpacity:0` + 满 alpha 实色本体 + `patternOverlay`（`blendMode: soft light`, opacity 1, pattern id `fd183aee...`，512x512 绒布）。导入 MasterGo 后无纹理、隐藏该层也无变化 —— 因为 pattern 从源头没解析出来。

**How to apply:** 已在 `patches/ag-psd+30.1.0.patch` 修复 `Patt` handler：循环 `readPattern(reader)` 填充 `target.patterns`，失败时跳过剩余字节（避免中断整个 PSD 解析）。`readPattern` 本身可用（导出于 psdReader），只是 handler 没调它。

解析出 pattern 后还需把 `psd.patterns` 喂给消费方：`src/parser/psd-parser.ts` 用模块级变量 `globalPsdPatterns`（在 `parsePsdFile` 入口从 `psd.patterns` 设置），`resolvePatternData(id, layer, globalPsdPatterns)` 取用。原先这里第三参传 `undefined`。

相关坑：(1) `fillOpacity:0 + overlay` 时 `compositeLayerEffects` 的 `hasFullCoverageOverlay` 判定要纳入 patternOverlay(opacity>=1)，否则 alpha 被 `*fillOpacity` 抹掉。(2) overlay 的 blendMode：`applyPatternOverlayToPixels` 原本只做 normal，已加 `blendChannel` 支持 soft light/multiply/overlay/screen 等。

**关键语义（踩过坑）：`fillOpacity:0 + patternOverlay` = 「纹理接管」**。PS 中 fillOpacity 让图层本体填充透明，但图层样式不受影响 —— 可见输出**只有 pattern 纹理本身**，且 pattern 以其 blendMode 相对**下层**（而非本体实色）混合。
- ❌ 错误做法：把 pattern 柔光叠到本体实色上再满 alpha 显示 → 输出整块实色底（本案例显示为浅黄 `(255,241,189)` 实色图）。
- ✅ 正确做法（`compositeLayerEffects` 中 `patternTakesOver = fillOpacity<=0.01 && 不透明pattern`）：pattern 用 **normal** 直接写入成为输出 RGB（本案例=灰度绒布纹理），再把 pattern 的 blendMode **提升到节点级**（`serialized.blendMode = convertBlendMode(overlayBlendMode)`），由平台对下层做柔光混合。本案例 bggreen 深绿底 + 灰度纹理 SOFT_LIGHT → 细腻透明质感。

参见 [[mastergo-effect-visible-false]]。
