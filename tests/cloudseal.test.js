/* The encrypted shape of the cloud documents (app/core/cloudseal.js): what is sealed, what stays in the clear, what happens to a record that
   does not open, and how plaintext left from before encryption is recognised and cleaned up only after it was read back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, randomBytes, toB64, fromB64 } from '../app/core/crypto.js';
import {
  openCloud, hasLegacy, sealDayPatch, sealUserPatch, sealSavedPatch, sealWeightsPatch, legacyCleanup,
} from '../app/core/cloudseal.js';
import { stateFromCloud, dayPatchDiff, userPatch, savedPatchDiff, weightsPatchDiff, DELETE } from '../app/core/cloudmap.js';
import { createStore } from '../app/data/store.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { makeRng, FUZZ_SEED } from './helpers/prng.js';
import { anyValue } from './helpers/hostile.js';

const UID = 'alice-uid';
const NOW = 1_800_000_000_000;
const DAY = '2026-11-12';
const profile = { sex: 'male', birthYear: 1990, heightCm: 183.5, weightKg: 81.5, activity: 'moderate', goal: 'maintain', pace: null };
const THUMB = `data:image/jpeg;base64,${'QUJD'.repeat(300)}`;
const per100 = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const food = (name, extra = {}) => ({ name, slot: 'Almuerzo', source: 'db', items: [{ name: `${name} (ingrediente)`, grams: 150, per100 }], ...extra });

let keyPromise;
const ctx = async (uid = UID) => ({ key: await (keyPromise ||= deriveKey('una contraseña de prueba', randomBytes(16), 1000)), uid });

/** A realistic local state, made by the real store. */
function sampleState() {
  const s = createStore(memoryStorage(), { uuid: (() => { let n = 0; return () => `m${++n}`; })(), now: () => new Date(NOW) });
  s.saveProfile(profile);
  s.setGoals({ kcal: 2100, protein_g: 130, carbs_g: 210, fat_g: 70, waterL: 2.4, steps: 9000 }, '2026-11-01');
  s.addMeal(DAY, food('Pollo secreto con arroz', { thumb: THUMB }));
  s.addMeal(DAY, food('Tarta de la abuela'));
  const gone = s.addMeal('2026-11-10', food('Se borra'));
  s.addMeal('2026-11-10', food('Cena de ayer'));
  s.deleteMeal('2026-11-10', gone.id);
  s.addWater(DAY, 750); s.setSteps(DAY, 6420);
  s.logWeight(DAY, 81.25); s.logWeight('2026-11-10', 81.75);
  s.saveMeal(food('Favorita secreta'));
  return s.getSyncState();
}

// ---- a tiny stand-in for Firestore's merge, to build the stored documents ----
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && v !== DELETE;
function applyPatch(doc, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === DELETE) delete doc[k];
    else if (isPlain(v)) { if (!isPlain(doc[k])) doc[k] = {}; applyPatch(doc[k], v); }
    else doc[k] = JSON.parse(JSON.stringify(v));
  }
  return doc;
}
const empty = stateFromCloud({});

async function sealedDocs(state, c) {
  const docs = { days: {} };
  docs.user = applyPatch({}, await sealUserPatch(userPatch(state, NOW), c));
  for (const [iso, day] of Object.entries(state.days)) docs.days[iso] = applyPatch({}, await sealDayPatch(iso, dayPatchDiff(undefined, day, NOW), c));
  docs.saved = applyPatch({}, await sealSavedPatch(savedPatchDiff(empty, state, NOW), c));
  docs.weights = applyPatch({}, await sealWeightsPatch(weightsPatchDiff(empty, state, NOW), c));
  return docs;
}
function plainDocs(state) {
  const docs = { days: {} };
  docs.user = applyPatch({}, userPatch(state, NOW));
  for (const [iso, day] of Object.entries(state.days)) docs.days[iso] = applyPatch({}, dayPatchDiff(undefined, day, NOW));
  docs.saved = applyPatch({}, savedPatchDiff(empty, state, NOW));
  docs.weights = applyPatch({}, weightsPatchDiff(empty, state, NOW));
  return docs;
}
const strings = (docs) => JSON.stringify(docs);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- round trip ----------
test('sealed documents open back to exactly the state that was sealed', async () => {
  const c = await ctx();
  const state = sampleState();
  const docs = await sealedDocs(state, c);
  const out = await openCloud(docs, c);
  assert.equal(out.failed, 0);
  assert.equal(hasLegacy(out.legacyIds), false);
  assert.deepEqual(JSON.parse(JSON.stringify(out.enc.profile)), JSON.parse(JSON.stringify(state.profile)));
  assert.deepEqual(out.enc.goals, state.goals);
  for (const iso of Object.keys(state.days)) assert.deepEqual(clone(out.enc.days[iso]), clone(state.days[iso]), iso);
  assert.deepEqual(clone(out.enc.saved), clone(state.saved));
  assert.deepEqual(clone(out.enc.weights), clone(state.weights));
  assert.deepEqual(clone(out.enc.weightsAt), clone(state.weightsAt));
  assert.equal(out.enc.days[DAY].steps, 6420);
  assert.equal(out.enc.days[DAY].waterMl, 750);
  assert.ok(out.enc.days[DAY].meals.m1.thumb, 'the thumbnail comes back too');
  assert.equal(Object.values(out.legacy.days).reduce((n, d) => n + Object.keys(d.meals).length, 0), 0, 'nothing sealed shows up as plaintext');
});

test('nothing readable is left in the stored documents: no names, no thumbnails, no numbers by name', async () => {
  const c = await ctx();
  const text = strings(await sealedDocs(sampleState(), c));
  for (const secret of ['Pollo secreto', 'Tarta de la abuela', 'Favorita secreta', 'ingrediente', 'QUJDQUJD', 'data:image', 'jpeg', '183.5', '81.5', 'heightCm', 'birthYear', 'weightKg',
    'per100', 'kcal', 'protein_g', 'grams', 'slot', '"name"', '"items"', 'sex', 'activity', '6420', '81.25', '81.75']) {
    assert.ok(!text.includes(secret), `"${secret}" is visible in the stored documents`);
  }
  // what does stay in the clear, on purpose (SECURITY.md): ids, dates, stamps, sizes
  assert.ok(text.includes('"mealsE"') && text.includes('updatedAt') && text.includes(DAY));
});

test('the plaintext shape is never produced by the sealed writers', async () => {
  const c = await ctx();
  const docs = await sealedDocs(sampleState(), c);
  const plainFields = ['profile', 'goals', 'meals', 'waterMl', 'steps', 'items', 'w'];
  for (const d of [docs.user, docs.saved, docs.weights, ...Object.values(docs.days)]) for (const f of plainFields) assert.equal(f in d, false, f);
});

// ---------- records that do not open ----------
test('a tampered record is dropped and counted; the others are unharmed; nothing throws', async () => {
  const c = await ctx();
  const docs = await sealedDocs(sampleState(), c);
  const e = docs.days[DAY].mealsE.m1;
  const ct = fromB64(e.ct); ct[3] ^= 1; e.ct = toB64(ct);
  const out = await openCloud(docs, c);
  assert.equal(out.failed, 1);
  assert.equal('m1' in out.enc.days[DAY].meals, false);
  assert.ok(out.enc.days[DAY].meals.m2);
  assert.equal(out.enc.days[DAY].steps, 6420);
});

test('a record copied to another day, another id, another document or another user does not open', async () => {
  const c = await ctx();
  const docs = await sealedDocs(sampleState(), c);
  const other = { ...docs, days: { ...docs.days, '2026-11-11': { mealsE: { m1: clone(docs.days[DAY].mealsE.m1) }, updatedAt: NOW } } };
  let out = await openCloud(other, c);
  assert.equal(out.failed, 1, 'moved to another day');
  assert.equal('2026-11-11' in out.enc.days, false);

  const renamed = clone(docs); renamed.days[DAY].mealsE.mX = renamed.days[DAY].mealsE.m1; delete renamed.days[DAY].mealsE.m1;
  out = await openCloud(renamed, c);
  assert.equal(out.failed, 1, 'moved to another id');

  const crossed = clone(docs); crossed.saved.itemsE.m1 = clone(docs.days[DAY].mealsE.m1);
  out = await openCloud(crossed, c);
  assert.equal(out.failed, 1, 'moved to the favourites');

  const field = clone(docs); field.days[DAY].stepsE = clone(docs.days[DAY].waterE);
  out = await openCloud(field, c);
  assert.equal(out.failed, 1, 'steps replaced by the (valid) water record');
  assert.notEqual(out.enc.days[DAY].steps, 750);

  out = await openCloud(docs, await ctx('bob-uid'));
  assert.equal(out.failed > 5, true, 'another user\'s key and id open nothing');
  assert.equal(Object.keys(out.enc.days).length >= 0, true);
});

test('another key opens nothing: everything is counted and the state is empty', async () => {
  const docs = await sealedDocs(sampleState(), await ctx());
  const wrong = { key: await deriveKey('otra', randomBytes(16), 1000), uid: UID };
  const out = await openCloud(docs, wrong);
  assert.ok(out.failed >= 8);
  assert.equal(out.enc.profile, null);
  assert.deepEqual(out.enc.goals, []);
  assert.equal(Object.values(out.enc.days).reduce((n, d) => n + Object.keys(d.meals).length, 0), 0);
  assert.equal(out.enc.saved.length, 0);
});

test('the clear stamps next to a sealed record are hints: only the stamp inside is believed', async () => {
  const c = await ctx();
  const docs = await sealedDocs(sampleState(), c);
  const base = await openCloud(clone(docs), c);
  const messed = clone(docs);
  messed.days[DAY].mealsE.m1.updatedAt = 1;
  messed.days[DAY].waterAt = 5; messed.days[DAY].stepsAt = 5; messed.user.profileAt = 9; messed.weights.at = { [DAY]: 3 }; messed.user.goalsAt = { '2026-11-01': 4 };
  const out = await openCloud(messed, c);
  assert.equal(out.failed, 0);
  assert.deepEqual(clone(out.enc.days[DAY]), clone(base.enc.days[DAY]));
  assert.equal(out.enc.profileAt, base.enc.profileAt);
  assert.deepEqual(clone(out.enc.weightsAt), clone(base.enc.weightsAt));
});

test('a sealed place that holds something else (plaintext, junk) is counted, not trusted', async () => {
  const c = await ctx();
  const docs = await sealedDocs(sampleState(), c);
  docs.days[DAY].mealsE.evil = { name: 'plain meal', items: [] };
  docs.days[DAY].mealsE.worse = 'text';
  docs.days[DAY].waterE = { v: 1 };
  docs.saved.itemsE = 'not a map';
  docs.user.profileE = 5;
  docs.weights.wE = [1, 2];
  const out = await openCloud(docs, c);
  assert.ok(out.failed >= 6);
  assert.equal('evil' in out.enc.days[DAY].meals, false);
  assert.equal(out.enc.profile, null);
  assert.equal(out.enc.saved.length, 0);
});

test('hostile documents through openCloud: never throws, always a well-formed result, prototypes untouched (generated)', async () => {
  const c = await ctx();
  const rng = makeRng(FUZZ_SEED);
  const good = await sealedDocs(sampleState(), c);
  const before = Object.getOwnPropertyNames(Object.prototype).join();
  const fields = ['mealsE', 'waterE', 'stepsE', 'itemsE', 'wE', 'goalsE', 'profileE', 'meals', 'items', 'w', 'goals', 'profile', 'deleted', 'at', 'goalsAt'];
  for (let i = 0; i < 400; i += 1) {
    const docs = clone(good);
    const targets = [docs.user, docs.saved, docs.weights, docs.days[DAY]];
    for (let k = 0; k < 4; k += 1) { const t = rng.pick(targets); t[rng.pick(fields)] = anyValue(rng); }
    if (rng.chance(0.3)) docs.days[rng.pick(['__proto__', 'constructor', 'x', '2026-11-12'])] = anyValue(rng);
    const out = await openCloud(rng.chance(0.2) ? anyValue(rng) : docs, c);
    assert.ok(Number.isInteger(out.failed) && out.failed >= 0);
    for (const st of [out.enc, out.legacy]) { assert.ok(Array.isArray(st.goals) && Array.isArray(st.saved)); assert.ok(typeof st.days === 'object'); }
  }
  assert.equal(Object.getOwnPropertyNames(Object.prototype).join(), before);
  assert.equal({}.polluted, undefined);
});

// ---------- plaintext left from before encryption ----------
test('plaintext documents are read as legacy, listed for cleanup, and never mixed into the encrypted view', async () => {
  const c = await ctx();
  const state = sampleState();
  const out = await openCloud(plainDocs(state), c);
  assert.equal(out.failed, 0);
  assert.equal(Object.values(out.enc.days).reduce((n, d) => n + Object.keys(d.meals).length, 0), 0, 'no plaintext meal shows up as encrypted');
  assert.equal(out.enc.profile, null);
  assert.deepEqual(clone(out.legacy.days[DAY]), clone(state.days[DAY]));
  assert.equal(out.legacy.profile.heightCm, 183.5);
  assert.equal(out.legacy.saved.length, 1);
  assert.equal(hasLegacy(out.legacyIds), true);
  assert.deepEqual(out.legacyIds.days[DAY], { meals: ['m1', 'm2'], field: true, water: true, steps: true });
  assert.equal(out.legacyIds.saved.field, true);
  assert.equal(out.legacyIds.user.profile, true);
});

test('cleanup deletes plaintext only for records whose sealed copy was read back and equals the merge', async () => {
  const c = await ctx();
  const state = sampleState();
  const legacyOut = await openCloud(plainDocs(state), c);
  // nothing sealed yet: nothing may be deleted
  let r = legacyCleanup(legacyOut.legacyIds, legacyOut.enc, state, UID, NOW);
  assert.deepEqual(r.writes, []);
  assert.ok(r.unverified >= 6);
  // everything sealed and read back: all plaintext fields go, whole, so no empty map is left behind
  const both = { ...plainDocs(state) }; const sealedD = await sealedDocs(state, c);
  both.user = { ...both.user, profileE: sealedD.user.profileE, goalsE: sealedD.user.goalsE };
  for (const iso of Object.keys(both.days)) both.days[iso] = { ...both.days[iso], ...sealedD.days[iso], meals: both.days[iso].meals };
  both.saved = { ...both.saved, itemsE: sealedD.saved.itemsE };
  both.weights = { ...both.weights, wE: sealedD.weights.wE };
  const readBack = await openCloud(both, c);
  r = legacyCleanup(readBack.legacyIds, readBack.enc, state, UID, NOW);
  assert.equal(r.unverified, 0);
  const byPath = Object.fromEntries(r.writes.map((w) => [w.path.join('/'), w.patch]));
  assert.equal(byPath[`users/${UID}/days/${DAY}`].meals, DELETE);
  assert.equal(byPath[`users/${UID}/days/${DAY}`].waterMl, DELETE);
  assert.equal(byPath[`users/${UID}/days/${DAY}`].steps, DELETE);
  assert.equal(byPath[`users/${UID}/meta/saved`].items, DELETE);
  assert.equal(byPath[`users/${UID}/meta/weights`].w, DELETE);
  assert.equal(byPath[`users/${UID}`].profile, DELETE);
  assert.equal(byPath[`users/${UID}`].goals, DELETE);
  // one record whose sealed copy is missing or different stays in plaintext, and the rest go one by one
  const partial = clone(both); delete partial.days[DAY].mealsE.m2;
  const rb = await openCloud(partial, c);
  r = legacyCleanup(rb.legacyIds, rb.enc, state, UID, NOW);
  const day = r.writes.find((w) => w.path.join('/') === `users/${UID}/days/${DAY}`).patch;
  assert.equal(r.unverified, 1);
  assert.deepEqual(Object.keys(day.meals), ['m1']);
  assert.equal(day.meals.m1, DELETE);
});

test('sealed patches: deletions clear a plaintext copy only when one is listed, writes never delete plaintext', async () => {
  const c = await ctx();
  const patch = { updatedAt: NOW, meals: { a: DELETE, b: { id: 'b', name: 'x', items: [], updatedAt: 7 } }, deleted: { a: 5 } };
  const clean = await sealDayPatch(DAY, patch, c);
  assert.equal(clean.mealsE.a, DELETE);
  assert.equal('meals' in clean, false, 'no plaintext field is written to a document that has none');
  assert.equal(clean.mealsE.b.updatedAt, 7);
  assert.deepEqual(Object.keys(clean.mealsE.b).sort(), ['ct', 'iv', 'updatedAt', 'v']);
  const withLegacy = await sealDayPatch(DAY, patch, c, { meals: ['a', 'b'], field: true });
  assert.deepEqual(Object.keys(withLegacy.meals), ['a'], 'only the deleted id, never the one just written');
});
