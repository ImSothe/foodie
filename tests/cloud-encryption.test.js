/* The cloud copy is end-to-end encrypted: the real store and the real sync code, two simulated phones, a fake Firestore whose stored JSON is inspected.
   Setup, unlock, wrong passphrase, key custody, plaintext migration (including an interrupted one), tampering, reset, sign-out. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore } from '../app/data/store.js';
import { createCloud } from '../app/data/cloud.js';
import { createKeyring } from '../app/data/keyring.js';
import { stateFromCloud, dayPatchDiff, userPatch, savedPatchDiff, weightsPatchDiff } from '../app/core/cloudmap.js';
import { fromB64, toB64 } from '../app/core/crypto.js';
import { createBackend } from './helpers/fake-firebase.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { FAST_CRYPTO, PASS } from './helpers/cloud-device.js';

const DAY = '2026-11-12';
const profile = { sex: 'male', birthYear: 1990, heightCm: 183.5, weightKg: 81.5, activity: 'moderate', goal: 'maintain', pace: null };
const per100 = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const THUMB = `data:image/jpeg;base64,${'QUJD'.repeat(200)}`;
const food = (name, extra = {}) => ({ name, slot: 'Almuerzo', source: 'db', items: [{ name: `${name} (ingrediente)`, grams: 150, per100 }], ...extra });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));
const SECRETS = ['Pollo secreto', 'Tarta de la abuela', 'Favorita secreta', 'ingrediente', 'data:image', 'QUJDQUJD', '183.5', '81.5', 'heightCm', 'birthYear', 'weightKg', 'per100', 'protein_g', 'grams', '"slot"', '"name"', '"items"', '"sex"', '6420', '81.3'];

/** A phone. `keyring` can be shared by two phones objects to simulate the same device after a restart. */
function phone(backend, clock, name, { keyring = createKeyring(), seed = null, delays = [] } = {}) {
  let n = 0;
  const uid = { current: null, next: 'alice' };
  const store = createStore(memoryStorage(), { uuid: () => `${name}-${++n}`, now: () => new Date(clock.t) });
  if (seed) seed(store);
  const cloud = createCloud({ store, loadSdk: async () => backend.sdk(uid), now: () => clock.t, win: null, doc: null, keyring, delay: async (ms) => { delays.push(ms); }, ...FAST_CRYPTO });
  const settle = async () => { for (let i = 0; i < 400 && cloud.status === 'syncing'; i += 1) await tick(); };
  return {
    store, cloud, keyring, uid, delays,
    async signIn(as = 'alice') { uid.next = as; await cloud.signIn(); await tick(); await settle(); },
    async sync() { clock.t += 1000; await cloud.syncNow(); await settle(); },
  };
}
const names = (p, iso = DAY) => p.store.mealsOf(iso).map((m) => m.name).sort();
const stored = (backend) => JSON.stringify([...backend.docs.entries()]);
const baseData = (s) => {
  s.saveProfile(profile);
  s.addMeal(DAY, food('Pollo secreto con arroz', { thumb: THUMB }));
  s.addMeal(DAY, food('Tarta de la abuela'));
  s.setSteps(DAY, 6420);
  s.logWeight(DAY, 81.3);
  s.saveMeal(food('Favorita secreta'));
};

test('a new account asks for a passphrase first, and nothing is uploaded until it is chosen', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a', { seed: baseData });
  await a.signIn();
  assert.equal(a.cloud.status, 'setup');
  assert.equal(a.cloud.needsPassphrase, 'setup');
  assert.equal(a.cloud.encrypted, false);
  assert.equal(backend.docs.size, 0, 'no data left the device');
  assert.equal(backend.stats.writes, 0);
  assert.deepEqual(await a.cloud.setupPassphrase('corta'), { ok: false, reason: 'weak' });
  assert.equal(backend.stats.writes, 0);
  assert.deepEqual(await a.cloud.setupPassphrase(PASS), { ok: true, synced: true });
  assert.equal(a.cloud.status, 'synced');
  assert.equal(a.cloud.encrypted, true);
  assert.equal(a.cloud.needsPassphrase, null);
});

test('after setup the stored documents contain none of the plaintext, and carry the verifier', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a', { seed: baseData });
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  const text = stored(backend);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `"${secret}" is stored in the clear`);
  assert.ok(!text.includes(PASS), 'the passphrase is never stored');
  const user = backend.docs.get('users/alice');
  assert.deepEqual(Object.keys(user.crypto).sort(), ['check', 'iter', 'salt', 'v']);
  assert.equal(user.crypto.iter, 1000);
  assert.equal(fromB64(user.crypto.salt).length, 16);
  assert.deepEqual(Object.keys(backend.docs.get(`users/alice/days/${DAY}`)).sort(), ['mealsE', 'stepsAt', 'stepsE', 'updatedAt'].sort());
  assert.ok(backend.docs.get('users/alice/meta/saved').itemsE && backend.docs.get('users/alice/meta/weights').wE);
  assert.ok(!JSON.stringify(user).includes('"profile"') && user.profileE);
});

test('a second phone is locked until the passphrase is typed; a wrong one is refused slowly; the right one brings the data; it is remembered', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a', { seed: baseData });
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  const b = phone(backend, clock, 'b');
  await b.signIn();
  assert.equal(b.cloud.status, 'locked');
  assert.equal(b.cloud.needsPassphrase, 'locked');
  assert.deepEqual(names(b), [], 'nothing was read or shown');
  assert.equal(backend.stats.reads <= 12, true);
  const wrong = await b.cloud.unlock('esta no es la contraseña');
  assert.deepEqual(wrong, { ok: false, reason: 'wrong' });
  assert.deepEqual(b.delays, [1000], 'a wrong attempt costs a second');
  assert.equal(b.cloud.status, 'locked');
  assert.deepEqual(names(b), []);
  assert.deepEqual(await b.cloud.unlock(PASS), { ok: true, synced: true });
  assert.deepEqual(names(b), ['Pollo secreto con arroz', 'Tarta de la abuela']);
  assert.equal(b.store.getDay(DAY).steps, 6420);
  assert.ok(b.store.mealsOf(DAY).find((m) => m.thumb));
  assert.equal(b.store.getSaved().length, 1);
  // the same device after a restart: a new cloud object, the same keyring: no prompt
  const again = phone(backend, clock, 'b2', { keyring: b.keyring });
  await again.signIn();
  assert.equal(again.cloud.status, 'synced');
  assert.deepEqual(names(again), ['Pollo secreto con arroz', 'Tarta de la abuela']);
  assert.equal(again.cloud.encrypted, true);
});

test('two phones converge with encryption on, and the cloud never holds plaintext', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a'); const b = phone(backend, clock, 'b');
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  await b.signIn(); await b.cloud.unlock(PASS);
  a.store.addMeal(DAY, food('Pollo secreto con arroz', { thumb: THUMB }));
  a.store.setSteps(DAY, 6420);
  await a.sync();
  b.store.addMeal(DAY, food('Tarta de la abuela'));
  b.store.logWeight(DAY, 81.3);
  await b.sync(); await a.sync();
  assert.deepEqual(names(a), ['Pollo secreto con arroz', 'Tarta de la abuela']);
  assert.deepEqual(names(b), names(a));
  a.store.deleteMeal(DAY, a.store.mealsOf(DAY).find((m) => m.name === 'Tarta de la abuela').id);
  await a.sync(); await b.sync();
  assert.deepEqual(names(b), ['Pollo secreto con arroz'], 'a deletion travels');
  assert.equal(b.store.getDay(DAY).steps, 6420);
  assert.equal(a.store.getWeights()[DAY], 81.3);
  const text = stored(backend);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `"${secret}" is stored in the clear`);
  assert.equal(a.cloud.failedRecords + b.cloud.failedRecords, 0);
});

test('migration: an account with plaintext data is sealed, read back, and only then cleaned; nothing is lost', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  // plaintext documents exactly as an older copy of the app wrote them
  const old = createStore(memoryStorage(), { uuid: (() => { let n = 0; return () => `old-${++n}`; })(), now: () => new Date(clock.t) });
  baseData(old);
  old.addMeal('2026-11-10', food('Cena de ayer'));
  const state = old.getSyncState(); const empty = stateFromCloud({});
  const at = clock.t - 5000;
  const put = (path, data) => backend.docs.set(path, clone(data));
  put('users/alice', userPatch(state, at));
  for (const [iso, day] of Object.entries(state.days)) put(`users/alice/days/${iso}`, dayPatchDiff(undefined, day, at));
  put('users/alice/meta/saved', savedPatchDiff(empty, state, at));
  put('users/alice/meta/weights', weightsPatchDiff(empty, state, at));
  assert.ok(stored(backend).includes('Pollo secreto'), 'the fixture really is plaintext');

  const a = phone(backend, clock, 'a', { seed: (s) => s.addMeal(DAY, food('Cena local de este móvil')) });
  await a.signIn();
  assert.equal(a.cloud.status, 'setup', 'existing users are asked for a passphrase on the first sync after the update');
  assert.ok(stored(backend).includes('Pollo secreto'), 'nothing changed in the cloud yet');
  assert.deepEqual(await a.cloud.setupPassphrase(PASS), { ok: true, synced: true });
  assert.deepEqual(a.cloud.migration, { pending: 0 });
  const text = stored(backend);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `"${secret}" is still stored in the clear`);
  for (const path of ['users/alice', `users/alice/days/${DAY}`, 'users/alice/days/2026-11-10', 'users/alice/meta/saved', 'users/alice/meta/weights']) {
    const d = backend.docs.get(path);
    for (const f of ['profile', 'goals', 'meals', 'waterMl', 'steps', 'items', 'w']) assert.equal(f in d, false, `${path} still has ${f}`);
  }
  assert.deepEqual(names(a), ['Cena local de este móvil', 'Pollo secreto con arroz', 'Tarta de la abuela'], 'cloud and local data are merged');
  const b = phone(backend, clock, 'b');
  await b.signIn(); await b.cloud.unlock(PASS);
  assert.deepEqual(names(b), names(a));
  assert.deepEqual(names(b, '2026-11-10'), ['Cena de ayer']);
  assert.equal(b.store.getProfile().heightCm, 183.5);
  assert.equal(b.store.getDay(DAY).steps, 6420);
  assert.equal(b.store.getSaved().length, 1);
  assert.equal(b.store.getWeights()[DAY], 81.3);
});

test('migration interrupted at every point: plaintext is untouched until verified, no data is lost, and the next sync finishes the job', async () => {
  // count how many Firestore calls a clean migration makes, then drop the connection after each of them in turn
  const make = (backend, clock) => {
    const old = createStore(memoryStorage(), { uuid: (() => { let n = 0; return () => `old-${++n}`; })(), now: () => new Date(clock.t) });
    baseData(old);
    const state = old.getSyncState(); const empty = stateFromCloud({}); const at = clock.t - 5000;
    backend.docs.set('users/alice', clone(userPatch(state, at)));
    for (const [iso, day] of Object.entries(state.days)) backend.docs.set(`users/alice/days/${iso}`, clone(dayPatchDiff(undefined, day, at)));
    backend.docs.set('users/alice/meta/saved', clone(savedPatchDiff(empty, state, at)));
    backend.docs.set('users/alice/meta/weights', clone(weightsPatchDiff(empty, state, at)));
  };
  const probe = createBackend(); const pc = { t: 1_800_000_000_000 }; make(probe, pc);
  const pa = phone(probe, pc, 'p'); await pa.signIn(); const before = probe.stats.calls; await pa.cloud.setupPassphrase(PASS);
  const total = probe.stats.calls - before;
  assert.ok(total >= 8, `a migration makes ${total} calls`);
  for (let cut = 0; cut < total; cut += 1) {
    const backend = createBackend(); const clock = { t: 1_800_000_000_000 }; make(backend, clock);
    const a = phone(backend, clock, 'a');
    await a.signIn();
    backend.stats.failIn = cut;
    await a.cloud.setupPassphrase(PASS);
    backend.stats.failIn = null;
    if (!a.cloud.encrypted) await a.cloud.setupPassphrase(PASS);            // it stopped before the key existed: the person simply tries again
    // wherever it stopped: the plaintext that is still there is complete and untouched, and every meal is still readable somewhere
    const day = backend.docs.get(`users/alice/days/${DAY}`);
    if (day && day.meals) assert.deepEqual(Object.keys(day.meals).sort(), ['old-1', 'old-2'], `cut ${cut}: plaintext meals are all there or all gone`);
    else assert.ok(day === undefined || day.mealsE, `cut ${cut}`);
    // the next sync (this phone is still holding its key) finishes
    await a.sync(); await a.sync();
    assert.equal(a.cloud.status, 'synced', `cut ${cut}: ${a.cloud.error}`);
    assert.deepEqual(names(a), ['Pollo secreto con arroz', 'Tarta de la abuela'], `cut ${cut}`);
    const text = stored(backend);
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `cut ${cut}: "${secret}" is still stored in the clear`);
    const b = phone(backend, clock, 'b'); await b.signIn(); await b.cloud.unlock(PASS);
    assert.deepEqual(names(b), ['Pollo secreto con arroz', 'Tarta de la abuela'], `cut ${cut}: another phone reads everything`);
  }
});

test('a failed read-back leaves the plaintext untouched and says so', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const old = createStore(memoryStorage(), { uuid: (() => { let n = 0; return () => `old-${++n}`; })(), now: () => new Date(clock.t) });
  baseData(old);
  const state = old.getSyncState(); const empty = stateFromCloud({}); const at = clock.t - 5000;
  backend.docs.set('users/alice', clone(userPatch(state, at)));
  backend.docs.set(`users/alice/days/${DAY}`, clone(dayPatchDiff(undefined, state.days[DAY], at)));
  backend.docs.set('users/alice/meta/saved', clone(savedPatchDiff(empty, state, at)));
  const a = phone(backend, clock, 'a');
  await a.signIn();
  // the sealed copies are corrupted on the server right after they are written: the read-back must notice and keep the plaintext
  const realGet = backend.sdk;
  const writesBefore = backend.stats.writes;
  const sdkFor = (uid) => {
    const sdk = realGet(uid);
    const commitOf = sdk.writeBatch;
    sdk.writeBatch = (db) => { const b = commitOf(db); const c = b.commit.bind(b); b.commit = async () => { await c(); for (const [p, d] of backend.docs) if (d.mealsE) for (const e of Object.values(d.mealsE)) { const ct = fromB64(e.ct); ct[0] ^= 1; e.ct = toB64(ct); } }; return b; };
    return sdk;
  };
  a.cloud = null;
  const tampered = createCloud({ store: a.store, loadSdk: async () => sdkFor({ current: null, next: 'alice' }), now: () => clock.t, win: null, doc: null, keyring: createKeyring(), ...FAST_CRYPTO, delay: async () => {} });
  await tampered.signIn(); await tick(); await tampered.setupPassphrase(PASS);
  while (tampered.status === 'syncing') await tick();
  assert.equal(tampered.status, 'error');
  assert.equal(tampered.error, 'migration-incomplete');
  assert.ok(backend.stats.writes > writesBefore);
  const day = backend.docs.get(`users/alice/days/${DAY}`);
  assert.deepEqual(Object.keys(day.meals).sort(), ['old-1', 'old-2'], 'the plaintext meals were not deleted');
  assert.equal(names({ store: a.store }).length, 2, 'and the data on the phone is intact');
});

test('a tampered record is dropped and counted, never shown, never crashes the sync, and a copy kept on the phone repairs it', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a'); const b = phone(backend, clock, 'b');
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  await b.signIn(); await b.cloud.unlock(PASS);
  a.store.addMeal(DAY, food('Pollo secreto con arroz')); a.store.addMeal(DAY, food('Tarta de la abuela'));
  await a.sync();
  const day = backend.docs.get(`users/alice/days/${DAY}`);
  const [firstId] = Object.keys(day.mealsE);
  const ct = fromB64(day.mealsE[firstId].ct); ct[5] ^= 4; day.mealsE[firstId].ct = toB64(ct);          // the server flips a bit
  const c = phone(backend, clock, 'c'); await c.signIn(); await c.cloud.unlock(PASS);
  assert.equal(c.cloud.failedRecords, 1);
  assert.equal(c.store.mealsOf(DAY).length, 1, 'the damaged meal is not shown');
  assert.equal(c.cloud.status, 'synced', 'and the sync carries on');
  await b.sync();
  assert.equal(b.cloud.failedRecords, 1);
  await a.sync();                                          // a did not touch that day, so it does not even pull it: its own copy is untouched
  assert.equal(a.store.mealsOf(DAY).length, 2);
  a.store.setSyncInfo({ uid: 'alice', lastPull: 0 });      // a full pull (a reinstall, a new session): a still holds both meals and rewrites the damaged one
  await a.sync();
  await b.sync();
  assert.equal(b.cloud.failedRecords, 0, 'repaired by the copy a phone still had');
  assert.equal(b.store.mealsOf(DAY).length, 2);
});

test('a record copied by the server to another day or another account does not open', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a');
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  a.store.addMeal(DAY, food('Pollo secreto con arroz'));
  await a.sync();
  const day = backend.docs.get(`users/alice/days/${DAY}`);
  backend.docs.set('users/alice/days/2026-11-01', { mealsE: clone(day.mealsE), updatedAt: clock.t + 10 });
  const b = phone(backend, clock, 'b'); await b.signIn(); await b.cloud.unlock(PASS);
  assert.equal(b.cloud.failedRecords, 1, 'the copy on another day is refused');
  assert.deepEqual(names(b, '2026-11-01'), []);
  assert.deepEqual(names(b), ['Pollo secreto con arroz']);
});

test('sign-out removes the key from the device: signing in again asks for the passphrase', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a', { seed: baseData });
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  assert.ok(await a.keyring.load('alice'));
  await a.cloud.signOut();
  assert.equal(a.cloud.encrypted, false);
  assert.equal(await a.keyring.load('alice'), null);
  await a.signIn();
  assert.equal(a.cloud.status, 'locked');
  assert.deepEqual(await a.cloud.unlock(PASS), { ok: true, synced: true });
});

test('a cloud copy reset from another phone makes this phone ask for the new passphrase', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a', { seed: baseData });
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  const b = phone(backend, clock, 'b', { seed: (s) => s.addMeal(DAY, food('Solo en el móvil B')) });
  await b.signIn(); await b.cloud.unlock(PASS);
  const res = await b.cloud.resetEncryption('una contraseña totalmente nueva');
  assert.deepEqual(res, { ok: true, synced: true });
  await a.sync();
  assert.equal(a.cloud.status, 'locked', 'the old key no longer matches the verifier');
  assert.equal(await a.keyring.load('alice'), null, 'the obsolete key is forgotten');
  assert.deepEqual(await a.cloud.unlock(PASS), { ok: false, reason: 'wrong' }, 'the old passphrase is dead');
  assert.deepEqual(await a.cloud.unlock('una contraseña totalmente nueva'), { ok: true, synced: true });
  assert.ok(names(a).includes('Solo en el móvil B'));
});

test('"forgot my passphrase": the cloud copy is deleted and this phone\'s data is uploaded again under a new one', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a', { seed: baseData });
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  // a reinstalled phone: the cloud has a passphrase it does not know, but it holds the data locally
  const lost = phone(backend, clock, 'lost', { seed: (s) => { baseData(s); s.addMeal(DAY, food('Cena solo local')); } });
  await lost.signIn();
  assert.equal(lost.cloud.status, 'locked');
  assert.deepEqual(await lost.cloud.setupPassphrase('otra frase distinta de la anterior'), { ok: false, reason: 'exists' }, 'a new passphrase never overwrites an existing one by accident');
  assert.deepEqual(await lost.cloud.resetEncryption('corta'), { ok: false, reason: 'weak' });
  assert.ok(backend.docs.has(`users/alice/days/${DAY}`), 'nothing was deleted by a refused attempt');
  assert.deepEqual(await lost.cloud.resetEncryption('otra frase distinta de la anterior'), { ok: true, synced: true });
  assert.equal(lost.cloud.status, 'synced');
  const c = phone(backend, clock, 'c'); await c.signIn();
  assert.deepEqual(await c.cloud.unlock(PASS), { ok: false, reason: 'wrong' });
  assert.deepEqual(await c.cloud.unlock('otra frase distinta de la anterior'), { ok: true, synced: true });
  assert.ok(names(c).includes('Cena solo local'));
  const text = stored(backend);
  for (const secret of SECRETS) assert.ok(!text.includes(secret));
});

test('a verifier that asks for fewer iterations than this app accepts is not used', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a', { seed: baseData });
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  const strict = createCloud({ store: createStore(memoryStorage(), {}), loadSdk: async () => backend.sdk({ current: null, next: 'alice' }), now: () => clock.t, win: null, doc: null, keyring: createKeyring(), delay: async () => {} });
  await strict.signIn(); await tick();
  assert.equal(strict.status, 'locked', 'iter 1000 is below the production floor');
  assert.deepEqual(await strict.unlock(PASS), { ok: false, reason: 'wrong' });
});

test('a different account on the same phone never inherits the key', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = phone(backend, clock, 'a', { seed: baseData });
  await a.signIn(); await a.cloud.setupPassphrase(PASS);
  await a.signIn('bob');
  assert.equal(a.cloud.status, 'setup', 'bob has no passphrase');
  assert.equal(a.cloud.encrypted, false);
  assert.deepEqual(names(a), [], 'alice\'s data was cleared before anything of bob\'s was read');
  assert.equal(await a.keyring.load('bob'), null);
});

// ---------- static guards ----------
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('static: the passphrase is never stored, logged or sent anywhere but the key derivation', () => {
  for (const f of ['../app/data/cloud.js', '../app/core/crypto.js', '../app/core/cloudseal.js', '../app/data/keyring.js', '../app/core/passphrase.js']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');          // comments may say what the code never does
    assert.doesNotMatch(src, /console\./, `${f} logs`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie/, `${f} touches web storage`);
  }
  const cloud = read('../app/data/cloud.js');
  // every place the passphrase is used: strength check, key derivation, nothing else
  const uses = [...cloud.matchAll(/passphrase/g)].length;
  assert.ok(uses > 0);
  assert.doesNotMatch(cloud, /(setItem|setSyncInfo|setCameraMode|keyring\.save)\([^)]*passphrase/, 'the passphrase is not handed to a storage');
  assert.doesNotMatch(cloud, /(batch\.set|toFirestore|sealUserPatch|sealDayPatch)\([^)]*passphrase/, 'the passphrase is not written to the cloud');
  const keyringCalls = [...cloud.matchAll(/keyring\.save\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(keyringCalls.length >= 2 && keyringCalls.every((a) => a === 'uid, key'), `keyring.save is only given the derived key: ${keyringCalls}`);
  const ui = [read('../app/ui/screens/cloud-card.js'), read('../app/main.js')].join('\n');
  assert.doesNotMatch(ui, /(localStorage|sessionStorage|console\.|store\.[a-zA-Z]+)\([^)]*(passphrase|pass\b)/i, 'the UI hands the passphrase only to the cloud object');
});

test('static: the production defaults are not weakened anywhere in the app', () => {
  for (const f of ['../app/main.js', '../app/ui/screens/cloud-card.js', '../app/ui/screens/settings.js']) {
    assert.doesNotMatch(read(f), /kdfIterations|minIterations/, `${f} must not change the key derivation cost`);
  }
  assert.match(read('../app/core/crypto.js'), /export const KDF_ITERATIONS = 600000;/);
});

test('plaintext junk the cleaners drop (an invalid meal, a weight out of range) is removed by the migration and does not keep it "incomplete" for ever', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  backend.docs.set(`users/alice/days/${DAY}`, { meals: { junk: { id: 'junk', name: 'sin ingredientes', items: [], updatedAt: 5 }, ok: { id: 'ok', name: 'Bien', slot: 'Cena', source: 'db', items: [{ name: 'x', grams: 100, per100 }], updatedAt: 6 } }, waterMl: 500, waterAt: 7, updatedAt: 9 });
  backend.docs.set('users/alice/meta/weights', { w: { [DAY]: 81.3, '2026-11-11': 99999 }, at: { [DAY]: 3, '2026-11-11': 3 }, updatedAt: 3 });
  const a = phone(backend, clock, 'a');
  await a.signIn();
  assert.deepEqual(await a.cloud.setupPassphrase(PASS), { ok: true, synced: true });
  assert.deepEqual(a.cloud.migration, { pending: 0 });
  assert.equal(a.cloud.status, 'synced');
  assert.equal('meals' in backend.docs.get(`users/alice/days/${DAY}`), false);
  assert.equal('w' in backend.docs.get('users/alice/meta/weights'), false);
  assert.deepEqual(names(a), ['Bien']);
});
