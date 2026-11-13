/* foodie · reading the stored data into a clean state and writing a state back out as one JSON text per key (pure: no storage, no DOM).
   The store uses it for every load, and the one-time migration from localStorage to IndexedDB (data/idb-storage.js) uses the very same
   cleaners, so what is copied is what the app would have read.

   Keys (the origin is shared with other apps, so they all start with "fd."):
   fd.profile  fd.goals  fd.days  fd.saved  fd.weights  fd.sync (edit stamps and what changed since the last cloud sync)  fd.products  fd.ui
   (fd.theme is not here: it stays in localStorage, because boot.js needs it before the first paint.) */
import { cleanProducts } from '../core/off.js';
import { cleanProfile } from '../core/goals.js';
import { cleanDays, cleanGoalsHistory, cleanSaved, cleanWeights, cleanSyncMeta } from '../core/schema.js';

export const STORAGE_KEYS = {
  profile: 'fd.profile', goals: 'fd.goals', days: 'fd.days', saved: 'fd.saved', weights: 'fd.weights', sync: 'fd.sync', products: 'fd.products', ui: 'fd.ui',
};
export const DATA_KEYS = Object.values(STORAGE_KEYS);
const KEY_NAMES = new Set(DATA_KEYS);

/** Camera modes the app remembers between visits. */
export const CAMERA_MODES = ['photo', 'code', 'label'];
export const cleanUi = (raw) => ({ mode: raw && typeof raw === 'object' && CAMERA_MODES.includes(raw.mode) ? raw.mode : 'photo' });

/**
 * Longest stored value (in characters) that is parsed at all, and that is written. A year of heavy use is about 6 MB of days with photo
 * thumbnails; the real limits are per entry (100 meals a day, 20 thumbnails a day, 4000 days) and this only stops an absurd value.
 */
export const MAX_STORED_CHARS = 32 * 1024 * 1024;

/** True for a `storage` event that concerns this app's data (another tab wrote it, or the storage was cleared). */
export const isStoreKey = (key) => key === null || KEY_NAMES.has(key);

export const problem = (kind, key, cause) => Object.assign(new Error(`foodie store: ${kind} (${key})`), { kind, key, cause });

/**
 * @param {(key:string)=>string|null} getItem
 * @param {(error:Error)=>void} [report]  told about unreadable values: kind 'read', 'too-large' or 'corrupt'
 */
export function loadState(getItem, report = () => {}) {
  const read = (key) => {
    let raw;
    try { raw = getItem(key); } catch (e) { report(problem('read', key, e)); return null; }
    if (raw === null || raw === undefined || typeof raw !== 'string') return null;
    if (raw.length > MAX_STORED_CHARS) { report(problem('too-large', key)); return null; }
    try { return JSON.parse(raw); } catch (e) { report(problem('corrupt', key, e)); return null; }
  };
  return {
    profile: cleanProfile(read(STORAGE_KEYS.profile)),
    goals: cleanGoalsHistory(read(STORAGE_KEYS.goals)),
    days: cleanDays(read(STORAGE_KEYS.days)),
    saved: cleanSaved(read(STORAGE_KEYS.saved)),
    weights: cleanWeights(read(STORAGE_KEYS.weights)),
    sync: cleanSyncMeta(read(STORAGE_KEYS.sync)),
    products: cleanProducts(read(STORAGE_KEYS.products)),
    ui: cleanUi(read(STORAGE_KEYS.ui)),
  };
}

/** One JSON text per key, exactly what the store writes. */
export function serializeState(state) {
  return Object.fromEntries(Object.entries(STORAGE_KEYS).map(([name, key]) => [key, JSON.stringify(state[name])]));
}

/** What a person would call "how much data": used to check that a copy is complete. */
export function countsOf(state) {
  let meals = 0;
  let thumbs = 0;
  for (const day of Object.values(state.days)) {
    for (const m of Object.values(day.meals)) { meals += 1; if (m.thumb) thumbs += 1; }
  }
  return {
    days: Object.keys(state.days).length, meals, thumbs, saved: state.saved.length, weights: Object.keys(state.weights).length,
    goals: state.goals.length, profile: state.profile ? 1 : 0, products: Object.keys(state.products).length,
  };
}
