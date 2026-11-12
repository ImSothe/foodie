/* foodie · how local data maps to Firestore documents (pure logic). Nothing here talks to the network.

   users/{uid}                  { profile, profileAt, goals: [{from, goals}], goalsAt: {from: stamp}, updatedAt }
   users/{uid}/days/{iso}       { meals: {id: Meal}, deleted: {id: stamp}, waterMl, waterAt, steps, stepsAt, updatedAt }
   users/{uid}/meta/saved       { items: {id: Meal}, deleted: {id: stamp}, updatedAt }
   users/{uid}/meta/weights     { w: {iso: kg}, at: {iso: stamp}, updatedAt }

   Writes are PATCHES: nested objects that are merged into the document field by field, so a write that touches meal "a" never
   touches meal "b" (two devices editing different meals never overwrite each other). The DELETE marker means "remove this field".
   Everything that comes back from the cloud goes through the same cleaners as data read from localStorage. */
import {
  cleanDay, cleanSaved, cleanWeights, cleanGoalsHistory, cleanTombstones, cleanStamp, isEmptyDay, nullMap,
} from './schema.js';
import { cleanProfile } from './goals.js';
import { isIso } from './dates.js';
import { emptyState } from './merge.js';

export const DELETE = Symbol('delete-field');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = (v) => JSON.stringify(v);
const stampMap = (raw, keyOk) => {
  const out = nullMap();
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) { const t = keyOk(k) ? cleanStamp(v) : null; if (t) out[k] = t; }
  return out;
};

// ---------- cloud -> local ----------

/**
 * @param {{user?:*, days?:Object<string,*>, saved?:*, weights?:*}} raw documents as the SDK returned them (untrusted)
 * @returns a (partial) state, every part cleaned; missing parts are empty
 */
export function stateFromCloud(raw) {
  const state = emptyState();
  const r = isObj(raw) ? raw : {};
  const user = isObj(r.user) ? r.user : {};
  state.profile = cleanProfile(user.profile);
  state.profileAt = state.profile ? cleanStamp(user.profileAt) || 0 : 0;
  state.goals = cleanGoalsHistory(user.goals);
  const goalsAt = stampMap(user.goalsAt, isIso);
  for (const e of state.goals) if (goalsAt[e.from]) state.goalsAt[e.from] = goalsAt[e.from];
  if (isObj(r.days)) {
    for (const [iso, d] of Object.entries(r.days)) {
      const day = isIso(iso) ? cleanDay(d) : null;
      if (day && !isEmptyDay(day)) state.days[iso] = day;
    }
  }
  const saved = isObj(r.saved) ? r.saved : {};
  state.saved = cleanSaved(isObj(saved.items) ? Object.values(saved.items) : []);
  state.savedDeleted = cleanTombstones(saved.deleted);
  const weights = isObj(r.weights) ? r.weights : {};
  state.weights = cleanWeights(weights.w);
  const at = stampMap(weights.at, isIso);
  for (const iso of Object.keys(state.weights)) if (at[iso]) state.weightsAt[iso] = at[iso];
  return state;
}

// ---------- local -> cloud ----------

const put = (obj, key, id, value) => { (obj[key] ||= {})[id] = value; };

/**
 * Patch for one day from what changed locally. `mark` = { m: {id: stamp}, d: {id: stamp}, w?: stamp, s?: stamp }
 * (meals edited, meals deleted, water edited, steps edited).
 */
export function dayPatchFromDirty(day, mark, now) {
  const patch = { updatedAt: now };
  for (const id of Object.keys(mark.m || {})) {
    const meal = day && day.meals[id];
    if (!meal) continue;
    put(patch, 'meals', id, meal);
    put(patch, 'deleted', id, DELETE);              // an edit after a deletion brings the meal back
  }
  for (const id of Object.keys(mark.d || {})) {
    const at = day && day.deleted && day.deleted[id];
    if (!at) continue;
    put(patch, 'meals', id, DELETE);
    put(patch, 'deleted', id, at);
  }
  if (mark.w && day) { patch.waterMl = day.waterMl; patch.waterAt = day.waterAt || 0; }
  if (mark.s && day) { patch.steps = day.steps; patch.stepsAt = day.stepsAt || 0; }
  return Object.keys(patch).length > 1 ? patch : null;
}

/** The patch that turns the cloud's version of a day into `target`, or null when they already agree. */
export function dayPatchDiff(cloudDay, target, now) {
  const base = cloudDay || cleanDay({});
  const patch = { updatedAt: now };
  for (const [id, meal] of Object.entries(target.meals)) {
    if (!(id in base.meals) || json(base.meals[id]) !== json(meal)) put(patch, 'meals', id, meal);
    if (base.deleted && id in base.deleted) put(patch, 'deleted', id, DELETE);
  }
  for (const [id, at] of Object.entries(target.deleted || {})) {
    if (!base.deleted || base.deleted[id] !== at) put(patch, 'deleted', id, at);
    if (id in base.meals) put(patch, 'meals', id, DELETE);
  }
  if (target.waterMl !== base.waterMl || (target.waterAt || 0) !== (base.waterAt || 0)) { patch.waterMl = target.waterMl; patch.waterAt = target.waterAt || 0; }
  if (target.steps !== base.steps || (target.stepsAt || 0) !== (base.stepsAt || 0)) { patch.steps = target.steps; patch.stepsAt = target.stepsAt || 0; }
  return Object.keys(patch).length > 1 ? patch : null;
}

/** The whole user document (profile and goals history); it is small, so it is written as one. */
export function userPatch(state, now) {
  const patch = { goals: state.goals, goalsAt: { ...state.goalsAt }, updatedAt: now };
  if (state.profile) { patch.profile = state.profile; patch.profileAt = state.profileAt || 0; }
  return patch;
}

export const userDocsDiffer = (cloudState, state) => json([cloudState.profile, cloudState.profileAt, cloudState.goals, cloudState.goalsAt])
  !== json([state.profile, state.profileAt, state.goals, state.goalsAt]);

/** Patch of the favourites document: given ids written, given ids removed (tombstones). */
export function savedPatch(state, ids, deletedIds, now) {
  const patch = { updatedAt: now };
  for (const id of ids) {
    const meal = state.saved.find((m) => m.id === id);
    if (meal) { put(patch, 'items', id, meal); put(patch, 'deleted', id, DELETE); }
  }
  for (const id of deletedIds) {
    const at = state.savedDeleted[id];
    if (at) { put(patch, 'items', id, DELETE); put(patch, 'deleted', id, at); }
  }
  return Object.keys(patch).length > 1 ? patch : null;
}

export function savedPatchDiff(cloudState, state, now) {
  const have = Object.fromEntries(cloudState.saved.map((m) => [m.id, m]));
  const ids = state.saved.filter((m) => !(m.id in have) || json(have[m.id]) !== json(m)).map((m) => m.id);
  const gone = Object.keys(state.savedDeleted).filter((id) => cloudState.savedDeleted[id] !== state.savedDeleted[id]);
  return savedPatch(state, ids, gone, now);
}

export function weightsPatch(state, isos, now) {
  const patch = { updatedAt: now };
  for (const iso of isos) if (iso in state.weights) { put(patch, 'w', iso, state.weights[iso]); put(patch, 'at', iso, state.weightsAt[iso] || 0); }
  return Object.keys(patch).length > 1 ? patch : null;
}

export function weightsPatchDiff(cloudState, state, now) {
  const isos = Object.keys(state.weights).filter((iso) => cloudState.weights[iso] !== state.weights[iso] || (cloudState.weightsAt[iso] || 0) !== (state.weightsAt[iso] || 0));
  return weightsPatch(state, isos, now);
}

/** Readable form of a patch for tests and logs (the DELETE marker is not JSON). */
export const describePatch = (patch) => JSON.stringify(patch, (k, v) => (v === DELETE ? '<delete>' : v));
