import test from 'node:test';
import assert from 'node:assert/strict';
import { recentMeals, copyOfMeal, MAX_RECENTS } from '../app/core/recents.js';
import { createStore, STORAGE_KEYS } from '../app/data/store.js';
import { sliderMaxFor, MAX_GRAMS } from '../app/ui/meal-editor.js';

import { memoryStorage } from './helpers/memory-storage.js';
const memory = (initial = {}) => memoryStorage(initial);   // a Map, or (FOODIE_BACKEND=idb) the real IndexedDB storage layer
let n = 0;
const env = { uuid: () => `id-${++n}`, now: () => new Date(2026, 10, 12, 9, 30) };
const per100 = { kcal: 100, protein_g: 10, carbs_g: 10, fat_g: 1 };
const meal = (name, grams = 100, over = {}) => ({ name, slot: 'Almuerzo', source: 'db', items: [{ name, grams, per100 }], ...over });

test('recents: newest first, one entry per dish and portion, a different portion counts as another', () => {
  const s = createStore(memory(), env);
  s.addMeal('2026-11-10', meal('Arroz', 150, { time: '13:00' }));
  s.addMeal('2026-11-11', meal('Pollo', 200, { time: '14:00' }));
  s.addMeal('2026-11-11', meal('Arroz', 150, { time: '09:00' }));      // the same rice as on the 10th: listed once
  s.addMeal('2026-11-12', meal('Arroz', 300, { time: '08:00' }));      // other portion: another entry
  const r = recentMeals(s);
  assert.deepEqual(r.map((x) => `${x.meal.name}:${x.meal.items[0].grams}`), ['Arroz:300', 'Pollo:200', 'Arroz:150']);
  assert.equal(r[0].kcal, 300);
  assert.equal(r[0].iso, '2026-11-12');
});

test('recents: nothing logged gives an empty list, and the list is capped', () => {
  const s = createStore(memory(), env);
  assert.deepEqual(recentMeals(s), []);
  for (let i = 0; i < 20; i += 1) s.addMeal('2026-11-11', meal(`Plato ${i}`));
  assert.equal(recentMeals(s).length, MAX_RECENTS);
  assert.equal(recentMeals(s, 3).length, 3);
});

test('copyOfMeal drops identity and time so the store gives the copy its own, and keeps the thumbnail', () => {
  const original = meal('Pollo', 150, { id: 'x1', time: '13:00', updatedAt: 5, thumb: 'data:image/jpeg;base64,AAAA' });
  const copy = copyOfMeal(original, 'Cena');
  assert.equal(copy.id, undefined);
  assert.equal(copy.time, undefined);
  assert.equal(copy.updatedAt, undefined);
  assert.equal(copy.slot, 'Cena');
  assert.equal(copy.thumb, original.thumb);
  copy.items[0].grams = 1;
  assert.equal(original.items[0].grams, 150, 'the copy must not share items with the original');
  const s = createStore(memory(), env);
  const added = s.addMeal('2026-11-12', copy);
  assert.ok(added && added.id && added.id !== 'x1');
  assert.equal(added.slot, 'Cena');
});

test('the camera mode is remembered, only accepts known modes, and clearing the device forgets it', () => {
  const st = memory();
  const s = createStore(st, env);
  assert.equal(s.getCameraMode(), 'photo');
  s.setCameraMode('code');
  assert.equal(s.getCameraMode(), 'code');
  s.setCameraMode('search');
  s.setCameraMode('<script>');
  assert.equal(s.getCameraMode(), 'code');
  assert.equal(createStore(st, env).getCameraMode(), 'code', 'it survives a reload');
  assert.equal(STORAGE_KEYS.ui, 'fd.ui');
  s.clearAll();
  assert.equal(s.getCameraMode(), 'photo');
  assert.equal(st.getItem('fd.ui'), null);
  const hostile = createStore(memory({ 'fd.ui': '{"mode":"__proto__"}' }), env);
  assert.equal(hostile.getCameraMode(), 'photo');
});

test('the slider is never a wall: it reaches past the estimate and past the current amount', () => {
  assert.equal(sliderMaxFor({ grams: 160, gramsMax: 250 }), 320);       // double the amount beats the estimate's upper range
  assert.equal(sliderMaxFor({ grams: 40, gramsMax: 90 }), 100);
  assert.equal(sliderMaxFor({ grams: 300, gramsMax: 250 }), 600);
  assert.equal(sliderMaxFor({ grams: 4000 }), MAX_GRAMS);
});
