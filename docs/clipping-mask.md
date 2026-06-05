# PSD 剪贴蒙版（clipping mask）在 Figma / MasterGo 的渲染

## 背景

PSD 剪贴蒙版（`layer.clipping = true`）的语义：被剪贴层只显示落在**基底层 alpha 形状**内的部分，且**基底层自身也显示**。

在 Figma / MasterGo 中，用单个节点设 `isMask` 无法同时满足这两点——两种蒙版模式各有一个失败面，且不可兼得：

| 蒙版模式 | MasterGo | Figma | mask 自身是否显示 | 裁剪形状 |
| --- | --- | --- | --- | --- |
| alpha 蒙版 | `isMaskOutline=false` | `maskType='ALPHA'` | ❌ 不显示（只贡献 alpha 通道） | ✅ 图片 alpha 形状（保留圆角等不规则形状） |
| 轮廓蒙版 | `isMaskOutline=true` | `maskType='VECTOR'` | ✅ 显示 | ❌ 节点矩形（含 cornerRadii），丢失图片 alpha 的不规则形状 |

典型反例（来自 `新手礼包商城轮播图.psd`，含多个 clip group）：

- **`矩形 1 拷贝 8`**：基底是实心 `#ffffe7` 矩形底，需要自身颜色显示。单节点 alpha 蒙版下底色消失。
- **`...1024_512 拷贝`**：基底是圆角卡片图，被剪贴的是满覆盖背景，需要按 alpha 圆角形状裁剪。单节点轮廓蒙版下圆角丢失、被裁成矩形。

诊断时发现：两组 mask 节点属性完全相同（`isMask=true / fills=1:IMAGE`）却表现不同，正是因为它们对蒙版模式的诉求相反。

## 解法：双节点拆分显示与裁剪

`buildChildrenWithClipping`（[src/ir/builder.ts](../src/ir/builder.ts)）把每个 clip group 生成为：

```
clip group (frame, clipsContent=false)
├── baseDisplay        ← 基底副本，正常显示，承载颜色/效果（保证 #ffffe7 这类底色可见）
├── baseMask (isMask)  ← 基底副本，作 alpha 蒙版，按图片 alpha 形状裁剪后续被剪贴层
└── 被剪贴层...          ← 被 baseMask 裁剪（蒙版只裁排在其后的兄弟）
```

- `baseMask` 剥离 effects/strokes，仅保留 fill 以提供 alpha 形状。
- 显示职责给 `baseDisplay`、裁剪职责给 `baseMask`，二者解耦，因此不再依赖「mask 自身是否显示」这一平台行为。

IR 通过 `IRNode.isMask` 字段（[src/ir/types.ts](../src/ir/types.ts)）标记 `baseMask`，两个 renderer 对称消费：

- **MasterGo**（[src/platform/mastergo-renderer.ts](../src/platform/mastergo-renderer.ts)）：`isMask=true, isMaskOutline=false, isMaskVisible=false`（alpha 形状裁剪，自身不显示——显示由 baseDisplay 负责）。
- **Figma**（[src/platform/figma-renderer.ts](../src/platform/figma-renderer.ts)）：`isMask=true, maskType='ALPHA'`。

平台同步说明（遵循 [CLAUDE.md](../CLAUDE.md) §4）：双节点结构、alpha 蒙版裁剪是平台无关逻辑，两侧一致；`isMaskOutline/isMaskVisible`（MasterGo）与 `maskType`（Figma）是平台 API 差异，各自实现等价语义。

## 已知限制

- **导出回 PSD（round-trip）未处理**：`baseDisplay + baseMask` 双节点结构还原成 PSD clipping 链尚未实现。当前导出会把它们当普通节点。需要往返保真时另做。
- 每个 clip group 会多出一个 `xxx (mask)` 节点，是分离显示/裁剪职责的代价。

## 调试入口

排查 clip group 渲染问题时，先判断现象属于哪个失败面：
- 「基底自身没显示」→ 用了 alpha 蒙版但缺 baseDisplay；
- 「裁剪形状不对（矩形 vs 圆角）」→ 用了轮廓蒙版。

验证素材：`新手礼包商城轮播图.psd`（含 `矩形 1 拷贝 8`、`...1024_512 拷贝`、`side`、`矩形 859 拷贝`、`shop_ribbon_red` 等多个 clip group）。
