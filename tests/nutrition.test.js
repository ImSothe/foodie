import test from 'node:test';
import assert from 'node:assert/strict';
import { NUTRIENTS, KEYS, scale, sumItems, sumMeals, kcalFromMacros, macroMismatch, clampGrams, progress, fmtNum, fmtAmount } from '../app/core/nutrition.js';

const chicken = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const rice = { kcal: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3, fiber_g: 0.4 };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('nutrient table: unique keys, a unit on every row, a reference value on every micronutrient', () => {
  assert.equal(new Set(KEYS).size, KEYS.length);
  for (const n of NUTRIENTS) {
    assert.ok(n.label && n.unit, n.key);
    assert.ok(n.key === 'kcal' || n.key.endsWith(`_${n.unit === 'µg' ? 'ug' : n.unit}`), `${n.key} does not match its unit`);
    if (!['energy', 'macro'].includes(n.group)) assert.ok(n.nrv > 0, `${n.key} has no reference value`);
  }
});

test('scale: amounts follow the grams and unknown nutrients stay unknown', () => {
  const s = scale(chicken, 150);
  near(s.kcal, 247.5);
  near(s.protein_g, 46.5);
  assert.ok(!('vit_c_mg' in s));
  assert.deepEqual(scale(chicken, 0), { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  assert.deepEqual(scale(null, 100), {});
});

test('scale: values that are not valid numbers are ignored, never added as NaN', () => {
  const s = scale({ kcal: '165', protein_g: NaN, carbs_g: -4, fat_g: Infinity, fiber_g: 2 }, 100);
  assert.deepEqual(s, { fiber_g: 2 });
  assert.deepEqual(scale(chicken, -50), { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
});

test('sumItems: totals of a plate and how many items lack each nutrient', () => {
  const { totals, missing } = sumItems([{ grams: 160, per100: chicken }, { grams: 180, per100: rice }]);
  near(totals.kcal, 264 + 234);
  near(totals.protein_g, 49.6 + 4.86);
  near(totals.fiber_g, 0.72);
  assert.equal(missing.kcal, 0);
  assert.equal(missing.fiber_g, 1);       // the chicken has no fibre data
  assert.equal(missing.vit_c_mg, 2);
  assert.ok(Object.values(totals).every(Number.isFinite));
});

test('sumItems and sumMeals tolerate empty or broken input', () => {
  assert.equal(sumItems().totals.kcal, 0);
  assert.equal(sumItems([null, {}, { grams: 100 }]).totals.kcal, 0);
  assert.equal(sumMeals([{ items: [{ grams: 100, per100: rice }] }, { name: 'no items' }]).totals.kcal, 130);
});

test('changing grams changes every total with no other input (the slider needs nothing else)', () => {
  const item = { grams: 150, per100: rice };
  const before = sumItems([item]).totals;
  item.grams = 200;
  const after = sumItems([item]).totals;
  near(after.kcal / before.kcal, 200 / 150);
  near(after.carbs_g / before.carbs_g, 200 / 150);
});

test('macroMismatch: flags calories that the macros cannot explain', () => {
  near(kcalFromMacros(chicken), 31 * 4 + 3.6 * 9);
  assert.equal(macroMismatch(chicken), false);
  assert.equal(macroMismatch(rice), false);
  assert.equal(macroMismatch({ kcal: 400, protein_g: 10, carbs_g: 20, fat_g: 5 }), true);   // macros give 165
  assert.equal(macroMismatch({ kcal: 20, protein_g: 1, carbs_g: 1, fat_g: 0 }), false);     // small absolute gap
  assert.equal(macroMismatch({ protein_g: 10 }), false);                                     // nothing stated
});

test('clampGrams: stays in range and on the step', () => {
  assert.equal(clampGrams(152, 80, 260), 150);
  assert.equal(clampGrams(20, 80, 260), 80);
  assert.equal(clampGrams(999, 80, 260), 260);
  assert.equal(clampGrams(-5), 0);
  assert.equal(clampGrams(NaN, 10, 50), 10);
  assert.equal(clampGrams(7, 0, 30, 1), 7);
});

test('progress and formatting', () => {
  assert.equal(progress(1050, 2100), 0.5);
  assert.equal(progress(100, 0), 0);
  assert.equal(progress(undefined, 100), 0);
  assert.equal(fmtNum(1240), '1.240');
  assert.equal(fmtNum(9.46), '9,5');
  assert.equal(fmtNum(12.6), '13');
  assert.equal(fmtNum(0), '0');
  assert.equal(fmtAmount(57.2, 'protein_g'), '57 g');
  assert.equal(fmtAmount(2.5, 'vit_b12_ug'), '2,5 µg');
});

test('microCoverage: tells a complete table food from a product that only has label data', async () => {
  const { microCoverage } = await import('../app/core/nutrition.js');
  assert.equal(microCoverage(null), 0);
  assert.equal(microCoverage({ kcal: 97, protein_g: 9, sodium_mg: 35, calcium_mg: 100 }), 2 / 15);
  const full = Object.fromEntries(KEYS.map((k) => [k, 0]));
  assert.equal(microCoverage(full), 1);
});
