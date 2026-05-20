# PSD to Figma / MasterGo

> 🌐 English documentation: [README.en.md](./README.en.md)

一个将 PSD 文件作为可编辑图层导入到 **Figma** 或 **MasterGo** 的插件。

[使用说明](#使用说明) · [开发说明](#开发说明) · [架构说明](#架构说明)

## 功能特性

- 解析 PSD 文件并转换为原生的设计平台节点
- 同时支持 **Figma** 和 **MasterGo** 两个设计平台
- 保留图层层级、文字样式、效果和混合模式
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
3. 在弹出的窗口中选择本地的 `.psd` 文件。
4. 等待解析完成后，PSD 内容将作为可编辑图层插入到当前画布中。

## 架构说明

插件采用 **IR（Intermediate Representation）中间表示** 架构，将 PSD 解析与平台渲染解耦：

```
PSD 文件 → 解析器 (parser) → IR 中间表示 → 平台渲染器 (renderer)
                                               ├── FigmaRenderer
                                               └── MasterGoRenderer
```

- **解析层** (`src/parser/`)：将 PSD 文件解析为序列化的图层数据
- **IR 层** (`src/ir/`)：将图层数据转换为平台无关的中间节点树
- **渲染层** (`src/platform/`)：运行时自动检测当前平台，选择对应的渲染器将 IR 树转换为原生节点

这种架构使得新增设计平台支持只需实现 `PlatformRenderer` 接口即可，无需修改解析逻辑。

## 开发说明

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Figma Desktop](https://www.figma.com/downloads/) 和/或 [MasterGo Desktop](https://mastergo.com/resource)

### 安装依赖

```bash
npm install
```

### 构建

```bash
npm run build
```

### 开发模式（监听文件变化）

```bash
npm run watch
```

构建产物位于 `dist/` 目录，其中包含 `manifest.json`（Figma）和 `manifest.mastergo.json`（MasterGo），分别用于对应平台的插件导入。

### 项目结构

```
src/
├── code.ts              # 插件主线程入口（自动检测平台）
├── ui.ts                # 插件 UI 入口
├── ui.html              # 插件 UI 模板
├── logger.ts            # 内置日志（无网络请求）
├── parser/
│   └── psd-parser.ts    # PSD 文件解析
├── ir/
│   ├── types.ts         # IR 中间表示类型定义
│   └── builder.ts       # 序列化数据 → IR 节点树
├── platform/
│   ├── types.ts         # 渲染器接口定义
│   ├── index.ts         # 平台检测与渲染器工厂
│   ├── figma-renderer.ts    # Figma 渲染器
│   └── mastergo-renderer.ts # MasterGo 渲染器
└── types/
    └── psd-types.ts     # 类型定义
```

## License

MIT
