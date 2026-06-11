---
name: mastergo-effect-visible-false
description: MasterGo 不严格尊重 effect 的 visible:false，禁用阴影/效果不能靠 visible 屏蔽，必须不进 IR
metadata: 
  node_type: memory
  type: project
  originSessionId: 2b325dc0-865c-4174-b7ca-a85f23fc103b
---

MasterGo 渲染端（`src/platform/mastergo-renderer.ts` 的 `applyEffects`）对 effect 的 `visible: false` **不可靠** —— PS 中被禁用（眼睛关闭）的内阴影若以 `visible:false` 下发给 MasterGo，仍会被显示出来。Figma 强类型 effect 则严格遵守 `visible`。

**Why:** PSD 中 PS 里手动关闭的阴影解析为 `enabled: false, present: true`（`ag-psd`）。`src/converter/effect-converter.ts` 的 `convertShadow` 旧判断 `if (!shadow.enabled && shadow.present !== true) return null` 会把这类项保留为 `visible:false` 进 IR，导致 MasterGo 误显示。typical 案例：`新手礼包商城轮播图.psd` 的 `shop_ribbon_red`。

**How to apply:** 禁用的阴影/效果应在转换层（`effect-converter.ts`）**直接 return null，根本不进 IR**，不要依赖 `visible:false` 在渲染端屏蔽。判定只看 `shadow.enabled`，不要再用 `present`。这样不损害 round-trip：导出端 `src/exporter/psd-builder.ts` 本就按 `&& e.visible` 过滤禁用项，原始 effects 由 plugin data 还原。整组样式禁用（`effects.disabled === true`）已由 `convertEffects` 顶部拦截，与单个效果禁用是两条不同路径。
