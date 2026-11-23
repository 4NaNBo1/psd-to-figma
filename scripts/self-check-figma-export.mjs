import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { createCanvas, Image } from 'canvas';
import { initializeCanvas, readPsd } from 'ag-psd';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const assets = new Map();
let download;
let nextUrl = 0;
globalThis.figma = {
  currentPage: { selection: [] },
  createVector() {
    return {
      async setVectorNetworkAsync({ vertices }) {
        this.vertices = vertices;
        this.width = Math.max(...vertices.map(v => v.x));
        this.height = Math.max(...vertices.map(v => v.y));
      },
      async exportAsync({ constraint }) {
        return png(this.width, this.height, constraint.value, (ctx, w, h) => {
          const radius = this.vertices[0].cornerRadius * constraint.value;
          ctx.beginPath();
          ctx.roundRect(0, 0, w, h, radius);
          ctx.fill();
        });
      },
      remove() {},
    };
  },
  createRectangle() {
    return {
      resize(width, height) { Object.assign(this, { width, height }); },
      async exportAsync({ constraint }) {
        return png(this.width, this.height, constraint.value, (ctx, w, h) => {
          const gradient = ctx.createLinearGradient(0, 0, 0, h);
          gradient.addColorStop(0, '#0000');
          gradient.addColorStop(0.5, '#000');
          gradient.addColorStop(1, '#000');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, w, h);
        });
      },
      remove() {},
    };
  },
};
globalThis.document = {
  createElement: tag => tag === 'canvas' ? createCanvas(1, 1) : {
    click() { download = assets.get(this.href); },
  },
  body: { appendChild() {}, removeChild() {} },
};
globalThis.URL.createObjectURL = blob => {
  const url = `fixture:${++nextUrl}`;
  assets.set(url, blob);
  return url;
};
globalThis.URL.revokeObjectURL = url => assets.delete(url);
initializeCanvas(createCanvas);

// Load the normal entry points without a filesystem build or a browser download.
const entry = buildSync({
  stdin: {
    contents: `export { serializeSelection } from './src/exporter/node-serializer';
               export { buildAndDownloadPsd } from './src/exporter/psd-builder';
               export { parseFontName } from './src/ir/builder';`,
    resolveDir: root,
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['ag-psd'],
}).outputFiles[0].text;
const bundled = { exports: {} };
new Function('module', 'exports', 'require', entry)(bundled, bundled.exports, require);
const { serializeSelection, buildAndDownloadPsd, parseFontName } = bundled.exports;

// Route decoded browser image data through node-canvas in this harness.
const canvasFactory = document.createElement;
document.createElement = tag => {
  const item = canvasFactory(tag);
  if (tag === 'canvas') {
    const getContext = item.getContext.bind(item);
    item.getContext = (...args) => {
      const ctx = getContext(...args);
      if (!ctx.fixtureDrawImage) {
        ctx.fixtureDrawImage = ctx.drawImage.bind(ctx);
        ctx.drawImage = (img, ...rest) => ctx.fixtureDrawImage(img.decoded ?? img, ...rest);
      }
      return ctx;
    };
  }
  return item;
};
globalThis.Image = class {
  set src(url) {
    assets.get(url).arrayBuffer().then(buffer => {
      this.decoded = new Image();
      this.decoded.src = Buffer.from(buffer);
      this.width = this.decoded.width;
      this.height = this.decoded.height;
      this.onload();
    }).catch(() => this.onerror());
  }
};

function png(width, height, scale, draw) {
  const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
  draw(canvas.getContext('2d'), canvas.width, canvas.height);
  return canvas.toBuffer('image/png');
}
const fill = (color, ctx, w, h) => {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
};
function node(type, name, bounds, options = {}) {
  const [x, y, width, height] = bounds;
  const [rx, ry, rw, rh] = options.renderBounds ?? bounds;
  const shape = {
    id: name, name, type, x, y, width, height,
    absoluteTransform: [[1, 0, x], [0, 1, y]],
    absoluteBoundingBox: { x, y, width, height },
    absoluteRenderBounds: { x: rx, y: ry, width: rw, height: rh },
    opacity: 1, visible: true, fills: [], strokes: [], effects: [],
    blendMode: 'PASS_THROUGH',
    async exportAsync({ constraint }) {
      return png(rw, rh, constraint.value, options.paint ?? fill.bind(null, '#326bb1'));
    },
    ...options.props,
  };
  for (const child of shape.children ?? []) child.parent = shape;
  return shape;
}

const background = node('RECTANGLE', 'background', [-120, 0, 490, 300], { renderBounds: [0, 0, 250, 300] });
const texture = node('VECTOR', 'texture', [10, 10, 80, 32], {
  props: { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, { type: 'IMAGE' }] },
});
const reflected = node('VECTOR', 'reflected', [203, 225, 25, 31], {
  renderBounds: [203, 225, 21, 29], props: { rotation: 0, absoluteTransform: [[1, 0, 203], [0, -1, 256]] },
});
const outline = node('RECTANGLE', 'outline', [100, 10, 28, 28], {
  renderBounds: [98, 8, 32, 32],
  paint: (ctx, w, h) => { ctx.strokeStyle = '#000'; ctx.lineWidth = w / 8; ctx.strokeRect(w / 8, h / 8, w * 0.75, h * 0.75); },
  props: { strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], strokeWeight: 2, strokeAlign: 'OUTSIDE' },
});
const alphaMask = node('RECTANGLE', 'fade', [20, 65, 190, 108], {
  props: { isMask: true, maskType: 'ALPHA', topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0, bottomRightRadius: 0, cornerSmoothing: 0 },
});
const label = node('TEXT', 'body', [25, 75, 180, 130], {
  renderBounds: [25, 77, 174, 92],
  props: {
    textAlignHorizontal: 'LEFT', textAutoResize: 'HEIGHT', characters: '多行文字必须可以直接编辑。\n保留换行、字号和样式。',
    getRangeFontName: () => ({ family: 'PingFang SC', style: 'Regular' }),
    getRangeFontSize: () => 22,
    getRangeLineHeight: () => ({ unit: 'PERCENT', value: 150 }),
  },
});
let nested = label;
for (let i = 0; i < 13; i++) {
  nested = node('GROUP', `wrapper ${i}`, [20, 65, 190, 150], { props: { children: [nested] } });
}
const content = node('GROUP', 'content', [20, 65, 190, 150], { props: { children: [nested] } });
const frame = node('FRAME', 'viewport', [15, 60, 200, 120], { props: { clipsContent: true, children: [alphaMask, content] } });
const invisible = node('GROUP', 'opacity 0', [10, 10, 80, 32], {
  props: { opacity: 0, children: [node('VECTOR', 'invisible texture', [10, 10, 80, 32])] },
});
const decorMask = node('RECTANGLE', 'decor mask', [12, 234, 75, 25], { props: { isMask: true, maskType: 'ALPHA' } });
const decorFill = node('RECTANGLE', 'decor fill', [12, 230, 80, 32]);
const decor = node('GROUP', 'decor', [12, 234, 75, 25], {
  paint: fill.bind(null, '#369e6c'),
  props: { children: [decorMask, decorFill] },
});
const voiceBounds = [25, 185, 120, 40];
const roundedNetwork = {
  vertices: [{ x: 0, y: 0, cornerRadius: 20 }, { x: 120, y: 0, cornerRadius: 20 },
    { x: 120, y: 40, cornerRadius: 20 }, { x: 0, y: 40, cornerRadius: 20 }],
  segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
  regions: [{ windingRule: 'EVENODD', loops: [[0, 1, 2, 3]] }],
};
const voiceMask = node('VECTOR', 'voice mask', voiceBounds, {
  props: { isMask: true, maskType: 'VECTOR', vectorNetwork: roundedNetwork },
});
const voiceFill = node('VECTOR', 'voice fill', voiceBounds, {
  props: {
    vectorNetwork: roundedNetwork,
    fills: [{ type: 'GRADIENT_RADIAL', gradientStops: [{ color: { a: 1 } }, { color: { a: 1 } }] }],
  },
});
const blendPattern = node('GROUP', 'soft light pattern', voiceBounds, {
  props: { blendMode: 'SOFT_LIGHT', opacity: 0.34, children: [node('VECTOR', 'motif', voiceBounds)] },
});
const voiceSurface = node('GROUP', 'surface', voiceBounds, {
  props: { children: [voiceFill, voiceMask, blendPattern] },
});
const voicePlate = node('FRAME', 'voice background', voiceBounds, {
  paint: (ctx, w, h) => {
    ctx.fillStyle = '#3a95ff';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, h / 2);
    ctx.fill();
  },
  props: { children: [node('VECTOR', 'outer outline', voiceBounds), voiceSurface] },
});
const voiceText = node('TEXT', 'voice label', [61, 195, 62, 22], {
  props: { textAutoResize: 'WIDTH_AND_HEIGHT', characters: '按住说话', fontName: { family: 'FZXinZongYiHeiS', style: 'DemiBold' }, fontSize: 16 },
});
const voice = node('INSTANCE', 'voice button', voiceBounds, { props: { children: [voicePlate, voiceText] } });
const externalBlend = node('GROUP', 'external blend', voiceBounds, {
  props: { clipsContent: true, children: [node('VECTOR', 'unbacked pattern', voiceBounds, { props: { blendMode: 'SOFT_LIGHT' } })] },
});
const room = node('INSTANCE', 'fixture', [0, 0, 250, 300], {
  paint: fill.bind(null, '#d4ae74'),
  props: { clipsContent: true, children: [background, texture, reflected, outline, frame, invisible, decor, voice, externalBlend] },
});
globalThis.figma.currentPage.selection = [room];

for (const scale of [1, 3]) {
  const data = await serializeSelection(() => {}, () => {}, scale);
  await buildAndDownloadPsd(data.nodes, data.width, data.height, 'fixture.psd', () => {}, undefined, undefined, data.compositeBase64);
  const buffer = Buffer.from(await download.arrayBuffer());
  if (process.argv[2]) await writeFile(`${process.argv[2]}-${scale}x.psd`, buffer);
  const psd = readPsd(buffer);
  assert.equal(psd.width, 250 * scale);
  assert.equal(psd.height, 300 * scale);
  assert.deepEqual([...psd.canvas.getContext('2d').getImageData(0, 0, 1, 1).data], [212, 174, 116, 255]);
  const [roomLayer] = psd.children;
  const [bg, title, flip, stroke, viewport, hidden, decoration, speechButton, unbacked] = roomLayer.children;
  assert.equal(bg.left, 0);
  assert.equal(bg.right, psd.width);
  assert.equal(bg.canvas.width, psd.width);
  assert.equal(flip.top, 225 * scale);
  assert.equal(flip.canvas.height, 29 * scale);
  assert.equal(title.effects?.solidFill, undefined);
  assert.equal(stroke.left, 98 * scale);
  assert.equal(stroke.canvas.getContext('2d').getImageData(16 * scale, 16 * scale, 1, 1).data[3], 0);
  assert.equal(viewport.mask.right, 215 * scale);
  const [masked] = viewport.children;
  assert.equal(masked.mask.top, 65 * scale);
  const coverage = masked.mask.canvas.getContext('2d');
  assert.ok(coverage.getImageData(0, 0, 1, 1).data[0] < 10);
  assert.equal(coverage.getImageData(0, 100 * scale, 1, 1).data[0], 255);
  let paragraph = masked;
  let depth = 2;
  while (paragraph.children?.length) {
    depth++;
    paragraph = paragraph.children[0];
  }
  assert.equal(depth, 10);
  assert.equal(paragraph.text.shapeType, 'box');
  assert.equal(paragraph.text.text, label.characters);
  assert.equal(paragraph.text.style.font.name, 'PingFangSC-Regular');
  assert.equal(paragraph.text.style.leading, 33 * scale);
  assert.equal(hidden.hidden, true);
  assert.equal(decoration.children, undefined);
  assert.equal(decoration.canvas.width, 75 * scale);
  assert.deepEqual([...decoration.canvas.getContext('2d').getImageData(0, 0, 1, 1).data], [54, 158, 108, 255]);
  const [speechPlate, speechText] = speechButton.children;
  assert.equal(speechButton.children.length, 2);
  assert.equal(speechPlate.children, undefined, 'Render the internally blended plate as one picture');
  const plate = speechPlate.canvas.getContext('2d');
  assert.equal(plate.getImageData(0, 0, 1, 1).data[3], 0, 'The button corner stays transparent');
  assert.equal(plate.getImageData(60 * scale, 20 * scale, 1, 1).data[3], 255);
  assert.equal(speechText.text.text, '按住说话');
  assert.equal(speechText.text.style.font.name, 'FZXINZYHS-DB--GB1-0');
  assert.equal(unbacked.children[0].blendMode, 'soft light', 'A blend using an external backdrop stays live');
  assert.equal(new Set([roomLayer, ...roomLayer.children].map(l => l.id)).size, 10);
}
// Keeping hidden layers disables automatic group compositing.
const layered = await serializeSelection(() => {}, () => {}, 1, false);
await buildAndDownloadPsd(layered.nodes, layered.width, layered.height, 'layered.psd', () => {});
const layeredPsd = readPsd(Buffer.from(await download.arrayBuffer()));
const layeredButton = layeredPsd.children[0].children.find(layer => layer.name === 'voice button');
const roundedMask = layeredButton.children[0].children[1].children[1].mask;
const maskPixels = roundedMask.canvas.getContext('2d');
assert.equal(maskPixels.getImageData(0, 0, 1, 1).data[0], 0, 'The editable mask preserves rounded vertices');
assert.equal(maskPixels.getImageData(60, 20, 1, 1).data[0], 255);

const mixedFonts = node('TEXT', 'mixed fonts', [0, 0, 120, 24], {
  props: {
    characters: '方正钉普健摩9 Arial',
    textAutoResize: 'WIDTH_AND_HEIGHT',
    getRangeFontName: start => [
      { family: '方正新综艺黑 简', style: 'Demi Bold' },
      { family: 'FZXinZongYiHeiS SemiBold', style: 'Regular' },
      { family: '钉钉进步体', style: 'Regular' },
      { family: 'Alibaba PuHuiTi 2.0', style: '85 Bold' },
      { family: 'Alibaba Health Font 2.0 CN', style: '85 B' },
      { family: 'MF MoDeng', style: 'Regular' },
      { family: 'DINPro', style: 'Regular' },
    ][start] ?? { family: 'Arial', style: 'Regular' },
    getRangeFontSize: () => 16,
  },
});
globalThis.figma.currentPage.selection = [mixedFonts];
const fontExport = await serializeSelection(() => {}, () => {}, 1);
await buildAndDownloadPsd(fontExport.nodes, fontExport.width, fontExport.height, 'fonts.psd', () => {});
const fontPsd = readPsd(Buffer.from(await download.arrayBuffer()));
const [textLayer] = fontPsd.children;
assert.equal(textLayer.text.text, mixedFonts.characters);
assert.deepEqual(textLayer.text.styleRuns.map(({ style }) => (style.font ?? textLayer.text.style.font).name), [
  'FZXINZYHS-DB--GB1-0',
  'FZXINZYHS-SB--GB1-0',
  'DingTalk-JinBuTi',
  'AlibabaPuHuiTi_2_85_Bold',
  'AlibabaHealthFont20CN-85B',
  'MF-MoDeng-Regular',
  'DINPro-Regular',
  'ArialMT',
]);
assert.deepEqual(parseFontName('FZXINZYHS-DB--GB1-0'), { family: 'FZXinZongYiHeiS', style: 'DemiBold' });
assert.deepEqual(parseFontName('FZXINZYHS-SB--GB1-0'), { family: 'FZXinZongYiHeiS', style: 'SemiBold' });

process.stdout.write('Figma export checks passed at 1× and 3×, including layered masks and editable font mappings.\n');
