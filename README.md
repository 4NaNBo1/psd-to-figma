# PSD to Figma

A Figma plugin that imports PSD files as editable Figma layers.

## Features

- Parse PSD files and convert them into native Figma nodes
- Preserve layer hierarchy, text styles, effects, and blend modes
- Runs entirely inside Figma — no external network requests

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Figma Desktop](https://www.figma.com/downloads/)

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Development

```bash
npm run watch
```

Then open Figma Desktop → Plugins → Development → Import plugin from manifest → select `manifest.json`.

## Project Structure

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
