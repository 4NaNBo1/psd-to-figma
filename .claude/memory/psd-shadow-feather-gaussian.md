---
name: psd-shadow-feather-gaussian
description: "投影/发光羽化用 3-pass box 近似 PS 高斯,每-pass 半径须=blur·0.55 否则辉光过窄像硬描边"
metadata: 
  node_type: memory
  type: project
  originSessionId: b95b50ee-a27d-42b5-99ab-a62c2feda8a3
---

PS 投影/发光的羽化是高斯模糊,本项目在 `compositeLayerEffects`(psd-parser.ts)用 3-pass box blur 近似。

**Why:** 旧实现每 pass 半径 = blur/3,3-pass 等效高斯 σ≈blur/3 —— 远小于 PS 的 size,辉光过窄、紧贴边缘像实色硬描边(典型:低阶猪猪 拷贝 的多层同心 spread dropShadow 黄色辉光被压成硬边)。低阶猪猪真实 alpha 实测,每 pass 半径 = blur·0.55 时辉光宽度/柔和度与 PS 吻合。

**How to apply:**
- 统一用 `featherAlpha(alpha,w,h,blurRadius)` 做羽化(封装 3-pass + 系数 `SHADOW_BLUR_PASS_FACTOR=0.55`、`SHADOW_BLUR_PASSES=3`),替换 dropShadow/outerGlow/innerShadow/innerGlow 4 处手写 pass 循环。
- `computeShadowExpansion` 的 reach 须按羽化实际可达半径估:`blur·0.55·3 + spread + offset`,否则辉光外圈被画布 expand 边界截断铺不开。
- `blur=0` 时 featherAlpha 直接返回(choke=100 的实色硬边阴影如 Piggy Pop 橙边不受影响)。
- 平台无关:compositeLayerEffects 在 parser(UI iframe),Figma/MasterGo 共用,改一处两端生效。导出端不需改(只写 size/choke 参数,PS 用自己高斯渲染)。
- 注意:多层同心 spread dropShadow 须**倒序** blendColorOnto(列表首个=视觉最上,见 [[psd-text-rasterize-companion-rect]] 同款问题)。

待验证:用户实测低阶猪猪辉光是否变宽变柔贴近 PS;Image #1 曾比 node 复现更硬,需排除 MasterGo image fill 渲染端是否还有额外削边。
