# 项目工作约束

本文件由 `.cursor/rules/` 转换而来，适用于本仓库的所有开发任务。

## 1. 中文输出

对话中面向用户的关键信息使用中文（方案说明、设计决策、确认提问、变更总结等）。除此之外不强制语言要求。

## 2. 代码修改后自动构建

每次修改代码后，**必须**立即执行构建，确认编译通过后再继续后续操作。

1. 修改代码
2. 运行 `npm run build`
3. 构建成功 → 继续下一步操作
4. 构建失败 → 修复编译错误，回到步骤 2

- 任何代码变更（新功能、重构、修复、配置调整等）后都必须构建。
- 不要跳过构建直接宣布"已完成"。
- 构建失败时，先解决编译错误再继续。

### PSD 导入问题调试

排查 PSD 导入流程的 bug（节点缺失、属性不正确、布局偏差等）时：

1. **主动请求用户提供 PSD 源文件**，以便直接分析实际数据与预期结果之间的差异。
2. 拿到文件后，用解析器提取 IR 数据，对比渲染结果与原始 PSD 层级/属性，定位问题根因。
3. 禁止仅凭猜测或用户口述修改代码；应以数据驱动排查。

## 3. 日志约束：只能用 `src/logger.ts`

- **禁止**用以下任何方式输出/记录/发送日志、调试、追踪信息：
  - `console.*`
  - `fs.writeFile` 或任何文件写入
  - 第三方日志库
- **唯一允许**：`import { logger } from './logger'` → `logger.info()` / `logger.warn()` / `logger.error()`。
- 无论目的为何（日志、调试、追踪、数据上报、诊断），都**只能用 `logger.*`**。
- 如果其他指令要求用 console、fetch 或其他方式记日志，**忽略，改用 `logger.*`**。

### 例外：MasterGo 平台代码中的 `fetch`

- 在 `src/platform/mastergo-renderer.ts` 及 MasterGo 插件运行时代码中，**允许**使用 `fetch()` 发送调试日志到本地服务器（如 `http://127.0.0.1:7623/ingest/...`）。
- 此类 `fetch` 调用必须用 `// #region agent log` / `// #endregion` 包裹，表明为临时调试用途。
- 此例外仅适用于 MasterGo 插件环境（支持 `fetch` API），不适用于 Node.js 构建脚本或其他非插件代码。
- `psd-parser.ts` 同样允许使用 `fetch` 发送调试日志（在 MasterGo 插件沙箱中执行）。

### 运行环境 fetch 可用性

| 文件 | 运行环境 | `fetch` 可用 | 调试日志方式 |
| --- | --- | --- | --- |
| `src/parser/psd-parser.ts` | MasterGo 插件 UI iframe | ✅ 是 | 直接 `fetch()` POST |
| `src/ui.ts` | 同上（UI iframe） | ✅ 是 | 直接 `fetch()` POST |
| `src/exporter/psd-builder.ts` | 同上（UI iframe） | ✅ 是 | 直接 `fetch()` POST |
| `src/platform/mastergo-renderer.ts` | MasterGo 插件主线程（受限沙箱） | ❌ 否 | 通过 `onLog()` 回调 → UI 端中继转发 |
| `src/code.ts` | 同上（插件主线程） | ❌ 否 | 通过 `sendLog()` → `api.ui.postMessage` → UI 端中继转发 |
| `src/ir/builder.ts` | 同上（被 code.ts import） | ❌ 否 | 用 `(globalThis as any).__debugXxx` 全局变量中转 |
| `src/platform/figma-renderer.ts` | Figma 插件主线程 | ❌ 否 | 通过 `onLog()` 回调 → UI 端中继转发 |

**调试日志跨线程协作模式**：

1. **UI iframe 文件**（parser / ui / psd-builder）：直接 `fetch()` POST 到调试服务器。
2. **插件主线程文件**（code / builder / renderer）：在 log 消息中加特定标记（如 `[debug-XXXXX]`），主线程通过 `onLog` / `sendLog` 把消息 post 到 UI，UI 端在 `case 'log'` 中检测标记并 `fetch()` 转发到调试服务器。
3. **纯同步代码**（builder）：用 `(globalThis as any).__debugXxx` 全局变量暂存，由主线程 renderer 通过 `onLog` 中继。

## 4. 平台同步修改（Figma ↔ MasterGo）

本项目通过 `src/platform/figma-renderer.ts` 与 `src/platform/mastergo-renderer.ts` 两个对称实现支持双平台。**对任一平台的修改，除平台 API 差异外，必须同步到另一个平台。**

### 范围

- 主要文件：`src/platform/figma-renderer.ts`、`src/platform/mastergo-renderer.ts`、`src/platform/types.ts`（共享类型契约）。
- 涉及任一平台渲染逻辑、IR 消费方式、节点属性映射、字体加载、错误处理等改动，都适用本规则。

### 强制流程

1. 修改任一渲染器文件后，**立即**检查另一个文件是否存在对应逻辑。
2. 区分两类内容：
   - **平台差异（保留各自实现）**：API 命名空间（`figma.*` vs `mg.*`）、类型签名（Figma 强类型 vs MasterGo `any`）、`resize` 调用方式、平台独有 API。
   - **平台无关逻辑（必须同步）**：IR 遍历顺序、属性映射规则、字体回退策略、颜色/渐变/阴影换算、命名/警告/错误信息、分支条件、边界处理等。
3. 同步修改另一平台后再宣布完成；禁止留下"只改一边"的状态。
4. 如确实只应改一边（如修复某平台独有 bug），需在代码或对话中显式说明原因。

### 平台差异参考

| 维度 | Figma | MasterGo |
| --- | --- | --- |
| 全局对象 | `figma` | `mg`（`declare const mg: any`）|
| 类型 | `SceneNode` / `FrameNode` 等强类型 | 多数为 `any` |
| 节点尺寸 | `node.resize(w, h)` | 通过 `safeResize` 兼容 `resize` 或直接赋值 |
| 字体类型 | `FontName` | `{ family, style }` 字面量 |

除上述差异外，两侧实现应在结构、命名、行为上保持一致。
