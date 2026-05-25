# PSD to Figma / MasterGo

> 🌐 English documentation: [README.md](./README.md)

一个在 **Figma** 或 **MasterGo** 中双向打通 PSD 文件的插件：既可以将 `.psd` 作为可编辑图层导入，也可以将当前画布选中的节点导出为 `.psd`。

[使用说明](#使用说明) · [导出 PSD](#导出-psd) · [开发说明](#开发说明)

## 功能特性

- 将 `.psd` 文件解析为原生可编辑图层，支持**一次导入多个 PSD**
- 把画布选中的节点反向导出为可在 Photoshop 中打开的 `.psd` 文件
- 同时支持 **Figma** 和 **MasterGo** 两个设计平台
- 保留图层层级、文字样式、图层效果与混合模式；PSD 往返时尽量保留原稿的位置 / 字体 / 矢量等元数据
- 完全在插件内部运行，不发起任何外部网络请求

## 使用说明

### 下载插件

前往 [Releases 页面](https://github.com/4NaNBo1/psd-to-figma/releases/latest) 下载最新版本的插件包。

> 也可以直接打开：<https://github.com/4NaNBo1/psd-to-figma/releases>

### 安装到 Figma

1. 解压下载的压缩包到本地任意目录。
2. 打开 [Figma 桌面客户端](https://www.figma.com/downloads/)（Web 版本不支持本地插件导入）。
3. 在菜单栏选择 **Plugins → Development → Import plugin from manifest...**。
4. 选择解压目录中的 `manifest.json` 文件，完成导入。

### 安装到 MasterGo

1. 解压下载的压缩包到本地任意目录。
2. 打开 [MasterGo 桌面客户端](https://mastergo.com/resource)。
3. 在菜单栏选择 **插件 → 开发模式 → 导入插件（manifest.json）**。
4. 选择解压目录中的 `manifest.mastergo.json` 文件，完成导入。

### 使用插件

1. 在 Figma 或 MasterGo 中打开任意一个设计文件。
2. 通过插件菜单启动 **PSD Importer** 插件。
3. 插件界面包含两个标签页：
   - **导入 PSD**：点击或拖拽一个或多个 `.psd` 文件到上传区，解析后作为可编辑图层插入当前画布。
   - **导出 PSD**：将当前选中的节点导出为 `.psd` 文件并直接下载到本地（详见下一节）。

> 批量导入时，多个 PSD 的根节点会在画布上**水平依次排开**（间距 100px），进度文案会显示 `[i/N]`，整批结束后会统一聚焦到导入区域。批次进行中也可以继续追加新文件，不必等当前一批完成。

## 导出 PSD

插件可以把 Figma / MasterGo 画布中的节点反向打包为 `.psd` 文件，方便交付给使用 Photoshop 的同事。

### 操作流程

1. 在画布中选中一个或多个要导出的节点（可以是单个图层，也可以是整个 Frame / 编组）。
2. 在插件界面切换到 **导出 PSD** 标签页。
3. 修改输出文件名（默认会基于选中节点名生成）。
4. 点击 **导出 PSD**，等待进度条走完后，浏览器会自动将 `.psd` 文件下载到本地。

> 整个过程完全在插件内运行，不会上传任何节点数据到外部服务器。

### 支持的内容

导出时会尽可能保留以下信息，使生成的 PSD 在 Photoshop 中接近原始外观：

- **图层层级**：Frame / Group / Component 会输出为 PSD 的图层组，保持嵌套结构与展开状态。
- **基础属性**：位置、尺寸、不透明度、可见性、混合模式（涵盖 Normal / Multiply / Screen / Overlay 等全部 PS 支持的模式）。
- **文字图层**：保留文案、字体、字号、字色、字间距、行高、对齐方式；多段样式会输出为 PSD 的 `styleRuns`，区分点文本（Point Text）与段落文本（Box Text）；文本支持**多重描边叠加**。
- **图层效果**：投影、内阴影、外发光 / 内发光、斜面与浮雕、绸缎、纯色叠加、图案叠加、渐变叠加（线性 / 径向 / 角度 / 反射 / 菱形）、描边（inside / center / outside 对齐）。
  - 形状受平台单节点限制只渲染第一条描边并给出告警。
  - Inner Shadow / Glow / Bevel / Satin / Pattern Overlay 等无法直接映射为设计平台原生属性的效果，会被烘焙到位图中。
- **位图内容**：矩形 / 椭圆 / 向量 / 布尔运算等矢量节点会栅格化为 PNG 作为图层位图；带图片填充的矩形会直接导出图片内容。
- **智能对象**：Instance（实例）会作为 PSD 的 `placedLayer`（智能对象）输出，便于在 Photoshop 中替换或非破坏性编辑。
- **剪贴蒙版**：被标记为 mask 的节点会以 PSD 的 `clipping` 标志输出，保留遮罩关系。
- **PSD 往返**：若节点是通过本插件从 PSD 导入而来，导出时会自动复用原始 PSD 的 `engineData`、变换 / 矢量 / 效果元数据，让 Photoshop 重新打开时文字定位、字体度量与矢量信息更接近原稿。

### 已知限制

- **矢量栅格化**：矢量、椭圆、布尔运算等会导出为位图而非 PS 的形状图层，不再可编辑为路径。
- **描边类型**：仅 `SOLID` 颜色描边会被导出，渐变 / 图片描边会被忽略。
- **图片尺寸上限**：单个节点导出的位图最长边为 4096px，超过会自动等比缩小。
- **导出超时**：单个节点的 `exportAsync` 上限为 15 秒，超时的节点会跳过位图导出但保留结构与样式信息。
- **嵌套深度**：超过 50 层嵌套的子节点会被跳过，并在日志中给出告警。
- **CMYK / 通道**：所有内容按 RGB 8-bit 写出，PSD 中的 alpha 通道、专色通道等不会被生成。

## 开发说明

仅在你需要从源码本地构建时使用。普通用户从 [Releases](https://github.com/4NaNBo1/psd-to-figma/releases/latest) 下载即可。

```bash
npm install        # 安装依赖（需要 Node.js >= 18）
npm run build      # 构建一次
npm run watch      # 监听文件变化
```

构建产物位于 `dist/` 目录，包含 `manifest.json`（Figma）与 `manifest.mastergo.json`（MasterGo）。

> 插件采用 IR（中间表示）架构：`parser → IR → platform renderer` 用于导入，`node-serializer → psd-builder` 用于导出。新增设计平台只需在 `src/platform/` 下实现 `PlatformRenderer` 接口。

## License

MIT
