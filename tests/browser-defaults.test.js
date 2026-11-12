/* The parts of image.js, vision.js and cloudmap.js that run against real browser objects, exercised with small fakes of those objects,
   so that what the other tests replace by injection is also checked once as it is wired by default. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawToBlob, compressFile, thumbnailDataUrl, blobToDataUrl } from '../app/data/image.js';
import { createVision } from '../app/data/vision.js';
import { dayPatchFromDirty, DELETE } from '../app/core/cloudmap.js';
import { cleanDay } from '../app/core/schema.js';

function withGlobals(fakes, fn) {
  const saved = {};
  for (const k of Object.keys(fakes)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: fakes[k], configurable: true, writable: true }); }
  const restore = () => { for (const k of Object.keys(fakes)) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}

class FakeReader {
  readAsDataURL(blob) { setTimeout(() => { if (blob.bad) this.onerror(new Error('x')); else { this.result = `data:${blob.type};base64,QUJD`; this.onload(); } }, 0); }
}
const fakeDocument = (encoded) => ({
  createElement: (tag) => {
    assert.equal(tag, 'canvas');
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob(cb, type, q) { cb({ type, size: encoded(type, q) }); } };
    return canvas;
  },
});

test('image: the default canvas comes from document.createElement and gets the scaled size', async () => {
  await withGlobals({ document: fakeDocument(() => 1000) }, async () => {
    const r = await drawToBlob({ videoWidth: 2560, videoHeight: 1440 });
    assert.deepEqual([r.width, r.height], [1280, 720]);
    assert.equal(r.blob.type, 'image/webp');
  });
});

test('image: blobToDataUrl reads a blob with FileReader, and a read error gives null', async () => {
  await withGlobals({ FileReader: FakeReader }, async () => {
    assert.equal(await blobToDataUrl({ type: 'image/jpeg' }), 'data:image/jpeg;base64,QUJD');
    assert.equal(await blobToDataUrl({ type: 'image/jpeg', bad: true }), null);
  });
});

test('image: the default decoder asks for the orientation to be applied', async () => {
  let asked;
  const bitmap = { width: 100, height: 100, close() { this.closed = true; } };
  await withGlobals({ document: fakeDocument(() => 1000), createImageBitmap: async (f, opts) => { asked = opts; return bitmap; } }, async () => {
    const r = await compressFile({ type: 'image/jpeg' });
    assert.ok(r);
    assert.deepEqual(asked, { imageOrientation: 'from-image' });
    assert.equal(bitmap.closed, true);
  });
});

test('image: a thumbnail with the default reader', async () => {
  await withGlobals({ document: fakeDocument(() => 900), FileReader: FakeReader }, async () => {
    const url = await thumbnailDataUrl({ width: 800, height: 600 });
    assert.equal(url, 'data:image/jpeg;base64,QUJD');
  });
});

test('vision: the default picture reader and thumbnail are wired to FileReader, createImageBitmap and the canvas', async () => {
  const answer = JSON.stringify({ is_food: true, dish: 'x', confidence: 0.9, scale_ref: 'plate', needs_context: false, items: [{ name: 'a', grams: 10, per100: { kcal: 10 } }] });
  const sent = [];
  const sdk = {
    initializeAppCheck() {}, ReCaptchaEnterpriseProvider: class {}, GoogleAIBackend: class {}, ThinkingLevel: { LOW: 'LOW' },
    Schema: { object: (p) => p, array: (p) => p, string: () => 1, number: () => 1, boolean: () => 1, enumString: (p) => p },
    getAI: () => ({}), getGenerativeModel: () => ({ generateContent: async (parts) => { sent.push(parts); return { response: { text: () => answer } }; } }),
  };
  const closed = [];
  await withGlobals({
    FileReader: FakeReader, document: fakeDocument(() => 500),
    createImageBitmap: async () => ({ width: 640, height: 480, close: () => closed.push(1) }),
  }, async () => {
    const vision = createVision({ cloud: { user: { uid: 'u' }, firebase: async () => ({ sdk, app: {} }) }, appCheckSiteKey: 'k', compress: async () => ({ blob: { type: 'image/webp' } }), now: () => 1e12 });
    const r = await vision.analyze({});
    assert.equal(r.ok, true);
    assert.equal(sent[0][0].inlineData.data, 'QUJD', 'the picture is sent as base64 without the data URL prefix');
    assert.equal(vision.configured, true);
    assert.equal(await vision.thumbnail({ type: 'image/webp' }), 'data:image/jpeg;base64,QUJD');
    assert.equal(closed.length, 1, 'the decoded bitmap is released');
  });
  await withGlobals({ createImageBitmap: async () => { throw new Error('cannot decode'); } }, async () => {
    const vision = createVision({ cloud: { user: null }, appCheckSiteKey: 'k' });
    assert.equal(await vision.thumbnail({}), null);
  });
});

test('cloudmap: a patch from the local changes carries only what changed, deletions as tombstones, an edit clears an old tombstone', () => {
  const day = cleanDay({
    meals: { a: { id: 'a', name: 'A', items: [{ name: 'x', grams: 1, per100: { kcal: 1 } }], updatedAt: 50 }, b: { id: 'b', name: 'B', items: [{ name: 'x', grams: 1, per100: { kcal: 1 } }] } },
    waterMl: 500, waterAt: 60, steps: 100, stepsAt: 70, deleted: { gone: 80 },
  });
  const patch = dayPatchFromDirty(day, { m: { a: 50 }, d: { gone: 80 }, w: 60, s: 70 }, 999);
  assert.equal(patch.updatedAt, 999);
  assert.equal(patch.meals.a.name, 'A');
  assert.equal('b' in patch.meals, false, 'meal b did not change');
  assert.equal(patch.deleted.a, DELETE, 'an edit after a deletion removes the cloud tombstone');
  assert.equal(patch.meals.gone, DELETE);
  assert.equal(patch.deleted.gone, 80);
  assert.deepEqual([patch.waterMl, patch.waterAt, patch.steps, patch.stepsAt], [500, 60, 100, 70]);
  assert.equal(dayPatchFromDirty(day, { m: { nope: 1 }, d: { nope: 1 } }, 999), null, 'nothing to send');
  assert.equal(dayPatchFromDirty(undefined, { m: { a: 1 }, w: 1 }, 5), null);
});
