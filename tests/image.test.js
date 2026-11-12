import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSize, encodeCanvas, drawToBlob, compressFile, thumbnailDataUrl, MAX_SIDE, MAX_BYTES, THUMB_SIDE, THUMB_MAX_CHARS } from '../app/data/image.js';

/** A canvas that records what was drawn and encodes by a table: `encoders[type](quality)` gives a size, or null when the type is unsupported. */
function fakeCanvasFactory(encoders, { noContext = false } = {}) {
  const made = [];
  const create = (w, h) => {
    const canvas = {
      width: w, height: h, drawn: [], encoded: [],
      getContext: () => (noContext ? null : { drawImage: (...a) => canvas.drawn.push(a) }),
      toBlob(cb, type, quality) {
        canvas.encoded.push([type, quality]);
        const enc = encoders[type];
        const size = enc ? enc(quality) : null;
        // like real browsers: an unsupported type silently gives PNG
        cb(size === null ? { type: 'image/png', size: 999999 } : { type, size });
      },
    };
    made.push(canvas);
    return canvas;
  };
  return { create, made };
}

test('fitSize: shrinks to the longest side, never enlarges, keeps the ratio, whole pixels', () => {
  assert.deepEqual(fitSize(4000, 3000), { width: 1280, height: 960 });
  assert.deepEqual(fitSize(3000, 4000), { width: 960, height: 1280 });
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitSize(1280, 1280), { width: 1280, height: 1280 });
  assert.deepEqual(fitSize(4000, 3000, 160), { width: 160, height: 120 });
  assert.deepEqual(fitSize(10000, 1), { width: 1280, height: 1 });
  for (const bad of [[0, 5], [5, 0], [-1, 5], [NaN, 5], [Infinity, 5], ['x', 5], [null, null], [undefined, 3]]) assert.deepEqual(fitSize(...bad), { width: 0, height: 0 }, String(bad));
  assert.equal(MAX_SIDE, 1280);
});

test('encodeCanvas: WebP when the browser really makes WebP, otherwise JPEG; quality drops until it fits', async () => {
  const webp = fakeCanvasFactory({ 'image/webp': (q) => Math.round(q * 600000), 'image/jpeg': (q) => Math.round(q * 900000) });
  const a = await encodeCanvas(webp.create(10, 10));
  assert.equal(a.type, 'image/webp');
  assert.ok(a.size <= MAX_BYTES, `${a.size}`);

  const noWebp = fakeCanvasFactory({ 'image/jpeg': (q) => Math.round(q * 500000) });
  const b = await encodeCanvas(noWebp.create(10, 10));
  assert.equal(b.type, 'image/jpeg', 'a PNG answer to a WebP request is not WebP');
  assert.ok(b.size <= MAX_BYTES);
  assert.equal(noWebp.made[0].encoded[0][0], 'image/webp', 'WebP was tried first');
});

test('encodeCanvas: stays under the byte target when it can, and returns the smallest it managed when it cannot', async () => {
  const fits = fakeCanvasFactory({ 'image/jpeg': (q) => (q <= 0.5 ? 300000 : 900000) });
  assert.ok((await encodeCanvas(fits.create(1, 1))).size <= MAX_BYTES);
  const never = fakeCanvasFactory({ 'image/jpeg': (q) => Math.round(1000000 * q) });
  const out = await encodeCanvas(never.create(1, 1), { maxBytes: 1000 });
  assert.equal(out.size, 400000, 'the smallest attempt (quality 0.4)');
  const nothing = fakeCanvasFactory({});
  assert.equal(await encodeCanvas(nothing.create(1, 1)), null);
  const throwing = { toBlob() { throw new Error('tainted canvas'); } };
  assert.equal(await encodeCanvas(throwing), null);
});

test('drawToBlob: scales a frame down before drawing it, and gives the size back', async () => {
  const f = fakeCanvasFactory({ 'image/jpeg': () => 100000 });
  const video = { videoWidth: 1920, videoHeight: 1080 };
  const r = await drawToBlob(video, { createCanvas: f.create });
  assert.deepEqual([r.width, r.height], [1280, 720]);
  assert.equal(f.made[0].width, 1280);
  assert.deepEqual(f.made[0].drawn[0], [video, 0, 0, 1280, 720]);
  const bitmap = { width: 640, height: 480 };
  assert.deepEqual([(await drawToBlob(bitmap, { createCanvas: f.create })).width, 640].length, 2);
});

test('drawToBlob: nothing to draw, no canvas context, or nothing encodable gives null', async () => {
  const f = fakeCanvasFactory({ 'image/jpeg': () => 1 });
  assert.equal(await drawToBlob({ videoWidth: 0, videoHeight: 0 }, { createCanvas: f.create }), null);
  assert.equal(await drawToBlob({}, { createCanvas: f.create }), null);
  assert.equal(await drawToBlob({ width: 10, height: 10 }, { createCanvas: fakeCanvasFactory({ 'image/jpeg': () => 1 }, { noContext: true }).create }), null);
  assert.equal(await drawToBlob({ width: 10, height: 10 }, { createCanvas: fakeCanvasFactory({}).create }), null);
});

test('compressFile: decodes with the orientation applied, shrinks, and always closes the bitmap', async () => {
  const f = fakeCanvasFactory({ 'image/jpeg': () => 50000 });
  let closed = 0;
  let asked;
  const decode = async (file) => { asked = file; return { width: 4032, height: 3024, close: () => { closed += 1; } }; };
  const file = { name: 'plato.jpg' };
  const r = await compressFile(file, { decode, createCanvas: f.create });
  assert.equal(asked, file);
  assert.deepEqual([r.width, r.height], [1280, 960]);
  assert.equal(closed, 1);
});

test('compressFile: a file that is not an image, or that cannot be decoded, is null and nothing leaks', async () => {
  assert.equal(await compressFile({}, { decode: async () => { throw new Error('not an image'); } }), null);
  let closed = 0;
  const f = fakeCanvasFactory({}, { noContext: true });
  assert.equal(await compressFile({}, { decode: async () => ({ width: 10, height: 10, close: () => { closed += 1; } }), createCanvas: f.create }), null);
  assert.equal(closed, 1);
});

test('thumbnailDataUrl: a 160 px JPEG data URL within 12 KB, quality lowered until it fits, never anything else', async () => {
  const f = fakeCanvasFactory({ 'image/jpeg': (q) => Math.round(q * 20000) });
  const sizes = [];
  const readBlob = async (b) => { sizes.push(b.size); return `data:image/jpeg;base64,${'A'.repeat(b.size > 12000 ? 13000 : 3000)}`; };
  const url = await thumbnailDataUrl({ width: 1280, height: 960 }, { createCanvas: f.create, readBlob });
  assert.ok(url.startsWith('data:image/jpeg;base64,'));
  assert.ok(url.length <= THUMB_MAX_CHARS);
  assert.deepEqual([f.made[0].width, f.made[0].height], [THUMB_SIDE, 120]);
  assert.ok(sizes.length >= 2, 'a too-large first attempt was retried at lower quality');
});

test('thumbnailDataUrl: null when it cannot be made small enough, when JPEG is unavailable, or when there is nothing to draw', async () => {
  const f = fakeCanvasFactory({ 'image/jpeg': () => 1 });
  assert.equal(await thumbnailDataUrl({ width: 100, height: 100 }, { createCanvas: f.create, readBlob: async () => `data:image/jpeg;base64,${'A'.repeat(20000)}` }), null);
  assert.equal(await thumbnailDataUrl({ width: 100, height: 100 }, { createCanvas: fakeCanvasFactory({}).create, readBlob: async () => 'x' }), null);
  assert.equal(await thumbnailDataUrl({ width: 0, height: 0 }, { createCanvas: f.create, readBlob: async () => 'x' }), null);
  assert.equal(await thumbnailDataUrl({ width: 10, height: 10 }, { createCanvas: f.create, readBlob: async () => null }), null);
});
