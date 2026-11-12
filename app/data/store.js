/* foodie · local store. Local-first: reads are synchronous so the app paints instantly, and every change is
   written to localStorage right away. All mutations go through this one place, so cloud sync can be hooked in
   later without touching the screens.

   Keys (the origin is shared with other apps, so they all start with "fd."):
   fd.profile  fd.goals  fd.days  fd.saved  fd.weights
   Whatever is read back is validated by core/schema.js: stored data is never trusted blindly. A stored value
   larger than MAX_STORED_CHARS is not even parsed. */
import { isIso } from '../core/dates.js';
import { cleanProfile, computePlan, toGoals } from '../core/goals.js';
import {
  cleanMeal, cleanDays, cleanGoalsHistory, cleanSaved, cleanWeights, cleanGoals, goalsFor as goalsInForce, setGoalsEntry,
  emptyDay, isEmptyDay, loggedDays as loggedDaysOf, mealsOfDay, clampWater, clampSteps, isId, nullMap,
  TIME, MAX_MEALS_PER_DAY, MAX_DAYS, MAX_SAVED,
} from '../core/schema.js';

export const STORAGE_KEYS = {
  profile: 'fd.profile', goals: 'fd.goals', days: 'fd.days', saved: 'fd.saved', weights: 'fd.weights',
};
const KEY_NAMES = new Set(Object.values(STORAGE_KEYS));

/** Longest stored value (in characters) that is parsed at all. Real data stays far below it. */
export const MAX_STORED_CHARS = 5 * 1024 * 1024;

/** True for a `storage` event that concerns this app's data (another tab wrote it, or the storage was cleared). */
export const isStoreKey = (key) => key === null || KEY_NAMES.has(key);

const fallbackId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const defaultId = () => (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : fallbackId());
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Reads a property of something that may be hostile (a throwing getter gives undefined). */
const peek = (obj, key) => { try { return obj === null || obj === undefined ? undefined : obj[key]; } catch (e) { return undefined; } };
const problem = (kind, key, cause) => Object.assign(new Error(`foodie store: ${kind} (${key})`), { kind, key, cause });

/** localStorage when there is a browser and it works, otherwise memory (private mode, blocked storage, Node). */
function browserStorage() {
  try {
    if (typeof document !== 'undefined' && globalThis.localStorage) {
      const probe = '__fd_probe__';
      globalThis.localStorage.setItem(probe, '1');
      globalThis.localStorage.removeItem(probe);
      return globalThis.localStorage;
    }
  } catch (e) { /* blocked: keep the data in memory for this session */ }
  const mem = new Map();
  return { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
}

/**
 * @param {{getItem(k:string):string|null, setItem(k:string,v:string):void, removeItem(k:string):void}} storage
 * @param {{uuid?:()=>string, now?:()=>Date}} [env] injectable for tests
 */
export function createStore(storage, env = {}) {
  const uuid = env.uuid || defaultId;
  const now = env.now || (() => new Date());
  const listeners = new Set();
  const errorListeners = new Set();
  let loadProblems = [];             // problems found while loading, replayed to listeners that register later
  let batching = 0;
  let pending = false;
  let persistent = true;
  let state;

  function report(error) {
    if (error.kind === 'write') persistent = false;
    else loadProblems.push(error);
    for (const fn of [...errorListeners]) { try { fn(error); } catch (e) { /* a broken listener must not break the store */ } }
  }

  function read(key) {
    let raw;
    try { raw = storage.getItem(key); } catch (e) { report(problem('read', key, e)); return null; }
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return null;
    if (raw.length > MAX_STORED_CHARS) { report(problem('too-large', key)); return null; }
    try { return JSON.parse(raw); } catch (e) { report(problem('corrupt', key, e)); return null; }
  }

  function load() {
    loadProblems = [];
    return {
      profile: cleanProfile(read(STORAGE_KEYS.profile)),
      goals: cleanGoalsHistory(read(STORAGE_KEYS.goals)),
      days: cleanDays(read(STORAGE_KEYS.days)),
      saved: cleanSaved(read(STORAGE_KEYS.saved)),
      weights: cleanWeights(read(STORAGE_KEYS.weights)),
    };
  }

  function write(name) {
    try {
      const json = JSON.stringify(state[name]);
      // never write what load() would refuse to read back
      if (json.length > MAX_STORED_CHARS) throw new Error('value too large to store');
      storage.setItem(STORAGE_KEYS[name], json);
    } catch (e) { report(problem('write', STORAGE_KEYS[name], e)); }
  }

  function notify() {
    if (batching) { pending = true; return; }
    for (const fn of [...listeners]) fn();
  }

  function commit(...names) {
    for (const n of names) write(n);
    notify();
  }

  const dayOf = (iso) => (isIso(iso) && state.days[iso]) || emptyDay();
  /** Stores a day (or drops it when empty) and forgets the oldest days beyond the cap. False if the day itself was the oldest and fell off. */
  function putDay(iso, day) {
    if (isEmptyDay(day)) { delete state.days[iso]; return true; }
    state.days[iso] = day;
    const keys = Object.keys(state.days);
    if (keys.length > MAX_DAYS) for (const old of keys.sort().slice(0, keys.length - MAX_DAYS)) delete state.days[old];
    return !!state.days[iso];
  }

  state = load();

  return {
    // ---- reads (synchronous; returned objects are read-only for callers) ----
    getProfile: () => state.profile,
    getGoalHistory: () => state.goals,
    /** Goals in force on a day. Without stored goals, the plan computed from the profile (not saved). */
    goalsFor(iso) {
      return goalsInForce(state.goals, isIso(iso) ? iso : '9999-12-31') || (state.profile ? toGoals(computePlan(state.profile)) : null);
    },
    getDay: (iso) => dayOf(iso),
    mealsOf: (iso) => mealsOfDay(isIso(iso) ? state.days[iso] : undefined),
    getDays: () => state.days,
    loggedDays: () => loggedDaysOf(state.days),
    getSaved: () => state.saved,
    getWeights: () => state.weights,
    /** False once a write to storage has failed: the data is only kept in memory for this session. */
    get persistent() { return persistent; },

    // ---- profile and goals ----
    saveProfile(raw) {
      const profile = cleanProfile(raw);
      if (!profile) return null;
      state.profile = profile;
      commit('profile');
      return profile;
    },
    /** Goals taking effect on `from` (default today); earlier days keep the goals they had. */
    setGoals(raw, from = localIso(now())) {
      const goals = cleanGoals(raw);
      if (!goals) return null;
      const next = setGoalsEntry(state.goals, from, goals);
      if (next !== state.goals) { state.goals = next; commit('goals'); }
      return goals;
    },

    // ---- meals ----
    /**
     * Adds a meal to a day. Keeps `meal.id` if it has one (undo of a delete), otherwise generates one.
     * Returns null for an invalid meal, an invalid id, or a day that already has MAX_MEALS_PER_DAY meals.
     */
    addMeal(iso, meal) {
      if (!isIso(iso)) return null;
      const rawId = peek(meal, 'id');
      const rawTime = peek(meal, 'time');
      const clean = cleanMeal(meal, {
        id: rawId === undefined || rawId === null || rawId === '' ? uuid() : rawId,
        time: typeof rawTime === 'string' && TIME.test(rawTime) ? rawTime : hhmm(now()),
      });
      if (!clean) return null;
      const day = dayOf(iso);
      if (!(clean.id in day.meals) && Object.keys(day.meals).length >= MAX_MEALS_PER_DAY) return null;
      day.meals[clean.id] = clean;
      if (!putDay(iso, day)) return null;
      commit('days');
      return clean;
    },
    /** Replaces an existing meal. `silent` saves without telling subscribers (used while a slider is moving). */
    updateMeal(iso, meal, { silent = false } = {}) {
      const day = isIso(iso) ? state.days[iso] : undefined;
      const id = peek(meal, 'id');
      if (!day || !isId(id) || !(id in day.meals)) return null;
      const clean = cleanMeal(meal);
      if (!clean) return null;
      day.meals[clean.id] = clean;
      if (silent) write('days'); else commit('days');
      return clean;
    },
    /** Removes a meal and returns it (pass it to addMeal to undo). */
    deleteMeal(iso, id) {
      const day = isIso(iso) ? state.days[iso] : undefined;
      if (!day || !isId(id) || !(id in day.meals)) return null;
      const meal = day.meals[id];
      delete day.meals[id];
      putDay(iso, day);
      commit('days');
      return meal;
    },
    duplicateMeal(fromIso, id, toIso) {
      const from = isIso(fromIso) ? state.days[fromIso] : undefined;
      if (!from || !isId(id) || !(id in from.meals) || !isIso(toIso)) return null;
      const copy = cleanMeal(from.meals[id], { id: uuid() });
      if (!copy) return null;
      const day = dayOf(toIso);
      if (Object.keys(day.meals).length >= MAX_MEALS_PER_DAY) return null;
      day.meals[copy.id] = copy;
      if (!putDay(toIso, day)) return null;
      commit('days');
      return copy;
    },

    // ---- water and steps ----
    /** Adds (or, if negative, removes) water; the total stays between 0 and 20 L. Returns the new total in ml. */
    addWater(iso, ml) {
      if (!isIso(iso)) return null;
      const day = dayOf(iso);
      day.waterMl = clampWater(day.waterMl + clampWaterDelta(ml));
      putDay(iso, day);
      commit('days');
      return day.waterMl;
    },
    setWater(iso, ml) {
      if (!isIso(iso)) return null;
      const day = dayOf(iso);
      day.waterMl = clampWater(ml);
      putDay(iso, day);
      commit('days');
      return day.waterMl;
    },
    setSteps(iso, n) {
      if (!isIso(iso)) return null;
      const day = dayOf(iso);
      day.steps = clampSteps(n);
      putDay(iso, day);
      commit('days');
      return day.steps;
    },

    // ---- favourites ----
    /**
     * Saves a copy of a meal as a favourite. Saving the same meal twice does nothing (`added: false`).
     * Returns null for an invalid meal, and `{ meal: null, added: false, full: true }` at MAX_SAVED favourites.
     */
    saveMeal(meal, { keepId = false } = {}) {
      const rawId = peek(meal, 'id');
      const clean = cleanMeal(meal, { id: keepId && isId(rawId) ? rawId : uuid() });
      if (!clean) return null;
      const key = (m) => JSON.stringify([m.name, m.items.map((it) => [it.name, it.grams])]);
      const twin = state.saved.find((s) => key(s) === key(clean));
      if (twin) return { meal: twin, added: false };
      if (state.saved.length >= MAX_SAVED) return { meal: null, added: false, full: true };
      state.saved = [clean, ...state.saved];
      commit('saved');
      return { meal: clean, added: true };
    },
    /** Removes a favourite and returns it (pass it to saveMeal with keepId to undo). */
    removeSaved(id) {
      if (!isId(id)) return null;
      const meal = state.saved.find((m) => m.id === id);
      if (!meal) return null;
      state.saved = state.saved.filter((m) => m.id !== id);
      commit('saved');
      return meal;
    },

    // ---- weight ----
    /** One weight per day (logging again the same day replaces it). The profile follows the most recent weight. */
    logWeight(iso, kg) {
      if (!isIso(iso)) return null;
      const next = Object.assign(nullMap(), state.weights);
      next[iso] = kg;
      const weights = cleanWeights(next);
      if (weights[iso] === undefined) return null;
      state.weights = weights;
      const names = ['weights'];
      if (state.profile && Object.keys(weights).every((d) => d <= iso)) {
        const updated = cleanProfile({ ...state.profile, weightKg: weights[iso] });
        if (updated) { state.profile = updated; names.push('profile'); }
      }
      commit(...names);
      return weights[iso];
    },

    // ---- whole store ----
    /** A copy of everything, as plain data (nothing in it is shared with the live state). */
    exportAll() {
      return structuredClone({
        app: 'foodie', format: 1, exportedAt: now().toISOString(),
        profile: state.profile, goals: state.goals, days: state.days, saved: state.saved, weights: state.weights,
      });
    },
    clearAll() {
      for (const k of KEY_NAMES) {
        try { storage.removeItem(k); } catch (e) { report(problem('write', k, e)); } // still stored: the data may come back on reload
      }
      state = { profile: null, goals: [], days: nullMap(), saved: [], weights: nullMap() };
      notify();
    },
    /** Read everything from storage again (another tab changed it). */
    reload() { state = load(); notify(); },
    /** Group several changes into one notification. */
    batch(fn) {
      batching += 1;
      try { fn(); } finally {
        batching -= 1;
        if (!batching && pending) { pending = false; notify(); }
      }
    },
    /** Tell subscribers something changed (after silent updates). */
    touch: notify,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /**
     * Listener for storage problems: `error.kind` is 'write' (could not save), 'read', 'too-large' (a stored value was ignored
     * because it is over MAX_STORED_CHARS) or 'corrupt' (a stored value is not valid JSON). Problems found while loading are replayed
     * to a listener registered afterwards.
     */
    onStorageError(fn) {
      errorListeners.add(fn);
      for (const p of loadProblems) { try { fn(p); } catch (e) { /* ignore */ } }
      return () => errorListeners.delete(fn);
    },
  };
}

/** Water added or removed in one step: a finite number of ml, anything else is nothing. */
function clampWaterDelta(ml) {
  return typeof ml === 'number' && Number.isFinite(ml) ? Math.max(-20000, Math.min(20000, ml)) : 0;
}

export const store = createStore(browserStorage());
