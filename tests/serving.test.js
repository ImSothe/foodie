import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseQuantityG, servingOptions, defaultGrams, isLiquidQuantity, sliderMax, missingNotes, productMeal } from '../app/core/serving.js';
import { productFromOff } from '../app/core/off.js';
import { cleanMeal } from '../app/core/schema.js';
import { sumItems } from '../app/core/nutrition.js';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/off/${name}.json`, import.meta.url)), 'utf8'));
const per100 = { kcal: 539, protein_g: 6.3, carbs_g: 57.5, fat_g: 30.9 };
const product = (over = {}) => ({ ok: true, code: '3017620422003', name: 'Nutella', brand: 'Ferrero', imageUrl: null, per100, estimated: false, servingG: null, servingLabel: '', quantity: '', missing: [], ...over });

test('parseQuantityG: single, multipack, spelled-out totals, litres and decimal commas', () => {
  const cases = { '400 g': 400, '400g': 400, ' 500 G ': 500, '1 kg': 1000, '1,5 kg': 1500, '1,5 L': 1500, '2 l': 2000, '330 ml': 330, '33 cl': 330, '6 x 125 g': 750, '6 × 33 cl': 1980,
    '4 x 25g (100 g)': 100, '2 x 100 g': 200, '1 litro': 1000, '12 oz': 340.2 };
  for (const [text, grams] of Object.entries(cases)) assert.equal(parseQuantityG(text), grams, text);
});

test('parseQuantityG: nothing plausible gives null, never a guess', () => {
  for (const bad of ['', 'x', 'una caja', '0 g', '-5 g', '10 kg', '99999 g', 'g 400', '6 x', '400', null, undefined, 400, {}, 'a'.repeat(200), '1e9 g', 'NaN g']) assert.equal(parseQuantityG(bad), null, String(bad));
});

test('servingOptions: the label serving first, then the whole package, then 100 g; no duplicates', () => {
  assert.deepEqual(servingOptions(product({ servingG: 15, quantity: '400 g' })).map((o) => [o.key, o.grams]), [['serving', 15], ['package', 400], ['hundred', 100]]);
  assert.deepEqual(servingOptions(product({ quantity: '330 ml' })).map((o) => o.key), ['package', 'hundred']);
  assert.deepEqual(servingOptions(product()).map((o) => o.key), ['hundred']);
  assert.deepEqual(servingOptions(product({ servingG: 100, quantity: '100 g' })).map((o) => o.key), ['serving']);
  assert.deepEqual(servingOptions(product({ servingG: 30, quantity: '30 g' })).map((o) => o.key), ['serving', 'hundred']);
  for (const o of servingOptions(product({ servingG: 43.5, quantity: '1,5 kg' }))) assert.match(o.label, /\d/);
});

test('defaultGrams: the label serving; a drink up to 500 ml or a food up to 200 g whole; anything bigger is 100 g (a jar is not eaten whole)', () => {
  assert.equal(defaultGrams(product({ servingG: 15, quantity: '400 g' })), 15);
  assert.equal(defaultGrams(product({ quantity: '330 ml' })), 330);
  assert.equal(defaultGrams(product({ quantity: '500 ml' })), 500);
  assert.equal(defaultGrams(product({ quantity: '1,5 L' })), 100);
  assert.equal(defaultGrams(product({ quantity: '125 g' })), 125);
  assert.equal(defaultGrams(product({ quantity: '4 x 125 g' })), 100);
  assert.equal(defaultGrams(product({ quantity: '400 g' })), 100, 'Nutella: not the whole jar');
  assert.equal(defaultGrams(product({ quantity: '1 kg' })), 100);
  assert.equal(defaultGrams(product()), 100);
});

test('isLiquidQuantity: volumes are drinks, weights are not', () => {
  for (const q of ['330 ml', '1,5 L', '33 cl', '2 litros', '6 x 33 cl']) assert.equal(isLiquidQuantity(q), true, q);
  for (const q of ['400 g', '1 kg', '', 'lentejas', null, undefined, 5]) assert.equal(isLiquidQuantity(q), false, String(q));
});

test('sliderMax: room for the whole package and double the grams, a multiple of 5, never absurd', () => {
  assert.equal(sliderMax(product(), 100) % 5, 0);
  assert.ok(sliderMax(product({ quantity: '1 kg' }), 100) >= 1000);
  assert.ok(sliderMax(product(), 400) >= 800);
  assert.ok(sliderMax(product(), 100) >= 500);
  assert.ok(sliderMax(product({ quantity: '5 kg' }), 9000) <= 5000);
});

test('missingNotes: says what the product does not state and when calories were derived', () => {
  assert.deepEqual(missingNotes(product()), []);
  assert.match(missingNotes(product({ missing: ['fiber_g'] }))[0], /no indica fibra/);
  assert.match(missingNotes(product({ missing: ['fiber_g', 'sugars_g', 'sodium_mg'] }))[0], /fibra, azúcares ni sal/);
  assert.match(missingNotes(product({ estimated: true }))[0], /calculado a partir de los macros/);
  assert.equal(missingNotes(product({ missing: ['nonsense_key'] })).length, 0);
});

test('productMeal: source barcode, one item that keeps per-100 g so the grams stay editable, valid for the store', () => {
  const meal = productMeal(product({ quantity: '400 g' }), 15, { slot: 'Desayuno', time: '08:15' });
  assert.equal(meal.source, 'barcode');
  assert.equal(meal.slot, 'Desayuno');
  assert.equal(meal.name, 'Nutella Ferrero');
  assert.equal(meal.items.length, 1);
  assert.deepEqual(meal.items[0].per100, per100);
  const clean = cleanMeal({ ...meal, id: 'x1' });
  assert.ok(clean, 'the schema accepts it');
  assert.equal(clean.items[0].gramsMin, 0);
  assert.ok(clean.items[0].gramsMax >= 500);
  assert.equal(Math.round(sumItems(clean.items).totals.kcal), Math.round(539 * 0.15));
});

test('productMeal: hostile names are cleaned, an empty name falls back, brand is optional', () => {
  const evil = productMeal(product({ name: '<img src=x onerror=alert(1)>‮', brand: '' }), 100, { slot: 'Cena' });
  assert.equal(evil.name, '<img src=x onerror=alert(1)>');
  assert.equal(productMeal(product({ name: '', brand: '' }), 100, { slot: 'Cena' }).name, 'Producto');
  assert.ok(Array.from(productMeal(product({ name: 'x'.repeat(300) }), 100, { slot: 'Cena' }).name).length <= 80);
});

test('real fixtures end to end: a record becomes portions and a meal', () => {
  const taco = productFromOff(fixture('taco-kit'), '8410076472212');
  const options = servingOptions(taco);
  assert.ok(options.some((o) => o.key === 'serving' && o.grams === 43));
  const meal = productMeal(taco, defaultGrams(taco), { slot: 'Cena' });
  assert.ok(cleanMeal({ ...meal, id: 'y1' }));
});
