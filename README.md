# PSD to Figma / MasterGo

> 🌐 中文文档：[README.zh.md](./README.zh.md)

A two-way bridge between **Figma** / **MasterGo** and PSD: import `.psd` files as editable layers, or export selected canvas nodes back into a `.psd` file.

[Usage](#usage) · [Export to PSD](#export-to-psd) · [Development](#development)

## Features

- Parse PSD files into native, editable layers — **import multiple PSDs at once**
- Export selected canvas nodes back into a `.psd` file that opens in Photoshop
- Works in both **Figma** and **MasterGo**
- Preserve layer hierarchy, text styles, layer effects, and blend modes; round-trips also retain original PSD transform / font / vector metadata as faithfully as possible
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
   - **Import PSD**: click or drag one or more `.psd` files into the upload area; they are parsed and inserted into the current canvas as editable layers.
   - **Export PSD**: pack the currently selected nodes into a `.psd` file and download it (see the next section).

> When importing multiple PSDs, their root nodes are **laid out horizontally on the canvas** (100px gap), the progress label shows `[i/N]`, and the viewport is recentered only after the whole batch finishes. You can keep dropping new files while a batch is in progress.

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
- **Text layers**: characters, font family, size, color, letter spacing, line height, alignment. Mixed character styles are written as PSD `styleRuns`, with point text and box text handled separately. Text supports **stacked multi-stroke output**.
- **Layer effects**: drop shadow, inner shadow, outer / inner glow, bevel & emboss, satin, color overlay, pattern overlay, gradient overlay (linear / radial / angle / reflected / diamond), and stroke (inside / center / outside).
  - Shape layers can only render the first stroke (single-node platform limitation) — a warning is emitted when multiple strokes are present.
  - Effects with no native counterpart on the design platform (Inner Shadow / Glow / Bevel / Satin / Pattern Overlay) are baked into the layer bitmap.
- **Raster content**: rectangles / ellipses / vectors / boolean ops are rasterized to PNG and attached as the layer bitmap; image-filled rectangles export their image content directly.
- **Smart objects**: Instances are written as PSD `placedLayer` smart objects, so they can be replaced or edited non-destructively in Photoshop.
- **Clipping masks**: nodes marked as masks are exported with the PSD `clipping` flag set, preserving the masking relationship.
- **PSD round-trip**: if the selection was imported from a PSD by this plugin, the original `engineData`, transform / vector / effect metadata are reused on export, giving text positioning, font metrics, and vector data a much closer match when reopened in Photoshop.

### Known limitations

- **Vectors are rasterized**: vector / ellipse / boolean nodes export as bitmaps, not as PS shape layers — paths are no longer editable in Photoshop.
- **Stroke types**: only `SOLID` color strokes are exported; gradient / image strokes are ignored.
- **Image size cap**: the longest edge of each exported bitmap is capped at 4096px; larger nodes are scaled down proportionally.
- **Export timeout**: each node's `exportAsync` has a 15s timeout; nodes that time out keep their structure and style, but skip the bitmap.
- **Nesting depth**: children deeper than 50 levels are skipped (with a warning in the log).
- **CMYK / channels**: everything is written as RGB 8-bit; PSD alpha channels and spot channels are not generated.

## Development

Only needed if you want to build from source. End users should grab a prebuilt package from [Releases](https://github.com/4NaNBo1/psd-to-figma/releases/latest).

```bash
npm install        # Install dependencies (requires Node.js >= 18)
npm run build      # One-shot build
npm run watch      # Rebuild on file changes
```

Build output goes to `dist/` and includes `manifest.json` (Figma) and `manifest.mastergo.json` (MasterGo).

> The plugin uses an IR (Intermediate Representation) architecture: `parser → IR → platform renderer` for import, `node-serializer → psd-builder` for export. Adding a new design platform only requires implementing the `PlatformRenderer` interface in `src/platform/`.

## License

MIT
