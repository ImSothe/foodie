import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createOffClient } from '../app/data/off-client.js';
import { createStore, STORAGE_KEYS } from '../app/data/store.js';
import { cleanProduct, cleanProducts, productFromOff, MAX_PRODUCTS, offUrl } from '../app/core/off.js';
import { memoryStorage } from './helpers/memory-storage.js';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/off/${name}.json`, import.meta.url)), 'utf8'));
const NUTELLA = '3017620422003';
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const newStore = (initial = {}) => createStore(memoryStorage(initial), { now: () => new Date(2026, 10, 12, 9, 30) });

function setup(handler, { timeoutMs = 50, online = true } = {}) {
  const store = newStore();
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  return { store, calls, client: createOffClient({ store, fetchFn, timeoutMs, win: { navigator: { onLine: online } } }) };
}

test('lookup: a known product is fetched once, with a minimal request, and cached', async () => {
  const { client, calls, store } = setup(() => response(fixture('nutella')));
  const r = await client.lookup(NUTELLA);
  assert.equal(r.ok, true);
  assert.equal(r.cached, false);
  assert.equal(r.product.name, 'Nutella');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, offUrl(NUTELLA));
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.ok(calls[0].init.signal);
  assert.equal(store.getProduct(NUTELLA).name, 'Nutella');
});

test('lookup: a repeat scan is answered from the cache with no request at all, also offline', async () => {
  const { client, calls } = setup(() => response(fixture('nutella')));
  await client.lookup(NUTELLA);
  const offline = createOffClient({ store: (await (async () => { const s = newStore(); s.putProduct(productFromOff(fixture('nutella'), NUTELLA)); return s; })()), fetchFn: () => assert.fail('no request expected'), win: { navigator: { onLine: false } } });
  const again = await offline.lookup(NUTELLA);
  assert.equal(again.ok, true);
  assert.equal(again.cached, true);
  assert.equal(calls.length, 1);
});

test('lookup: the cache survives a restart of the store (it is in localStorage under fd.products)', async () => {
  const st = memoryStorage();
  const a = createStore(st);
  a.putProduct(productFromOff(fixture('nutella'), NUTELLA));
  assert.ok(st.m.has(STORAGE_KEYS.products));
  assert.equal(STORAGE_KEYS.products, 'fd.products');
  const b = createStore(st);
  assert.equal(b.getProduct(NUTELLA).per100.kcal, 539);
});

test('lookup: a code with a bad check digit or junk is refused before any request', async () => {
  const { client, calls } = setup(() => assert.fail('no request expected'));
  for (const bad of ['3017620422004', 'abc', '', null, undefined, 'https://evil.example/', '1'.repeat(400), '12345']) assert.deepEqual(await client.lookup(bad), { ok: false, reason: 'invalid' });
  assert.equal(calls.length, 0);
});

test('lookup: not found (status 0 in the body, or HTTP 404) is not cached', async () => {
  const a = setup(() => response(fixture('not-found')));
  assert.deepEqual(await a.client.lookup('3017620422003'), { ok: false, reason: 'not-found' });
  assert.equal(a.store.getProduct('3017620422003'), null);
  const b = setup(() => response({}, 404));
  assert.deepEqual(await b.client.lookup(NUTELLA), { ok: false, reason: 'not-found' });
});

test('lookup: a product without nutrition data is reported as such and not cached', async () => {
  const body = { status: 1, product: { product_name: 'Sin datos', nutriments: {} } };
  const { client, store } = setup(() => response(body));
  assert.deepEqual(await client.lookup(NUTELLA), { ok: false, reason: 'no-nutrition' });
  assert.equal(store.getProduct(NUTELLA), null);
});

test('lookup: server errors, broken JSON and junk are "error"', async () => {
  assert.deepEqual(await setup(() => response({}, 500)).client.lookup(NUTELLA), { ok: false, reason: 'error' });
  assert.deepEqual(await setup(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })).client.lookup(NUTELLA), { ok: false, reason: 'error' });
  assert.deepEqual(await setup(() => response('<html>')).client.lookup(NUTELLA), { ok: false, reason: 'error' });
  assert.deepEqual(await setup(() => response(null)).client.lookup(NUTELLA), { ok: false, reason: 'error' });
});

test('lookup: no network is "offline"', async () => {
  const down = setup(() => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(await down.client.lookup(NUTELLA), { ok: false, reason: 'offline' });
  const flight = setup(() => { throw new Error('whatever'); }, { online: false });
  assert.deepEqual(await flight.client.lookup(NUTELLA), { ok: false, reason: 'offline' });
});

test('lookup: a request that takes longer than the timeout is aborted and reported as "timeout"', async () => {
  const { client, calls } = setup((url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }), { timeoutMs: 20 });
  const started = Date.now();
  assert.deepEqual(await client.lookup(NUTELLA), { ok: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls.length, 1);
});

test('lookup: hostile answers are cleaned before they are cached or shown', async () => {
  const body = fixture('nutella');
  body.product.product_name = '<script>alert(1)</script>‮evil';
  body.product.product_name_es = '';
  body.product.brands = '<img src=x onerror=alert(1)>, Other';
  body.product.image_front_small_url = 'https://evil.example/x.jpg';
  const { client, store } = setup(() => response(body));
  const r = await client.lookup(NUTELLA);
  assert.equal(r.ok, true);
  assert.equal(r.product.name, '<script>alert(1)</script>evil');
  assert.equal(r.product.imageUrl, null);
  assert.equal(store.getProduct(NUTELLA).imageUrl, null);
});

test('off-client: its default is the plain global fetch and it only ever calls offUrl(code)', () => {
  const src = readFileSync(fileURLToPath(new URL('../app/data/off-client.js', import.meta.url)), 'utf8');
  assert.match(src, /fetchFn = \(\.\.\.a\) => fetch\(\.\.\.a\)/);
  assert.equal([...src.matchAll(/fetchFn\(/g)].length, 1);
  assert.match(src, /fetchFn\(offUrl\(code\)/);
});

// ---------------------------------------------------------------------------------------------
// the cache itself
// ---------------------------------------------------------------------------------------------

const prod = (code, over = {}) => ({ ...productFromOff(fixture('nutella'), NUTELLA), code, ...over });
const VALID_CODES = ['3017620422003', '8410076472212', '96385074', '036000291452', '5449000000996', '4006381333931', '7622210449283', '8000500310427'];

test('cleanProduct: only a complete, valid, re-checked product survives', () => {
  const good = productFromOff(fixture('nutella'), NUTELLA);
  assert.deepEqual(cleanProduct(good), good);
  for (const bad of [null, undefined, 'x', 5, [], {}, { ...good, ok: false }, { ...good, code: '3017620422004' }, { ...good, code: 42 }, { ...good, name: '' }, { ...good, name: '​' },
    { ...good, per100: null }, { ...good, per100: { protein_g: 3 } }, { ...good, per100: { kcal: 99999 } }]) {
    assert.equal(cleanProduct(bad), null, String(JSON.stringify(bad)).slice(0, 60));
  }
  const c = cleanProduct({ ...good, imageUrl: 'javascript:alert(1)', servingG: -5, name: `  ${good.name}‮ `, missing: ['__proto__'], extra: 1 });
  assert.equal(c.imageUrl, null);
  assert.equal(c.servingG, null);
  assert.equal(c.name, good.name);
  assert.equal('extra' in c, false);
  assert.ok(c.missing.every((k) => k in { fiber_g: 1, sugars_g: 1, protein_g: 1, carbs_g: 1, fat_g: 1, sat_fat_g: 1, sodium_mg: 1 }));
});

test('cleanProduct: the picture must be on the Open Food Facts image host', () => {
  const good = productFromOff(fixture('nutella'), NUTELLA);
  for (const url of ['https://images.openfoodfacts.org/images/products/301/x.jpg']) assert.equal(cleanProduct({ ...good, imageUrl: url }).imageUrl, url);
  for (const url of ['https://images.openfoodfacts.org.evil.test/x.jpg', 'https://evil.test/https://images.openfoodfacts.org/x.jpg', 'http://images.openfoodfacts.org/x.jpg', 'data:image/png;base64,AAAA',
    'https://images.openfoodfacts.org/x.jpg" onerror="alert(1)', 'https://images.openfoodfacts.org/ x', 'https://images.openfoodfacts.org/' + 'a'.repeat(400), 7, {}, null]) {
    assert.equal(cleanProduct({ ...good, imageUrl: url }).imageUrl, null, String(url).slice(0, 50));
  }
});

test('cleanProducts: no prototype, keyed by a valid code, the newest 200 kept', () => {
  const entries = {};
  VALID_CODES.forEach((code, i) => { entries[code] = { p: prod(code), at: 1000 + i }; });
  entries.__proto__ = { p: prod(NUTELLA), at: 5 };                       // an own key in JSON
  Object.defineProperty(entries, 'constructor', { value: { p: prod(NUTELLA), at: 5 }, enumerable: true });
  entries['0000000000001'] = { p: prod('0000000000001'), at: 1 };       // bad check digit
  entries['8410076472212'] = { p: prod('3017620422003'), at: 1 };       // stored under the wrong code
  const out = cleanProducts(entries);
  assert.equal(Object.getPrototypeOf(out), null);
  assert.ok(Object.keys(out).every((k) => VALID_CODES.includes(k)));
  assert.equal(out['8410076472212'], undefined, 'an entry stored under the code of another product is dropped');
  assert.equal(out['0000000000001'], undefined);
  assert.equal(out.constructor, undefined);
  for (const bad of [null, undefined, 'x', 5, [], [1, 2]]) assert.deepEqual(Object.keys(cleanProducts(bad)), []);
  assert.equal(MAX_PRODUCTS, 200);
});

test('store: putProduct keeps the newest 200 products and drops the oldest', () => {
  let tick = 0;
  const store = createStore(memoryStorage(), { now: () => new Date(2026, 0, 1, 0, 0, tick) });
  const codes = [];
  for (let n = 0; codes.length < 260; n += 1) {
    const body = String(100000000000 + n);
    let sum = 0;
    for (let i = 0; i < body.length; i += 1) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
    const code = body + String((10 - (sum % 10)) % 10);
    codes.push(code);
  }
  for (const code of codes) { tick += 1; assert.ok(store.putProduct(prod(code)), code); }
  const kept = codes.filter((c) => store.getProduct(c));
  assert.equal(kept.length, 200);
  assert.equal(store.getProduct(codes[0]), null, 'the oldest is gone');
  assert.ok(store.getProduct(codes[259]));
  assert.equal(store.putProduct({ ok: true, code: 'x' }), null);
});

test('store: products are a cache, not data: never exported, removed by clearAll, ignored when corrupt or huge', () => {
  const st = memoryStorage();
  const store = createStore(st);
  store.putProduct(productFromOff(fixture('nutella'), NUTELLA));
  assert.equal('products' in store.exportAll(), false);
  assert.ok(!JSON.stringify(store.exportAll()).includes('Nutella'));
  store.clearAll();
  assert.equal(store.getProduct(NUTELLA), null);
  assert.equal(st.m.has(STORAGE_KEYS.products), false);
  for (const junk of ['not json', '[]', '"x"', '{"3017620422003": {"p": 5}}', `"${'x'.repeat(6 * 1024 * 1024)}"`]) {
    const s2 = createStore(memoryStorage({ [STORAGE_KEYS.products]: junk }));
    assert.equal(s2.getProduct(NUTELLA), null);
  }
  for (const code of ['__proto__', 'constructor', undefined, null, 5, {}]) assert.equal(store.getProduct(code), null);
});
