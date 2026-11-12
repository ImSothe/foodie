import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, buildIndex, searchFoods } from '../app/core/search.js';
import { KEYS, macroMismatch, kcalFromMacros } from '../app/core/nutrition.js';
import { cleanPer100 } from '../app/core/schema.js';

const foods = JSON.parse(readFileSync(new URL('../app/data/foods.es.json', import.meta.url), 'utf8'));

test('normalize: case, accents, punctuation and spaces', () => {
  assert.equal(normalize('  Jamón   SERRANO, (curado)! '), 'jamon serrano curado');
  assert.equal(normalize('Piña'), 'pina');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(42), '42');
});

const mini = [
  { id: 'a', name: 'Arroz blanco cocido', aliases: ['arroz'] },
  { id: 'b', name: 'Pechuga de pollo', aliases: ['pollo', 'filete de pollo'] },
  { id: 'c', name: 'Pollo asado', aliases: [] },
  { id: 'd', name: 'Caldo de pollo', aliases: [] },
  { id: 'e', name: 'Plátano', aliases: ['banana'] },
  { id: 'f', name: 'Sopa de arroz', aliases: [] },
];
const ids = (q, list = mini) => searchFoods(buildIndex(list), q).map((f) => f.id);

test('search is accent- and case-insensitive', () => {
  assert.deepEqual(ids('PLATANO'), ['e']);
  assert.deepEqual(ids('plátano'), ['e']);
  assert.deepEqual(ids('  Banana '), ['e']);
});

test('search matches the name and the aliases', () => {
  assert.ok(ids('filete').includes('b'));          // alias word
  assert.ok(ids('banana').includes('e'));
});

test('prefix matches rank before matches inside a name', () => {
  // "pollo" starts "Pollo asado" and is an exact alias of "Pechuga de pollo"; "Caldo de pollo" only has it as a later word
  const r = ids('pollo');
  assert.equal(new Set(r).size, 3);
  assert.equal(r[r.length - 1], 'd');
  assert.deepEqual(ids('arroz'), ['a', 'f']);       // exact alias first, then a word in the middle
  assert.deepEqual(ids('arr'), ['a', 'f']);
  assert.equal(ids('ollo')[0], 'b');                // inside a word still matches, table order breaks ties
});

test('every word of the query must match', () => {
  assert.deepEqual(ids('arroz blanco'), ['a']);
  assert.deepEqual(ids('pollo arroz'), []);
  assert.deepEqual(ids('arroz sopa'), ['f']);
});

test('no match gives an empty list, an empty query gives everything alphabetically', () => {
  assert.deepEqual(ids('zzzz'), []);
  assert.deepEqual(ids(''), ['a', 'd', 'b', 'e', 'c', 'f']);
  assert.deepEqual(searchFoods(buildIndex([]), 'x'), []);
  assert.deepEqual(searchFoods(buildIndex(null), ''), []);
});

test('the limit applies', () => {
  assert.equal(searchFoods(buildIndex(mini), '', 2).length, 2);
});

test('search on the real table finds the usual things first', () => {
  const idx = buildIndex(foods);
  const first = (q) => searchFoods(idx, q)[0].id;
  assert.equal(first('pollo'), 'pechuga-pollo');
  assert.equal(first('platano'), 'platano');
  assert.equal(first('jamon'), 'jamon-serrano');
  assert.equal(first('aceite'), 'aceite-oliva');
  assert.ok(searchFoods(idx, 'tortilla').map((f) => f.id).includes('tortilla-patatas'));
  assert.ok(searchFoods(idx, 'garbanzos').length >= 1);
  assert.ok(searchFoods(idx, 'pina').some((f) => f.id === 'pina'));
});

test('foods table: about 100 entries, unique ids, complete valid compositions', () => {
  assert.ok(foods.length >= 95 && foods.length <= 110, `${foods.length} foods`);
  assert.equal(new Set(foods.map((f) => f.id)).size, foods.length, 'duplicate ids');
  assert.equal(new Set(foods.map((f) => f.name)).size, foods.length, 'duplicate names');
  for (const f of foods) {
    assert.match(f.id, /^[a-z0-9-]+$/, f.id);
    assert.ok(typeof f.name === 'string' && f.name.length > 1, f.id);
    assert.ok(Array.isArray(f.aliases) && f.aliases.every((a) => typeof a === 'string' && a), `${f.id} aliases`);
    assert.ok(f.portion && typeof f.portion.label === 'string' && f.portion.grams > 0 && f.portion.grams <= 1000, `${f.id} portion`);
    // Energy, macros, fibre, sugars, saturated fat and sodium are always there. A vitamin or mineral the source
    // does not report is left out (unknown), never written as 0.
    for (const k of Object.keys(f.per100)) assert.ok(KEYS.includes(k), `${f.id}: unknown nutrient ${k}`);
    for (const k of ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugars_g', 'sat_fat_g', 'sodium_mg']) assert.ok(k in f.per100, `${f.id}: ${k} missing`);
    for (const [k, v] of Object.entries(f.per100)) assert.ok(typeof v === 'number' && Number.isFinite(v) && v >= 0, `${f.id}.${k}`);
    assert.match(f.source, /^(USDA SR Legacy \d+|estimate)$/, `${f.id}: every food says where its numbers come from`);
    assert.ok(cleanPer100(f.per100), `${f.id}: rejected by the schema`);
  }
});

test('foods table: calories agree with the macros (within the app tolerance) and nothing is impossible', () => {
  for (const f of foods) {
    const p = f.per100;
    assert.equal(macroMismatch(p), false, `${f.id}: ${p.kcal} kcal stated, ${kcalFromMacros(p)} from macros`);
    assert.ok(p.protein_g + p.carbs_g + p.fat_g <= 100.5, `${f.id}: macros add more than 100 g`);
    // Sugars are analysed and carbohydrate is computed by difference, so they can cross by a little (melon).
    assert.ok(p.sugars_g <= p.carbs_g + 1, `${f.id}: more sugar than carbohydrates`);
    assert.ok(p.sat_fat_g <= p.fat_g + 0.05, `${f.id}: more saturated fat than fat`);
    assert.ok(p.kcal <= 900, `${f.id}`);
  }
});

test('foods table: the typical portion is plausible for the food', () => {
  for (const f of foods) {
    const m = f.portion.label.match(/\((\d+) (g|ml)\)/);
    if (m) assert.equal(Number(m[1]), f.portion.grams, `${f.id}: label says ${m[1]}, grams is ${f.portion.grams}`);
  }
});
