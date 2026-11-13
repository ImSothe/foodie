/* Thumbnails of photo meals: at most 20 a day (and 20 among the favourites), so a day document stays far below Firestore's 1 MiB.
   Past the cap the meal is still saved, just without its thumbnail. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDay, cleanSaved, cleanMeal, MAX_THUMBS_PER_DAY, MAX_THUMBS_SAVED, THUMB_MAX_CHARS, countThumbs } from '../app/core/schema.js';
import { mergeDay } from '../app/core/merge.js';
import { createStore } from '../app/data/store.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { THUMB } from './helpers/year-data.js';

const per100 = { kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 3 };
const item = { name: 'x', grams: 100, per100 };
const m = (id, thumb = true) => ({ id, name: id, slot: 'Cena', source: 'ai', items: [item], ...(thumb ? { thumb: THUMB } : {}) });
const DAY = '2026-11-12';
const mkStore = () => createStore(memoryStorage(), { uuid: (() => { let n = 0; return () => `u${++n}`; })(), now: () => new Date(2026, 10, 12, 9, 0) });

test('cleanDay keeps the first 20 thumbnails of a day and strips the rest; every meal survives', () => {
  const meals = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`m${i}`, m(`m${i}`)]));
  const day = cleanDay({ meals });
  assert.equal(Object.keys(day.meals).length, 50);
  assert.equal(countThumbs(day.meals), MAX_THUMBS_PER_DAY);
  assert.ok(day.meals.m0.thumb && day.meals.m19.thumb);
  assert.equal('thumb' in day.meals.m20, false);
  assert.equal(day.meals.m20.name, 'm20');
  assert.deepEqual(cleanDay(JSON.parse(JSON.stringify(day))), day, 'idempotent');
});

test('a day with 100 full-size thumbnails would not fit in a cloud document; with the cap it is a quarter of the limit', () => {
  const day = cleanDay({ meals: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`m${i}`, m(`m${i}`)])) });
  const bytes = Buffer.byteLength(JSON.stringify(day));
  assert.ok(bytes < 400 * 1024, `${bytes} bytes`);
  assert.ok(THUMB_MAX_CHARS * 100 > 1024 * 1024, 'the cap is what keeps it under 1 MiB');
});

test('the store drops the thumbnail of the 21st photo meal of a day but saves the meal', () => {
  const s = mkStore();
  for (let i = 0; i < 20; i += 1) assert.ok(s.addMeal(DAY, m(`a${i}`)).thumb, `meal ${i}`);
  const extra = s.addMeal(DAY, m('extra'));
  assert.ok(extra, 'the meal is saved');
  assert.equal('thumb' in extra, false);
  assert.equal(s.mealsOf(DAY).length, 21);
  assert.equal(countThumbs(s.getDay(DAY).meals), 20);
  // another day has its own allowance
  assert.ok(s.addMeal('2026-11-11', m('b0')).thumb);
  // editing a meal that has a thumbnail keeps it (the cap counts the others)
  const first = s.mealsOf(DAY).find((x) => x.id === 'a0');
  assert.ok(s.updateMeal(DAY, { ...first, name: 'editada' }).thumb);
  // duplicating onto a full day drops the copy's thumbnail
  const copy = s.duplicateMeal('2026-11-11', 'b0', DAY);
  assert.equal('thumb' in copy, false);
  // deleting one frees a place for the next
  s.deleteMeal(DAY, 'a1');
  assert.ok(s.addMeal(DAY, m('again')).thumb);
});

test('favourites keep at most 20 thumbnails', () => {
  const s = mkStore();
  for (let i = 0; i < 25; i += 1) s.saveMeal({ ...m(`f${i}`), name: `Favorita ${i}` });
  assert.equal(s.getSaved().length, 25);
  assert.equal(countThumbs(s.getSaved()), MAX_THUMBS_SAVED);
  assert.equal(countThumbs(cleanSaved(JSON.parse(JSON.stringify(s.getSaved())))), MAX_THUMBS_SAVED);
});

test('merging two devices never exceeds the cap, whatever each side had, and is the same either way round', () => {
  const side = (prefix) => cleanDay({ meals: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`${prefix}${i}`, { ...m(`${prefix}${i}`), updatedAt: 100 + i }])) });
  const a = side('a');
  const b = side('b');
  const ab = mergeDay(a, b, 1000);
  const ba = mergeDay(b, a, 1000);
  assert.equal(Object.keys(ab.meals).length, 30);
  assert.equal(countThumbs(ab.meals), MAX_THUMBS_PER_DAY);
  assert.equal(JSON.stringify(ab), JSON.stringify(ba));
});

test('a thumbnail is still only a small JPEG data URL', () => {
  assert.ok(cleanMeal(m('ok')).thumb);
  assert.equal('thumb' in cleanMeal({ ...m('big'), thumb: `${THUMB}A` }), false);
});
