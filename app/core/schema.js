/* foodie · data shapes (pure logic). Everything read from storage, imported or typed by the user goes through
   these cleaners: they return a clean copy or null, never throw, and never trust the input.

   days[iso]  = { meals: { [id]: Meal }, waterMl, steps }
   Meal       = { id, name, slot, time: 'HH:MM', source, confidence?, items: [Item] }
   Item       = { name, grams, gramsMin?, gramsMax?, per100 }        (totals are always derived, never stored)
   goals      = [{ from: iso, goals: { kcal, protein_g, carbs_g, fat_g, waterL, steps } }]   (sorted by `from`)
*/
import { KEYS } from './nutrition.js';
import { isIso } from './dates.js';

export const SLOTS = ['Desayuno', 'Almuerzo', 'Cena', 'Snack'];
export const SOURCES = ['ai', 'barcode', 'label', 'db', 'manual'];

const MAX_ITEMS = 60;
const MAX_GRAMS = 5000;
const MAX_WATER_ML = 20000;
const MAX_STEPS = 200000;
const MAX_SAVED = 300;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const numIn = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const round1 = (v) => Math.round(v * 10) / 10;

/** Composition per 100 g: only the nutrients the app knows, only valid numbers. Null without calories. */
export function cleanPer100(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const k of KEYS) {
    const max = k === 'kcal' ? 1000 : k.endsWith('_g') ? 100 : 100000;
    const v = numIn(raw[k], 0, max);
    if (v !== null) out[k] = v;
  }
  return 'kcal' in out ? out : null;
}

export function cleanItem(raw) {
  if (!isObj(raw)) return null;
  const name = text(raw.name, 120);
  const grams = numIn(raw.grams, 0, MAX_GRAMS);
  const per100 = cleanPer100(raw.per100);
  if (!name || grams === null || !per100) return null;
  const item = { name, grams, per100 };
  const min = numIn(raw.gramsMin, 0, MAX_GRAMS);
  const max = numIn(raw.gramsMax, 0, MAX_GRAMS);
  if (min !== null && max !== null && min <= max) { item.gramsMin = min; item.gramsMax = max; }
  return item;
}

export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function cleanMeal(raw) {
  if (!isObj(raw)) return null;
  const id = text(raw.id, 64);
  if (!id || !Array.isArray(raw.items)) return null;
  const items = raw.items.slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean);
  if (!items.length) return null;
  const meal = {
    id,
    name: text(raw.name, 80) || items.slice(0, 3).map((it) => it.name).join(', '),
    slot: SLOTS.includes(raw.slot) ? raw.slot : 'Snack',
    time: TIME.test(raw.time) ? raw.time : '12:00',
    source: SOURCES.includes(raw.source) ? raw.source : 'manual',
    items,
  };
  const confidence = numIn(raw.confidence, 0, 1);
  if (confidence !== null) meal.confidence = confidence;
  return meal;
}

export const emptyDay = () => ({ meals: {}, waterMl: 0, steps: 0 });

export function cleanDay(raw) {
  if (!isObj(raw)) return null;
  const day = emptyDay();
  if (isObj(raw.meals)) {
    for (const m of Object.values(raw.meals)) {
      const meal = cleanMeal(m);
      if (meal) day.meals[meal.id] = meal;
    }
  }
  day.waterMl = Math.round(numIn(raw.waterMl, 0, MAX_WATER_ML) || 0);
  day.steps = Math.round(numIn(raw.steps, 0, MAX_STEPS) || 0);
  return day;
}

export const isEmptyDay = (day) => !day || (!Object.keys(day.meals).length && !day.waterMl && !day.steps);

/** Every valid day of a stored map; empty days and invalid dates are dropped. */
export function cleanDays(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [iso, d] of Object.entries(raw)) {
    if (!isIso(iso)) continue;
    const day = cleanDay(d);
    if (day && !isEmptyDay(day)) out[iso] = day;
  }
  return out;
}

/** Days with at least one meal (water or steps alone do not count as "logged", for the streak and the calendar). */
export const loggedDays = (days) => new Set(Object.keys(days || {}).filter((iso) => Object.keys(days[iso].meals).length > 0));

/** Meals of a day in time order. */
export const mealsOfDay = (day) => (day ? Object.values(day.meals) : [])
  .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

export const GOAL_RANGES = {
  kcal: [800, 6000], protein_g: [0, 600], carbs_g: [0, 1000], fat_g: [0, 400], waterL: [0.5, 8], steps: [0, 60000],
};

export function cleanGoals(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(GOAL_RANGES)) {
    const v = numIn(raw[k], lo, hi);
    if (v === null) return null;
    out[k] = k === 'waterL' ? round1(v) : Math.round(v);
  }
  return out;
}

export function cleanGoalsHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const byDate = new Map();
  for (const e of raw) {
    const goals = isObj(e) && isIso(e.from) ? cleanGoals(e.goals) : null;
    if (goals) byDate.set(e.from, { from: e.from, goals });
  }
  return [...byDate.values()].sort((a, b) => (a.from < b.from ? -1 : 1)).slice(-1000);
}

/** Goals in force on a day: the latest entry that started on or before it (before the first entry, the first one). */
export function goalsFor(history, iso) {
  if (!history || !history.length) return null;
  let current = history[0];
  for (const e of history) if (e.from <= iso) current = e; else break;
  return current.goals;
}

const sameGoals = (a, b) => Object.keys(GOAL_RANGES).every((k) => a[k] === b[k]);

/** New history with `goals` taking effect on `from`. Setting what is already in force changes nothing. */
export function setGoalsEntry(history, from, goals) {
  const clean = cleanGoals(goals);
  if (!clean || !isIso(from)) return history;
  const inForce = goalsFor(history, from);
  const sameDay = history.find((e) => e.from === from);
  if (!sameDay && inForce && sameGoals(inForce, clean)) return history;
  const rest = history.filter((e) => e.from !== from);
  return [...rest, { from, goals: clean }].sort((a, b) => (a.from < b.from ? -1 : 1));
}

export function cleanSaved(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const m of raw) {
    const meal = cleanMeal(m);
    if (meal && !seen.has(meal.id)) { seen.add(meal.id); out.push(meal); }
  }
  return out.slice(0, MAX_SAVED);
}

export function cleanWeights(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [iso, kg] of Object.entries(raw)) {
    const v = isIso(iso) ? numIn(kg, 30, 300) : null;
    if (v !== null) out[iso] = round1(v);
  }
  return out;
}

/** [{ iso, kg }] oldest first. */
export const weightList = (weights) => Object.keys(weights || {}).sort().map((iso) => ({ iso, kg: weights[iso] }));

/** Slot to suggest at a given hour (0-23), with Spanish meal times. */
export function defaultSlot(hour) {
  if (hour >= 5 && hour < 11) return 'Desayuno';
  if (hour >= 11 && hour < 17) return 'Almuerzo';
  if (hour >= 17 && hour < 20) return 'Snack';
  return 'Cena';
}

export const clampWater = (ml) => Math.round(Math.min(MAX_WATER_ML, Math.max(0, Number(ml) || 0)));
export const clampSteps = (n) => Math.round(Math.min(MAX_STEPS, Math.max(0, Number(n) || 0)));
