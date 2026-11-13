/* The REAL sync code (app/data/cloud.js + app/core/cloudmap.js + the real store) against the REAL rules in the emulator.
   Two simulated phones of one account edit, delete and sync; every patch cloudmap produces goes through firestore.rules.
   The Firebase calls are the real `firebase/firestore` functions; only sign-in is faked (tests/helpers/fake-firebase.js), because the
   emulator context already is "signed in as alice". If a rule refuses what the app writes, the sync ends in status 'error' with
   code 'permission-denied' and these tests fail. */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'firebase/firestore';
import { createStore } from '../../app/data/store.js';
import { createCloud } from '../../app/data/cloud.js';
import { createBackend } from '../helpers/fake-firebase.js';
import { memoryStorage } from '../helpers/memory-storage.js';
import { buildYear } from '../helpers/year-data.js';
import { createEnv, ALICE, BOB, DAY, profile } from './helpers.mjs';

let env;
before(async () => { env = await createEnv(); });
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const per100 = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const food = (name, extra = {}) => ({ name, slot: 'Almuerzo', source: 'db', items: [{ name, grams: 150, per100 }], ...extra });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A phone: its own store, its own cloud object, one shared clock, and a Firestore connection that is `as` in the emulator. */
function phone(clock, name, { as = ALICE, initial = {} } = {}) {
  let n = 0;
  const db = env.authenticatedContext(as).firestore();
  const uid = { current: null, next: ALICE };
  const fake = createBackend().sdk(uid);                    // sign-in only; its Firestore half is replaced below
  const sdk = { ...fake, ...fs, getFirestore: () => db };
  const store = createStore(memoryStorage(initial), { uuid: () => `${name}-${++n}`, now: () => new Date(clock.t) });
  const cloud = createCloud({ store, loadSdk: async () => sdk, now: () => clock.t, win: null, doc: null });
  return {
    store, cloud,
    async signIn() { const r = await cloud.signIn(); await tick(); return r; },
    async sync() { clock.t += 1000; await cloud.syncNow(); while (cloud.status === 'syncing') await tick(5); assert.notEqual(cloud.status, 'error', `sync failed: ${cloud.error}`); },
  };
}

const names = (p, iso = DAY) => p.store.mealsOf(iso).map((m) => m.name).sort();
const readAll = async () => {
  const out = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    for (const path of [`users/${ALICE}`, `users/${ALICE}/meta/saved`, `users/${ALICE}/meta/weights`, `users/${ALICE}/meta/usage`]) { const s = await fs.getDoc(fs.doc(d, path)); if (s.exists()) out[path] = s.data(); }
    const days = await fs.getDocs(fs.collection(d, 'users', ALICE, 'days'));
    for (const s of days.docs) out[`users/${ALICE}/days/${s.id}`] = s.data();
  });
  return out;
};

describe('the app against the rules', () => {
  it('two devices edit every kind of data, delete, and converge; no write is refused', async () => {
    const clock = { t: 1_800_000_000_000 };
    const a = phone(clock, 'a'); const b = phone(clock, 'b');
    await a.signIn(); await b.signIn();

    a.store.saveProfile(profile);
    a.store.setGoals({ kcal: 2100, protein_g: 130, carbs_g: 210, fat_g: 70, waterL: 2.4, steps: 9000 }, '2026-11-01');
    a.store.addMeal(DAY, food('Desayuno de A', { thumb: `data:image/jpeg;base64,${'A'.repeat(1000)}` }));
    a.store.addWater(DAY, 500);
    a.store.setSteps(DAY, 4200);
    a.store.logWeight(DAY, 79.4);
    a.store.saveMeal(food('Favorita de A'));
    a.store.recordPhoto();
    a.store.recordPhoto();
    await a.sync();

    await b.sync();
    b.store.addMeal(DAY, food('Cena de B'));
    b.store.addMeal('2026-11-10', food('Ayer de B'));
    b.store.addWater(DAY, 250);
    b.store.logWeight('2026-11-10', 80.1);
    b.store.saveMeal(food('Favorita de B'));
    b.store.recordPhoto();
    await b.sync();

    await a.sync();
    a.store.deleteMeal(DAY, a.store.mealsOf(DAY).find((m) => m.name === 'Desayuno de A').id);
    a.store.removeSaved(a.store.getSaved().find((m) => m.name === 'Favorita de B').id);
    await a.sync(); await b.sync();

    for (const p of [a, b]) {
      assert.deepEqual(names(p), ['Cena de B']);
      assert.deepEqual(names(p, '2026-11-10'), ['Ayer de B']);
      assert.deepEqual(p.store.getSaved().map((m) => m.name), ['Favorita de A']);
      assert.equal(p.store.getDay(DAY).steps, 4200);
      assert.equal(p.store.getDay(DAY).waterMl, 750);
      assert.deepEqual(p.store.getWeights()[DAY], 79.4);
      assert.equal(p.store.getProfile().heightCm, 180);
    }
    const docs = await readAll();
    assert.deepEqual(a.store.getUsage(), b.store.getUsage());
    assert.equal(docs[`users/${ALICE}/meta/usage`].photos, 3, 'b had already pulled the 2 photos of a when it counted its own');
    assert.deepEqual(Object.keys(docs).sort(), [`users/${ALICE}`, `users/${ALICE}/days/${DAY}`, `users/${ALICE}/days/2026-11-10`, `users/${ALICE}/meta/saved`, `users/${ALICE}/meta/usage`, `users/${ALICE}/meta/weights`].sort());
  });

  it('a whole year of data (365 days, a thumbnail a day, 30 favourites) uploads in batches and a fresh phone downloads it', async () => {
    const clock = { t: 1_800_000_000_000 };
    const year = buildYear({ days: 365, mealsPerDay: 4, thumbsPerDay: 1 });
    const a = phone(clock, 'a', { initial: year.text });
    await a.signIn(); await a.sync();
    const b = phone(clock, 'b');
    await b.signIn(); await b.sync();
    assert.equal(Object.keys(b.store.getDays()).length, 365);
    assert.equal(b.store.getSaved().length, 30);
    const meals = Object.values(b.store.getDays()).reduce((n, d) => n + Object.keys(d.meals).length, 0);
    assert.equal(meals, 365 * 4);
    const docs = await readAll();
    assert.equal(Object.keys(docs).filter((p) => p.includes('/days/')).length, 365);
  });

  it('a day at the app caps (100 meals, 20 thumbnails) is accepted', async () => {
    const clock = { t: 1_800_000_000_000 };
    const a = phone(clock, 'a');
    await a.signIn();
    const thumb = `data:image/jpeg;base64,${'A'.repeat(12 * 1024 - 23)}`;
    for (let i = 0; i < 100; i += 1) a.store.addMeal(DAY, food(`Comida ${i}`, i < 25 ? { thumb } : {}));
    assert.equal(a.store.mealsOf(DAY).length, 100);
    await a.sync();
    const day = (await readAll())[`users/${ALICE}/days/${DAY}`];
    assert.equal(Object.keys(day.meals).length, 100);
  });

  it('negative control: the same sync pointed at someone else\'s data ends in permission-denied', async () => {
    const clock = { t: 1_800_000_000_000 };
    const mallory = phone(clock, 'm', { as: BOB });          // a connection that is bob in the emulator...
    await mallory.cloud.signIn();                            // ...while the app believes it is alice
    await tick();
    mallory.store.addMeal(DAY, food('No debería escribirse'));
    clock.t += 1000;
    await mallory.cloud.syncNow();
    while (mallory.cloud.status === 'syncing') await tick(5);
    assert.equal(mallory.cloud.status, 'error');
    assert.equal(mallory.cloud.error, 'permission-denied');
    assert.deepEqual(Object.keys(await readAll()), []);
  });
});
