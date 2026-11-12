import test from 'node:test';
import assert from 'node:assert/strict';
import { createScanner, createDetector, FORMATS, SCAN_INTERVAL_MS } from '../app/data/scanner.js';
import { openCamera, classifyCameraError, stopStream, attachStream, cameraSupported } from '../app/data/camera.js';

/** A manual clock: timers run only when the test says so, so the loop is deterministic. */
function clock() {
  let t = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { id += 1; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (i) => { timers.delete(i); },
    pending: () => timers.size,
    async advance(ms) {
      t += ms;
      for (const [i, tm] of [...timers]) if (tm.at <= t && timers.has(i)) { timers.delete(i); await tm.fn(); }
    },
  };
}
const video = (readyState = 4) => ({ readyState });
const GOOD = '3017620422003';

function setup(frames, { readyState = 4 } = {}) {
  const c = clock();
  const seen = [];
  const calls = { detect: 0 };
  const queue = [...frames];
  const detector = { detect: async () => { calls.detect += 1; const f = queue.length > 1 ? queue.shift() : queue[0]; if (f instanceof Error) throw f; return f; } };
  const codes = [];
  const ignored = [];
  const errors = [];
  const scanner = createScanner({
    video: video(readyState), detector, onCode: (code, info) => codes.push([code, info.format]), onIgnored: (k) => ignored.push(k), onError: (e) => errors.push(e),
    intervalMs: SCAN_INTERVAL_MS, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now,
  });
  return { c, scanner, codes, ignored, errors, calls, seen };
}

test('scanner: stops at the first valid product code and reports it once', async () => {
  const { c, scanner, codes, calls } = setup([[], [], [{ rawValue: GOOD, format: 'ean_13' }], [{ rawValue: '8410076472212', format: 'ean_13' }]]);
  scanner.start();
  for (let i = 0; i < 10; i += 1) await c.advance(SCAN_INTERVAL_MS);
  assert.deepEqual(codes, [[GOOD, 'ean_13']]);
  assert.equal(scanner.running, false);
  assert.equal(calls.detect, 3, 'no frame is analysed after the code was found');
  assert.equal(c.pending(), 0, 'no timer is left running');
});

test('scanner: scans at about 8 frames a second, not faster', async () => {
  const { c, scanner, calls } = setup([[]]);
  scanner.start();
  await c.advance(0);
  assert.equal(calls.detect, 1);
  await c.advance(SCAN_INTERVAL_MS - 1);
  assert.equal(calls.detect, 1, 'too early for the next frame');
  await c.advance(1);
  assert.equal(calls.detect, 2);
  scanner.stop();
});

test('scanner: waits until the video has a frame', async () => {
  const { c, scanner, calls } = setup([[]], { readyState: 0 });
  scanner.start();
  for (let i = 0; i < 5; i += 1) await c.advance(SCAN_INTERVAL_MS);
  assert.equal(calls.detect, 0);
  scanner.stop();
});

test('scanner: never overlaps two detections', async () => {
  const c = clock();
  let running = 0;
  let max = 0;
  const detector = { detect: () => new Promise((resolve) => { running += 1; max = Math.max(max, running); setTimeout(() => { running -= 1; resolve([]); }, 5); }) };
  const scanner = createScanner({ video: video(), detector, onCode() {}, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now });
  scanner.start();
  for (let i = 0; i < 6; i += 1) { await c.advance(SCAN_INTERVAL_MS); await new Promise((r) => setTimeout(r, 8)); }
  assert.equal(max, 1);
  scanner.stop();
});

test('scanner: a QR with a link, a Wi-Fi code or a barcode with a bad check digit is ignored and never acted on', async () => {
  const hostile = [
    { rawValue: 'https://evil.example/login?next=1', format: 'qr_code' },
    { rawValue: 'WIFI:S:home;P:secret;;', format: 'qr_code' },
    { rawValue: 'javascript:alert(1)', format: 'qr_code' },
    { rawValue: '3017620422004', format: 'ean_13' },
    { rawValue: '<script>alert(1)</script>', format: 'qr_code' },
    { rawValue: '', format: 'qr_code' },
    { rawValue: 42, format: 'qr_code' },
    null, undefined, 'text',
  ];
  const { c, scanner, codes, ignored } = setup([hostile]);
  scanner.start();
  for (let i = 0; i < 6; i += 1) await c.advance(SCAN_INTERVAL_MS);
  assert.deepEqual(codes, []);
  assert.equal(scanner.running, true, 'it keeps looking');
  assert.ok(ignored.length >= 1 && ignored.length <= 2, 'the notice is rate limited');
  assert.ok(ignored.every((k) => k === 'qr' || k === 'other'));
  scanner.stop();
});

test('scanner: a GS1 Digital Link QR is a product code, a link to anything else is not', async () => {
  const { c, scanner, codes } = setup([[{ rawValue: 'https://id.gs1.org/01/03017620422003/10/L1', format: 'qr_code' }]]);
  scanner.start();
  await c.advance(0);
  assert.deepEqual(codes, [[GOOD, 'qr_code']]);
});

test('scanner: a detector that throws is tolerated for a while, then reported; stop() ends it at once', async () => {
  const { c, scanner, errors, calls } = setup([new Error('boom')]);
  scanner.start();
  for (let i = 0; i < 30; i += 1) await c.advance(SCAN_INTERVAL_MS);
  assert.equal(errors.length, 1);
  assert.equal(scanner.running, false);
  assert.equal(calls.detect, 20);

  const b = setup([[]]);
  b.scanner.start();
  await b.c.advance(0);
  b.scanner.stop();
  const before = b.calls.detect;
  await b.c.advance(1000);
  assert.equal(b.calls.detect, before);
  assert.equal(b.c.pending(), 0);
});

test('scanner: start twice does not double the loop; a result that arrives after stop() is dropped', async () => {
  const c = clock();
  let resolve;
  const detector = { detect: () => new Promise((r) => { resolve = r; }) };
  const codes = [];
  const scanner = createScanner({ video: video(), detector, onCode: (x) => codes.push(x), setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now });
  scanner.start();
  scanner.start();
  assert.equal(c.pending(), 1);
  const tick = c.advance(0);
  await Promise.resolve();
  scanner.stop();
  resolve([{ rawValue: GOOD, format: 'ean_13' }]);
  await tick;
  assert.deepEqual(codes, []);
});

test('detector: the native BarcodeDetector is used when it supports our formats', async () => {
  const made = [];
  class Native { constructor(o) { made.push(o); } static async getSupportedFormats() { return ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'code_128']; } async detect() { return []; } }
  const r = await createDetector({ win: { BarcodeDetector: Native }, load: async () => assert.fail('the ponyfill must not load') });
  assert.equal(r.kind, 'native');
  assert.deepEqual(made[0].formats, FORMATS);
});

test('detector: the ponyfill loads only when the browser has no usable BarcodeDetector', async () => {
  let loaded = 0;
  class Poly { constructor(o) { this.formats = o.formats; } async detect() { return []; } }
  const load = async () => { loaded += 1; return Poly; };
  assert.equal((await createDetector({ win: {}, load })).kind, 'wasm');
  assert.equal(loaded, 1);
  class Limited { static async getSupportedFormats() { return ['code_128']; } }
  assert.equal((await createDetector({ win: { BarcodeDetector: Limited }, load })).kind, 'wasm');
  class Broken { static async getSupportedFormats() { throw new Error('nope'); } }
  assert.equal((await createDetector({ win: { BarcodeDetector: Broken }, load })).kind, 'wasm');
  assert.equal(loaded, 3);
  const r = await createDetector({ win: {}, load });
  assert.deepEqual(r.detector.formats, FORMATS);
});

test('detector: a ponyfill that fails to load is an error the caller can handle', async () => {
  await assert.rejects(createDetector({ win: {}, load: async () => { throw new Error('offline'); } }), /offline/);
});

// ---------------------------------------------------------------------------------------------
// camera
// ---------------------------------------------------------------------------------------------

const err = (name) => Object.assign(new Error(name), { name });
const fakeStream = () => { const tracks = [{ stopped: 0, stop() { this.stopped += 1; } }, { stopped: 0, stop() { this.stopped += 1; } }]; return { tracks, getTracks: () => tracks }; };

test('camera: errors are classified for the UI', () => {
  assert.equal(classifyCameraError(err('NotAllowedError')), 'denied');
  assert.equal(classifyCameraError(err('SecurityError')), 'denied');
  assert.equal(classifyCameraError(err('NotFoundError')), 'none');
  assert.equal(classifyCameraError(err('OverconstrainedError')), 'none');
  assert.equal(classifyCameraError(err('NotReadableError')), 'busy');
  for (const x of [null, undefined, {}, 'x', err('Whatever')]) assert.equal(classifyCameraError(x), 'unknown');
});

test('camera: opens the rear camera first, falls back to any camera when the constraints are refused', async () => {
  const asked = [];
  const stream = fakeStream();
  const md = { getUserMedia: async (c) => { asked.push(c); if (asked.length === 1) throw err('OverconstrainedError'); return stream; } };
  const r = await openCamera(md);
  assert.equal(r.ok, true);
  assert.equal(r.stream, stream);
  assert.deepEqual(asked[0].video.facingMode, { ideal: 'environment' });
  assert.equal(asked[0].audio, false);
  assert.equal(asked[1].video, true);
});

test('camera: a denied permission is not asked twice, and the reason comes back', async () => {
  let calls = 0;
  const r = await openCamera({ getUserMedia: async () => { calls += 1; throw err('NotAllowedError'); } });
  assert.deepEqual(r, { ok: false, problem: 'denied' });
  assert.equal(calls, 1);
  assert.deepEqual(await openCamera({ getUserMedia: async () => { throw err('NotFoundError'); } }), { ok: false, problem: 'none' });
  assert.deepEqual(await openCamera({ getUserMedia: async () => { throw err('NotReadableError'); } }), { ok: false, problem: 'busy' });
});

test('camera: no mediaDevices (plain http, old browser) is "unsupported", not a crash', async () => {
  for (const md of [undefined, null, {}, { getUserMedia: 5 }]) {
    assert.equal(cameraSupported(md), false);
    assert.deepEqual(await openCamera(md), { ok: false, problem: 'unsupported' });
  }
});

test('camera: stopStream stops every track, twice is fine, nothing is fine', () => {
  const s = fakeStream();
  stopStream(s);
  stopStream(s);
  assert.deepEqual(s.tracks.map((t) => t.stopped), [2, 2]);          // called twice: stop() itself is idempotent in browsers
  for (const bad of [null, undefined, {}, { getTracks: 5 }]) assert.doesNotThrow(() => stopStream(bad));
  const throwing = { getTracks: () => [{ stop() { throw new Error('x'); } }, { stop() { throw new Error('y'); } }] };
  assert.doesNotThrow(() => stopStream(throwing));
});

test('camera: attachStream mutes, marks inline playback and plays, and survives a refused play()', async () => {
  const attrs = {};
  const v = { setAttribute: (k, val) => { attrs[k] = val; }, play: async () => { throw err('NotAllowedError'); } };
  const s = fakeStream();
  await attachStream(v, s);
  assert.equal(v.muted, true);
  assert.equal(v.srcObject, s);
  assert.ok('playsinline' in attrs);
});
