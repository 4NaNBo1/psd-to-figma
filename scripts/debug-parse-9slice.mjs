import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { createCanvas, ImageData } from 'canvas';
import { initializeCanvas } from 'ag-psd';
import { parsePsdFile } from '../src/parser/psd-parser.ts';
import { buildIRTree } from '../src/ir/builder.ts';
import { readPngDimensions } from '../src/exporter/nine-slice-collapse.ts';
import { PNG } from 'pngjs';

function cornerRadiusEstimate(buf) {
  const png = PNG.sync.read(buf);
  const { width: w, height: h, data: d } = png;
  let topOpaque = -1;
  let leftOpaque = -1;
  for (let x = 0; x < w; x++) {
    if (d[(0 * w + x) * 4 + 3] > 128) { topOpaque = x; break; }
  }
  for (let y = 0; y < h; y++) {
    if (d[(y * w + 0) * 4 + 3] > 128) { leftOpaque = y; break; }
  }
  return { w, h, topOpaque, leftOpaque, est: Math.max(topOpaque, leftOpaque) };
}

initializeCanvas((w, h) => {
  const c = createCanvas(w, h);
  if (!c.toBlob) {
    c.toBlob = (cb, type) => {
      const buf = c.toBuffer(type === 'image/png' ? 'image/png' : 'image/png');
      cb(new Blob([buf], { type: type || 'image/png' }));
    };
  }
  return c;
});

// Polyfill browser APIs used by psd-parser image encoding
globalThis.document = {
  createElement(tag) {
    if (tag === 'canvas') {
      const c = createCanvas(1, 1);
      if (!c.toBlob) {
        c.toBlob = (cb, type) => {
          const buf = c.toBuffer('image/png');
          cb(new Blob([buf], { type: type || 'image/png' }));
        };
      }
      return c;
    }
    return {};
  },
};
globalThis.Blob = class Blob {
  constructor(parts) { this._parts = parts; }
  async arrayBuffer() {
    const p = this._parts[0];
    return p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength);
  }
};
globalThis.ImageData = ImageData;


function findLayer(layers, pred, path = '') {
  if (!layers) return null;
  for (const l of layers) {
    const p = `${path}/${l.name}`;
    if (pred(l, p)) return { layer: l, path: p };
    const c = findLayer(l.children, pred, p);
    if (c) return c;
  }
  return null;
}

function walkAll(layers, path = '', out = []) {
  if (!layers) return out;
  for (const l of layers) {
    const p = `${path}/${l.name}`;
    out.push({ path: p, name: l.name, type: l.type });
    walkAll(l.children, p, out);
  }
  return out;
}

for (const f of [
  '/Users/admin/Downloads/图层样式测试.psd',
  '/Users/admin/Downloads/图层样式测试export-9slice.psd',
]) {
  console.log('\n===', f.split('/').pop(), '===');
  const buf = readFileSync(f);
  const psd = await parsePsdFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), () => {});
  console.log('root layers:', psd.layers?.length);
  const hit = findLayer(psd.layers, (l, p) => p.includes('btnbg_hard') && l.name === 'bg');
  if (!hit) {
    console.log('bg layer not found under btnbg_hard');
    continue;
  }
  const layer = hit.layer;
  console.log('serialized type:', layer.type);
  console.log('serialized name:', layer.name);
  console.log('nineSliceSettings:', layer.nineSliceSettings ? JSON.parse(layer.nineSliceSettings) : null);
  console.log('cornerRadii:', layer.cornerRadii);
  console.log('expandOffset:', layer.expandOffset);
  console.log('size:', layer.width, layer.height);
  console.log('imageIndex:', layer.imageIndex);
  console.log('effects:', layer.effects?.length);
  console.log('strokes:', layer.strokes?.length);
  console.log('rawVectorData:', !!layer.rawVectorData, layer.rawVectorData?.slice(0, 80));
  const b64 = psd.images[layer.imageIndex];
  const pngBuf = Buffer.from(b64, 'base64');
  console.log('png dims:', b64 ? readPngDimensions(new Uint8Array(pngBuf)) : null);
  console.log('corner est:', cornerRadiusEstimate(pngBuf));
  console.log('rect:', layer.width + (layer.expandOffset ?? 0) * 2, layer.height + (layer.expandOffset ?? 0) * 2);

  const ir = buildIRTree(psd);
  const irHit = findLayer([ir], (l, p) => p.includes('btnbg_hard') && l.name === 'bg');
  if (irHit) {
    const n = irHit.layer;
    console.log('IR name:', n.name);
    console.log('IR cornerRadii:', n.cornerRadii);
    console.log('IR size:', n.width, n.height);
    console.log('IR fills:', n.fills?.length, n.fills?.map(f => ({ type: f.type, scaleMode: f.scaleMode })));
    console.log('IR nineSliceSettings:', n.nineSliceSettings ? JSON.parse(n.nineSliceSettings) : null);
  }
}
