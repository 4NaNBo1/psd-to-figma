# PSD to Figma / MasterGo

> 🌐 中文文档：[README.md](./README.md)

A plugin that imports PSD files as editable layers into **Figma** or **MasterGo**.

[Usage](#usage) · [Development](#development) · [Architecture](#architecture)

## Features

- Parse PSD files and convert them into native design platform nodes
- Supports both **Figma** and **MasterGo**
- Preserve layer hierarchy, text styles, effects, and blend modes
- Runs entirely inside the plugin — no external network requests

## Usage

### Download

Grab the latest plugin package from the [Releases page](https://github.com/4NaNBo1/psd-to-figma/releases/latest).

> Or open: <https://github.com/4NaNBo1/psd-to-figma/releases>

### Install in Figma

1. Unzip the downloaded archive to any local directory.
2. Open [Figma Desktop](https://www.figma.com/downloads/) (the Web version does not support local plugin imports).
3. From the menu bar, choose **Plugins → Development → Import plugin from manifest...**.
4. Select the `manifest.json` file inside the unzipped folder to finish importing.

### Install in MasterGo

1. Unzip the downloaded archive to any local directory.
2. Open [MasterGo Desktop](https://mastergo.com/resource).
3. From the menu bar, choose **Plugins → Development → Import plugin from manifest...**.
4. Select the `manifest.mastergo.json` file inside the unzipped folder to finish importing.

### Run the plugin

1. Open any design file in Figma or MasterGo.
2. Launch the **PSD Importer** plugin from the plugins menu.
3. Pick a local `.psd` file in the dialog.
4. Once parsing finishes, the PSD content will be inserted into the current canvas as editable layers.

## Architecture

The plugin uses an **IR (Intermediate Representation)** architecture to decouple PSD parsing from platform rendering:

```
PSD File → Parser → IR Tree → Platform Renderer
                                 ├── FigmaRenderer
                                 └── MasterGoRenderer
```

- **Parser** (`src/parser/`): Parses PSD files into serialized layer data
- **IR Layer** (`src/ir/`): Converts serialized data into a platform-agnostic intermediate node tree
- **Renderer** (`src/platform/`): Auto-detects the current platform at runtime and renders the IR tree into native nodes

Adding support for a new design platform only requires implementing the `PlatformRenderer` interface — no changes to parsing logic needed.

## Development

### Requirements

- [Node.js](https://nodejs.org/) >= 18
- [Figma Desktop](https://www.figma.com/downloads/) and/or [MasterGo Desktop](https://mastergo.com/resource)

### Install dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

### Watch mode

```bash
npm run watch
```

Build output goes to the `dist/` directory, which includes `manifest.json` (Figma) and `manifest.mastergo.json` (MasterGo) for importing into the respective platforms.

### Project structure

```
src/
├── code.ts              # Plugin main thread (auto-detects platform)
├── ui.ts                # Plugin UI entry
├── ui.html              # Plugin UI template
├── logger.ts            # Built-in logger (no network)
├── parser/
│   └── psd-parser.ts    # PSD file parsing
├── ir/
│   ├── types.ts         # IR type definitions
│   └── builder.ts       # Serialized data → IR node tree
├── platform/
│   ├── types.ts         # Renderer interface
│   ├── index.ts         # Platform detection & renderer factory
│   ├── figma-renderer.ts    # Figma renderer
│   └── mastergo-renderer.ts # MasterGo renderer
└── types/
    └── psd-types.ts     # Type definitions
```

## License

MIT
