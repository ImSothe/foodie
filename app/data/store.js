/* foodie · local store. Local-first: reads are synchronous so the app paints instantly, and every change is
   written to localStorage right away. All mutations go through this one place, so cloud sync can be hooked in
   later without touching the screens.

   Keys (the origin is shared with other apps, so they all start with "fd."):
   fd.profile  fd.goals  fd.days  fd.saved  fd.weights
   Whatever is read back is validated by core/schema.js: stored data is never trusted blindly. */
import { isIso } from '../core/dates.js';
import { cleanProfile, computePlan, toGoals } from '../core/goals.js';
import {
  cleanMeal, cleanDays, cleanGoalsHistory, cleanSaved, cleanWeights, cleanGoals, goalsFor as goalsInForce, setGoalsEntry,
  emptyDay, isEmptyDay, loggedDays as loggedDaysOf, mealsOfDay, clampWater, clampSteps, TIME,
} from '../core/schema.js';

export const STORAGE_KEYS = {
  profile: 'fd.profile', goals: 'fd.goals', days: 'fd.days', saved: 'fd.saved', weights: 'fd.weights',
};

const fallbackId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const defaultId = () => (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : fallbackId());
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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
  let batching = 0;
  let pending = false;
  let persistent = true;
  let state;

  function read(key) {
    try {
      const raw = storage.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch (e) { return null; }
  }

  function load() {
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
      storage.setItem(STORAGE_KEYS[name], JSON.stringify(state[name]));
    } catch (e) {
      persistent = false;
      for (const fn of errorListeners) fn(e);
    }
  }

  function notify() {
    if (batching) { pending = true; return; }
    for (const fn of [...listeners]) fn();
  }

  function commit(...names) {
    for (const n of names) write(n);
    notify();
  }

  const dayOf = (iso) => state.days[iso] || emptyDay();
  function putDay(iso, day) {
    if (isEmptyDay(day)) delete state.days[iso]; else state.days[iso] = day;
  }

  state = load();

  return {
    // ---- reads (synchronous; returned objects are read-only for callers) ----
    getProfile: () => state.profile,
    getGoalHistory: () => state.goals,
    /** Goals in force on a day. Without stored goals, the plan computed from the profile (not saved). */
    goalsFor(iso) {
      return goalsInForce(state.goals, iso) || (state.profile ? toGoals(computePlan(state.profile)) : null);
    },
    getDay: (iso) => dayOf(iso),
    mealsOf: (iso) => mealsOfDay(state.days[iso]),
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
    /** Adds a meal to a day. Keeps `meal.id` if given (undo of a delete), otherwise generates one. */
    addMeal(iso, meal) {
      if (!isIso(iso)) return null;
      const time = meal && TIME.test(meal.time) ? meal.time : hhmm(now());
      const clean = cleanMeal({ ...meal, time, id: (meal && meal.id) || uuid() });
      if (!clean) return null;
      const day = dayOf(iso);
      day.meals[clean.id] = clean;
      putDay(iso, day);
      commit('days');
      return clean;
    },
    /** Replaces an existing meal. `silent` saves without telling subscribers (used while a slider is moving). */
    updateMeal(iso, meal, { silent = false } = {}) {
      const day = state.days[iso];
      if (!day || !meal || !day.meals[meal.id]) return null;
      const clean = cleanMeal(meal);
      if (!clean) return null;
      day.meals[clean.id] = clean;
      if (silent) write('days'); else commit('days');
      return clean;
    },
    /** Removes a meal and returns it (pass it to addMeal to undo). */
    deleteMeal(iso, id) {
      const day = state.days[iso];
      const meal = day && day.meals[id];
      if (!meal) return null;
      delete day.meals[id];
      putDay(iso, day);
      commit('days');
      return meal;
    },
    duplicateMeal(fromIso, id, toIso) {
      const src = state.days[fromIso] && state.days[fromIso].meals[id];
      if (!src || !isIso(toIso)) return null;
      const copy = cleanMeal({ ...structuredClone(src), id: uuid() });
      const day = dayOf(toIso);
      day.meals[copy.id] = copy;
      putDay(toIso, day);
      commit('days');
      return copy;
    },

    // ---- water and steps ----
    /** Adds (or, if negative, removes) water; the total stays between 0 and 20 L. Returns the new total in ml. */
    addWater(iso, ml) {
      if (!isIso(iso)) return null;
      const day = dayOf(iso);
      day.waterMl = clampWater(day.waterMl + (Number(ml) || 0));
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
    /** Saves a copy of a meal as a favourite. Saving the same meal twice does nothing (`added: false`). */
    saveMeal(meal, { keepId = false } = {}) {
      const clean = cleanMeal({ ...structuredClone(meal), id: keepId && meal.id ? meal.id : uuid() });
      if (!clean) return null;
      const key = (m) => JSON.stringify([m.name, m.items.map((it) => [it.name, it.grams])]);
      const twin = state.saved.find((s) => key(s) === key(clean));
      if (twin) return { meal: twin, added: false };
      state.saved = [clean, ...state.saved];
      commit('saved');
      return { meal: clean, added: true };
    },
    /** Removes a favourite and returns it (pass it to saveMeal with keepId to undo). */
    removeSaved(id) {
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
      const weights = cleanWeights({ ...state.weights, [iso]: kg });
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
    exportAll() {
      return {
        app: 'foodie', format: 1, exportedAt: now().toISOString(),
        profile: state.profile, goals: state.goals, days: state.days, saved: state.saved, weights: state.weights,
      };
    },
    clearAll() {
      for (const k of Object.values(STORAGE_KEYS)) { try { storage.removeItem(k); } catch (e) { /* nothing to remove */ } }
      state = { profile: null, goals: [], days: {}, saved: [], weights: {} };
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
    onStorageError(fn) { errorListeners.add(fn); return () => errorListeners.delete(fn); },
  };
}

export const store = createStore(browserStorage());
