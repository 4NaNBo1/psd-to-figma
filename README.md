# PSD to Figma / MasterGo

一个在 **Figma** 或 **MasterGo** 中双向打通 PSD 文件的插件：既可以将 `.psd` 作为可编辑图层导入，也可以将当前画布选中的节点导出为 `.psd`。

[使用说明](#使用说明) · [导出 PSD](#导出-psd) · [配合 9-Slice 插件](#配合-9-slice-插件) · [开发说明](#开发说明) · [更新历史](#更新历史)

当前版本：`v1.6.4`

## 功能特性

- 将 `.psd` 文件解析为原生可编辑图层，支持**一次导入多个 PSD**
- 把画布选中的节点反向导出为可在 Photoshop 中打开的 `.psd` 文件
- 同时支持 **Figma** 和 **MasterGo** 两个设计平台
- 保留图层层级、文字样式、图层效果与混合模式；PSD 往返时尽量保留原稿的位置 / 字体 / 矢量等元数据
- 与 [9-Slice 插件](https://github.com/4NaNBo1/9slice/releases) 配合，支持九宫 UI 切图的导入 / 导出往返与元数据保留（详见 [配合 9-Slice 插件](#配合-9-slice-插件)）
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
2. 打开 MasterGo 桌面客户端。
3. 在菜单栏选择 **插件 → 开发者模式 → 创建/添加插件 → 点击或拖动上传（manifest.mastergo.json）文件**。
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

## 配合 9-Slice 插件

UI 切图里常见的九宫缩放（按钮底图、弹窗背景、气泡框等）在 Figma / MasterGo 中没有原生 `border-image` 属性。建议与本仓库配套的 **[9-Slice 插件](https://github.com/4NaNBo1/9slice/releases)** 一起使用：9-Slice 负责在设计工具里生成可缩放的九宫组件，本插件负责 PSD 与画布之间的双向打通，并在往返时保留切片元数据。

> 9-Slice 插件下载：<https://github.com/4NaNBo1/9slice/releases/latest>

### 为什么配合使用效果更好

| 场景 | 只用本插件 | 配合 9-Slice |
| --- | --- | --- |
| 普通位图图层 | 导入 / 导出为单层 PNG，效果正常 | 无额外收益 |
| 需要九宫缩放的 UI 切图 | 导出为 9 个切片矩形时，MasterGo 等平台常只保留 `topLeft` 像素，其余区域透明，PSD 里只剩碎片 | 9-Slice 生成标准九宫组件；本插件导出时**自动折叠回单层**并保留切片参数 |
| PSD ↔ 设计工具往返 | 位图可还原，但切片信息会丢失 | 切片元数据随 PSD 图层名或 plugin data 一并往返，回到设计工具后可被 9-Slice 识别 |

两个插件针对同一套 `nineSliceSettings` 元数据格式协作，避免手工拆图、手工记切片值。

### 配合还原机制

```
PSD 图层（nineSliceSettings 编码于图层名）
  ↓ 导入（本插件）
矩形图层 + nineSliceSettings（sharedPluginData / pluginData）
  ↓ 9-Slice 读取元数据，或用户手动 Create Component
九宫组件（9 个子矩形：topLeft / top / … / bottomRight）
  ↓ 导出（本插件）
折叠为单层位图 + nineSliceSettings → 编码进 PSD 图层名
  ↓ 再次导入
还原 displayName + nineSliceSettings → 9-Slice 可继续编辑
```

**元数据内容**（JSON，`version: 1`）：

- `imageSize`：原图宽高（像素）
- `slices`：`{ top, right, bottom, left }` 四边切片距离

**三条传递通道**（按优先级）：

1. **同文件内 plugin data**：导入 PSD 时，本插件把元数据写入节点的 `nineSliceSettings`，并通过 `sharedPluginData('9slice', …)` 暴露给 9-Slice 读取。
2. **PSD 图层名后缀**：导出 PSD 时，元数据经 Base64URL 编码后附在图层名末尾（以私有区段字符 `\uE000` 分隔，Photoshop 中仍显示正常名称）。再次导入时自动解码并写回 plugin data。这是**跨文件、跨同事**最可靠的通道。
3. **从子节点几何推断**：若 plugin data 因跨插件隔离不可见，本插件会根据 9 个命名子矩形的布局反推 `slices`，并结合组件内存储的原图尺寸补全 `imageSize`。

**导出时的折叠策略**（解决 MasterGo 切片导出透明的问题）：

- 若该九宫组件旁存在**同名的隐藏 PSD 导入原层**（带 `psd_original_image` 等 round-trip 标记），优先用这层导出完整位图并继承 PSD 原始元数据，九宫组件本身不再单独输出。
- 否则从组件的图片填充或 `exportAsync` 读取完整图源，合并为**一个 PSD 图层**，同时附带 `nineSliceSettings`。

### 导入效果较好的做法

1. **从本插件导出的 PSD 再导入**：若导出时成功写入了图层名后缀，导入日志会出现 `restored 9-slice metadata from PSD layer name`，矩形图层会自动带上 `nineSliceSettings`，9-Slice 可直接识别。
2. **从 Photoshop 来的 PSD**：若图层名不含编码后缀，导入后仍得到普通位图；选中该图层，用 9-Slice 手动设置 `Top / Right / Bottom / Left` 并 **Create Component** 即可。
3. **导入后立刻做九宫**：对带图片填充的矩形运行 9-Slice → **Create Component**。组件会出现在原图层右侧（命名形如 `图层名 / 9-Slice`），原图层可保留或隐藏。
4. **不要改子图层名称**：9-Slice 生成的 9 个子矩形必须保持 `topLeft`、`top`、`topRight`、`left`、`center`、`right`、`bottomLeft`、`bottom`、`bottomRight` 命名，否则本插件无法通过几何推断切片。

### 导出效果较好的做法

1. **先建九宫再导出**：对需要交付给 Photoshop 或做 PSD 往返的 UI 切图，务必先用 9-Slice 生成组件，再选中包含该组件的 Frame / 编组导出。本插件会识别九宫结构并折叠为单层，而不是输出 9 张透明碎片。
2. **保持组件结构完整**：导出前不要打散（ungroup）九宫组件，也不要删除 9 个子矩形；元数据读取依赖组件树或 plugin data。
3. **PSD 往返链路**：`PSD → 本插件导入 → 9-Slice 编辑 → 本插件导出 → PSD` 是保真度最高的路径。若导入时保留了隐藏原层，导出会优先使用该层的完整位图与 PSD 元数据。
4. **选中范围**：导出时选中整个 Frame 或编组即可；九宫组件作为子节点会被自动折叠，无需单独选中。
5. **验收方式**：在 Photoshop 中打开导出的 PSD，图层应显示为**单层完整位图**（非 9 层透明碎片）；再次导入后，9-Slice 应能读取切片值并重新生成可缩放组件。

### 9-Slice 插件快速上手

1. 从 [9-Slice Releases](https://github.com/4NaNBo1/9slice/releases) 下载并安装（Figma 用 `manifest.json`，MasterGo 用 `manifest.mastergo.json`）。
2. 选中带图片填充的图层，运行 9-Slice 插件。
3. 调整 Top / Right / Bottom / Left 切线，点击 **Create Component**。
4. 缩放生成的组件验证边缘与中心拉伸是否符合预期。
5. 需要交付 PSD 时，用本插件 **导出 PSD** 即可。

## 开发说明

仅在你需要从源码本地构建时使用。普通用户从 [Releases](https://github.com/4NaNBo1/psd-to-figma/releases/latest) 下载即可。

```bash
npm install        # 安装依赖（需要 Node.js >= 18）
npm run build      # 构建一次
npm run watch      # 监听文件变化
```

构建产物位于 `dist/` 目录，包含 `manifest.json`（Figma）与 `manifest.mastergo.json`（MasterGo）。

> 插件采用 IR（中间表示）架构：`parser → IR → platform renderer` 用于导入，`node-serializer → psd-builder` 用于导出。新增设计平台只需在 `src/platform/` 下实现 `PlatformRenderer` 接口。

## 更新历史

### v1.6.4

- 修复 PSD 导出时 pass-through 叠加层烘焙范围：文本、矢量、椭圆及带图片填充的独立内容层不再被误当作穿透叠加层合成进基底层。
- 仅当 pass-through 叠加层紧挨基底层之上时才执行烘焙，避免中间夹有独立内容层时误合成。
- 修复图层效果（阴影/发光等）中 `pass through` 混合模式写入 ag-psd 报错的问题，round-trip 残留值递归降级为 `normal`。

### v1.6.3

- 修复 PSD 剪贴蒙版：蒙版使用效果合成前的原始 channel alpha，避免 outer glow / outside stroke 撑大裁剪轮廓。
- 剪贴蒙版基底层效果改为叠加图，还原 Photoshop 的 base content → clipped content → base effects 顺序；辅助节点导出时自动跳过。
- 改进图层效果栅格化：支持阴影/发光/斜面的 blend mode，修正 bevel Depth、内外斜面定位、inner glow choke 与 inner shadow 边界填充等问题。
- 文本层画布显示统一使用 PSD 原始字形像素，保留可编辑 TextNode 与 round-trip 元数据。

### v1.6.2

- 修复部分 PSD 导入时图层效果（lfx2）混合模式枚举解析失败的问题。
- 兼容 `BlnM.normal` 等使用完整键名（而非 `BlnM.Nrml` 缩写）的描述符格式。
- 补充 `normal`、`lddg`、`lbrn` 等混合模式缩写别名。

### v1.6.1

- 与 [9-Slice 插件](https://github.com/4NaNBo1/9slice/releases) 打通：导出时自动将九宫组件折叠为单层位图，避免 MasterGo 等平台切片导出透明碎片。
- 支持 `nineSliceSettings` 元数据往返：经 plugin data、PSD 图层名 Base64URL 编码与几何推断三条通道传递。
- 修复 9-Slice 导出往返时 PSD 通道像素保留问题，提高位图保真度。
- 校验嵌入式智能对象源数据，跳过无效的 `placedLayer` 写入。
- 修复 PSD 导出时透传叠加层烘焙与 MasterGo 图层层叠顺序问题。
- 移除 codegraph / graphify 代码智能分析工具链。

### v1.6.0

- 将单子图层组的效果合成进栅格图层，修复导出后效果丢失问题。

### v1.5.0

- 提升智能对象滤镜、遮罩、模糊效果与重渲染流程的 PSD 往返保真度。
- 修复 MasterGo 文本 Y 轴漂移，并为低覆盖描边图层增加栅格化回退。
- 增强图案、图层蒙版、继承组效果、剪贴蒙版、旋转文字、文字变形与大小写等导入导出能力。
- 增加调整图层与原始图像保留相关处理。
- 默认 README 切换为中文，并补充按 tag 记录的更新历史。

### v1.4.0

- 支持批量导入 PSD，并在导出时剥离导入器辅助包装节点。
- 保留 PSD transform、effect、vector 等原始元数据，提高往返输出精度。
- 合成 inner shadow、glow、bevel、satin、pattern、多重描边等复杂图层效果。
- 修复描边与填充层级，简化错误展示。
- 刷新 README，使功能覆盖范围更完整。

### v1.3.0

- 新增 PSD 导出能力与标签页式插件 UI。
- 保留 PSD 文本 `engineData` 与边界信息，提高文字往返保真度。
- 修复渐变角度、描边圆角、导出文件名自动跟随与面板布局稳定性。
- 将插件命名调整为 **PSD Import & Export**，并优化 UI footer。

### v1.2.0

- 引入 IR 中间层与平台渲染器，为 Figma / MasterGo 双平台打通统一导入链路。
- 注入构建版本，并新增更新检查能力。
- 将 `.cursor/rules` 纳入版本控制。

### v1.1.0

- 新增 PSD 图层蒙版支持。
- 修复文本自动行高处理。

### v1.0.0

- 建立基础 PSD 到 Figma 插件能力。
- 支持旋转文本图层、文字边界与仿射变换相关修复。
- 建立 CI 与发布工作流，并开始提供中英文 README。

## License

MIT
