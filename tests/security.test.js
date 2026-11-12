/* Security tests: hostile input against every cleaner and the store. Nothing here needs a browser.
   Fuzzing is seeded and deterministic; replay a failure with FOODIE_FUZZ_SEED=<seed from the message>. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../app/core/schema.js';
import { cleanProfile } from '../app/core/goals.js';
import { addDays } from '../app/core/dates.js';
import * as storeModule from '../app/data/store.js';
import { h } from '../app/ui/dom.js';
import { makeRng, FUZZ_SEED } from './helpers/prng.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installFakeDom, htmlWrites, allText, walk } from './helpers/fake-dom.js';
import {
  XSS_CORPUS, HOSTILE_KEYS, FORBIDDEN_CHARS, anyValue, mutate, deepNest, withOwnKey, boobyTrap,
} from './helpers/hostile.js';
import * as inv from './helpers/invariants.js';

const { createStore, STORAGE_KEYS } = storeModule;
const MAX_STORED_CHARS = 5 * 1024 * 1024;                       // the policy: a stored value over 5 MB is not parsed
const isStoreKey = (k) => (storeModule.isStoreKey ? storeModule.isStoreKey(k) : false);
const LIMITS = { mealsPerDay: 100, days: 4000, weights: 4000, saved: 300 };
const cp = (...codes) => String.fromCodePoint(...codes);
const DAY = '2026-11-12';
const plain = (x) => JSON.parse(JSON.stringify(x));
const protoNames = () => Object.getOwnPropertyNames(Object.prototype).sort().join();
const PROTO_BEFORE = protoNames();

function assertPrototypeIntact(where) {
  assert.equal(protoNames(), PROTO_BEFORE, `${where}: Object.prototype changed`);
  assert.equal(Object.getPrototypeOf(Object.prototype), null, `${where}: Object.prototype got a prototype`);
  const o = {};
  for (const k of ['x', 'id', 'name', 'meals', 'kcal', 'items', 'polluted', 'isAdmin']) assert.equal(o[k], undefined, `${where}: ({}).${k} is defined`);
}

const store = (initial, env = {}) => {
  let n = 0;
  return createStore(memoryStorage(initial), { uuid: () => `id-${++n}`, now: () => new Date(2026, 10, 12, 9, 30), ...env });
};
const per100 = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const meal = (over = {}) => ({ name: 'Pollo', slot: 'Almuerzo', source: 'db', items: [{ name: 'Pollo', grams: 150, per100 }], ...over });

// ---------------------------------------------------------------------------------------------
// Fuzzing every cleaner
// ---------------------------------------------------------------------------------------------

const SPECS = [
  { name: 'cleanPer100', fn: schema.cleanPer100, base: inv.validPer100, check: (o) => (o === null ? '' : inv.per100Problem(o)) },
  { name: 'cleanItem', fn: schema.cleanItem, base: inv.validItem, check: (o) => (o === null ? '' : inv.itemProblem(o)) },
  { name: 'cleanMeal', fn: schema.cleanMeal, base: () => inv.validMeal(), check: (o) => (o === null ? '' : inv.mealProblem(o)) },
  { name: 'cleanDay', fn: schema.cleanDay, base: inv.validDay, check: (o) => (o === null ? '' : inv.dayProblem(o)) },
  { name: 'cleanDays', fn: schema.cleanDays, base: inv.validDays, check: inv.daysProblem },
  { name: 'cleanGoals', fn: schema.cleanGoals, base: inv.validGoals, check: (o) => (o === null ? '' : inv.goalsProblem(o)) },
  { name: 'cleanGoalsHistory', fn: schema.cleanGoalsHistory, base: inv.validHistory, check: inv.historyProblem },
  { name: 'cleanSaved', fn: schema.cleanSaved, base: inv.validSaved, check: inv.savedProblem },
  { name: 'cleanWeights', fn: schema.cleanWeights, base: inv.validWeights, check: inv.weightsProblem },
  { name: 'cleanProfile', fn: (x) => cleanProfile(x), base: inv.validProfile, check: (o) => (o === null ? '' : inv.profileProblem(o)) },
  { name: 'cleanFood', fn: schema.cleanFood, base: () => ({ id: 'f1', name: 'Pollo', aliases: ['ave'], portion: { label: '1 filete (120 g)', grams: 120 }, per100: inv.validPer100() }),
    check: (o) => (o === null ? '' : (inv.idProblem(o.id) || inv.textProblem(o.name, 120, 'food.name') || inv.per100Problem(o.per100)
      || (o.aliases.length > 20 ? 'too many aliases' : '') || o.aliases.map((a) => inv.textProblem(a, 60, 'alias')).find(Boolean)
      || inv.textProblem(o.portion.label, 60, 'portion.label') || (o.portion.grams > 0 && o.portion.grams <= 1000 ? '' : 'portion.grams'))) },
];

const PER_CLEANER = 3000;

function describe(input) {
  try { return JSON.stringify(input, (k, v) => (typeof v === 'string' && v.length > 60 ? `${v.slice(0, 60)}...(${v.length})` : typeof v === 'bigint' ? `${v}n` : v)).slice(0, 400); } catch (e) { return '(not printable)'; }
}

function fuzzOne(spec, seed) {
  const rng = makeRng(seed);
  let hostile = 0;
  for (let i = 0; i < PER_CLEANER; i += 1) {
    const roll = rng.next();
    const input = roll < 0.30 ? anyValue(rng) : roll < 0.33 ? deepNest(rng.int(100, 3000), (v) => (rng.chance(0.5) ? [v] : { meals: v, items: v, id: v })) : mutate(rng, spec.base());
    const where = `${spec.name} seed=${seed} iteration=${i}`;
    let out;
    try { out = spec.fn(input); } catch (e) { assert.fail(`${where}: threw ${e && e.message}\ninput: ${describe(input)}`); }
    const fail = (what) => assert.fail(`${where}: ${what}
input: ${describe(input)}`);   // the message is built only when something is wrong
    const problem = spec.check(out);
    if (problem) fail(problem);
    if (out === null) { hostile += 1; continue; }
    const json = JSON.stringify(out);
    if (JSON.stringify(spec.fn(out)) !== json) fail('not idempotent');
    if (JSON.stringify(spec.fn(JSON.parse(json))) !== json) fail('JSON round trip is not stable');
  }
  return hostile;
}

test(`fuzz: ${SPECS.length} cleaners x ${PER_CLEANER} hostile inputs (seed ${FUZZ_SEED}): never throw, valid shape, idempotent, stable through JSON, prototype untouched`, (t) => {
  const started = Date.now();
  let total = 0;
  SPECS.forEach((spec, k) => {
    const rejected = fuzzOne(spec, FUZZ_SEED + k * 7919);
    total += PER_CLEANER;
    t.diagnostic(`${spec.name}: ${PER_CLEANER} inputs, ${rejected} rejected`);
  });
  assertPrototypeIntact('after fuzzing');
  assert.ok(total >= 20000);
  t.diagnostic(`${total} generated inputs in ${Date.now() - started} ms, seed ${FUZZ_SEED}`);
});

test('fuzz: throwing getters and proxies are invalid input, not exceptions', () => {
  const rng = makeRng(FUZZ_SEED);
  for (const spec of SPECS) {
    for (let i = 0; i < 200; i += 1) assert.doesNotThrow(() => spec.fn(boobyTrap(rng)), `${spec.name} threw on a trap (seed ${FUZZ_SEED})`);
  }
  const trapped = { id: 'a', get items() { throw new Error('boom'); } };
  assert.equal(schema.cleanMeal(trapped), null);
  assert.equal(schema.cleanDay({ get meals() { throw new Error('boom'); } }), null);
});

test('fuzz: a valid value is cleaned to itself (the generators and the cleaners agree)', () => {
  for (const spec of SPECS) {
    const base = spec.base();
    const out = spec.fn(base);
    assert.notEqual(out, null, spec.name);
    assert.equal(spec.check(out), '', spec.name);
  }
});

// ---------------------------------------------------------------------------------------------
// Defect 2: ids
// ---------------------------------------------------------------------------------------------

const BAD_IDS = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '', ' ', 'a b', 'a.b', 'a/b', '../x', 'x'.repeat(65),
  cp(0xE9), cp(0x202E) + 'a', 'a' + cp(0), '<script>', 'id\n', 42, null, undefined, {}, [], true];

test('defect 2: meal ids must be 1-64 of A-Z a-z 0-9 _ - and never a name from Object.prototype', () => {
  for (const id of BAD_IDS) assert.equal(schema.cleanMeal({ id, name: 'x', items: meal().items }), null, JSON.stringify(id));
  for (const id of ['a', 'A_b-9', 'x'.repeat(64), '3f2b8a52-6f7d-4c5e-9d2e-1a2b3c4d5e6f', 'm-lq3x9-ab12cd34', '123']) {
    assert.equal(schema.cleanMeal({ id, name: 'x', items: meal().items }).id, id);
  }
  assert.equal(schema.isId('__proto__'), false);
  assert.equal(schema.isId('ok-1'), true);
});

test('defect 2: a hostile id in a stored day cannot replace the prototype of the meals map or shadow a builtin', () => {
  const mk = (id) => ({ id, name: 'evil', slot: 'Cena', time: '20:00', source: 'db', items: meal().items });
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype']) {
    const day = schema.cleanDay(JSON.parse(`{"meals": {"${id}": ${JSON.stringify(mk(id))}, "ok": ${JSON.stringify(mk('ok'))}}, "waterMl": 0, "steps": 0}`));
    assert.deepEqual(Object.keys(day.meals), ['ok'], id);
    assert.equal(Object.getPrototypeOf(day.meals), null, id);
    assert.equal(day.meals.constructor, undefined, id);
    assert.equal(day.meals.toString, undefined, id);
    assertPrototypeIntact(id);
  }
  // the same through the real loading path
  const evil = `{"${DAY}": {"meals": {"__proto__": ${JSON.stringify(mk('__proto__'))}, "constructor": ${JSON.stringify(mk('constructor'))}, "good": ${JSON.stringify(mk('good'))}}}}`;
  const s = store({ [STORAGE_KEYS.days]: evil });
  assert.deepEqual(s.mealsOf(DAY).map((m) => m.id), ['good']);
  assert.equal(Object.getPrototypeOf(s.getDay(DAY).meals), null);
  assertPrototypeIntact('store load');
});

test('defect 2: JSON.stringify of a cleaned day is exactly what it was before (maps without a prototype serialize the same)', () => {
  const day = schema.cleanDay({ meals: { b: { id: 'b', name: 'B', slot: 'Cena', time: '21:00', source: 'db', items: [{ name: 'x', grams: 10, per100: { kcal: 10 } }] } }, waterMl: 250, steps: 3 });
  assert.equal(JSON.stringify(day), '{"meals":{"b":{"id":"b","name":"B","slot":"Cena","time":"21:00","source":"db","items":[{"name":"x","grams":10,"per100":{"kcal":10}}]}},"waterMl":250,"steps":3}');
  assert.equal(JSON.stringify(schema.cleanWeights({ [DAY]: 80 })), `{"${DAY}":80}`);
});

test('defect 2: addMeal, updateMeal, deleteMeal, duplicateMeal, removeSaved and saveMeal with hostile ids change nothing and do not throw', () => {
  const s = store();
  const good = s.addMeal(DAY, meal());
  const fav = s.saveMeal(good).meal;
  const beforeDays = JSON.stringify(s.getDays());
  const beforeSaved = JSON.stringify(s.getSaved());
  const trap = { toString() { throw new Error('boom'); } };
  for (const id of [...BAD_IDS, trap]) {
    if (id !== '' && id !== null && id !== undefined) assert.equal(s.addMeal(DAY, { ...meal(), id }), null, `addMeal ${String(typeof id === 'object' ? 'obj' : id)}`);   // no id at all means "make one"
    assert.equal(s.updateMeal(DAY, { ...good, id }), null, 'updateMeal');
    assert.equal(s.deleteMeal(DAY, id), null, 'deleteMeal');
    assert.equal(s.duplicateMeal(DAY, id, '2026-11-13'), null, 'duplicateMeal');
    assert.equal(s.removeSaved(id), null, 'removeSaved');
  }
  assert.equal(s.saveMeal({ ...good, id: '__proto__' }, { keepId: true }).meal.id === '__proto__', false, 'saveMeal keeps no hostile id');
  assert.equal(JSON.stringify(s.getDays()), beforeDays);
  assert.equal(JSON.stringify(s.getSaved()), beforeSaved);
  assert.equal(s.mealsOf(DAY).length, 1);
  assert.equal(s.mealsOf(DAY)[0].id, good.id);
  assertPrototypeIntact('store methods');
});

test('defect 2: hostile dates are refused too (a date is also a key)', () => {
  const s = store();
  for (const iso of ['__proto__', 'constructor', '2026-13-40', '', null, {}, 'x'.repeat(5000)]) {
    assert.equal(s.addMeal(iso, meal()), null);
    assert.equal(s.addWater(iso, 250), null);
    assert.equal(s.setSteps(iso, 5), null);
    assert.equal(s.logWeight(iso, 80), null);
    assert.deepEqual(s.mealsOf(iso), []);
    assert.deepEqual(plain(s.getDay(iso)), { meals: {}, waterMl: 0, steps: 0 });
  }
  assertPrototypeIntact('hostile dates');
});

// ---------------------------------------------------------------------------------------------
// Defect 3: free text
// ---------------------------------------------------------------------------------------------

test('defect 3: control, zero-width and bidi characters are removed from names and whitespace is collapsed', () => {
  const dirty = cp(0x202E) + 'ev' + cp(0) + 'il' + cp(0x200B) + ' ' + cp(10) + '  na' + cp(0x2066) + 'me' + cp(0x2069) + cp(0xFEFF) + cp(9) + 'x ';
  assert.equal(schema.cleanText(dirty, 80), 'evil name x');
  const m = schema.cleanMeal({ id: 'a', name: dirty, items: [{ name: dirty, grams: 1, per100 }] });
  assert.equal(m.name, 'evil name x');
  assert.equal(m.items[0].name, 'evil name x');
  for (let c = 0; c < 0x20; c += 1) assert.ok(!FORBIDDEN_CHARS.test(schema.cleanText(`a${cp(c)}b`, 10)), `C0 ${c}`);
  for (let c = 0x7F; c <= 0x9F; c += 1) assert.ok(!FORBIDDEN_CHARS.test(schema.cleanText(`a${cp(c)}b`, 10)), `C1 ${c}`);
  for (const c of [0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0xFEFF, 0x2028, 0x2029]) {
    assert.equal(schema.cleanText(`a${cp(c)}b`, 10).replace(' ', ''), 'ab', `U+${c.toString(16)}`);
  }
});

test('defect 3: a name made only of invisible characters is empty (an item with it is rejected, a meal falls back to its items)', () => {
  const ghost = cp(0x200B, 0x202E, 0, 0xFEFF, 32, 9);
  assert.equal(schema.cleanText(ghost, 80), '');
  assert.equal(schema.cleanItem({ name: ghost, grams: 1, per100 }), null);
  assert.equal(schema.cleanMeal({ id: 'a', name: ghost, items: meal().items }).name, 'Pollo');
});

test('defect 3: text is cut by code points: no half surrogate pair, whatever the offset', () => {
  for (let prefix = 0; prefix < 4; prefix += 1) {
    const long = 'x'.repeat(prefix) + cp(0x1F600).repeat(200);
    for (const [max, name] of [[80, 'meal'], [120, 'item']]) {
      const m = schema.cleanMeal({ id: 'a', name: long, items: [{ name: long, grams: 1, per100 }] });
      const t = name === 'meal' ? m.name : m.items[0].name;
      assert.equal(inv.textProblem(t, max, name), '', `prefix ${prefix} ${name}`);
      assert.equal(Array.from(t).length, max, `prefix ${prefix}: ${name} keeps ${max} code points`);
    }
  }
  assert.equal(schema.cleanText('ab' + cp(0xD83D), 10), 'ab');                  // a lone high surrogate is dropped
  assert.equal(schema.cleanText(cp(0xDE00) + 'ab', 10), 'ab');
  assert.equal(schema.cleanText(cp(0x1F600) + 'ab', 2), cp(0x1F600) + 'a');
});

test('defect 3: the name generated from the items is bounded too (it used to reach 362 characters)', () => {
  const items = ['a', 'b', 'c'].map((c) => ({ name: c.repeat(120), grams: 1, per100 }));
  const m = schema.cleanMeal({ id: 'x', items });
  assert.ok(Array.from(m.name).length <= 80);
  assert.equal(inv.mealProblem(m), '');
});

test('defect 3: cleaning text is idempotent and leaves ordinary Spanish text alone', () => {
  for (const s of ['Pechuga de pollo a la plancha', 'Ni' + cp(0xF1) + 'o ' + cp(0xE9) + ' ' + cp(0xFC) + 'ber', 'Arroz con leche (casero) 100 %', cp(0x1F600) + ' emoji']) assert.equal(schema.cleanText(s, 80), s);
  for (const s of XSS_CORPUS) assert.equal(schema.cleanText(schema.cleanText(s, 80), 80), schema.cleanText(s, 80));
});

// ---------------------------------------------------------------------------------------------
// Defect 5: caps
// ---------------------------------------------------------------------------------------------

const manyMeals = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, { id: `m${i}`, name: 'x', items: meal().items }]));
const isoRange = (n, start = '2000-01-01') => Array.from({ length: n }, (_, i) => addDays(start, i));

test('defect 5: at most 100 meals per day, when cleaning and when adding', () => {
  assert.equal(Object.keys(schema.cleanDay({ meals: manyMeals(250) }).meals).length, LIMITS.mealsPerDay);
  const s = store();
  for (let i = 0; i < LIMITS.mealsPerDay; i += 1) assert.ok(s.addMeal(DAY, meal()), `meal ${i}`);
  assert.equal(s.addMeal(DAY, meal()), null);
  assert.equal(s.mealsOf(DAY).length, 100);
  assert.equal(s.duplicateMeal(DAY, s.mealsOf(DAY)[0].id, DAY), null);
  // replacing a meal that is already there is still allowed on a full day
  const first = s.mealsOf(DAY)[0];
  assert.ok(s.addMeal(DAY, { ...first, name: 'changed' }));
  assert.equal(s.mealsOf(DAY).length, 100);
  assert.ok(s.duplicateMeal(DAY, first.id, '2026-11-13'));
});

test('defect 5: at most 4000 days are kept and the oldest are dropped first', () => {
  const dates = isoRange(4100);
  const raw = Object.fromEntries(dates.map((iso) => [iso, { meals: manyMeals(1), waterMl: 0, steps: 0 }]));
  const days = schema.cleanDays(raw);
  const keys = Object.keys(days).sort();
  assert.equal(keys.length, LIMITS.days);
  assert.equal(keys[0], dates[100]);
  assert.equal(keys[keys.length - 1], dates[4099]);
  // through the store: loading and adding a newer day
  const s = store({ [STORAGE_KEYS.days]: JSON.stringify(raw) });
  assert.equal(Object.keys(s.getDays()).length, 4000);
  assert.ok(s.addMeal('2026-11-12', meal()));
  assert.equal(Object.keys(s.getDays()).length, 4000);
  assert.equal(Object.keys(s.getDays()).sort()[0], dates[101]);
  // a day older than everything kept falls off at once, and the store says so
  assert.equal(s.addMeal('1990-01-01', meal()), null);
  assert.equal(s.mealsOf('1990-01-01').length, 0);
});

test('defect 5: at most 4000 weights are kept, the oldest dropped first', () => {
  const dates = isoRange(4100, '2000-01-01');
  const w = schema.cleanWeights(Object.fromEntries(dates.map((iso) => [iso, 80])));
  assert.equal(Object.keys(w).length, LIMITS.weights);
  assert.equal(Object.keys(w).sort()[0], dates[100]);
  const s = store({ [STORAGE_KEYS.weights]: JSON.stringify(Object.fromEntries(dates.map((iso) => [iso, 80]))) });
  assert.equal(Object.keys(s.getWeights()).length, 4000);
  assert.equal(s.logWeight('2026-11-12', 79.5), 79.5);
  assert.equal(Object.keys(s.getWeights()).length, 4000);
  assert.equal(s.logWeight('1990-01-01', 70), null);                         // older than everything kept
});

test('defect 5: at most 300 favourites; the 301st is refused, not silently dropped', () => {
  assert.equal(schema.cleanSaved(Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, name: 'x', items: meal().items }))).length, LIMITS.saved);
  const s = store();
  for (let i = 0; i < LIMITS.saved; i += 1) assert.equal(s.saveMeal({ ...meal({ name: `Comida ${i}` }), id: 'src' }).added, true);
  const r = s.saveMeal({ ...meal({ name: 'one more' }), id: 'src' });
  assert.deepEqual(r, { meal: null, added: false, full: true });
  assert.equal(s.getSaved().length, 300);
});

test('defect 5: a stored value over 5 MB is not parsed, is treated as empty, and is reported through the storage-error listener', () => {
  const big = 'x'.repeat(6 * 1024 * 1024);
  let parsed = 0;
  const realParse = JSON.parse;
  JSON.parse = (...a) => { parsed += 1; return realParse(...a); };
  let s;
  try {
    s = store({ [STORAGE_KEYS.days]: big, [STORAGE_KEYS.profile]: JSON.stringify({ sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain' }) });
  } finally { JSON.parse = realParse; }
  assert.equal(parsed, 1, 'only the small profile value is parsed');
  assert.deepEqual(plain(s.getDays()), {});
  assert.ok(s.getProfile(), 'the other keys still load');
  const seen = [];
  s.onStorageError((e) => seen.push([e.kind, e.key]));          // registered after loading: the problem is replayed
  assert.deepEqual(seen, [['too-large', STORAGE_KEYS.days]]);
  // a value exactly at the limit is still read; one character more is not
  const atLimit = `"${'a'.repeat(MAX_STORED_CHARS - 2)}"`;
  assert.equal(atLimit.length, MAX_STORED_CHARS);
  const errors = [];
  const s2 = store({ [STORAGE_KEYS.saved]: atLimit, [STORAGE_KEYS.weights]: `${atLimit}x` });
  s2.onStorageError((e) => errors.push(e.kind));
  assert.deepEqual(errors, ['too-large']);
  assert.deepEqual(s2.getSaved(), []);
});

test('defect 5: reload() reports a value that became too large in another tab', () => {
  const st = memoryStorage();
  const s = createStore(st, { uuid: () => 'u1' });
  const kinds = [];
  s.onStorageError((e) => kinds.push(e.kind));
  st.m.set(STORAGE_KEYS.days, 'y'.repeat(MAX_STORED_CHARS + 1));
  s.reload();
  assert.deepEqual(kinds, ['too-large']);
});

// ---------------------------------------------------------------------------------------------
// Defect 6: the rest of the review
// ---------------------------------------------------------------------------------------------

test('defect 6: logWeight spreads nothing from outside: hostile dates and values are refused and the map stays prototype-less', () => {
  const s = store();
  for (const kg of ['80', {}, [80], NaN, Infinity, -0, null, undefined, 29.9, 300.1, trapValue()]) assert.equal(s.logWeight(DAY, kg), null, String(typeof kg));
  assert.equal(s.logWeight(DAY, 80.04), 80);
  assert.equal(Object.getPrototypeOf(s.getWeights()), null);
  assertPrototypeIntact('logWeight');
});
function trapValue() { return { valueOf() { throw new Error('boom'); }, toString() { throw new Error('boom'); } }; }

test('defect 6: exportAll is a copy with plain data: changing it cannot change the store, and it survives JSON', () => {
  const s = store();
  s.saveProfile({ sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain' });
  s.addMeal(DAY, meal());
  const out = s.exportAll();
  out.days[DAY].meals[Object.keys(out.days[DAY].meals)[0]].name = 'tampered';
  out.profile.sex = 'female';
  assert.equal(s.mealsOf(DAY)[0].name, 'Pollo');
  assert.equal(s.getProfile().sex, 'male');
  assert.deepEqual(plain(out).days[DAY].meals, plain(out.days[DAY].meals));
  assert.equal(out.app, 'foodie');
  assert.match(out.exportedAt, /^2026-11-12T/);
});

test('defect 6: clearAll never throws, and tells the user when the data could not really be removed', () => {
  const st = memoryStorage({ [STORAGE_KEYS.days]: '{}' }, { failRemove: true });
  const s = createStore(st);
  const errors = [];
  s.onStorageError((e) => errors.push(e.kind));
  assert.doesNotThrow(() => s.clearAll());
  assert.ok(errors.includes('write'));
  assert.equal(s.persistent, false);
  assert.equal(s.getProfile(), null);
});

test('defect 6: only this app\'s keys (or a clear of the whole storage) count as a storage event', () => {
  for (const k of Object.values(STORAGE_KEYS)) assert.equal(isStoreKey(k), true, k);
  assert.equal(isStoreKey(null), true);
  for (const k of ['fd.theme', 'other-app', 'fd.', 'fd.profile2', '', undefined, '__proto__', 'constructor']) assert.equal(isStoreKey(k), false, String(k));
});

test('defect 6: addWater, setWater, setSteps and logWeight take numbers only', () => {
  const s = store();
  for (const bad of [NaN, Infinity, '250', {}, [250], null, undefined, trapValue()]) {
    assert.doesNotThrow(() => s.addWater(DAY, bad));
    assert.equal(s.getDay(DAY).waterMl, 0, String(typeof bad));
  }
  assert.equal(s.setWater(DAY, 'abc'), 0);
  assert.equal(s.setWater(DAY, 5e9), 20000);
  assert.doesNotThrow(() => s.setSteps(DAY, trapValue()));
});

test('defect 6: food table entries are cleaned like user text before they reach a meal', () => {
  const evil = { id: 'f1', name: `  ${cp(0x202E)}Pollo${cp(0)} <b>x</b>  `, aliases: ['ok', cp(0x200B), 5, XSS_CORPUS[0], '', 'x'.repeat(500)], portion: { label: `1 filete${cp(10)}(120 g)`, grams: 120 }, per100: { ...per100, evil: 1 } };
  const food = schema.cleanFood(evil);
  assert.equal(food.name, 'Pollo <b>x</b>');
  assert.deepEqual(food.aliases.slice(0, 3), ['ok', XSS_CORPUS[0], 'x'.repeat(60)]);
  assert.equal(food.portion.label, '1 filete (120 g)');
  assert.deepEqual(Object.keys(food.per100), ['kcal', 'protein_g', 'carbs_g', 'fat_g']);
  for (const bad of [null, 'x', [], { ...evil, id: '__proto__' }, { ...evil, id: 'a b' }, { ...evil, name: cp(0x200B) }, { ...evil, per100: null },
    { ...evil, portion: { label: 'x', grams: 0 } }, { ...evil, portion: { label: 'x', grams: 5000 } }, { ...evil, portion: null }, { ...evil, portion: { label: cp(0), grams: 10 } }]) {
    assert.equal(schema.cleanFood(bad), null, JSON.stringify(bad));
  }
  // the real table passes through unchanged
  assert.equal(schema.cleanFood(JSON.parse('{"id":"a","name":"A","aliases":[],"portion":{"label":"1 (10 g)","grams":10},"per100":{"kcal":1}}')).name, 'A');
});

test('defect 6: add-food cleans the food table with cleanFood (no raw JSON reaches a meal)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../app/ui/screens/add-food.js', import.meta.url), 'utf8');
  assert.match(src, /cleanFood/);
  assert.doesNotMatch(src, /cleanPer100\(f\.per100\)/);
});

test('defect 6: every food in the shipped table survives cleanFood unchanged', async () => {
  const { readFileSync } = await import('node:fs');
  const foods = JSON.parse(readFileSync(new URL('../app/data/foods.es.json', import.meta.url), 'utf8'));
  for (const f of foods) assert.deepEqual(plain(schema.cleanFood(f)), plain(f), f.id);
});

// ---------------------------------------------------------------------------------------------
// XSS corpus through the store, rendered through the DOM helper
// ---------------------------------------------------------------------------------------------

test('XSS corpus: every payload comes back from the store as a plain, bounded, single-line string', () => {
  const s = store();
  const payloads = [...XSS_CORPUS, ...HOSTILE_KEYS];
  for (const [i, p] of payloads.entries()) {
    const day = addDays('2026-01-01', i);
    const m = s.addMeal(day, { id: `p${i}`, name: p, slot: 'Cena', source: 'ai', items: [{ name: p, grams: 10, per100 }, { name: `${p} 2`, grams: 5, per100 }] });
    const saved = s.saveMeal({ id: `q${i}`, name: p, items: [{ name: p, grams: 10, per100 }] });
    for (const stored of [m, saved && saved.meal].filter(Boolean)) {
      assert.equal(inv.mealProblem(stored), '', `payload ${i}: ${p.slice(0, 40)}`);
      assert.ok(typeof stored.name === 'string');
    }
    // data that is already clean text is kept exactly (it is escaped when drawn, not mangled when stored)
    const trimmed = p.trim();
    if (!FORBIDDEN_CHARS.test(p) && !/\s\s/.test(trimmed) && Array.from(trimmed).length <= 80 && !/[\uD800-\uDFFF]/.test(trimmed) && trimmed) {
      assert.equal(m.name, trimmed, `payload ${i} should be kept as typed`);
    }
  }
  // and the whole store still round-trips through JSON (what localStorage holds)
  const again = createStore(memoryStorage(Object.fromEntries(['days', 'saved'].map((k) => [STORAGE_KEYS[k], JSON.stringify(k === 'days' ? s.getDays() : s.getSaved())]))));
  assert.equal(again.getSaved().length, s.getSaved().length);
  assert.equal(Object.keys(again.getDays()).length, Object.keys(s.getDays()).length);
  assertPrototypeIntact('xss corpus');
});

test('XSS corpus: payloads in food-table entries are cleaned and bounded', () => {
  for (const p of XSS_CORPUS) {
    const food = schema.cleanFood({ id: 'f', name: p, aliases: [p], portion: { label: p, grams: 10 }, per100 });
    if (food === null) continue;                                       // e.g. a name that is only invisible characters
    assert.equal(inv.textProblem(food.name, 120, 'name'), '');
    assert.equal(inv.textProblem(food.portion.label, 60, 'label'), '');
    for (const a of food.aliases) assert.equal(inv.textProblem(a, 60, 'alias'), '');
  }
});

test('XSS corpus: drawn with the DOM helper, every payload is a text node, never markup, never a handler', () => {
  const dom = installFakeDom();
  try {
    const writesBefore = htmlWrites.length;
    for (const p of XSS_CORPUS) {
      const stored = schema.cleanText(p, 80);
      const row = h('li', { class: 'meal' }, h('span', { title: stored, 'aria-label': stored }, stored), h('button', { dataset: { id: stored } }, stored));
      const nodes = walk(row);
      assert.equal(allText(row), stored + stored, 'text is drawn as text');
      assert.deepEqual(nodes.filter((n) => n.nodeType === 1).map((n) => n.tagName), ['li', 'span', 'button'], 'no element came out of the text');
      for (const el of nodes.filter((n) => n.nodeType === 1)) {
        for (const name of el.attributes.keys()) assert.ok(!/^on/i.test(name) && name !== 'srcdoc', `attribute ${name}`);
        assert.deepEqual(el.listeners, []);
      }
    }
    assert.equal(htmlWrites.length, writesBefore, 'nothing was written as HTML');
    assert.ok(dom.doc.created.every((e) => ['li', 'span', 'button'].includes(e.tagName)));
  } finally { dom.restore(); }
});

// ---------------------------------------------------------------------------------------------
// The store under attack
// ---------------------------------------------------------------------------------------------

const GOOD = {
  profile: JSON.stringify({ sex: 'female', age: 30, heightCm: 165, weightKg: 60, activity: 'light', goal: 'lose', pace: 0.2 }),
  days: JSON.stringify({ [DAY]: { meals: { a: { id: 'a', name: 'Good', slot: 'Cena', time: '20:00', source: 'db', items: meal().items } }, waterMl: 500, steps: 100 } }),
};

test('store attack: corrupted JSON in each key loads to a valid state, and only that key is lost', () => {
  for (const key of Object.keys(STORAGE_KEYS)) {
    const initial = { [STORAGE_KEYS.profile]: GOOD.profile, [STORAGE_KEYS.days]: GOOD.days, [STORAGE_KEYS[key]]: '{"broken": ' };
    let s;
    assert.doesNotThrow(() => { s = store(initial); }, key);
    const errors = [];
    s.onStorageError((e) => errors.push(`${e.kind}:${e.key}`));
    assert.deepEqual(errors, [`corrupt:${STORAGE_KEYS[key]}`], key);
    assert.equal(!!s.getProfile(), key !== 'profile', key);
    assert.equal(s.mealsOf(DAY).length, key === 'days' ? 0 : 1, key);
  }
});

test('store attack: every key holding the wrong type loads to an empty, valid state', () => {
  const wrong = ['null', 'true', '0', '"text"', '[]', '[1,2,3]', '{}', '{"a":1}', '[[[[]]]]', '1e999', '-0', '"__proto__"', '{"__proto__":{"polluted":1}}', '[{"__proto__":{"polluted":1}}]'];
  for (const value of wrong) {
    const s = store(Object.fromEntries(Object.values(STORAGE_KEYS).map((k) => [k, value])));
    assert.equal(s.getProfile(), null, value);
    assert.deepEqual(s.getGoalHistory(), [], value);
    assert.deepEqual(plain(s.getDays()), {}, value);
    assert.deepEqual(s.getSaved(), [], value);
    assert.deepEqual(plain(s.getWeights()), {}, value);
    assert.equal(s.goalsFor(DAY), null);
    assert.doesNotThrow(() => { s.exportAll(); s.loggedDays(); s.mealsOf(DAY); });
    assert.equal(({}).polluted, undefined, `${value} polluted Object.prototype`);
  }
  assertPrototypeIntact('wrong types');
});

test('store attack: __proto__ keys in stored JSON do not reach Object.prototype or the maps', () => {
  const days = `{"__proto__": {"meals": {}, "waterMl": 5}, "${DAY}": {"__proto__": {"polluted": true}, "meals": {"__proto__": {"id": "a", "polluted": true}}, "waterMl": 7}}`;
  const weights = `{"__proto__": 80, "constructor": 81, "${DAY}": 79}`;
  const s = store({ [STORAGE_KEYS.days]: days, [STORAGE_KEYS.weights]: weights });
  assert.deepEqual(Object.keys(s.getDays()), [DAY]);
  assert.equal(s.getDay(DAY).waterMl, 7);
  assert.deepEqual(Object.keys(s.getWeights()), [DAY]);
  assertPrototypeIntact('__proto__ in storage');
});

test('store attack: a storage that throws on get, set and remove still gives a working in-memory store', () => {
  for (const failures of [{ failGet: true }, { failSet: true }, { failRemove: true }, { failGet: true, failSet: true, failRemove: true }]) {
    let s;
    assert.doesNotThrow(() => { s = createStore(memoryStorage({ [STORAGE_KEYS.days]: GOOD.days }, failures)); }, JSON.stringify(failures));
    const kinds = [];
    s.onStorageError((e) => kinds.push(e.kind));
    assert.doesNotThrow(() => {
      s.addMeal(DAY, meal());
      s.addWater(DAY, 250);
      s.saveProfile({ sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain' });
      s.logWeight(DAY, 80);
      s.exportAll();
      s.clearAll();
    }, JSON.stringify(failures));
    if (failures.failSet || failures.failRemove) assert.ok(kinds.includes('write'), JSON.stringify(failures));
    if (failures.failSet) assert.equal(s.persistent, false);
  }
});

test('store attack: a storage that returns something that is not a string, or a getItem that returns garbage types', () => {
  for (const value of [42, {}, [], true, Symbol.iterator, () => 1, undefined]) {
    const st = { getItem: () => value, setItem() {}, removeItem() {} };
    assert.doesNotThrow(() => createStore(st), String(typeof value));
  }
});

test('store attack: hostile input to every mutator never throws and never corrupts the state', () => {
  const rng = makeRng(FUZZ_SEED);
  const s = store();
  s.saveProfile({ sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain' });
  s.addMeal(DAY, meal());
  for (let i = 0; i < 1500; i += 1) {
    const a = anyValue(rng);
    const b = anyValue(rng);
    const mealLike = mutate(rng, { id: 'x1', name: 'n', slot: 'Cena', time: '10:00', source: 'db', items: meal().items });
    const iso = rng.chance(0.5) ? DAY : anyValue(rng);
    const calls = [
      () => s.saveProfile(a), () => s.setGoals(a, b), () => s.addMeal(iso, mealLike), () => s.updateMeal(iso, mealLike, { silent: rng.chance(0.5) }),
      () => s.deleteMeal(iso, a), () => s.duplicateMeal(iso, a, b), () => s.addWater(iso, a), () => s.setWater(iso, a), () => s.setSteps(iso, a),
      () => s.saveMeal(mealLike, { keepId: rng.chance(0.5) }), () => s.removeSaved(a), () => s.logWeight(iso, a),
      () => s.goalsFor(a), () => s.getDay(a), () => s.mealsOf(a),
    ];
    const call = rng.pick(calls);
    try { call(); } catch (e) { assert.fail(`a mutator threw (seed ${FUZZ_SEED}, iteration ${i}): ${e && e.message}`); }
  }
  // whatever happened, the state is still valid
  assert.equal(inv.daysProblem(s.getDays()), '');
  assert.equal(inv.savedProblem(s.getSaved()), '');
  assert.equal(inv.weightsProblem(s.getWeights()), '');
  assert.equal(inv.historyProblem(s.getGoalHistory()), '');
  assertPrototypeIntact('mutator fuzzing');
});

test('store attack: an export of hostile data re-imports to the same data', () => {
  const s = store();
  for (const [i, p] of XSS_CORPUS.entries()) s.addMeal(addDays('2026-03-01', i), { id: `e${i}`, name: p, items: [{ name: p, grams: 1, per100 }] });
  const dumped = JSON.stringify(s.exportAll());
  const back = JSON.parse(dumped);
  const s2 = createStore(memoryStorage({ [STORAGE_KEYS.days]: JSON.stringify(back.days), [STORAGE_KEYS.saved]: JSON.stringify(back.saved) }));
  assert.equal(JSON.stringify(s2.getDays()), JSON.stringify(s.getDays()));
});

test('store attack: the helpers really produce hostile data (the suite would notice if they stopped)', () => {
  const rng = makeRng(1);
  const kinds = new Set();
  for (let i = 0; i < 4000; i += 1) {
    const v = anyValue(rng);
    kinds.add(Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  }
  for (const k of ['array', 'object', 'string', 'number', 'null', 'undefined', 'boolean', 'function', 'symbol', 'bigint']) assert.ok(kinds.has(k), `anyValue never produced ${k}`);
  const o = withOwnKey({}, '__proto__', { polluted: 1 });
  assert.deepEqual(Object.keys(o), ['__proto__']);
  assert.equal(({}).polluted, undefined);
});
