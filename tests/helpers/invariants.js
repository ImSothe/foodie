/* Shape invariants every cleaned value must satisfy, and generators of valid values to mutate.
   A check returns an empty string when the value is fine, otherwise a description of what is wrong. */
import { KEYS } from '../../app/core/nutrition.js';
import { SLOTS, SOURCES, GOAL_RANGES } from '../../app/core/schema.js';

// The limits are written out here on purpose: the tests state the policy, they do not read it back from the code under test.
const MAX_ITEMS = 60;
const MAX_MEALS_PER_DAY = 100;
const MAX_DAYS = 4000;
const MAX_SAVED = 300;
const MAX_WEIGHTS = 4000;
import { LIMITS } from '../../app/core/goals.js';
import { isIso } from '../../app/core/dates.js';
import { FORBIDDEN_CHARS } from './hostile.js';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && !Object.is(v, -0);
const onlyKeys = (o, allowed) => Object.keys(o).filter((k) => !allowed.includes(k));
const RESERVED = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'];

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) i += 1; else return true;
    } else if (c >= 0xDC00 && c <= 0xDFFF) return true;
  }
  return false;
}

export function textProblem(s, max, what, { required = true } = {}) {
  if (typeof s !== 'string') return `${what} is not a string`;
  if (required && !s) return `${what} is empty`;
  if (FORBIDDEN_CHARS.test(s)) return `${what} keeps a control, zero-width or bidi character`;
  if (hasLoneSurrogate(s)) return `${what} has a lone surrogate`;
  if (Array.from(s).length > max) return `${what} is longer than ${max} code points`;
  if (s !== s.trim() || /\s\s/.test(s)) return `${what} has loose whitespace`;
  return '';
}

export const idProblem = (id, what = 'id') => (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !RESERVED.includes(id) ? '' : `${what} is not a safe id: ${JSON.stringify(String(id).slice(0, 30))}`);

export function per100Problem(p) {
  if (!isPlain(p)) return 'per100 is not an object';
  const extra = onlyKeys(p, KEYS);
  if (extra.length) return `per100 has unknown keys ${extra}`;
  if (!('kcal' in p)) return 'per100 has no kcal';
  for (const [k, v] of Object.entries(p)) {
    const max = k === 'kcal' ? 1000 : k.endsWith('_g') ? 100 : 100000;
    if (!fin(v, 0, max)) return `per100.${k} = ${v}`;
  }
  return '';
}

export function itemProblem(it) {
  if (!isPlain(it)) return 'item is not an object';
  const extra = onlyKeys(it, ['name', 'grams', 'gramsMin', 'gramsMax', 'per100']);
  if (extra.length) return `item has unknown keys ${extra}`;
  if (('gramsMin' in it) !== ('gramsMax' in it)) return 'only one of gramsMin and gramsMax';
  if ('gramsMin' in it && !(fin(it.gramsMin, 0, 5000) && fin(it.gramsMax, 0, 5000) && it.gramsMin <= it.gramsMax)) return 'bad slider range';
  return textProblem(it.name, 120, 'item.name') || (fin(it.grams, 0, 5000) ? '' : `item.grams = ${it.grams}`) || per100Problem(it.per100);
}

export function mealProblem(m) {
  if (!isPlain(m)) return 'meal is not an object';
  const extra = onlyKeys(m, ['id', 'name', 'slot', 'time', 'source', 'confidence', 'items']);
  if (extra.length) return `meal has unknown keys ${extra}`;
  if (!SLOTS.includes(m.slot) || !SOURCES.includes(m.source)) return 'meal slot or source not allowed';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(m.time)) return `meal.time = ${m.time}`;
  if ('confidence' in m && !fin(m.confidence, 0, 1)) return 'meal.confidence';
  if (!Array.isArray(m.items) || m.items.length < 1 || m.items.length > MAX_ITEMS) return 'meal.items length';
  return idProblem(m.id, 'meal.id') || textProblem(m.name, 80, 'meal.name') || m.items.map(itemProblem).find(Boolean) || '';
}

export function dayProblem(d) {
  if (!isPlain(d)) return 'day is not an object';
  if (Object.keys(d).join() !== 'meals,waterMl,steps') return `day keys ${Object.keys(d)}`;
  if (Object.getPrototypeOf(d.meals) !== null) return 'day.meals has a prototype';
  const ids = Object.keys(d.meals);
  if (ids.length > MAX_MEALS_PER_DAY) return 'too many meals in a day';
  for (const id of ids) if (d.meals[id].id !== id) return 'meal stored under a different id';
  if (!Number.isInteger(d.waterMl) || d.waterMl < 0 || d.waterMl > 20000 || Object.is(d.waterMl, -0)) return 'waterMl';
  if (!Number.isInteger(d.steps) || d.steps < 0 || d.steps > 200000 || Object.is(d.steps, -0)) return 'steps';
  return ids.map((id) => mealProblem(d.meals[id])).find(Boolean) || '';
}

export function daysProblem(days) {
  if (!isPlain(days) || Object.getPrototypeOf(days) !== null) return 'days is not a prototype-less map';
  const keys = Object.keys(days);
  if (keys.length > MAX_DAYS) return 'too many days';
  for (const k of keys) if (!isIso(k)) return `invalid date key ${k}`;
  return keys.map((k) => dayProblem(days[k])).find(Boolean) || '';
}

export function goalsProblem(g) {
  if (!isPlain(g)) return 'goals is not an object';
  if (onlyKeys(g, Object.keys(GOAL_RANGES)).length || Object.keys(g).length !== Object.keys(GOAL_RANGES).length) return 'goals keys';
  for (const [k, [lo, hi]] of Object.entries(GOAL_RANGES)) if (!fin(g[k], lo, hi)) return `goals.${k} = ${g[k]}`;
  return '';
}

export function historyProblem(h) {
  if (!Array.isArray(h)) return 'history is not an array';
  if (h.length > 1000) return 'history too long';
  for (let i = 0; i < h.length; i += 1) {
    if (!isPlain(h[i]) || Object.keys(h[i]).join() !== 'from,goals' || !isIso(h[i].from)) return `history[${i}] shape`;
    if (i > 0 && !(h[i - 1].from < h[i].from)) return 'history is not strictly sorted';
    const p = goalsProblem(h[i].goals);
    if (p) return p;
  }
  return '';
}

export function savedProblem(s) {
  if (!Array.isArray(s)) return 'saved is not an array';
  if (s.length > MAX_SAVED) return 'too many favourites';
  if (new Set(s.map((m) => m && m.id)).size !== s.length) return 'duplicate favourite ids';
  return s.map(mealProblem).find(Boolean) || '';
}

export function weightsProblem(w) {
  if (!isPlain(w) || Object.getPrototypeOf(w) !== null) return 'weights is not a prototype-less map';
  const keys = Object.keys(w);
  if (keys.length > MAX_WEIGHTS) return 'too many weights';
  for (const k of keys) {
    if (!isIso(k)) return `invalid date key ${k}`;
    if (!fin(w[k], 30, 300) || Math.round(w[k] * 10) / 10 !== w[k]) return `weight ${w[k]}`;
  }
  return '';
}

export function profileProblem(p) {
  if (!isPlain(p)) return 'profile is not an object';
  if (Object.keys(p).join() !== 'sex,birthYear,heightCm,weightKg,activity,goal,pace') return `profile keys ${Object.keys(p)}`;
  const age = new Date().getFullYear() - p.birthYear;
  if (!Number.isInteger(p.birthYear) || age < LIMITS.age[0] || age > LIMITS.age[1]) return 'profile age';
  if (!fin(p.heightCm, ...LIMITS.heightCm) || !fin(p.weightKg, ...LIMITS.weightKg)) return 'profile height or weight';
  if (!['male', 'female'].includes(p.sex) || !['sedentary', 'light', 'moderate', 'active', 'very_active'].includes(p.activity)) return 'profile enums';
  if (!['lose', 'maintain', 'gain'].includes(p.goal)) return 'profile goal';
  if (p.goal === 'maintain' ? p.pace !== null : ![0.05, 0.1, 0.15, 0.2, 0.25].includes(p.pace)) return `profile pace ${p.pace}`;
  return '';
}

// ---------- valid values (to mutate) ----------

export const validPer100 = () => ({ kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6, fiber_g: 0, sodium_mg: 74, iron_mg: 1 });
export const validItem = () => ({ name: 'Pollo', grams: 150, gramsMin: 50, gramsMax: 300, per100: validPer100() });
export const validMeal = (id = 'm1') => ({ id, name: 'Comida', slot: 'Almuerzo', time: '14:00', source: 'db', confidence: 0.8, items: [validItem(), validItem()] });
export const validDay = () => ({ meals: { a: validMeal('a'), b: validMeal('b') }, waterMl: 1500, steps: 4000 });
export const validDays = () => ({ '2026-11-12': validDay(), '2026-11-11': validDay(), '2026-02-30': validDay() });
export const validGoals = () => ({ kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 60, waterL: 2.5, steps: 8000 });
export const validHistory = () => [{ from: '2026-11-01', goals: validGoals() }, { from: '2026-11-10', goals: validGoals() }];
export const validSaved = () => [validMeal('s1'), validMeal('s2')];
export const validWeights = () => ({ '2026-11-12': 80.2, '2026-11-01': 81.5 });
export const validProfile = () => ({ sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'lose', pace: 0.2 });
