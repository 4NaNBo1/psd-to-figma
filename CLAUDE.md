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

### 反例（两侧字体回退分支不一致，禁止）

```typescript
async function loadBestFont(...) {
  const direct = await tryLoadFont(rawFamily, rawStyle);
  if (direct) return direct;
  if (rawStyle !== 'Bold') {
  }
  ...
}
```

```typescript
async function loadBestFont(...) {
  const direct = await tryLoadFont(rawFamily, rawStyle);
  if (direct) return direct;
  if (rawStyle !== 'Regular') {
  }
  ...
}
```

### 正例

两侧 `loadBestFont` 的回退分支、警告文案、调用顺序完全一致，仅 `figma.loadFontAsync` 与 `mg.loadFontAsync` 不同。

## 5. 导入 ↔ 导出对称性（round-trip 保真）

PSD 导入（PSD → IR → 平台节点）与导出（平台节点 → IR → PSD）是一对互逆流程。**新增或修改任一节点/属性的导入处理时，必须同步设计并实现对应的导出处理方案，确保数据能尽量无损地往返（round-trip）。**

### 强制流程

处理某种 PSD 节点或属性的导入时，必须同时回答并落实"如何导出还原"：

1. **平台直接支持** → 导出时按平台 API 正常读取并写回 PSD。两侧（Figma / MasterGo）的导入与导出映射都要实现，且遵循[第 4 节](#4-平台同步修改figma--mastergo)的平台同步约束。
2. **平台不直接支持，但有替代方案** → 用替代方案在平台中表达（如：不支持的混合模式用近似模式、不支持的滤镜用栅格化图层、不支持的形状用矢量路径等）。**替代方案必须可逆**：导出时能识别该替代表达并还原回原始 PSD 结构/属性。
3. **平台不支持且无可逆替代方案** → **存储原始 PSD 数据**（原始字节 / 解析出的原始属性），挂在对应节点上（如 plugin data / IR 的原始数据字段）。导出时优先使用存储的原始数据还原，保证该节点不丢失信息。

### 落实要求

- 不允许出现"只做了导入、没做导出"或"导出后该属性丢失"的半成品状态。
- 选择替代方案时，必须在代码或对话中说明：替代方案是什么、导出如何识别并还原。
- 选择存储原始 PSD 数据时，必须明确：存什么、存在哪里、导出时如何取用还原。
- 涉及平台节点的方案，导入与导出两侧、Figma 与 MasterGo 两个平台都要覆盖。

### 决策优先级

平台原生支持 > 可逆替代方案 > 存储原始 PSD 数据兜底。能用更高优先级的方案就不退到下一级。

## 6. Git 提交信息

提交信息**只保留一行英文简介**（Conventional Commits 风格，如 `feat: ...` / `fix: ...`），不要写多行正文、变更清单、中文说明等额外内容。

- 详细的方案说明、变更细节放在对话或 `docs/` 中，不进提交信息正文。
- 不在提交信息里附加 `Co-Authored-By` 等尾注。

## 7. Git 版本 Tag 与 README

每次为仓库**新增**语义化版本 tag（如 `v1.6.1`）时，**必须**同步更新 `README.md` 的发布说明，再执行 `git tag`。

### 强制流程

1. 用 `git log <上一 tag>..HEAD --oneline` 梳理自上一版本以来的变更。
2. 更新 `README.md`：
   - 将文首 **当前版本** 改为新 tag（如 ``当前版本：`v1.6.1` ``）。
   - 在 **更新历史** 章节**最上方**新增 `### vX.Y.Z` 小节（新版本在前、旧版本在后）。
   - 用中文 bullet 概括用户可感知的变更（功能、修复、限制），不要只粘贴 commit message。
3. 提交 README（及必要的规则/文档）变更后，再打 tag：`git tag vX.Y.Z`（附注 tag 可选，须与版本号一致）。
4. 禁止只打 tag 不更新 README；禁止 README 版本号与最新 tag 不一致。

### 格式参考

```markdown
### v1.6.1

- 简要说明第一项变更。
- 简要说明第二项变更。
```
