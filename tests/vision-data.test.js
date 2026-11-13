import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createVision, classifyAiError, VISION_MODEL, TIMEOUT_MS } from '../app/data/vision.js';
import { VISION_JSON_SCHEMA } from '../app/core/vision.js';
import { memoryUsage } from './helpers/usage.js';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/vision/${name}.json`, import.meta.url)), 'utf8'));
const jpeg = { type: 'image/jpeg', size: 1000 };

/** A fake Firebase: records what is built and in which order, and answers with whatever the test queues. */
function fakeFirebase(answers) {
  const log = [];
  const calls = [];
  const queue = [...answers];
  const sdk = {
    initializeAppCheck: (app, opts) => { log.push(['appcheck', opts]); },
    ReCaptchaEnterpriseProvider: class { constructor(key) { this.key = key; } },
    GoogleAIBackend: class {},
    ThinkingLevel: { LOW: 'LOW' },
    Schema: { object: (p) => ({ kind: 'object', ...p }), array: (p) => ({ kind: 'array', ...p }), string: () => ({ kind: 'string' }), number: () => ({ kind: 'number' }), boolean: () => ({ kind: 'boolean' }), enumString: (p) => ({ kind: 'enum', ...p }) },
    getAI: (app, o) => { log.push(['ai']); return { app, o }; },
    getGenerativeModel: (ai, cfg) => {
      log.push(['model', cfg]);
      return { generateContent: async (parts) => {
        calls.push(parts);
        const a = queue.length > 1 ? queue.shift() : queue[0];
        if (a instanceof Error) throw a;
        return { response: { text: () => a } };
      } };
    },
  };
  return { log, calls, cloudPart: { user: { uid: 'u1' }, firebase: async () => ({ sdk, app: { name: 'app' } }) } };
}

function setup(answers, over = {}) {
  const fb = fakeFirebase(answers);
  let t = 1_000_000;
  const vision = createVision({
    cloud: over.cloud || fb.cloudPart, appCheckSiteKey: 'site-key', now: () => t, compress: async (b) => ({ blob: jpeg, width: 100, height: 100 }),
    toBase64: async () => 'QUJD', delay: async () => { t += 1500; }, win: { location: { hostname: 'imsothe.github.io' }, navigator: { onLine: true } },
    usage: memoryUsage(), ...over.deps,
  });
  return { ...fb, vision, advance: (ms) => { t += ms; } };
}

const GOOD = JSON.stringify(fixture('plate'));

test('analyze: a successful call sends the picture inline with the prompt and returns a parsed result', async () => {
  const s = setup([GOOD]);
  const r = await s.vision.analyze({}, { context: 'pollo con arroz' });
  assert.equal(r.ok, true);
  assert.equal(r.result.items.length, 4);
  assert.equal(r.photo, jpeg);
  const parts = s.calls[0];
  assert.deepEqual(parts[0], { type: 'inlineData', inlineData: { data: 'QUJD', mimeType: 'image/jpeg' } });
  assert.match(parts[1], /Contexto aportado/);
  assert.match(parts[1], /pollo con arroz/);
});

test('analyze: App Check is initialised BEFORE the AI model is created, with auto refresh and the site key', async () => {
  const s = setup([GOOD]);
  await s.vision.analyze({});
  const order = s.log.map((e) => e[0]);
  assert.deepEqual(order, ['appcheck', 'ai', 'model']);
  const opts = s.log[0][1];
  assert.equal(opts.isTokenAutoRefreshEnabled, true);
  assert.equal(opts.provider.key, 'site-key');
});

test('analyze: the model is asked for JSON in the schema, at low temperature, with the minimum thinking the model accepts, and a timeout', async () => {
  const s = setup([GOOD]);
  await s.vision.analyze({});
  const cfg = s.log.find((e) => e[0] === 'model')[1];
  assert.equal(cfg.model, VISION_MODEL);
  assert.match(cfg.model, /^gemini-/);
  assert.equal(cfg.generationConfig.responseMimeType, 'application/json');
  assert.equal(cfg.generationConfig.temperature, 0.2);
  assert.equal(cfg.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(cfg.generationConfig.responseSchema.kind, 'object');
  assert.deepEqual(cfg.generationConfig.responseSchema.optionalProperties, ['notes']);
  assert.equal(cfg.requestOptions.timeout, TIMEOUT_MS);
  assert.match(cfg.systemInstruction, /nutritionist/);
  assert.equal(JSON.stringify(Object.keys(VISION_JSON_SCHEMA.properties)).includes('notes'), true);
});

test('analyze: App Check and the model are set up once, not per call', async () => {
  const s = setup([GOOD]);
  await s.vision.analyze({});
  s.advance(10000);
  await s.vision.analyze({});
  assert.deepEqual(s.log.map((e) => e[0]), ['appcheck', 'ai', 'model']);
  assert.equal(s.calls.length, 2);
});

test('analyze: it needs a signed-in person, and says so without touching Firebase', async () => {
  const s = setup([GOOD], { cloud: { user: null, firebase: async () => assert.fail('Firebase must not load') } });
  assert.deepEqual(await s.vision.analyze({}), { ok: false, reason: 'signed-out' });
});

test('analyze: without an App Check site key the answer is "not-configured", and nothing is loaded or sent', async () => {
  const s = setup([GOOD], { deps: { appCheckSiteKey: '' }, cloud: { user: { uid: 'u' }, firebase: async () => assert.fail('Firebase must not load') } });
  assert.deepEqual(await s.vision.analyze({}), { ok: false, reason: 'not-configured' });
  assert.equal(s.vision.configured, false);
});

test('analyze: one analysis at a time, and a 3 s cooldown after each', async () => {
  let release;
  const slow = setup([GOOD]);
  const fb = slow.cloudPart;
  const gate = new Promise((r) => { release = r; });
  const vision = createVision({
    cloud: { user: fb.user, firebase: async () => { await gate; return fb.firebase(); } }, appCheckSiteKey: 'k', now: () => 5_000_000, compress: async () => ({ blob: jpeg }), toBase64: async () => 'QQ', usage: memoryUsage(),
  });
  const first = vision.analyze({});
  assert.deepEqual(await vision.analyze({}), { ok: false, reason: 'busy-local' });
  release();
  assert.equal((await first).ok, true);
  assert.deepEqual(await vision.analyze({}), { ok: false, reason: 'cooldown' });

  const s = setup([GOOD]);
  assert.equal((await s.vision.analyze({})).ok, true);
  assert.equal((await s.vision.analyze({})).reason, 'cooldown');
  s.advance(2999);
  assert.equal((await s.vision.analyze({})).reason, 'cooldown');
  s.advance(1);
  assert.equal((await s.vision.analyze({})).ok, true);
});

test('analyze: a failed call also starts the cooldown, and the lock is always released', async () => {
  const s = setup([new Error('boom'), GOOD]);
  assert.equal((await s.vision.analyze({})).ok, false);
  assert.equal((await s.vision.analyze({})).reason, 'cooldown');
  s.advance(3000);
  assert.equal((await s.vision.analyze({})).ok, true);
});

test('analyze: a transient failure is retried once; a second one is reported', async () => {
  const busy = Object.assign(new Error('The model is overloaded'), { customErrorData: { status: 503 } });
  const s = setup([busy, GOOD]);
  const r = await s.vision.analyze({});
  assert.equal(r.ok, true);
  assert.equal(s.calls.length, 2);
  const twice = setup([busy]);
  assert.deepEqual(await twice.vision.analyze({}), { ok: false, reason: 'busy' });
  assert.equal(twice.calls.length, 2);
});

test('analyze: quota, App Check, offline and timeout are not retried and get their own reason', async () => {
  const cases = [
    [Object.assign(new Error('Quota exceeded for this project'), { customErrorData: { status: 429 } }), 'quota'],
    [Object.assign(new Error('Firebase App Check token is invalid.'), { customErrorData: { status: 401 } }), 'app-check'],
    [Object.assign(new TypeError('Failed to fetch'), {}), 'offline'],
    [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'timeout'],
  ];
  for (const [err, reason] of cases) {
    const s = setup([err, GOOD]);
    assert.deepEqual(await s.vision.analyze({}), { ok: false, reason });
    assert.equal(s.calls.length, 1, `${reason}: no retry`);
  }
});

test('analyze: a call that never answers is cut at the timeout', async () => {
  const fb = fakeFirebase([GOOD]);
  const sdkFb = await fb.cloudPart.firebase();
  sdkFb.sdk.getGenerativeModel = () => ({ generateContent: () => new Promise(() => {}) });
  const vision = createVision({ cloud: { user: { uid: 'u' }, firebase: async () => sdkFb }, appCheckSiteKey: 'k', timeoutMs: 30, compress: async () => ({ blob: jpeg }), toBase64: async () => 'QQ', now: () => 9e9, usage: memoryUsage() });
  const started = Date.now();
  assert.deepEqual(await vision.analyze({}), { ok: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 2000);
});

test('analyze: an answer that is not usable is "bad-answer", a picture that cannot be read is "bad-image"', async () => {
  assert.deepEqual(await setup(['esto no es json']).vision.analyze({}), { ok: false, reason: 'bad-answer' });
  assert.deepEqual(await setup([JSON.stringify({ is_food: true, items: [] })]).vision.analyze({}), { ok: false, reason: 'bad-answer' });
  const s = setup([GOOD], { deps: { compress: async () => null } });
  assert.deepEqual(await s.vision.analyze({}), { ok: false, reason: 'bad-image' });
  assert.equal(s.calls.length, 0);
});

test('analyze: hostile model output goes through the parser and comes out clean', async () => {
  const r = await setup([JSON.stringify(fixture('hostile'))]).vision.analyze({});
  assert.equal(r.ok, true);
  assert.equal(r.result.confidence, 1);
  assert.ok(r.result.items.every((i) => i.grams <= 2000));
});

test('analyze: the not-food and burrito answers arrive for the screen to handle', async () => {
  const nf = await setup([JSON.stringify(fixture('not-food'))]).vision.analyze({});
  assert.equal(nf.ok, true);
  assert.equal(nf.result.isFood, false);
  const bu = await setup([JSON.stringify(fixture('burrito'))]).vision.analyze({}, { label: false });
  assert.equal(bu.result.needsContext, true);
});

test('analyze: the label flag changes the user prompt, not the model', async () => {
  const s = setup([GOOD]);
  await s.vision.analyze({}, { label: true });
  assert.match(s.calls[0][1], /nutrition facts table/);
});

test('App Check debug token: only ever switched on for localhost', async () => {
  delete globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN;
  await setup([GOOD], { deps: { win: { location: { hostname: 'imsothe.github.io' }, navigator: { onLine: true } } } }).vision.analyze({});
  assert.equal(globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN, undefined);
  await setup([GOOD], { deps: { win: { location: { hostname: 'evil.localhost.example' }, navigator: { onLine: true } } } }).vision.analyze({});
  assert.equal(globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN, undefined);
  await setup([GOOD], { deps: { win: { location: { hostname: 'localhost' }, navigator: { onLine: true } } } }).vision.analyze({});
  assert.equal(globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN, true);
  delete globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN;
  const src = readFileSync(fileURLToPath(new URL('../app/data/vision.js', import.meta.url)), 'utf8');
  assert.equal([...src.matchAll(/FIREBASE_APPCHECK_DEBUG_TOKEN/g)].length >= 1, true);
  assert.match(src, /if \(isLocalhost\(win\)\) globalThis\.FIREBASE_APPCHECK_DEBUG_TOKEN = true/);
});

test('App Check hook: a custom initAppCheck replaces the default (the call path is ready for a token provider)', async () => {
  const seen = [];
  const s = setup([GOOD], { deps: { initAppCheck: (d) => seen.push(Object.keys(d).sort().join()) } });
  await s.vision.analyze({});
  assert.deepEqual(seen, ['app,sdk,siteKey']);
  assert.ok(!s.log.some((e) => e[0] === 'appcheck'));
});

test('classifyAiError: statuses, SDK codes and messages', () => {
  const c = (message, status, extra = {}) => classifyAiError(Object.assign(new Error(message), status ? { customErrorData: { status } } : {}, extra));
  assert.equal(c('x', 429), 'quota');
  assert.equal(c('RESOURCE_EXHAUSTED'), 'quota');
  assert.equal(c('Firebase App Check token is invalid', 401), 'app-check');
  assert.equal(c('x', 401), 'app-check');
  assert.equal(c('API key not valid', 403, { code: 'api-not-enabled' }), 'app-check');
  assert.equal(c('x', 500), 'busy');
  assert.equal(c('x', 503), 'busy');
  assert.equal(c('The request timed out'), 'timeout');
  assert.equal(c('Failed to fetch'), 'offline');
  // seen for real: the SDK words an HTTP 500 from the model as a fetch-error; the server answered, so it is "busy", not "offline"
  assert.equal(c('AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/models/x:generateContent: [500 ] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later. (AI/fetch-error)', 500, { code: 'fetch-error' }), 'busy');
  assert.equal(c('This model is currently experiencing high demand', 0), 'busy');
  assert.equal(c('x', 0, { code: 'fetch-error' }), 'offline');
  assert.equal(c('Response was blocked due to SAFETY'), 'blocked');
  assert.equal(c('something else entirely', 400), 'error');
  assert.equal(classifyAiError(new Error('x'), { onLine: false }), 'offline');
  for (const weird of [null, undefined, 5, 'x', {}, { message: 5 }]) assert.doesNotThrow(() => classifyAiError(weird));
});
