import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasValidCheckDigit, normalizeCode, offUrl, per100FromNutriments, productFromOff } from '../app/core/off.js';
import { macroMismatch } from '../app/core/nutrition.js';
import { cleanPer100 } from '../app/core/schema.js';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/off/${name}.json`, import.meta.url)), 'utf8'));

test('check digit: real EAN-13, EAN-8, UPC-A and GTIN-14 pass; a changed digit fails', () => {
  for (const ok of ['3017620422003', '8410076472212', '96385074', '036000291452', '03017620422003']) assert.equal(hasValidCheckDigit(ok), true, ok);
  for (const bad of ['3017620422004', '96385075', '036000291453', '1234567', '', 'abcdefgh', '30176204220031']) assert.equal(hasValidCheckDigit(bad), false, bad);
});

test('normalizeCode: numbers and GS1 Digital Links are products, every other QR text is ignored', () => {
  assert.equal(normalizeCode('3017620422003'), '3017620422003');
  assert.equal(normalizeCode('  3017620422003\n'), '3017620422003');
  assert.equal(normalizeCode('https://id.gs1.org/01/03017620422003/10/LOT1?x=1'), '3017620422003');
  assert.equal(normalizeCode('https://example.test/p/01/03017620422003'), '3017620422003');
  for (const nope of ['3017620422004', 'https://evil.example/login', 'javascript:alert(1)', 'WIFI:S:x;P:y;;', '<script>', '', null, undefined, 42, '1'.repeat(400), '01/03017620422003']) {
    assert.equal(normalizeCode(nope), null, String(nope).slice(0, 30));
  }
});

test('offUrl asks only for the fields it needs and encodes the code', () => {
  const u = offUrl('3017620422003');
  assert.ok(u.startsWith('https://world.openfoodfacts.org/api/v2/product/3017620422003.json?fields='));
  assert.ok(!/nutriscore|ingredients|images=/.test(u));
  assert.ok(offUrl('a/b?c').includes('a%2Fb%3Fc'));
});

test('real record: Nutella maps to per-100 g values that agree with its label', () => {
  const r = productFromOff(fixture('nutella'), '3017620422003');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Nutella');
  assert.equal(r.brand, 'Ferrero');
  assert.equal(r.per100.kcal, 539);
  assert.equal(r.per100.protein_g, 6.3);
  assert.equal(r.per100.carbs_g, 57.5);
  assert.equal(r.per100.fat_g, 30.9);
  assert.equal(r.per100.sat_fat_g, 10.6);
  assert.equal(r.per100.sugars_g, 56.3);
  assert.equal(r.per100.sodium_mg, 42.8);                // 0.0428 g -> mg
  assert.equal(r.estimated, false);
  assert.equal(macroMismatch(r.per100), false);
  assert.ok(cleanPer100(r.per100), 'the app schema accepts it');
  assert.ok(r.imageUrl === null || r.imageUrl.startsWith('https://images.openfoodfacts.org/'));
});

test('real record with a serving size keeps it as grams', () => {
  const r = productFromOff(fixture('taco-kit'), '8410076472212');
  assert.equal(r.ok, true);
  assert.equal(r.servingG, 43);
  assert.match(r.servingLabel, /43/);
});

test('a code that is not in the database is "not-found", and junk is "invalid"', () => {
  assert.deepEqual(productFromOff(fixture('not-found'), '0000000000000'), { ok: false, reason: 'not-found' });
  for (const junk of [null, undefined, 'x', 7, {}, { status: 1 }, { status: 1, product: 'p' }, []]) assert.deepEqual(productFromOff(junk, '1'), { ok: false, reason: 'invalid' });
});

test('units: minerals g -> mg, vitamins g -> µg, salt is turned into sodium, kJ into kcal', () => {
  const r = per100FromNutriments({ 'energy-kj_100g': 418.4, proteins_100g: 1, calcium_100g: 0.12, 'vitamin-d_100g': 0.000005, 'vitamin-c_100g': 0.08, salt_100g: 1 });
  assert.equal(r.per100.kcal, 100);
  assert.equal(r.per100.calcium_mg, 120);
  assert.equal(r.per100.vit_d_ug, 5);
  assert.equal(r.per100.vit_c_mg, 80);
  assert.equal(r.per100.sodium_mg, 400);
});

test('no energy but macros: calories are derived and flagged as estimated; nothing at all is "no-nutrition"', () => {
  const r = per100FromNutriments({ proteins_100g: 10, carbohydrates_100g: 20, fat_100g: 5 });
  assert.equal(r.per100.kcal, 165);
  assert.equal(r.estimated, true);
  assert.equal(per100FromNutriments({ 'nova-group_100g': 4 }), null);
  assert.deepEqual(productFromOff({ status: 1, product: { product_name: 'Vacío', nutriments: {} } }, '1'), { ok: false, reason: 'no-nutrition' });
});

test('hostile records: text is cleaned, impossible numbers are dropped, foreign image hosts are refused', () => {
  const r = productFromOff({ status: 1, product: {
    product_name: '<img src=x onerror=alert(1)>‮evil', brands: 'Marca\u0000, Otra', image_front_small_url: 'https://evil.example/x.png', serving_quantity: '1e9',
    nutriments: { 'energy-kcal_100g': 120, proteins_100g: -5, carbohydrates_100g: 1e9, fat_100g: '3', __proto__: { x: 1 } } } }, '1');
  assert.equal(r.ok, true);
  assert.ok(!/[‮\u0000]/.test(r.name) && !/[‮\u0000]/.test(r.brand));
  assert.equal(r.imageUrl, null);
  assert.equal(r.servingG, null);
  assert.ok(!('protein_g' in r.per100) && !('carbs_g' in r.per100));
  assert.equal(r.per100.fat_g, 3);
  assert.equal(({}).x, undefined);
  assert.ok(r.missing.includes('protein_g'));
});
