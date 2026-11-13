/* The daily limit of photo analyses: pure logic, the flow with a fake model, the store, two devices through the cloud, and a static guard
   that the limit is checked before anything is sent. (The rules for the usage document are in tests/rules/ and tests/rules.test.js.) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DAILY_PHOTO_LIMIT, MAX_FREE_RERUNS, MAX_USAGE_PHOTOS, emptyUsage, cleanUsage, photosToday, photosLeft, recordPhoto, mergeUsage, usageEqual, leftText, limitMessage,
} from '../app/core/limits.js';
import { mergeState, emptyState } from '../app/core/merge.js';
import { stateFromCloud, usagePatch } from '../app/core/cloudmap.js';
import { cleanSyncMeta } from '../app/core/schema.js';
import { createVision } from '../app/data/vision.js';
import { createStore } from '../app/data/store.js';
import { createCloud } from '../app/data/cloud.js';
import { createBackend } from './helpers/fake-firebase.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { memoryUsage } from './helpers/usage.js';
import { enter, FAST_CRYPTO } from './helpers/cloud-device.js';
import { makeRng, FUZZ_SEED } from './helpers/prng.js';
import { anyValue } from './helpers/hostile.js';

const TODAY = '2026-11-12';
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ---------- pure logic ----------
test('the limit is 10 photos a day and two free re-runs per photo', () => {
  assert.equal(DAILY_PHOTO_LIMIT, 10);
  assert.equal(MAX_FREE_RERUNS, 2);
});

test('photosLeft counts down from 10 on one day and renews on the next', () => {
  let u = emptyUsage();
  assert.equal(photosLeft(u, TODAY), 10);
  for (let i = 1; i <= 10; i += 1) { u = recordPhoto(u, TODAY); assert.equal(photosLeft(u, TODAY), 10 - i); }
  assert.equal(photosLeft(u, TODAY), 0);
  assert.equal(photosLeft(recordPhoto(u, TODAY), TODAY), 0, 'never negative');
  assert.equal(photosLeft(u, '2026-11-13'), 10, 'a new local day starts again');
  assert.deepEqual(recordPhoto(u, '2026-11-13'), { day: '2026-11-13', photos: 1 });
  assert.equal(photosToday(u, '2026-11-11'), 0, 'a record is only about its own day');
});

test('the counter is capped at what the rules accept', () => {
  assert.equal(recordPhoto({ day: TODAY, photos: MAX_USAGE_PHOTOS }, TODAY).photos, MAX_USAGE_PHOTOS);
  assert.equal(cleanUsage({ day: TODAY, photos: 1e9 }).photos, MAX_USAGE_PHOTOS);
});

test('cleanUsage accepts only a real day and a whole count, and never throws', () => {
  assert.deepEqual(cleanUsage({ day: TODAY, photos: 3 }), { day: TODAY, photos: 3 });
  assert.deepEqual(cleanUsage({ day: TODAY, photos: 3.9 }), { day: TODAY, photos: 3 });
  for (const bad of [null, undefined, 5, 'x', [], { day: 'today', photos: 3 }, { day: TODAY, photos: -1 }, { day: TODAY, photos: NaN }, { day: TODAY, photos: '3' }, { day: TODAY, photos: Infinity }, { day: 20261112, photos: 1 }, { day: '2026-13-45', photos: 1 }]) {
    assert.deepEqual(cleanUsage(bad), emptyUsage(), JSON.stringify(bad));
  }
  const throwing = { get day() { throw new Error('boom'); }, photos: 1 };
  assert.deepEqual(cleanUsage(throwing), emptyUsage());
  const rng = makeRng(FUZZ_SEED);
  for (let i = 0; i < 3000; i += 1) {
    const v = i % 2 ? anyValue(rng) : { day: rng.chance(0.5) ? TODAY : anyValue(rng), photos: anyValue(rng) };
    const out = cleanUsage(v);
    assert.deepEqual(cleanUsage(out), out, 'idempotent');
    assert.ok(out.photos >= 0 && out.photos <= MAX_USAGE_PHOTOS && Number.isInteger(out.photos));
  }
});

test('mergeUsage: later day wins, same day the higher count; commutative, associative and idempotent (generated)', () => {
  assert.deepEqual(mergeUsage({ day: '2026-11-12', photos: 9 }, { day: '2026-11-13', photos: 1 }), { day: '2026-11-13', photos: 1 });
  assert.deepEqual(mergeUsage({ day: TODAY, photos: 3 }, { day: TODAY, photos: 5 }), { day: TODAY, photos: 5 });
  assert.deepEqual(mergeUsage(emptyUsage(), { day: TODAY, photos: 1 }), { day: TODAY, photos: 1 });
  assert.deepEqual(mergeUsage(undefined, undefined), emptyUsage());
  const rng = makeRng(FUZZ_SEED);
  const gen = () => (rng.chance(0.15) ? emptyUsage() : { day: `2026-11-${String(rng.int(10, 14)).padStart(2, '0')}`, photos: rng.int(1, 12) });
  for (let i = 0; i < 2000; i += 1) {
    const [a, b, c] = [gen(), gen(), gen()];
    assert.deepEqual(mergeUsage(a, b), mergeUsage(b, a));
    assert.deepEqual(mergeUsage(mergeUsage(a, b), c), mergeUsage(a, mergeUsage(b, c)));
    assert.deepEqual(mergeUsage(a, a), a);
  }
});

test('usage goes through mergeState and the merge stays commutative', () => {
  const a = { ...emptyState(), usage: { day: TODAY, photos: 4 } };
  const b = { ...emptyState(), usage: { day: TODAY, photos: 7 } };
  const now = 1_800_000_000_000;
  assert.deepEqual(mergeState(a, b, now).usage, { day: TODAY, photos: 7 });
  assert.deepEqual(mergeState(b, a, now).usage, { day: TODAY, photos: 7 });
  assert.deepEqual(mergeState(a, emptyState(), now).usage, a.usage);
  assert.deepEqual(mergeState({ ...emptyState(), usage: undefined }, b, now).usage, b.usage, 'a state without usage (older data) is fine');
});

test('cloudmap: usage comes back cleaned, and the patch is written only when the cloud differs', () => {
  assert.deepEqual(stateFromCloud({ usage: { day: TODAY, photos: 4, evil: 1 } }).usage, { day: TODAY, photos: 4 });
  assert.deepEqual(stateFromCloud({ usage: { day: 'x', photos: 4 } }).usage, emptyUsage());
  assert.deepEqual(stateFromCloud({}).usage, emptyUsage());
  const cloud = { usage: { day: TODAY, photos: 4 } };
  assert.equal(usagePatch(cloud, { usage: { day: TODAY, photos: 4 } }, 5), null);
  assert.deepEqual(usagePatch(cloud, { usage: { day: TODAY, photos: 5 } }, 99), { day: TODAY, photos: 5, updatedAt: 99 });
  assert.equal(usagePatch(cloud, { usage: emptyUsage() }, 5), null, 'nothing to say yet');
  assert.ok(usageEqual({ day: TODAY, photos: 1 }, { day: TODAY, photos: 1 }));
});

test('the Spanish texts', () => {
  assert.equal(leftText(7), 'Te quedan 7 fotos hoy');
  assert.equal(leftText(1), 'Te queda 1 foto hoy');
  assert.equal(leftText(0), 'No te quedan fotos hoy');
  const [title, text] = limitMessage();
  assert.equal(title, 'Has llegado al límite de 10 fotos de hoy');
  assert.equal(text, 'Se renueva a medianoche. Puedes seguir añadiendo comidas con el escáner o la búsqueda.');
});

// ---------- the flow, with a fake model ----------
const NOT_FOOD = JSON.stringify(JSON.parse(read('./fixtures/vision/not-food.json')));
const PLATE = JSON.stringify(JSON.parse(read('./fixtures/vision/plate.json')));
const jpeg = { type: 'image/jpeg', size: 1000 };

function flow(answers, usage = memoryUsage({ today: TODAY })) {
  const queue = [...answers];
  const counts = { model: 0, compress: 0, firebase: 0 };
  const sdk = {
    initializeAppCheck: () => {}, ReCaptchaEnterpriseProvider: class {}, GoogleAIBackend: class {}, ThinkingLevel: { LOW: 'LOW' },
    Schema: { object: (p) => p, array: (p) => p, string: () => 1, number: () => 1, boolean: () => 1, enumString: (p) => p },
    getAI: () => ({}),
    getGenerativeModel: () => ({
      generateContent: async () => {
        counts.model += 1;
        const a = queue.length > 1 ? queue.shift() : queue[0];
        if (a instanceof Error) throw a;
        return { response: { text: () => a } };
      },
    }),
  };
  let t = 1_000_000;
  const vision = createVision({
    cloud: { user: { uid: 'u1' }, firebase: async () => { counts.firebase += 1; return { sdk, app: {} }; } }, appCheckSiteKey: 'k', now: () => t,
    compress: async () => { counts.compress += 1; return { blob: jpeg }; }, toBase64: async () => 'QUJD', delay: async () => {}, usage,
    win: { location: { hostname: 'imsothe.github.io' }, navigator: { onLine: true } },
  });
  return { vision, usage, counts, wait: () => { t += 3100; } };
}
const shoot = async (f, picture = {}, o) => { f.wait(); return f.vision.analyze(picture, o); };

test('flow: ten photos are analysed, the eleventh is refused WITHOUT touching the model, the compressor or Firebase', async () => {
  const f = flow([PLATE]);
  for (let i = 1; i <= 10; i += 1) { const r = await shoot(f); assert.equal(r.ok, true, `photo ${i}`); assert.equal(r.left, 10 - i); }
  assert.equal(f.counts.model, 10);
  const before = { ...f.counts };
  const r = await shoot(f);
  assert.deepEqual(r, { ok: false, reason: 'daily-limit' });
  assert.deepEqual(f.counts, before, 'no compression, no SDK, no model call for the refused photo');
});

test('flow: a "not food" answer counts; a failed call and an unreadable answer do not', async () => {
  const f = flow([NOT_FOOD]);
  assert.equal((await shoot(f)).ok, true);
  assert.equal(f.usage.photosLeft(), 9, 'not food counts');
  const bad = flow([new Error('quota exceeded 429')]);
  assert.equal((await shoot(bad)).reason, 'quota');
  assert.equal(bad.usage.photosLeft(), 10);
  const junk = flow(['this is not json']);
  assert.equal((await shoot(junk)).reason, 'bad-answer');
  assert.equal(junk.usage.photosLeft(), 10);
  const slow = flow([Object.assign(new Error('x'), { code: 'timeout' })]);
  assert.equal((await shoot(slow)).reason, 'timeout');
  assert.equal(slow.usage.photosLeft(), 10);
});

test('flow: a failed first call can be retried for free, and then it counts once', async () => {
  const f = flow([new Error('Failed to fetch'), PLATE]);
  const photo = {};
  assert.equal((await shoot(f, photo)).reason, 'offline');
  assert.equal(f.usage.photosLeft(), 10);
  assert.equal((await shoot(f, photo)).ok, true);
  assert.equal(f.usage.photosLeft(), 9);
});

test('flow: adding context to a counted photo is free, twice; the third run of the same photo counts again', async () => {
  const f = flow([PLATE]);
  const photo = {};
  assert.equal((await shoot(f, photo)).ok, true);
  assert.equal(f.usage.photosLeft(), 9);
  assert.equal((await shoot(f, photo, { context: 'pollo con arroz' })).ok, true);
  assert.equal((await shoot(f, photo, { context: 'pollo con arroz y salsa' })).ok, true);
  assert.equal(f.usage.photosLeft(), 9, 'two re-runs cost nothing');
  assert.equal((await shoot(f, photo, { context: 'otra vez' })).ok, true);
  assert.equal(f.usage.photosLeft(), 8, 'beyond the free re-runs it is a new analysis');
  // a different photo is a different analysis, even with the same context
  assert.equal((await shoot(f, {}, { context: 'pollo' })).ok, true);
  assert.equal(f.usage.photosLeft(), 7);
});

test('flow: when the day is used up, a re-run of a photo that was counted still works', async () => {
  const f = flow([PLATE], memoryUsage({ today: TODAY, start: { day: TODAY, photos: 9 } }));
  const photo = {};
  assert.equal((await shoot(f, photo)).ok, true);
  assert.equal(f.usage.photosLeft(), 0);
  assert.equal((await shoot(f, photo, { context: 'con contexto' })).ok, true, 'the context screen is not cut off by the limit');
  assert.equal((await shoot(f, {})).reason, 'daily-limit');
});

test('flow: the limit renews at local midnight', async () => {
  const f = flow([PLATE], memoryUsage({ today: TODAY, start: { day: TODAY, photos: 10 } }));
  assert.equal((await shoot(f)).reason, 'daily-limit');
  f.usage.day.current = '2026-11-13';
  assert.equal((await shoot(f)).ok, true);
  assert.equal(f.usage.photosLeft(), 9);
});

test('flow: the vision module refuses to be built without a counter', () => {
  assert.throws(() => createVision({ cloud: { user: null } }), /usage counter/);
  assert.throws(() => createVision({ cloud: { user: null }, usage: {} }), /usage counter/);
});

// ---------- the store ----------
const mkStore = (storage = memoryStorage(), at = new Date(2026, 10, 12, 9, 0)) => createStore(storage, { uuid: (() => { let n = 0; return () => `u${++n}`; })(), now: () => at });

test('store: the counter is kept across a reload, counts per local day, and is cleared with the data', () => {
  const storage = memoryStorage();
  const s = mkStore(storage);
  assert.equal(s.photosLeft(), 10);
  s.recordPhoto(); s.recordPhoto();
  assert.equal(s.photosLeft(), 8);
  assert.deepEqual(s.getUsage(), { day: TODAY, photos: 2 });
  const again = mkStore(storage);
  assert.equal(again.photosLeft(), 8, 'persisted');
  assert.equal(mkStore(storage, new Date(2026, 10, 13, 0, 5)).photosLeft(), 10, 'after midnight');
  assert.equal(mkStore(storage, new Date(2026, 10, 12, 23, 59)).photosLeft(), 8, 'just before midnight');
  s.clearAll();
  assert.equal(s.photosLeft(), 10);
});

test('store: a hostile counter in storage is cleaned', () => {
  for (const usage of [{ day: 'javascript:1', photos: 3 }, { day: TODAY, photos: -5 }, { day: TODAY, photos: 'many' }, 'text', null, { day: TODAY, photos: 1e300 }]) {
    const s = mkStore(memoryStorage({ 'fd.sync': JSON.stringify({ usage }) }));
    const left = s.photosLeft();
    assert.ok(left >= 0 && left <= 10, JSON.stringify(usage));
  }
  assert.deepEqual(cleanSyncMeta({ usage: { day: TODAY, photos: 4, x: 1 } }).usage, { day: TODAY, photos: 4 });
});

// ---------- two devices through the cloud ----------
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
function device(backend, clock, name) {
  let n = 0;
  const uid = { current: null, next: 'alice' };
  const store = createStore(memoryStorage(), { uuid: () => `${name}-${++n}`, now: () => new Date(clock.t) });
  const cloud = createCloud({ store, loadSdk: async () => backend.sdk(uid), now: () => clock.t, win: null, doc: null, ...FAST_CRYPTO });
  return {
    store, cloud,
    async signIn() { await cloud.signIn(); await tick(); await enter(cloud); },
    async sync() { clock.t += 1000; await cloud.syncNow(); while (cloud.status === 'syncing') await tick(5); },
  };
}

test('cloud: two phones share one counter; photos counted offline on both end at the higher count, not the sum', async () => {
  const backend = createBackend(); const clock = { t: new Date(2026, 10, 12, 10, 0).getTime() };
  const a = device(backend, clock, 'a'); const b = device(backend, clock, 'b');
  await a.signIn(); await b.signIn();
  a.store.recordPhoto(); a.store.recordPhoto(); a.store.recordPhoto();
  await a.sync();
  assert.deepEqual(backend.docs.get('users/alice/meta/usage'), { day: TODAY, photos: 3, updatedAt: backend.docs.get('users/alice/meta/usage').updatedAt });
  await b.sync();
  assert.equal(b.store.photosLeft(), 7, 'b learns what a used');
  b.store.recordPhoto();
  await b.sync(); await a.sync();
  assert.equal(a.store.photosLeft(), 6);
  assert.equal(b.store.photosLeft(), 6);
  // both offline, each counts on its own
  backend.stats.offline = true;
  a.store.recordPhoto(); a.store.recordPhoto();                       // a: 6
  b.store.recordPhoto(); b.store.recordPhoto(); b.store.recordPhoto();  // b: 7
  backend.stats.offline = false;
  await a.sync(); await b.sync(); await a.sync();
  assert.deepEqual(a.store.getUsage(), { day: TODAY, photos: 7 });
  assert.deepEqual(b.store.getUsage(), { day: TODAY, photos: 7 });
  // a new day on one phone beats yesterday's count on the other
  clock.t = new Date(2026, 10, 13, 9, 0).getTime();
  a.store.recordPhoto();
  await a.sync(); await b.sync();
  assert.deepEqual(b.store.getUsage(), { day: '2026-11-13', photos: 1 });
  assert.equal(b.store.photosLeft(), 9);
});

test('cloud: a counter kept while signed out is merged on sign-in, and a corrupt cloud document cannot raise or lower it wrongly', async () => {
  const backend = createBackend(); const clock = { t: new Date(2026, 10, 12, 10, 0).getTime() };
  const a = device(backend, clock, 'a');
  a.store.recordPhoto(); a.store.recordPhoto();                      // before any sign-in
  await a.signIn(); await a.sync();
  assert.equal(backend.docs.get('users/alice/meta/usage').photos, 2);
  backend.docs.set('users/alice/meta/usage', { day: 'garbage', photos: 'lots' });
  await a.sync();
  assert.equal(a.store.photosLeft(), 8, 'a hostile document is ignored');
  assert.equal(backend.docs.get('users/alice/meta/usage').photos, 2, 'and the cloud is repaired with the real count');
});

// ---------- static guards ----------
test('static: the limit check comes before anything is compressed, sent or built', () => {
  const src = read('../app/data/vision.js');
  const body = src.slice(src.indexOf('async analyze('));
  const at = (needle) => { const i = body.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };
  const check = at('usage.photosLeft()');
  for (const later of ['await compress(', 'await toBase64(', 'ensureModel()', 'callOnce(', 'generateContent(', 'cloud.firebase()']) {
    const i = body.indexOf(later);
    if (i >= 0) assert.ok(check < i, `the limit must be checked before ${later}`);
  }
  assert.ok(at("reason: 'daily-limit'") < at('await compress('));
  assert.ok(at('usage.recordPhoto()') > at('parseVision('), 'a photo is counted only after the AI answered');
});

test('static: the app gives the vision module the real counter, and the photo screen shows the limit and never blocks barcode or search', () => {
  assert.match(read('../app/main.js'), /createVision\(\{ cloud, usage: store \}\)/);
  const photo = read('../app/ui/screens/photo.js');
  assert.match(photo, /daily-limit/);
  assert.match(photo, /limitMessage\(\)/);
  const product = read('../app/ui/screens/product.js');
  const search = read('../app/ui/screens/add-food.js');
  for (const src of [product, search, read('../app/data/off-client.js')]) assert.doesNotMatch(src, /photosLeft|recordPhoto|daily-limit/, 'only the photo analysis is limited');
});
