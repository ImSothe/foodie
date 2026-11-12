/* foodie · data shapes (pure logic). Everything read from storage, imported or typed by the user goes through
   these cleaners: they return a clean copy or null, never throw, and never trust the input.

   days[iso]  = { meals: { [id]: Meal }, waterMl, steps, waterAt?, stepsAt?, deleted?: { [id]: stamp } }
   Meal       = { id, name, slot, time: 'HH:MM', source, confidence?, updatedAt?, items: [Item] }
   stamp      = milliseconds since 1970 of the last edit (cloud sync: newest edit wins; `deleted` holds tombstones of removed meals)
   Item       = { name, grams, gramsMin?, gramsMax?, per100 }        (totals are always derived, never stored)
   goals      = [{ from: iso, goals: { kcal, protein_g, carbs_g, fat_g, waterL, steps } }]   (sorted by `from`)

   Safety rules enforced here (see SECURITY.md and tests/security.test.js):
   - text is single-line: control, zero-width and bidi characters are removed, whitespace collapsed, cut by code points;
   - ids match ^[A-Za-z0-9_-]{1,64}$ and are never "__proto__", "constructor" or other names of Object.prototype;
   - every map keyed by something that came from outside (days, meals, weights) has no prototype, so a hostile
     key can never reach Object.prototype;
   - collections are capped (meals per day, days, favourites, weights);
   - a cleaner that hits something unexpected (a getter that throws, say) answers null or empty, it does not throw. */
import { KEYS } from './nutrition.js';
import { isIso } from './dates.js';

export const SLOTS = ['Desayuno', 'Almuerzo', 'Cena', 'Snack'];
export const SOURCES = ['ai', 'barcode', 'label', 'db', 'manual'];

export const MAX_ITEMS = 60;
export const MAX_MEALS_PER_DAY = 100;
export const MAX_DAYS = 4000;
export const MAX_WEIGHTS = 4000;
export const MAX_SAVED = 300;
export const MAX_NAME = 80;
export const MAX_TOMBSTONES = 500;
/** Largest edit stamp accepted (the year 3000): anything beyond is not a time. */
export const MAX_STAMP = 32503680000000;
export const MAX_ITEM_NAME = 120;
const MAX_GRAMS = 5000;
const MAX_WATER_ML = 20000;
const MAX_STEPS = 200000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A finite number in range, or null. Negative zero becomes zero so JSON round trips are stable. */
const numIn = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? (v === 0 ? 0 : v) : null);
const round1 = (v) => Math.round(v * 10) / 10;
/** An edit time in ms since 1970, whole, or null. */
export const cleanStamp = (v) => { const n = numIn(v, 0, MAX_STAMP); return n === null ? null : Math.floor(n); };
/** Runs a cleaner so that nothing it meets (a throwing getter, a revoked proxy) can escape as an exception. */
const guard = (fn, fallback) => (...args) => {
  try { return fn(...args); } catch (e) { return fallback(); }
};
export const nullMap = () => Object.create(null);

// ---------- text and ids ----------

const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;                       // become a space, so words do not glue together
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g;      // every other C0 and C1 control: removed
// soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and direction marks (U+200B-200F),
// bidi embeddings/overrides (U+202A-202E), word joiner and invisible operators (U+2060-206F), bidi isolates, BOM, interlinear marks
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

function dropLoneSurrogates(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { out += s[i] + s[i + 1]; i += 1; }
    } else if (c < 0xDC00 || c > 0xDFFF) out += s[i];
  }
  return out;
}

/**
 * Single-line text: control, zero-width and bidi characters removed, whitespace collapsed, trimmed, and cut to `max`
 * code points (never in the middle of a surrogate pair). Anything that is not a string becomes ''.
 * Idempotent: cleanText(cleanText(x)) === cleanText(x).
 */
export function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  let t = v.length > SCAN_LIMIT ? v.slice(0, SCAN_LIMIT) : v;     // stored values are far smaller (5 MB is refused earlier); this only bounds the work
  if (/[\uD800-\uDFFF]/.test(t)) t = dropLoneSurrogates(t);
  t = t.replace(LINE_BREAKS, ' ').replace(CONTROL, '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const points = Array.from(t.slice(0, max * 2 + 2));              // at least max code points, never a pair cut in half after this step
  return points.length > max ? points.slice(0, max).join('').trim() : t.slice(0, max * 2 + 2).trim();
}

const SCAN_LIMIT = 1000000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_IDS = new Set([
  '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

/** True for ids that are safe to use as an object key and in the DOM. */
export const isId = (v) => typeof v === 'string' && ID.test(v) && !RESERVED_IDS.has(v);

// ---------- compositions, items, meals ----------

/** Composition per 100 g: only the nutrients the app knows, only valid numbers. Null without calories. */
export const cleanPer100 = guard((raw) => {
  if (!isObj(raw)) return null;
  const out = {};
  for (const k of KEYS) {
    const max = k === 'kcal' ? 1000 : k.endsWith('_g') ? 100 : 100000;
    const v = numIn(raw[k], 0, max);
    if (v !== null) out[k] = v;
  }
  return 'kcal' in out ? out : null;
}, () => null);

export const cleanItem = guard((raw) => {
  if (!isObj(raw)) return null;
  const name = cleanText(raw.name, MAX_ITEM_NAME);
  const grams = numIn(raw.grams, 0, MAX_GRAMS);
  const per100 = cleanPer100(raw.per100);
  if (!name || grams === null || !per100) return null;
  const item = { name, grams, per100 };
  const min = numIn(raw.gramsMin, 0, MAX_GRAMS);
  const max = numIn(raw.gramsMax, 0, MAX_GRAMS);
  if (min !== null && max !== null && min <= max) { item.gramsMin = min; item.gramsMax = max; }
  return item;
}, () => null);

export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * @param {*} raw
 * @param {{id?:*, time?:*, updatedAt?:*}} [over]  values that replace raw.id / raw.time / raw.updatedAt (the store uses it for new ids), read without copying `raw`
 */
export const cleanMeal = guard((raw, over) => {
  if (!isObj(raw)) return null;
  const id = over && 'id' in over ? over.id : raw.id;
  const rawItems = raw.items;
  if (!isId(id) || !Array.isArray(rawItems)) return null;
  const items = rawItems.slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean);
  if (!items.length) return null;
  const time = over && 'time' in over ? over.time : raw.time;
  const meal = {
    id,
    name: cleanText(raw.name, MAX_NAME) || cleanText(items.slice(0, 3).map((it) => it.name).join(', '), MAX_NAME),
    slot: SLOTS.includes(raw.slot) ? raw.slot : 'Snack',
    time: typeof time === 'string' && TIME.test(time) ? time : '12:00',
    source: SOURCES.includes(raw.source) ? raw.source : 'manual',
    items,
  };
  const confidence = numIn(raw.confidence, 0, 1);
  if (confidence !== null) meal.confidence = confidence;
  const updatedAt = over && 'updatedAt' in over ? cleanStamp(over.updatedAt) : cleanStamp(raw.updatedAt);
  if (updatedAt !== null) meal.updatedAt = updatedAt;
  return meal;
}, () => null);

// ---------- days ----------

export const emptyDay = () => ({ meals: nullMap(), waterMl: 0, steps: 0 });

export const cleanDay = guard((raw) => {
  if (!isObj(raw)) return null;
  const day = emptyDay();
  if (isObj(raw.meals)) {
    let count = 0;
    for (const m of Object.values(raw.meals)) {
      if (count >= MAX_MEALS_PER_DAY) break;
      const meal = cleanMeal(m);
      if (meal && !(meal.id in day.meals)) { day.meals[meal.id] = meal; count += 1; }
    }
  }
  day.waterMl = Math.round(numIn(raw.waterMl, 0, MAX_WATER_ML) || 0);
  day.steps = Math.round(numIn(raw.steps, 0, MAX_STEPS) || 0);
  // sync fields are written only when they carry something, so data that never meets the cloud keeps its old shape
  const waterAt = cleanStamp(raw.waterAt);
  const stepsAt = cleanStamp(raw.stepsAt);
  if (waterAt) day.waterAt = waterAt;
  if (stepsAt) day.stepsAt = stepsAt;
  const deleted = cleanTombstones(raw.deleted);
  if (Object.keys(deleted).length) day.deleted = deleted;
  return day;
}, () => null);

/** { [id]: stamp } of removed meals, the newest MAX_TOMBSTONES kept. */
export function cleanTombstones(raw) {
  const out = nullMap();
  if (!isObj(raw)) return out;
  const entries = [];
  for (const [id, at] of Object.entries(raw)) {
    const stamp = isId(id) ? cleanStamp(at) : null;
    if (stamp !== null) entries.push([id, stamp]);
  }
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [id, stamp] of entries.slice(0, MAX_TOMBSTONES)) out[id] = stamp;
  return out;
}

export const isEmptyDay = (day) => !day || (!Object.keys(day.meals).length && !day.waterMl && !day.steps && !day.waterAt && !day.stepsAt && !(day.deleted && Object.keys(day.deleted).length));

/** Every valid day of a stored map; empty days and invalid dates are dropped, and only the newest MAX_DAYS are kept. */
export const cleanDays = guard((raw) => {
  const out = nullMap();
  if (!isObj(raw)) return out;
  for (const [iso, d] of Object.entries(raw)) {
    if (!isIso(iso)) continue;
    const day = cleanDay(d);
    if (day && !isEmptyDay(day)) out[iso] = day;
  }
  const keys = Object.keys(out).sort();
  if (keys.length > MAX_DAYS) for (const iso of keys.slice(0, keys.length - MAX_DAYS)) delete out[iso];
  return out;
}, nullMap);

/** Days with at least one meal (water or steps alone do not count as "logged", for the streak and the calendar). */
export const loggedDays = (days) => new Set(Object.keys(days || {}).filter((iso) => Object.keys(days[iso].meals).length > 0));

/** Meals of a day in time order. */
export const mealsOfDay = (day) => (day ? Object.values(day.meals) : [])
  .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

// ---------- goals ----------

export const GOAL_RANGES = {
  kcal: [800, 6000], protein_g: [0, 600], carbs_g: [0, 1000], fat_g: [0, 400], waterL: [0.5, 8], steps: [0, 60000],
};

export const cleanGoals = guard((raw) => {
  if (!isObj(raw)) return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(GOAL_RANGES)) {
    const v = numIn(raw[k], lo, hi);
    if (v === null) return null;
    const rounded = k === 'waterL' ? round1(v) : Math.round(v);
    out[k] = rounded === 0 ? 0 : rounded;
  }
  return out;
}, () => null);

export const cleanGoalsHistory = guard((raw) => {
  if (!Array.isArray(raw)) return [];
  const byDate = new Map();
  for (const e of raw) {
    const goals = isObj(e) && isIso(e.from) ? cleanGoals(e.goals) : null;
    if (goals) byDate.set(e.from, { from: e.from, goals });
  }
  return [...byDate.values()].sort((a, b) => (a.from < b.from ? -1 : 1)).slice(-1000);
}, () => []);

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

// ---------- favourites, weights, foods ----------

export const cleanSaved = guard((raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const m of raw) {
    const meal = cleanMeal(m);
    if (meal && !seen.has(meal.id)) { seen.add(meal.id); out.push(meal); }
    if (out.length >= MAX_SAVED) break;
  }
  return out;
}, () => []);

export const cleanWeights = guard((raw) => {
  const out = nullMap();
  if (!isObj(raw)) return out;
  for (const [iso, kg] of Object.entries(raw)) {
    const v = isIso(iso) ? numIn(kg, 30, 300) : null;
    if (v !== null) out[iso] = round1(v);
  }
  const keys = Object.keys(out).sort();
  if (keys.length > MAX_WEIGHTS) for (const iso of keys.slice(0, keys.length - MAX_WEIGHTS)) delete out[iso];
  return out;
}, nullMap);

/** [{ iso, kg }] oldest first. */
export const weightList = (weights) => Object.keys(weights || {}).sort().map((iso) => ({ iso, kg: weights[iso] }));

/** An entry of the table of foods (app/data/foods.es.json), cleaned like any other text before it is stored or shown. */
export const cleanFood = guard((raw) => {
  if (!isObj(raw)) return null;
  const name = cleanText(raw.name, MAX_ITEM_NAME);
  const per100 = cleanPer100(raw.per100);
  const portion = isObj(raw.portion) ? raw.portion : null;
  const grams = portion ? numIn(portion.grams, 0.1, 1000) : null;
  const label = portion ? cleanText(portion.label, 60) : '';
  if (!isId(raw.id) || !name || !per100 || grams === null || !label) return null;
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.slice(0, 20).map((a) => cleanText(a, 60)).filter(Boolean) : [];
  const food = { id: raw.id, name, aliases, portion: { label, grams }, per100 };
  // Where the numbers come from: a USDA FoodData Central id, or "estimate" when no public table has the food.
  if (typeof raw.source === 'string' && /^(USDA SR Legacy \d{1,9}|estimate)$/.test(raw.source)) food.source = raw.source;
  return food;
}, () => null);

// ---------- small helpers ----------

/** Slot to suggest at a given hour (0-23), with Spanish meal times. */
export function defaultSlot(hour) {
  if (hour >= 5 && hour < 11) return 'Desayuno';
  if (hour >= 11 && hour < 17) return 'Almuerzo';
  if (hour >= 17 && hour < 20) return 'Snack';
  return 'Cena';
}

const finiteOr0 = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0; return Number.isFinite(n) ? n : 0; };
export const clampWater = (ml) => Math.round(Math.min(MAX_WATER_ML, Math.max(0, finiteOr0(ml)))) || 0;
export const clampSteps = (n) => Math.round(Math.min(MAX_STEPS, Math.max(0, finiteOr0(n)))) || 0;

// ---------- sync bookkeeping (kept in "fd.sync", never exported or sent to the cloud as such) ----------

const UID = /^[A-Za-z0-9]{1,128}$/;
export const MAX_DIRTY_DAYS = MAX_DAYS;
const stampsMap = (raw, keyOk, cap) => {
  const out = nullMap();
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, cap * 2)) {
    const t = keyOk(k) ? cleanStamp(v) : null;
    if (t) out[k] = t;
    if (Object.keys(out).length >= cap) break;
  }
  return out;
};

export const emptySyncMeta = () => ({
  uid: null, lastPull: 0, profileAt: 0, goalsAt: nullMap(), weightsAt: nullMap(), savedDeleted: nullMap(),
  dirty: { days: nullMap(), saved: nullMap(), savedDeleted: nullMap(), weights: nullMap(), profile: 0, goals: 0 },
});

export const cleanSyncMeta = guard((raw) => {
  const out = emptySyncMeta();
  if (!isObj(raw)) return out;
  out.uid = typeof raw.uid === 'string' && UID.test(raw.uid) ? raw.uid : null;
  out.lastPull = cleanStamp(raw.lastPull) || 0;
  out.profileAt = cleanStamp(raw.profileAt) || 0;
  out.goalsAt = stampsMap(raw.goalsAt, isIso, 1000);
  out.weightsAt = stampsMap(raw.weightsAt, isIso, MAX_WEIGHTS);
  out.savedDeleted = stampsMap(raw.savedDeleted, isId, MAX_TOMBSTONES);
  const d = isObj(raw.dirty) ? raw.dirty : {};
  out.dirty.saved = stampsMap(d.saved, isId, MAX_SAVED);
  out.dirty.savedDeleted = stampsMap(d.savedDeleted, isId, MAX_TOMBSTONES);
  out.dirty.weights = stampsMap(d.weights, isIso, MAX_WEIGHTS);
  out.dirty.profile = cleanStamp(d.profile) || 0;
  out.dirty.goals = cleanStamp(d.goals) || 0;
  if (isObj(d.days)) {
    for (const [iso, m] of Object.entries(d.days).slice(0, MAX_DIRTY_DAYS)) {
      if (!isIso(iso) || !isObj(m)) continue;
      const entry = { m: stampsMap(m.m, isId, MAX_MEALS_PER_DAY), d: stampsMap(m.d, isId, MAX_TOMBSTONES), w: cleanStamp(m.w) || 0, s: cleanStamp(m.s) || 0 };
      if (Object.keys(entry.m).length || Object.keys(entry.d).length || entry.w || entry.s) out.dirty.days[iso] = entry;
    }
  }
  return out;
}, emptySyncMeta);
