import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  VISION_JSON_SCHEMA, SCALE_REFS, MAX_ITEMS, MAX_GRAMS, LOW_CONFIDENCE, MAX_CONTEXT, toSdkSchema, buildVisionPrompt, parseVision, needsContextScreen, confidenceWord, visionMeal,
} from '../app/core/vision.js';
import { cleanMeal, cleanPer100 } from '../app/core/schema.js';
import { sumItems, KEYS } from '../app/core/nutrition.js';
import { makeRng, FUZZ_SEED } from './helpers/prng.js';
import { anyValue, mutate, HOSTILE_KEYS, FORBIDDEN_CHARS } from './helpers/hostile.js';
import * as inv from './helpers/invariants.js';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/vision/${name}.json`, import.meta.url)), 'utf8'));
const protoClean = () => assert.equal(({}).polluted, undefined);

test('schema: the required fields of the brief, items 1 to 12, per-100 g requirements', () => {
  assert.deepEqual(VISION_JSON_SCHEMA.required, ['is_food', 'dish', 'confidence', 'scale_ref', 'needs_context', 'items']);
  assert.deepEqual(VISION_JSON_SCHEMA.properties.scale_ref.enum, ['plate', 'cutlery', 'hand', 'glass', 'package', 'none']);
  assert.equal(VISION_JSON_SCHEMA.properties.items.maxItems, 12);
  assert.equal(VISION_JSON_SCHEMA.properties.items.minItems, 1);
  const item = VISION_JSON_SCHEMA.properties.items.items;
  assert.deepEqual(item.required, ['name', 'grams', 'grams_min', 'grams_max', 'confidence', 'hidden', 'per100']);
  assert.deepEqual(item.properties.per100.required, ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugars_g', 'sodium_mg']);
  const known = new Set(KEYS);
  for (const k of Object.keys(item.properties.per100.properties)) assert.ok(known.has(k), `${k} is a nutrient of the app`);
  for (const k of ['sat_fat_g', 'potassium_mg', 'calcium_mg', 'iron_mg', 'magnesium_mg', 'vit_a_ug', 'vit_c_mg', 'vit_d_ug', 'vit_e_mg', 'vit_b1_mg', 'vit_b2_mg', 'vit_b3_mg', 'vit_b6_mg', 'vit_b9_ug', 'vit_b12_ug']) {
    assert.ok(k in item.properties.per100.properties, k);
    assert.ok(!item.properties.per100.required.includes(k), `${k} is optional`);
  }
});

test('toSdkSchema: builds the SDK schema with optional properties taken from `required`', () => {
  const made = [];
  const wrap = (kind) => (p) => { const s = { kind, ...p }; made.push(s); return s; };
  const Schema = { object: wrap('object'), array: wrap('array'), string: wrap('string'), number: wrap('number'), boolean: wrap('boolean'), enumString: wrap('enum') };
  const s = toSdkSchema(VISION_JSON_SCHEMA, Schema);
  assert.equal(s.kind, 'object');
  assert.deepEqual(s.optionalProperties, ['notes']);
  assert.equal(s.properties.scale_ref.kind, 'enum');
  assert.deepEqual(s.properties.scale_ref.enum, SCALE_REFS);
  assert.equal(s.properties.items.kind, 'array');
  assert.equal(s.properties.items.maxItems, 12);
  const per100 = s.properties.items.items.properties.per100;
  assert.ok(per100.optionalProperties.includes('iron_mg') && !per100.optionalProperties.includes('kcal'));
  assert.throws(() => toSdkSchema({ type: 'weird' }, Schema), /unsupported/);
});

test('prompt: the context is cleaned, bounded and marked as true; without it there is none; a label gets its own instruction', () => {
  const plain = buildVisionPrompt();
  assert.match(plain.system, /scale reference/);
  assert.match(plain.system, /hidden = true/);
  assert.match(plain.system, /AVAILABLE carbohydrate/);
  assert.match(plain.system, /needs_context to true/);
  assert.match(plain.system, /Spanish/);
  assert.doesNotMatch(plain.user, /Contexto aportado/);
  const ctx = buildVisionPrompt({ context: `  burrito de pollo‮ con arroz\u0000 y frijoles ${'x'.repeat(1000)}` });
  assert.match(ctx.user, /Contexto aportado/);
  assert.ok(!FORBIDDEN_CHARS.test(ctx.user.replace(/\n/g, ' ')));
  assert.ok(ctx.user.length < 200 + MAX_CONTEXT * 2);
  assert.doesNotMatch(plain.user, /nutrition facts table/);
  assert.match(buildVisionPrompt({ label: true }).user, /nutrition facts table/);
  for (const bad of [undefined, null, 5, {}, ['x']]) assert.doesNotMatch(buildVisionPrompt({ context: bad }).user, /Contexto aportado/);
});

test('parseVision: a good plate keeps every ingredient with its range and marks the implied oil', () => {
  const r = parseVision(JSON.stringify(fixture('plate')));
  assert.equal(r.ok, true);
  assert.equal(r.isFood, true);
  assert.equal(r.dish, 'Pollo a la plancha con arroz y ensalada');
  assert.equal(r.confidence, 0.78);
  assert.equal(r.scaleRef, 'plate');
  assert.equal(r.needsContext, false);
  assert.equal(r.items.length, 4);
  assert.deepEqual(r.items.map((i) => i.hidden), [false, false, false, true]);
  const chicken = r.items[0];
  assert.deepEqual([chicken.grams, chicken.gramsMin, chicken.gramsMax], [140, 110, 180]);
  assert.equal(chicken.per100.protein_g, 31);
  assert.equal(chicken.inconsistent, false);
  for (const it of r.items) assert.ok(cleanPer100(it.per100));
  assert.equal(needsContextScreen(r), false);
  const kcal = sumItems(r.items).totals.kcal;
  assert.ok(kcal > 450 && kcal < 650, `${kcal} kcal is a plausible plate`);
});

test('parseVision: accepts the answer as text, in a code fence, or already parsed', () => {
  const text = JSON.stringify(fixture('plate'));
  assert.equal(parseVision(text).items.length, 4);
  assert.equal(parseVision('```json\n' + text + '\n```').items.length, 4);
  assert.equal(parseVision(fixture('plate')).items.length, 4);
});

test('parseVision: a closed burrito asks for context, not for trust', () => {
  const r = parseVision(fixture('burrito'));
  assert.equal(r.ok, true);
  assert.equal(r.needsContext, true);
  assert.equal(needsContextScreen(r), true);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[1].hidden, true);
});

test('parseVision: not food has no items and a low confidence', () => {
  const r = parseVision(fixture('not-food'));
  assert.equal(r.ok, true);
  assert.equal(r.isFood, false);
  assert.deepEqual(r.items, []);
  assert.ok(r.confidence <= 0.2);
  assert.equal(needsContextScreen(r), true);
  assert.equal(parseVision({ is_food: false, items: [{ name: 'x', grams: 5, per100: { kcal: 1 } }] }).items.length, 0);
});

test('parseVision: low confidence and no items also lead to the context screen', () => {
  assert.equal(needsContextScreen(parseVision({ ...fixture('plate'), confidence: LOW_CONFIDENCE - 0.01 })), true);
  assert.equal(needsContextScreen(parseVision({ ...fixture('plate'), confidence: LOW_CONFIDENCE })), false);
  assert.deepEqual(parseVision({ ...fixture('plate'), items: [] }), { ok: false, reason: 'empty' });
  assert.equal(needsContextScreen({ ok: false, reason: 'empty' }), false);
});

test('parseVision: hostile model output is cleaned, clamped and never trusted', () => {
  const r = parseVision(JSON.stringify(fixture('hostile')));
  assert.equal(r.ok, true);
  assert.equal(r.dish, '<script>alert(1)</script>plato');                       // markup stays text; the bidi mark is gone
  assert.equal(r.confidence, 1, 'a confidence of 7 is clamped');
  assert.equal(r.scaleRef, 'none', 'an unknown reference is "none"');
  assert.equal(r.needsContext, false, '"yes" is not true');
  assert.equal(r.notes, '<img src=x onerror=alert(1)>');
  const names = r.items.map((i) => i.name);
  assert.ok(!names.includes('') && !names.includes('sin calorias') && !names.includes('gramos negativos'), 'items without a name, calories or positive grams are dropped');
  const rice = r.items[0];
  assert.equal(rice.name, '<b>arroz</b>');
  assert.equal(rice.grams, MAX_GRAMS, 'a billion grams is capped');
  assert.ok(rice.gramsMin <= rice.grams && rice.gramsMax >= rice.grams);
  assert.equal(rice.confidence, 0);
  assert.equal(rice.hidden, false);
  assert.deepEqual(Object.keys(rice.per100).sort(), ['carbs_g', 'fat_g', 'kcal', 'protein_g']);
  assert.equal(r.items.find((i) => i.name === 'gramos texto').grams, 150, 'numeric strings are read');
  assert.ok(!names.includes('kcal absurdas'), 'kcal beyond any food is dropped');
  assert.equal(r.items.find((i) => i.name === 'no cuadra').inconsistent, true, 'kcal that do not match the macros are flagged');
  assert.ok(Array.from(names.at(-1)).length <= 120);
  protoClean();
  assert.equal(Object.getPrototypeOf(r.items[0].per100), Object.prototype);
  assert.equal(r.items[0].per100.constructor, Object);
});

test('parseVision: more than 12 items are cut, the scale reference list is closed', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `a${i}`, grams: 10, per100: { kcal: 10 } }));
  assert.equal(parseVision({ is_food: true, items: many }).items.length, MAX_ITEMS);
  for (const ref of SCALE_REFS) assert.equal(parseVision({ ...fixture('plate'), scale_ref: ref }).scaleRef, ref);
  for (const ref of ['', 'PLATE', '__proto__', 5, null, {}]) assert.equal(parseVision({ ...fixture('plate'), scale_ref: ref }).scaleRef, 'none');
});

test('parseVision: slider ranges are always usable (min <= grams <= max, not a point)', () => {
  const r = parseVision({ is_food: true, items: [
    { name: 'a', grams: 100, grams_min: 200, grams_max: 50, per100: { kcal: 10 } },
    { name: 'b', grams: 100, per100: { kcal: 10 } },
    { name: 'c', grams: 100, grams_min: 100, grams_max: 100, per100: { kcal: 10 } },
    { name: 'd', grams: 2000, grams_min: 1500, grams_max: 5000, per100: { kcal: 10 } },
  ] });
  for (const it of r.items) {
    assert.ok(it.gramsMin <= it.grams, `${it.name}: min`);
    assert.ok(it.gramsMax >= it.grams, `${it.name}: max`);
    assert.ok(it.gramsMax <= MAX_GRAMS);
  }
  assert.ok(r.items[2].gramsMax > r.items[2].grams, 'a range of zero width is widened');
});

test('parseVision: junk in, {ok:false} out, never an exception', () => {
  for (const bad of [null, undefined, '', 'not json', '{', '[]', '42', 'null', {}, [], 7, '{"items": "x"}'.repeat(2), 'x'.repeat(300000), '{"is_food": true}']) {
    const r = parseVision(bad);
    assert.equal(r.ok, false, String(bad).slice(0, 30));
    assert.ok(['invalid', 'empty'].includes(r.reason));
  }
});

test('confidenceWord: a word, with the same threshold as the context gate', () => {
  assert.equal(confidenceWord(0.9), 'Estimación segura');
  assert.equal(confidenceWord(0.75), 'Estimación segura');
  assert.equal(confidenceWord(0.6), 'Estimación media');
  assert.equal(confidenceWord(LOW_CONFIDENCE), 'Estimación media');
  assert.equal(confidenceWord(LOW_CONFIDENCE - 0.01), 'Estimación baja');
  assert.equal(confidenceWord(0), 'Estimación baja');
});

test('visionMeal: source ai with its confidence, implied items marked, valid for the store, thumbnail only if given', () => {
  const r = parseVision(fixture('plate'));
  const meal = visionMeal(r, { name: '  Comida de hoy ', slot: 'Almuerzo', time: '14:05', thumb: 'data:image/jpeg;base64,/9j/4AAQ' });
  assert.equal(meal.source, 'ai');
  assert.equal(meal.confidence, 0.78);
  assert.equal(meal.name, 'Comida de hoy');
  assert.equal(meal.items[3].name, 'aceite de oliva (estimado)');
  assert.equal(meal.items[0].name, 'pechuga de pollo a la plancha');
  const clean = cleanMeal({ ...meal, id: 'v1' });
  assert.ok(clean);
  assert.equal(clean.thumb, 'data:image/jpeg;base64,/9j/4AAQ');
  assert.equal(inv.mealProblem(clean), '');
  assert.equal('thumb' in cleanMeal({ ...visionMeal(r, { slot: 'Cena' }), id: 'v2' }), false);
  assert.equal(visionMeal(r, { slot: 'Cena' }).name, 'Pollo a la plancha con arroz y ensalada');
  assert.equal(visionMeal(parseVision({ is_food: true, dish: '', items: [{ name: 'queso', grams: 30, per100: { kcal: 400 } }] }), { slot: 'Cena' }).name, 'queso');
});

test('thumbnails in meals: only a small JPEG data URL, nothing else, nothing large', () => {
  const base = { id: 't1', name: 'x', items: [{ name: 'x', grams: 1, per100: { kcal: 1 } }] };
  const ok = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  assert.equal(cleanMeal({ ...base, thumb: ok }).thumb, ok);
  for (const bad of ['data:image/png;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA', 'javascript:alert(1)', 'https://evil.example/x.jpg', 'data:image/jpeg;base64,', 'data:image/jpeg;base64,AA AA',
    'data:image/jpeg;base64,' + 'A'.repeat(12 * 1024), 5, {}, null, '<img src=x onerror=1>']) {
    assert.equal('thumb' in cleanMeal({ ...base, thumb: bad }), false, String(bad).slice(0, 40));
  }
  assert.equal(cleanMeal({ ...base, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(12 * 1024 - 23) }).thumb.length, 12 * 1024 - 0);
});

test('parseVision: fuzzed answers (wrong types, huge numbers, hostile keys, traps) always give a valid result or a clean refusal', () => {
  const rng = makeRng(FUZZ_SEED + 99);
  const base = fixture('plate');
  for (let i = 0; i < 3000; i += 1) {
    const input = rng.chance(0.25) ? anyValue(rng) : mutate(rng, base);
    let r;
    try { r = parseVision(input); } catch (e) { assert.fail(`threw ${e.message} (seed ${FUZZ_SEED + 99}, iteration ${i})`); }
    if (!r.ok) { assert.ok(['invalid', 'empty'].includes(r.reason)); continue; }
    assert.ok(r.items.length <= MAX_ITEMS);
    assert.equal(inv.textProblem(r.dish, 80, 'dish', { required: false }), '', `dish (seed ${FUZZ_SEED + 99}, iteration ${i})`);
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.ok(SCALE_REFS.includes(r.scaleRef));
    for (const it of r.items) {
      assert.equal(inv.textProblem(it.name, 120, 'name'), '');
      assert.equal(inv.per100Problem(it.per100), '', `per100 (seed ${FUZZ_SEED + 99}, iteration ${i})`);
      assert.ok(it.grams >= 1 && it.grams <= MAX_GRAMS && it.gramsMin <= it.grams && it.gramsMax >= it.grams && it.gramsMax <= MAX_GRAMS);
      assert.ok(it.confidence >= 0 && it.confidence <= 1);
      assert.equal(typeof it.hidden, 'boolean');
    }
    const meal = cleanMeal({ ...visionMeal(r, { slot: 'Cena' }), id: 'f1' });
    if (r.items.length) assert.equal(inv.mealProblem(meal), '');
  }
  protoClean();
  for (const k of HOSTILE_KEYS) assert.equal(({})[k] === undefined || typeof ({})[k] === 'function' || k === '__proto__', true);
});
