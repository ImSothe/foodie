import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeState, emptyState, mergeDay, MAX_FUTURE_MS } from '../app/core/merge.js';
import { cleanMeal, cleanDay, nullMap } from '../app/core/schema.js';
import { stateFromCloud } from '../app/core/cloudmap.js';
import { makeRng, FUZZ_SEED } from './helpers/prng.js';

const NOW = 1_800_000_000_000;
const ITEM = { name: 'Arroz', grams: 100, per100: { kcal: 130, protein_g: 2.7, carbs_g: 28, fat_g: 0.3 } };
const meal = (id, updatedAt, name = 'Comida') => cleanMeal({ id, name, slot: 'Almuerzo', time: '14:00', source: 'db', updatedAt, items: [ITEM] });
const dayWith = (meals, extra = {}) => cleanDay({ meals: Object.fromEntries(meals.map((m) => [m.id, m])), ...extra });
const state = (over = {}) => ({ ...emptyState(), ...over });
const plain = (v) => JSON.parse(JSON.stringify(v));
const merged = (a, b) => plain(mergeState(a, b, NOW));

test('a meal that exists on one side only is kept', () => {
  const local = state({ days: Object.assign(nullMap(), { '2026-11-10': dayWith([meal('a', NOW - 1000)]) }) });
  const out = mergeState(local, state(), NOW);
  assert.deepEqual(Object.keys(out.days['2026-11-10'].meals), ['a']);
  const rev = mergeState(state(), local, NOW);
  assert.deepEqual(Object.keys(rev.days['2026-11-10'].meals), ['a']);
});

test('two devices adding different meals the same day end up with both', () => {
  const a = state({ days: Object.assign(nullMap(), { '2026-11-10': dayWith([meal('a', NOW - 5000)]) }) });
  const b = state({ days: Object.assign(nullMap(), { '2026-11-10': dayWith([meal('b', NOW - 4000)]) }) });
  assert.deepEqual(Object.keys(mergeState(a, b, NOW).days['2026-11-10'].meals).sort(), ['a', 'b']);
});

test('the newest edit of the same meal wins, whichever side it is on', () => {
  const old = state({ days: Object.assign(nullMap(), { '2026-11-10': dayWith([meal('a', NOW - 9000, 'viejo')]) }) });
  const fresh = state({ days: Object.assign(nullMap(), { '2026-11-10': dayWith([meal('a', NOW - 1000, 'nuevo')]) }) });
  assert.equal(mergeState(old, fresh, NOW).days['2026-11-10'].meals.a.name, 'nuevo');
  assert.equal(mergeState(fresh, old, NOW).days['2026-11-10'].meals.a.name, 'nuevo');
});

test('a deletion travels as a tombstone and beats an older copy of the meal', () => {
  const kept = state({ days: Object.assign(nullMap(), { '2026-11-10': dayWith([meal('a', NOW - 9000)]) }) });
  const deleted = state({ days: Object.assign(nullMap(), { '2026-11-10': cleanDay({ meals: {}, deleted: { a: NOW - 1000 } }) }) });
  const out = mergeState(kept, deleted, NOW);
  assert.ok(!out.days['2026-11-10'] || !('a' in out.days['2026-11-10'].meals), 'the meal came back');
  assert.ok(out.days['2026-11-10'].deleted.a, 'the tombstone was lost');
});

test('a meal edited after it was deleted comes back', () => {
  const edited = state({ days: Object.assign(nullMap(), { '2026-11-10': dayWith([meal('a', NOW - 500)]) }) });
  const deleted = state({ days: Object.assign(nullMap(), { '2026-11-10': cleanDay({ meals: {}, deleted: { a: NOW - 5000 } }) }) });
  assert.ok('a' in mergeState(edited, deleted, NOW).days['2026-11-10'].meals);
});

test('a device whose clock is far in the future cannot win for ever', () => {
  const skewed = state({ days: Object.assign(nullMap(), { '2026-11-10': dayWith([meal('a', NOW + 365 * 864e5, 'reloj roto')]) }) });
  const honest = state({ days: Object.assign(nullMap(), { '2026-11-10': dayWith([meal('a', NOW - 1000, 'honesto')]) }) });
  const out = mergeState(skewed, honest, NOW).days['2026-11-10'].meals.a;
  assert.ok(out.updatedAt <= NOW + MAX_FUTURE_MS, `stamp ${out.updatedAt} was not capped`);
});

test('water and steps: the later edit wins; with no stamps the larger value survives', () => {
  const a = state({ days: Object.assign(nullMap(), { '2026-11-10': cleanDay({ meals: {}, waterMl: 500, waterAt: NOW - 9000 }) }) });
  const b = state({ days: Object.assign(nullMap(), { '2026-11-10': cleanDay({ meals: {}, waterMl: 250, waterAt: NOW - 1000 }) }) });
  assert.equal(mergeState(a, b, NOW).days['2026-11-10'].waterMl, 250);
  const c = state({ days: Object.assign(nullMap(), { '2026-11-10': cleanDay({ meals: {}, steps: 3000 }) }) });
  const d = state({ days: Object.assign(nullMap(), { '2026-11-10': cleanDay({ meals: {}, steps: 8000 }) }) });
  assert.equal(mergeState(c, d, NOW).days['2026-11-10'].steps, 8000);
});

test('favourites and weights from both devices are combined', () => {
  const a = state({ saved: [meal('f1', NOW - 100)], weights: Object.assign(nullMap(), { '2026-11-08': 77 }), weightsAt: Object.assign(nullMap(), { '2026-11-08': NOW - 100 }) });
  const b = state({ saved: [meal('f2', NOW - 50)], weights: Object.assign(nullMap(), { '2026-11-09': 76.5 }), weightsAt: Object.assign(nullMap(), { '2026-11-09': NOW - 50 }) });
  const out = mergeState(a, b, NOW);
  assert.deepEqual(out.saved.map((m) => m.id).sort(), ['f1', 'f2']);
  assert.deepEqual(Object.keys(out.weights).sort(), ['2026-11-08', '2026-11-09']);
});

// ---- algebraic properties on generated states: merging must give the same result in any order ----

function randomState(rng) {
  const days = nullMap();
  for (const iso of ['2026-11-08', '2026-11-09', '2026-11-10']) {
    if (!rng.chance(0.7)) continue;
    const ids = ['a', 'b', 'c', 'd'].filter(() => rng.chance(0.5));
    const meals = ids.filter(() => rng.chance(0.7)).map((id) => meal(id, NOW - rng.int(1, 100000), rng.pick(['uno', 'dos', 'tres'])));
    const deleted = Object.fromEntries(ids.filter(() => rng.chance(0.3)).map((id) => [id, NOW - rng.int(1, 100000)]));
    const d = cleanDay({ meals: Object.fromEntries(meals.map((m) => [m.id, m])), deleted, waterMl: rng.int(0, 3000), waterAt: rng.chance(0.5) ? NOW - rng.int(1, 9e4) : undefined, steps: rng.int(0, 12000) });
    if (d) days[iso] = d;
  }
  const saved = ['f1', 'f2', 'f3'].filter(() => rng.chance(0.5)).map((id) => meal(id, NOW - rng.int(1, 9e4)));
  return state({ days, saved });
}

test('merging is commutative, idempotent and associative (2,000 random state triples)', () => {
  const rng = makeRng(FUZZ_SEED);
  for (let i = 0; i < 2000; i += 1) {
    const [a, b, c] = [randomState(rng), randomState(rng), randomState(rng)];
    const ctx = `seed ${FUZZ_SEED}, round ${i}`;
    assert.deepEqual(merged(a, b), merged(b, a), `not commutative: ${ctx}`);
    assert.deepEqual(merged(a, a), merged(a, state()), `not idempotent: ${ctx}`);
    const ab = mergeState(a, b, NOW);
    assert.deepEqual(plain(mergeState(ab, ab, NOW)), plain(ab), `merge of a result with itself changed it: ${ctx}`);
    assert.deepEqual(plain(mergeState(mergeState(a, b, NOW), c, NOW)), plain(mergeState(a, mergeState(b, c, NOW), NOW)), `not associative: ${ctx}`);
  }
});

test('a live meal is never dropped unless a tombstone at least as new says so', () => {
  const rng = makeRng(FUZZ_SEED + 1);
  for (let i = 0; i < 1000; i += 1) {
    const a = randomState(rng);
    const b = randomState(rng);
    const out = mergeState(a, b, NOW);
    for (const side of [a, b]) {
      for (const [iso, day] of Object.entries(side.days)) {
        for (const [id, m] of Object.entries(day.meals)) {
          const here = out.days[iso] && out.days[iso].meals[id];
          if (here) continue;
          const tombs = [a, b].map((s) => s.days[iso] && s.days[iso].deleted && s.days[iso].deleted[id]).filter(Boolean);
          assert.ok(tombs.some((t) => t >= m.updatedAt), `meal ${id} on ${iso} vanished without a newer tombstone (seed ${FUZZ_SEED + 1}, round ${i})`);
        }
      }
    }
  }
});

test('hostile cloud documents are cleaned on the way in, then merge into a clean state and never throw', () => {
  const hostile = {
    user: { profile: 7, goals: 'x', profileAt: 'now' },
    days: { '2026-11-10': { meals: { ok: { id: 'ok', items: 'no' }, evil: { id: '__proto__', items: [] } }, deleted: { constructor: 5 } }, '__proto__': {}, 'not-a-date': {} },
    saved: 'x', weights: [1],
  };
  const fromCloud = stateFromCloud(hostile);
  const out = mergeState(state(), fromCloud, NOW);
  assert.equal(({}).x, undefined);
  assert.deepEqual(Object.keys(out.days), []);
  assert.deepEqual(out.saved, []);
  assert.doesNotThrow(() => mergeDay(null, null, NOW));
});
