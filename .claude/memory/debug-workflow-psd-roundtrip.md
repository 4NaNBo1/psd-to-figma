---
name: debug-workflow-psd-roundtrip
description: 排查 PSD 导入/还原效果不对时的三级数据驱动调试流程
metadata:
  type: feedback
---

用户授权:遇到「导入效果不对」或「还原(round-trip)效果不对」的问题时,按以下优先级主动排查,不要凭猜测改代码。

**三级排查手段(优先级从高到低):**

1. **MasterGo MCP 直接读节点状态** — 用 `get_selection_code` / `get_selection_image` 拿当前画布选中节点的实际代码/渲染图,对照预期定位差异。
2. **MCP 拿不到所需信息时,加插桩日志** — 按 [[CLAUDE.md 第 3 节]] 的跨线程日志协作模式插桩(UI iframe 直接 `fetch`;插件主线程 code/renderer 走 `onLog`/`sendLog` 中继;纯同步代码 builder 用 `(globalThis as any).__debugXxx` 全局变量中转),用户把日志贴回来。
3. **用户提供原始 PSD + 导出后 PSD 路径** — 自己用解析器提取 IR 数据,解析两边节点状态做差异比对。

**Why:** 项目约束(CLAUDE.md 2.1「PSD 导入问题调试」)明确禁止凭猜测或口述改代码,必须数据驱动;用户已主动授权我用上述三种手段获取真实数据。

**How to apply:** 用户描述某个现象不对时,先选最高可行的手段拿真实数据,再定位根因。修复时同时检查 [[platform 双平台同步]](Figma + MasterGo 两侧)与 round-trip 导出对称性(CLAUDE.md 第 4、5 节)。相关坑参见 [[mastergo-effect-visible-false]]、[[psd-text-rasterize-companion-rect]]、[[psd-export-layer-geometry-relative-coords]] 等。
