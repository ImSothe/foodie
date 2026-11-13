import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../app/data/store.js';
import { createCloud } from '../app/data/cloud.js';
import { createBackend } from './helpers/fake-firebase.js';

const DAY = '2026-11-12';
const per100 = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const food = (name) => ({ name, slot: 'Almuerzo', source: 'db', items: [{ name, grams: 150, per100 }] });
const profile = { sex: 'male', birthYear: 1990, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain', pace: 0.2 };
import { memoryStorage } from './helpers/memory-storage.js';
const memory = () => memoryStorage();           // a Map, or (FOODIE_BACKEND=idb) the real IndexedDB storage layer
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A phone: its own store, its own cloud object, a shared backend and a shared clock. */
function device(backend, clock, name) {
  let n = 0;
  const uid = { current: null, next: 'alice' };
  const store = createStore(memory(), { uuid: () => `${name}-${++n}`, now: () => new Date(clock.t) });
  const cloud = createCloud({ store, loadSdk: async () => backend.sdk(uid), now: () => clock.t, win: null, doc: null });
  return {
    store, cloud, uid,
    async signIn(as = 'alice') { uid.next = as; const r = await cloud.signIn(); await tick(); return r; },
    async sync() { clock.t += 1000; await cloud.syncNow(); while (cloud.status === 'syncing') await tick(5); },
  };
}
const mealIds = (d, iso = DAY) => d.store.mealsOf(iso).map((m) => m.name).sort();

test('two devices on one account converge: meals added on each appear on the other', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = device(backend, clock, 'a'); const b = device(backend, clock, 'b');
  await a.signIn(); await b.signIn();
  a.store.addMeal(DAY, food('Desayuno de A'));
  await a.sync();
  b.store.addMeal(DAY, food('Cena de B'));
  await b.sync();                                   // gets A's meal and sends its own
  await a.sync();
  assert.deepEqual(mealIds(a), ['Cena de B', 'Desayuno de A']);
  assert.deepEqual(mealIds(b), ['Cena de B', 'Desayuno de A']);
  assert.equal(a.cloud.status, 'synced');
});

test('a meal deleted on one device is deleted on the other, and stays deleted', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = device(backend, clock, 'a'); const b = device(backend, clock, 'b');
  await a.signIn(); await b.signIn();
  const m = a.store.addMeal(DAY, food('Se borrará'));
  a.store.addMeal(DAY, food('Se queda'));
  await a.sync(); await b.sync();
  assert.deepEqual(mealIds(b), ['Se borrará', 'Se queda']);
  b.store.deleteMeal(DAY, b.store.mealsOf(DAY).find((x) => x.name === 'Se borrará').id);
  await b.sync(); await a.sync();
  assert.deepEqual(mealIds(a), ['Se queda']);
  await a.sync(); await b.sync();                   // nothing brings it back
  assert.deepEqual(mealIds(a), ['Se queda']);
  assert.deepEqual(mealIds(b), ['Se queda']);
  assert.ok(m.id);
});

test('the same meal edited on both devices: the newest edit wins everywhere', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = device(backend, clock, 'a'); const b = device(backend, clock, 'b');
  await a.signIn(); await b.signIn();
  a.store.addMeal(DAY, food('Original'));
  await a.sync(); await b.sync();
  clock.t += 5000; a.store.updateMeal(DAY, { ...a.store.mealsOf(DAY)[0], name: 'Editada en A' });
  clock.t += 5000; b.store.updateMeal(DAY, { ...b.store.mealsOf(DAY)[0], name: 'Editada en B' });   // later
  await a.sync(); await b.sync(); await a.sync();
  assert.deepEqual(mealIds(a), ['Editada en B']);
  assert.deepEqual(mealIds(b), ['Editada en B']);
});

test('goals, profile, favourites, weights, water and steps all travel', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = device(backend, clock, 'a'); const b = device(backend, clock, 'b');
  await a.signIn(); await b.signIn();
  a.store.saveProfile(profile);
  a.store.setGoals({ kcal: 2200, protein_g: 150, carbs_g: 250, fat_g: 70, waterL: 3, steps: 9000 }, DAY);
  a.store.saveMeal(food('Favorita'));
  a.store.logWeight(DAY, 79.4);
  a.store.addWater(DAY, 750);
  a.store.setSteps(DAY, 6400);
  await a.sync(); await b.sync();
  assert.equal(b.store.getProfile().heightCm, 180);
  assert.equal(b.store.goalsFor(DAY).kcal, 2200);
  assert.deepEqual(b.store.getSaved().map((m) => m.name), ['Favorita']);
  assert.equal(b.store.getWeights()[DAY], 79.4);
  assert.equal(b.store.getDay(DAY).waterMl, 750);
  assert.equal(b.store.getDay(DAY).steps, 6400);
  b.store.removeSaved(b.store.getSaved()[0].id);
  await b.sync(); await a.sync();
  assert.deepEqual(a.store.getSaved(), []);
});

test('offline: nothing is lost, the state says so, and the next sync sends everything', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = device(backend, clock, 'a');
  await a.signIn();
  await a.sync();
  backend.stats.offline = true;
  a.store.addMeal(DAY, food('Sin conexión'));
  await a.sync();
  assert.equal(a.cloud.status, 'offline');
  assert.deepEqual(mealIds(a), ['Sin conexión']);
  assert.ok(Object.keys(a.store.dirtyDays()).length > 0, 'the change is still waiting to be sent');
  backend.stats.offline = false;
  await a.sync();
  assert.equal(a.cloud.status, 'synced');
  assert.deepEqual(a.store.dirtyDays(), {});
  const stored = [...backend.docs.entries()].find(([p]) => p.endsWith(`/days/${DAY}`));
  assert.ok(stored && Object.keys(stored[1].meals).length === 1);
});

test('a sync with nothing new reads a little and writes nothing', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = device(backend, clock, 'a');
  await a.signIn();
  a.store.addMeal(DAY, food('Una'));
  await a.sync();
  const before = backend.stats.writes;
  await a.sync(); await a.sync();
  assert.equal(backend.stats.writes, before);
});

test('a permission error is reported by its code only and leaves the data alone', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = device(backend, clock, 'a');
  await a.signIn();
  a.store.addMeal(DAY, food('Privada'));
  backend.stats.failNext = 'permission-denied';
  await a.sync();
  assert.equal(a.cloud.status, 'error');
  assert.equal(a.cloud.error, 'permission-denied');
  assert.deepEqual(mealIds(a), ['Privada']);
});

test('another account on the same device never inherits the first account\'s data', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  const a = device(backend, clock, 'a');
  await a.signIn('alice');
  a.store.addMeal(DAY, food('De Alice'));
  await a.sync();
  await a.cloud.signOut();
  assert.deepEqual(mealIds(a), ['De Alice'], 'signing out keeps the data on the device');
  assert.equal(a.cloud.status, 'signed-out');
  await a.signIn('bob');
  await a.sync();
  assert.deepEqual(mealIds(a), [], 'bob starts clean');
  assert.ok([...backend.docs.keys()].every((p) => !p.startsWith('users/bob/') || !JSON.stringify(backend.docs.get(p)).includes('De Alice')));
});

test('hostile documents in the cloud are cleaned before they reach the device', async () => {
  const backend = createBackend(); const clock = { t: 1_800_000_000_000 };
  backend.docs.set('users/alice', { profile: 'x', goals: { a: 1 }, profileAt: 'now' });
  backend.docs.set(`users/alice/days/${DAY}`, { meals: { '__proto__': { id: '__proto__' }, ok1: { id: 'ok1', name: '<script>alert(1)</script>', slot: 'Cena', time: '99:99', source: 'x', items: [{ name: 'a‮b', grams: 100, per100 }] } }, waterMl: 1e12, updatedAt: clock.t });
  backend.docs.set('users/alice/meta/saved', { items: 'nope' });
  const a = device(backend, clock, 'a');
  await a.signIn(); await a.sync();
  assert.equal(({}).polluted, undefined);
  const [m] = a.store.mealsOf(DAY);
  assert.ok(m && m.id === 'ok1');
  assert.equal(m.time, '12:00');
  assert.equal(m.slot, 'Cena');
  assert.ok(!/[‮]/.test(m.items[0].name));
  assert.ok(a.store.getDay(DAY).waterMl <= 20000);
});

test('start() costs nothing for a device that never signed in, and does not load the SDK', async () => {
  let loaded = 0;
  const store = createStore(memory(), {});
  const cloud = createCloud({ store, loadSdk: async () => { loaded += 1; return {}; }, win: null, doc: null });
  cloud.start();
  await tick();
  assert.equal(loaded, 0);
  assert.equal(cloud.status, 'off');
  assert.equal(JSON.stringify(plain(store.getSyncInfo())), JSON.stringify({ uid: null, lastPull: 0 }));
});
