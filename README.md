# PSD to Figma

> 🌐 English documentation: [README.en.md](./README.en.md)

一个将 PSD 文件作为可编辑图层导入到 Figma 的插件。

[使用说明](#使用说明) · [开发说明](#开发说明)

## 功能特性

- 解析 PSD 文件并转换为原生的 Figma 节点
- 保留图层层级、文字样式、效果和混合模式
- 完全在 Figma 内部运行，不发起任何外部网络请求

## 使用说明

### 下载插件

前往 [Releases 页面](https://github.com/4NaNBo1/psd-to-figma/releases/latest) 下载最新版本的插件包。

> 也可以直接打开：<https://github.com/4NaNBo1/psd-to-figma/releases>

### 安装到 Figma

1. 解压下载的压缩包到本地任意目录。
2. 打开 [Figma 桌面客户端](https://www.figma.com/downloads/)（Web 版本不支持本地插件导入）。
3. 在菜单栏选择 **Plugins → Development → Import plugin from manifest...**。
4. 选择解压目录中的 `manifest.json` 文件，完成导入。

### 使用插件

1. 在 Figma 中打开任意一个设计文件。
2. 通过 **Plugins → Development → PSD to Figma** 启动插件。
3. 在弹出的窗口中选择本地的 `.psd` 文件。
4. 等待解析完成后，PSD 内容将作为可编辑图层插入到当前画布中。

## 开发说明

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Figma Desktop](https://www.figma.com/downloads/)

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

随后在 Figma Desktop 中通过 **Plugins → Development → Import plugin from manifest** 选择项目根目录的 `manifest.json` 即可调试。

### 项目结构

```
src/
├── code.ts              # Figma 主线程入口
├── ui.ts                # 插件 UI 入口
├── ui.html              # 插件 UI 模板
├── logger.ts            # 内置日志（无网络请求）
├── parser/
│   └── psd-parser.ts    # PSD 文件解析
├── converter/
│   ├── node-factory.ts  # Figma 节点创建
│   ├── text-converter.ts
│   └── effect-converter.ts
└── types/
    └── psd-types.ts     # 类型定义
```

## License

MIT
