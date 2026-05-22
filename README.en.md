# PSD to Figma / MasterGo

> 🌐 中文文档：[README.md](./README.md)

A two-way bridge between **Figma** / **MasterGo** and PSD: import `.psd` files as editable layers, or export selected canvas nodes back into a `.psd` file.

[Usage](#usage) · [Export to PSD](#export-to-psd) · [Development](#development) · [Architecture](#architecture)

## Features

- Parse PSD files and convert them into native design platform nodes
- Export selected nodes from the design platform into a `.psd` file that opens in Photoshop
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
3. The plugin UI has two tabs:
   - **Import PSD**: pick a local `.psd` file and insert it into the current canvas as editable layers.
   - **Export PSD**: pack the currently selected nodes into a `.psd` file and download it (see the next section).

## Export to PSD

The plugin can serialize nodes from your Figma / MasterGo canvas back into a `.psd` file, making it easy to hand off work to teammates who use Photoshop.

### Workflow

1. Select one or more nodes on the canvas (a single layer, a Frame, or an entire group).
2. Switch to the **Export PSD** tab in the plugin UI.
3. Adjust the output file name (a default is generated from the selection name).
4. Click **Export PSD**. When the progress bar finishes, the browser downloads the `.psd` file locally.

> The whole process runs inside the plugin — no node data is uploaded to any external service.

### What gets preserved

The exporter does its best to retain the following so the resulting PSD looks close to the original when opened in Photoshop:

- **Layer hierarchy**: Frames / Groups / Components become PSD layer groups, with nesting and expanded state preserved.
- **Basic properties**: position, size, opacity, visibility, and blend mode (all PS-supported modes — Normal / Multiply / Screen / Overlay, etc.).
- **Text layers**: characters, font family, size, color, letter spacing, line height, alignment. Mixed character styles are written as PSD `styleRuns`, with point text and box text handled separately.
- **Layer effects**: drop shadow, inner shadow, color overlay (solid fill), gradient overlay (linear / radial / angle / diamond), and stroke (inside / center / outside).
- **Raster content**: rectangles / ellipses / vectors / boolean ops are rasterized to PNG and attached as the layer bitmap; image-filled rectangles export their image content directly.
- **Smart objects**: Instances are written as PSD `placedLayer` smart objects, so they can be replaced or edited non-destructively in Photoshop.
- **Clipping masks**: nodes marked as masks are exported with the PSD `clipping` flag set, preserving the masking relationship.
- **PSD round-trip**: if the selection was imported from a PSD by this plugin, the original `engineData` is reused, giving text layers more faithful positioning and font metrics when reopened in Photoshop.

### Known limitations

- **Vectors are rasterized**: vector / ellipse / boolean nodes export as bitmaps, not as PS shape layers — paths are no longer editable in Photoshop.
- **Stroke types**: only `SOLID` color strokes are exported; gradient / image strokes are ignored.
- **Image size cap**: the longest edge of each exported bitmap is capped at 4096px; larger nodes are scaled down proportionally.
- **Export timeout**: each node's `exportAsync` has a 15s timeout; nodes that time out keep their structure and style, but skip the bitmap.
- **Nesting depth**: children deeper than 50 levels are skipped (with a warning in the log).
- **CMYK / channels**: everything is written as RGB 8-bit; PSD alpha channels and spot channels are not generated.

## Architecture

The plugin uses an **IR (Intermediate Representation)** architecture to decouple PSD parsing from platform rendering. Import and export share the same node abstraction:

```
Import: PSD File → Parser → IR Tree → Platform Renderer
                                       ├── FigmaRenderer
                                       └── MasterGoRenderer

Export: Selected nodes → Node serializer → ExportNodeData → PSD builder → .psd file
```

- **Parser** (`src/parser/`): Parses PSD files into serialized layer data
- **IR Layer** (`src/ir/`): Converts serialized data into a platform-agnostic intermediate node tree
- **Renderer** (`src/platform/`): Auto-detects the current platform at runtime and renders the IR tree into native nodes
- **Exporter** (`src/exporter/`): Reads the current selection, serializes it, and writes the PSD binary via `ag-psd`

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
├── exporter/
│   ├── node-serializer.ts  # Canvas nodes → ExportNodeData
│   └── psd-builder.ts      # ExportNodeData → .psd binary
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
