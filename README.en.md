# PSD to Figma

> 🌐 中文文档：[README.md](./README.md)

A Figma plugin that imports PSD files as editable Figma layers.

[Usage](#usage) · [Development](#development)

## Features

- Parse PSD files and convert them into native Figma nodes
- Preserve layer hierarchy, text styles, effects, and blend modes
- Runs entirely inside Figma — no external network requests

## Usage

### Download

Grab the latest plugin package from the [Releases page](https://github.com/4NaNBo1/psd-to-figma/releases/latest).

> Or open: <https://github.com/4NaNBo1/psd-to-figma/releases>

### Install in Figma

1. Unzip the downloaded archive to any local directory.
2. Open [Figma Desktop](https://www.figma.com/downloads/) (the Web version does not support local plugin imports).
3. From the menu bar, choose **Plugins → Development → Import plugin from manifest...**.
4. Select the `manifest.json` file inside the unzipped folder to finish importing.

### Run the plugin

1. Open any design file in Figma.
2. Launch the plugin via **Plugins → Development → PSD to Figma**.
3. Pick a local `.psd` file in the dialog.
4. Once parsing finishes, the PSD content will be inserted into the current canvas as editable layers.

## Development

### Requirements

- [Node.js](https://nodejs.org/) >= 18
- [Figma Desktop](https://www.figma.com/downloads/)

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

Then in Figma Desktop, choose **Plugins → Development → Import plugin from manifest** and select the `manifest.json` at the project root for debugging.

### Project structure

```
src/
├── code.ts              # Figma main thread entry
├── ui.ts                # Plugin UI entry
├── ui.html              # Plugin UI template
├── logger.ts            # Built-in logger (no network)
├── parser/
│   └── psd-parser.ts    # PSD file parsing
├── converter/
│   ├── node-factory.ts  # Figma node creation
│   ├── text-converter.ts
│   └── effect-converter.ts
└── types/
    └── psd-types.ts     # Type definitions
```

## License

MIT
