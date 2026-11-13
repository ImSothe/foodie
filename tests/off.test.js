import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasValidCheckDigit, expandUpcE, normalizeCode, offUrl, per100FromNutriments, productFromOff } from '../app/core/off.js';
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

test('UPC-E: expands to the UPC-A it stands for (every zero-suppression rule), and only when the scanner says it is UPC-E', () => {
  // known expansions: 04252614 -> 042100005264 (last digit 1), 01234565 -> 012345000065 (last digit 5), 06543216 -> 065100004326 style checks below
  assert.equal(expandUpcE('04252614'), '042100005264');
  assert.equal(expandUpcE('01234565'), '012345000065');
  assert.equal(normalizeCode('04252614', 'upc_e'), '042100005264');
  assert.equal(normalizeCode('04252614'), null, 'without the format it is an 8-digit EAN-8 candidate with a wrong check digit');
  assert.equal(normalizeCode('04252615', 'upc_e'), null, 'a wrong check digit is still rejected');
  for (const bad of ['24252614', '4252614', 'abcdefgh', '', '0425261400']) assert.equal(expandUpcE(bad), null, bad);
  // every zero-suppression rule (last of the six digits 0..9) gives a 12-digit code whose check digit is the UPC-E's own
  const checkOf = (body11) => { let sum = 0; for (let i = 0; i < 11; i += 1) sum += Number(body11[i]) * (i % 2 === 0 ? 3 : 1); return String((10 - (sum % 10)) % 10); };
  const expandBody = (n, [a1, b1, c1, d1, e1, f1]) => (f1 <= '2' ? `${n}${a1}${b1}${f1}0000${c1}${d1}${e1}` : f1 === '3' ? `${n}${a1}${b1}${c1}00000${d1}${e1}` : f1 === '4' ? `${n}${a1}${b1}${c1}${d1}00000${e1}` : `${n}${a1}${b1}${c1}${d1}${e1}0000${f1}`);
  for (const n of ['0', '1']) for (let f = 0; f <= 9; f += 1) {
    const six = `38${f === 3 || f === 4 ? '7' : '2'}${f === 4 ? '5' : '6'}1${f}`;
    const body = expandBody(n, six);
    assert.equal(body.length, 11);
    const upcE = `${n}${six}${checkOf(body)}`;
    assert.equal(expandUpcE(upcE), body + checkOf(body), upcE);
    assert.equal(normalizeCode(upcE, 'upc_e'), body + checkOf(body), upcE);
  }
  assert.equal(normalizeCode('96385074', 'upc_e'), null, 'a real EAN-8 labelled as UPC-E does not pass as one');
  assert.equal(normalizeCode('96385074', 'ean_8'), '96385074');
});
