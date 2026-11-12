import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPer100, cleanItem, cleanMeal, cleanDay, cleanDays, loggedDays, mealsOfDay, cleanGoals, cleanGoalsHistory, goalsFor,
  setGoalsEntry, cleanSaved, cleanWeights, weightList, defaultSlot, clampWater, clampSteps, isEmptyDay,
} from '../app/core/schema.js';

const per100 = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const item = (over = {}) => ({ name: 'Pollo', grams: 150, gramsMin: 50, gramsMax: 300, per100, ...over });
const meal = (over = {}) => ({ id: 'm1', name: 'Comida', slot: 'Almuerzo', time: '14:00', source: 'db', items: [item()], ...over });
const goals = { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 60, waterL: 2.5, steps: 8000 };

test('cleanPer100: keeps known nutrients with valid values, needs calories', () => {
  assert.deepEqual(cleanPer100({ ...per100, bogus: 5, fiber_g: -1, sodium_mg: 'x', iron_mg: 2 }), { ...per100, iron_mg: 2 });
  assert.equal(cleanPer100({ protein_g: 3 }), null);
  assert.equal(cleanPer100({ kcal: 5000 }), null);
  assert.equal(cleanPer100({ kcal: 100, fat_g: 500 }) && 'fat_g' in cleanPer100({ kcal: 100, fat_g: 500 }), false);
  for (const bad of [null, undefined, 5, 'x', []]) assert.equal(cleanPer100(bad), null);
});

test('cleanItem: name, grams and composition are required; the slider range only when coherent', () => {
  assert.deepEqual(cleanItem(item()), item());
  assert.equal('gramsMin' in cleanItem(item({ gramsMin: 400 })), false);   // min above max
  assert.equal('gramsMax' in cleanItem(item({ gramsMax: 'x' })), false);
  for (const bad of [null, item({ name: '' }), item({ name: 5 }), item({ grams: -1 }), item({ grams: 'x' }), item({ grams: 9999 }), item({ per100: null })]) {
    assert.equal(cleanItem(bad), null, JSON.stringify(bad));
  }
  assert.equal(cleanItem(item({ name: ` ${'a'.repeat(300)} ` })).name.length, 120);
});

test('cleanMeal: fixes what can be fixed and rejects the rest', () => {
  assert.deepEqual(cleanMeal(meal()), meal());
  const fixed = cleanMeal(meal({ slot: 'Brunch', time: '25:99', source: 'telepathy', name: '  ' }));
  assert.equal(fixed.slot, 'Snack');
  assert.equal(fixed.time, '12:00');
  assert.equal(fixed.source, 'manual');
  assert.equal(fixed.name, 'Pollo');                                        // falls back to the ingredients
  assert.equal(cleanMeal(meal({ confidence: 0.8 })).confidence, 0.8);
  assert.equal('confidence' in cleanMeal(meal({ confidence: 7 })), false);
  assert.equal(cleanMeal(meal({ items: [item(), { nope: true }] })).items.length, 1);
  for (const bad of [null, 'x', meal({ id: '' }), meal({ id: undefined }), meal({ items: [] }), meal({ items: 'x' }), meal({ items: [{}] })]) {
    assert.equal(cleanMeal(bad), null, JSON.stringify(bad));
  }
});

test('cleanMeal: ignores extra fields and caps the number of items', () => {
  const m = cleanMeal({ ...meal({ items: Array.from({ length: 100 }, () => item()) }), evil: '<script>' });
  assert.equal(m.items.length, 60);
  assert.equal('evil' in m, false);
});

test('cleanDay: meals keyed by id, water and steps as whole non-negative numbers', () => {
  const d = cleanDay({ meals: { x: meal({ id: 'a' }), y: { broken: 1 } }, waterMl: 1250.6, steps: -5 });
  assert.deepEqual(Object.keys(d.meals), ['a']);
  assert.equal(d.waterMl, 1251);
  assert.equal(d.steps, 0);
  assert.deepEqual(cleanDay({}), { meals: {}, waterMl: 0, steps: 0 });
  assert.equal(cleanDay(null), null);
  assert.equal(cleanDay({ waterMl: 99999999 }).waterMl, 0);                 // absurd values are dropped, not clamped
});

test('cleanDays: invalid dates and empty days are dropped', () => {
  const days = cleanDays({
    '2026-11-12': { meals: { a: meal({ id: 'a' }) } },
    '2026-02-30': { meals: { a: meal({ id: 'b' }) } },
    'hoy': { waterMl: 500 },
    '2026-11-11': {},
    '2026-11-10': { waterMl: 500 },
  });
  assert.deepEqual(Object.keys(days).sort(), ['2026-11-10', '2026-11-12']);
  assert.deepEqual(cleanDays('x'), {});
  assert.deepEqual(cleanDays(null), {});
});

test('loggedDays counts days with meals only; mealsOfDay sorts by time', () => {
  const days = cleanDays({
    '2026-11-12': { meals: { a: meal({ id: 'a', time: '21:00' }), b: meal({ id: 'b', time: '08:00' }) } },
    '2026-11-11': { waterMl: 2000 },
  });
  assert.deepEqual([...loggedDays(days)], ['2026-11-12']);
  assert.deepEqual(mealsOfDay(days['2026-11-12']).map((m) => m.id), ['b', 'a']);
  assert.deepEqual(mealsOfDay(undefined), []);
  assert.equal(isEmptyDay({ meals: {}, waterMl: 0, steps: 0 }), true);
});

test('cleanGoals: every figure is required and in range', () => {
  assert.deepEqual(cleanGoals({ ...goals, kcal: 2000.4, waterL: 2.46 }), { ...goals, waterL: 2.5 });
  for (const k of Object.keys(goals)) assert.equal(cleanGoals({ ...goals, [k]: undefined }), null, k);
  assert.equal(cleanGoals({ ...goals, kcal: 300 }), null);
  assert.equal(cleanGoals({ ...goals, kcal: '2000' }), null);
  assert.equal(cleanGoals(null), null);
});

test('goalsFor: the goals in force that day, changing them does not rewrite history', () => {
  const g1 = goals;
  const g2 = { ...goals, kcal: 1800 };
  let h = [];
  assert.equal(goalsFor(h, '2026-11-12'), null);
  h = setGoalsEntry(h, '2026-11-01', g1);
  h = setGoalsEntry(h, '2026-11-10', g2);
  assert.equal(goalsFor(h, '2026-11-09').kcal, 2000);
  assert.equal(goalsFor(h, '2026-11-10').kcal, 1800);
  assert.equal(goalsFor(h, '2026-12-31').kcal, 1800);
  assert.equal(goalsFor(h, '2020-01-01').kcal, 2000);        // before the first entry: the first goals
});

test('setGoalsEntry: replaces the same day, ignores no-ops and invalid input, keeps order', () => {
  let h = setGoalsEntry([], '2026-11-10', goals);
  assert.equal(setGoalsEntry(h, '2026-11-12', goals), h);                              // same as in force: nothing changes
  h = setGoalsEntry(h, '2026-11-10', { ...goals, kcal: 1900 });                        // same day: replaced
  assert.equal(h.length, 1);
  assert.equal(h[0].goals.kcal, 1900);
  h = setGoalsEntry(h, '2026-11-01', { ...goals, kcal: 2100 });                        // earlier date goes first
  assert.deepEqual(h.map((e) => e.from), ['2026-11-01', '2026-11-10']);
  assert.equal(setGoalsEntry(h, 'ayer', goals), h);
  assert.equal(setGoalsEntry(h, '2026-11-12', { kcal: 1 }), h);
});

test('cleanGoalsHistory: sorted, deduplicated, invalid entries dropped', () => {
  const h = cleanGoalsHistory([
    { from: '2026-11-10', goals }, { from: '2026-11-01', goals: { ...goals, kcal: 2200 } },
    { from: '2026-11-10', goals: { ...goals, kcal: 1700 } }, { from: 'x', goals }, { from: '2026-11-05', goals: {} }, null,
  ]);
  assert.deepEqual(h.map((e) => [e.from, e.goals.kcal]), [['2026-11-01', 2200], ['2026-11-10', 1700]]);
  assert.deepEqual(cleanGoalsHistory('x'), []);
});

test('cleanSaved: valid unique meals only', () => {
  const s = cleanSaved([meal({ id: 'a' }), meal({ id: 'a' }), { x: 1 }, meal({ id: 'b' })]);
  assert.deepEqual(s.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(cleanSaved(null), []);
});

test('cleanWeights and weightList', () => {
  const w = cleanWeights({ '2026-11-12': 80.04, '2026-11-01': 81.5, 'x': 70, '2026-11-02': 10, '2026-11-03': 'a' });
  assert.deepEqual(w, { '2026-11-12': 80, '2026-11-01': 81.5 });
  assert.deepEqual(weightList(w), [{ iso: '2026-11-01', kg: 81.5 }, { iso: '2026-11-12', kg: 80 }]);
  assert.deepEqual(weightList(null), []);
});

test('defaultSlot follows Spanish meal times', () => {
  assert.equal(defaultSlot(8), 'Desayuno');
  assert.equal(defaultSlot(11), 'Almuerzo');
  assert.equal(defaultSlot(14), 'Almuerzo');
  assert.equal(defaultSlot(18), 'Snack');
  assert.equal(defaultSlot(21), 'Cena');
  assert.equal(defaultSlot(2), 'Cena');
});

test('clampWater and clampSteps stay in range and round', () => {
  assert.equal(clampWater(-5), 0);
  assert.equal(clampWater(250.4), 250);
  assert.equal(clampWater(1e9), 20000);
  assert.equal(clampWater('x'), 0);
  assert.equal(clampSteps(12345.6), 12346);
  assert.equal(clampSteps(-1), 0);
});
