import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, STORAGE_KEYS } from '../app/data/store.js';

const memory = (initial = {}) => {
  const m = new Map(Object.entries(initial));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};
let n = 0;
const env = { uuid: () => `id-${++n}`, now: () => new Date(2026, 10, 12, 9, 30) };
const DAY = '2026-11-12';
const per100 = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const newMeal = (over = {}) => ({ name: 'Pollo', slot: 'Almuerzo', source: 'db', items: [{ name: 'Pollo', grams: 150, per100 }], ...over });
const profile = { sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain' };
const goals = { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 60, waterL: 2.5, steps: 8000 };

test('an empty storage gives an empty store', () => {
  const s = createStore(memory(), env);
  assert.equal(s.getProfile(), null);
  assert.equal(s.goalsFor(DAY), null);
  assert.deepEqual(s.mealsOf(DAY), []);
  assert.deepEqual(s.getDay(DAY), { meals: {}, waterMl: 0, steps: 0 });
  assert.equal(s.loggedDays().size, 0);
});

test('corrupt or hostile stored data is ignored, never thrown', () => {
  const st = memory({
    [STORAGE_KEYS.profile]: '{not json', [STORAGE_KEYS.goals]: '"x"', [STORAGE_KEYS.days]: '[1,2]',
    [STORAGE_KEYS.saved]: '{"a":1}', [STORAGE_KEYS.weights]: 'null',
  });
  const s = createStore(st, env);
  assert.equal(s.getProfile(), null);
  assert.deepEqual(s.getGoalHistory(), []);
  assert.deepEqual(s.getDays(), {});
  assert.deepEqual(s.getSaved(), []);
  assert.deepEqual(s.getWeights(), {});
});

test('stored data is validated on load', () => {
  const st = memory({
    [STORAGE_KEYS.profile]: JSON.stringify({ ...profile, birthYear: 1996, age: undefined, weightKg: 9999 }),
    [STORAGE_KEYS.days]: JSON.stringify({ [DAY]: { meals: { a: { id: 'a', items: [{ name: 'x', grams: -3, per100 }] } }, waterMl: 500 }, nope: {} }),
  });
  const s = createStore(st, env);
  assert.equal(s.getProfile(), null);                      // weight out of range
  assert.deepEqual(Object.keys(s.getDays()), [DAY]);
  assert.deepEqual(s.mealsOf(DAY), []);                    // the meal is invalid; the water stays
  assert.equal(s.getDay(DAY).waterMl, 500);
});

test('everything persists to storage and survives a reload of the store', () => {
  const st = memory();
  const s = createStore(st, env);
  s.saveProfile(profile);
  s.setGoals(goals, DAY);
  const meal = s.addMeal(DAY, newMeal());
  s.addWater(DAY, 250);
  s.setSteps(DAY, 4321);
  s.saveMeal(meal);
  s.logWeight(DAY, 79.5);
  const again = createStore(st, env);
  assert.deepEqual(again.getProfile(), s.getProfile());
  assert.equal(again.goalsFor(DAY).kcal, 2000);
  assert.equal(again.mealsOf(DAY)[0].name, 'Pollo');
  assert.deepEqual([again.getDay(DAY).waterMl, again.getDay(DAY).steps], [250, 4321]);
  assert.equal(again.getSaved().length, 1);
  assert.equal(again.getWeights()[DAY], 79.5);
  for (const k of st.m.keys()) assert.ok(k.startsWith('fd.'), k);
});

test('saveProfile rejects invalid profiles', () => {
  const s = createStore(memory(), env);
  assert.equal(s.saveProfile({ ...profile, age: 5 }), null);
  assert.equal(s.getProfile(), null);
});

test('goals: effective date keeps history, no-op changes are not stored', () => {
  const s = createStore(memory(), env);
  s.setGoals(goals, '2026-11-01');
  s.setGoals({ ...goals, kcal: 1800 }, '2026-11-10');
  s.setGoals({ ...goals, kcal: 1800 }, '2026-11-11');
  assert.equal(s.getGoalHistory().length, 2);
  assert.equal(s.goalsFor('2026-11-05').kcal, 2000);
  assert.equal(s.goalsFor('2026-11-12').kcal, 1800);
  assert.equal(s.setGoals({ kcal: 1 }), null);
});

test('goalsFor falls back to the plan computed from the profile', () => {
  const s = createStore(memory(), env);
  s.saveProfile(profile);
  const g = s.goalsFor(DAY);
  assert.equal(g.kcal % 10, 0);
  assert.ok(g.protein_g > 0);
  assert.equal(s.getGoalHistory().length, 0);               // computed, not stored
});

test('addMeal: generates an id, defaults the time, keeps a given id (undo), rejects invalid meals', () => {
  const s = createStore(memory(), env);
  const m = s.addMeal(DAY, newMeal());
  assert.match(m.id, /^id-\d+$/);
  assert.equal(m.time, '09:30');
  const undo = s.addMeal(DAY, { ...m, id: 'fixed', time: '20:15' });
  assert.equal(undo.id, 'fixed');
  assert.equal(undo.time, '20:15');
  assert.deepEqual(s.mealsOf(DAY).map((x) => x.id), [m.id, 'fixed']);   // sorted by time
  assert.equal(s.addMeal(DAY, newMeal({ items: [] })), null);
  assert.equal(s.addMeal('mañana', newMeal()), null);
  assert.equal(s.mealsOf(DAY).length, 2);
});

test('updateMeal replaces an existing meal only, silent skips notifications', () => {
  const s = createStore(memory(), env);
  const m = s.addMeal(DAY, newMeal());
  let calls = 0;
  s.subscribe(() => { calls += 1; });
  const edited = structuredClone(m);
  edited.items[0].grams = 300;
  assert.equal(s.updateMeal(DAY, edited, { silent: true }).items[0].grams, 300);
  assert.equal(calls, 0);
  s.updateMeal(DAY, edited);
  assert.equal(calls, 1);
  assert.equal(s.updateMeal(DAY, { ...edited, id: 'unknown' }), null);
  assert.equal(s.updateMeal('2026-01-01', edited), null);
  assert.equal(s.updateMeal(DAY, { ...edited, items: [] }), null);
  assert.equal(s.mealsOf(DAY)[0].items[0].grams, 300);
});

test('deleteMeal returns the meal so it can be restored; an emptied day disappears', () => {
  const s = createStore(memory(), env);
  const m = s.addMeal(DAY, newMeal());
  const removed = s.deleteMeal(DAY, m.id);
  assert.equal(removed.id, m.id);
  assert.deepEqual(s.getDays(), {});
  assert.equal(s.deleteMeal(DAY, m.id), null);
  s.addMeal(DAY, removed);
  assert.equal(s.mealsOf(DAY)[0].id, m.id);
});

test('duplicateMeal copies to another day with a new id and without sharing items', () => {
  const s = createStore(memory(), env);
  const m = s.addMeal(DAY, newMeal());
  const copy = s.duplicateMeal(DAY, m.id, '2026-11-13');
  assert.notEqual(copy.id, m.id);
  assert.equal(s.mealsOf('2026-11-13')[0].id, copy.id);
  copy.items[0].grams = 1;
  assert.equal(s.mealsOf(DAY)[0].items[0].grams, 150);
  assert.equal(s.duplicateMeal(DAY, 'nope', '2026-11-13'), null);
  assert.equal(s.duplicateMeal(DAY, m.id, 'x'), null);
});

test('water: add, undo with a negative amount, never below zero, correct to an exact value', () => {
  const s = createStore(memory(), env);
  assert.equal(s.addWater(DAY, 250), 250);
  assert.equal(s.addWater(DAY, 500), 750);
  assert.equal(s.addWater(DAY, -500), 250);
  assert.equal(s.addWater(DAY, -1000), 0);
  assert.deepEqual(s.getDays(), {});                      // zero water on an otherwise empty day leaves no trace
  assert.equal(s.setWater(DAY, 1800), 1800);
  assert.equal(s.setWater(DAY, 'abc'), 0);
  assert.equal(s.addWater('x', 250), null);
});

test('steps are stored as whole non-negative numbers', () => {
  const s = createStore(memory(), env);
  assert.equal(s.setSteps(DAY, 8123.7), 8124);
  assert.equal(s.setSteps(DAY, -3), 0);
});

test('favourites: copy of a meal, no duplicates, undoable removal', () => {
  const s = createStore(memory(), env);
  const m = s.addMeal(DAY, newMeal());
  const first = s.saveMeal(m);
  assert.equal(first.added, true);
  assert.notEqual(first.meal.id, m.id);
  assert.equal(s.saveMeal(m).added, false);
  assert.equal(s.getSaved().length, 1);
  const removed = s.removeSaved(first.meal.id);
  assert.equal(s.getSaved().length, 0);
  assert.equal(s.saveMeal(removed, { keepId: true }).meal.id, removed.id);
  assert.equal(s.removeSaved('nope'), null);
});

test('logWeight: one per day, validated, and the profile follows the latest weight', () => {
  const s = createStore(memory(), env);
  s.saveProfile(profile);
  assert.equal(s.logWeight('2026-11-10', 80.3), 80.3);
  assert.equal(s.getProfile().weightKg, 80.3);
  s.logWeight('2026-11-10', 79.9);
  assert.equal(s.getWeights()['2026-11-10'], 79.9);
  s.logWeight('2026-11-01', 85);                                   // older entry: the profile keeps the latest
  assert.equal(s.getProfile().weightKg, 79.9);
  assert.equal(s.logWeight('2026-11-11', 5), null);
  assert.equal(s.logWeight('x', 70), null);
});

test('exportAll has every dataset; clearAll removes only fd. data keys', () => {
  const st = memory({ 'fd.theme': 'dark', 'other-app': 'keep' });
  const s = createStore(st, env);
  s.saveProfile(profile);
  s.addMeal(DAY, newMeal());
  const out = s.exportAll();
  assert.deepEqual(Object.keys(out), ['app', 'format', 'exportedAt', 'profile', 'goals', 'days', 'saved', 'weights']);
  assert.equal(out.app, 'foodie');
  assert.equal(JSON.parse(JSON.stringify(out)).days[DAY].meals[Object.keys(out.days[DAY].meals)[0]].name, 'Pollo');
  s.clearAll();
  assert.equal(s.getProfile(), null);
  assert.deepEqual(s.getDays(), {});
  assert.equal(st.m.get('other-app'), 'keep');                     // never touches anything it does not own
  assert.equal(st.m.get('fd.theme'), 'dark');                      // the theme is a preference, not personal data
  for (const k of Object.values(STORAGE_KEYS)) assert.equal(st.m.has(k), false, k);
});

test('subscribe notifies on changes, batch groups them, unsubscribe stops', () => {
  const s = createStore(memory(), env);
  let calls = 0;
  const off = s.subscribe(() => { calls += 1; });
  s.addWater(DAY, 250);
  assert.equal(calls, 1);
  s.batch(() => { s.addWater(DAY, 250); s.setSteps(DAY, 10); s.saveProfile(profile); });
  assert.equal(calls, 2);
  s.batch(() => {});
  assert.equal(calls, 2);
  off();
  s.addWater(DAY, 250);
  assert.equal(calls, 2);
});

test('a failing storage keeps working in memory and reports the error', () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const s = createStore(broken, env);
  let errors = 0;
  s.onStorageError(() => { errors += 1; });
  assert.equal(s.persistent, true);
  s.addWater(DAY, 250);
  assert.equal(s.getDay(DAY).waterMl, 250);
  assert.equal(s.persistent, false);
  assert.equal(errors, 1);
});

test('reload picks up changes made by another tab', () => {
  const st = memory();
  const a = createStore(st, env);
  const b = createStore(st, env);
  a.addWater(DAY, 500);
  assert.equal(b.getDay(DAY).waterMl, 0);
  let calls = 0;
  b.subscribe(() => { calls += 1; });
  b.reload();
  assert.equal(b.getDay(DAY).waterMl, 500);
  assert.equal(calls, 1);
});
