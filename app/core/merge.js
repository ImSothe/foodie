/* foodie · merging local data with the cloud copy (pure logic: no DOM, no storage, no network).

   One rule decides every conflict: the newest edit wins, per record. A record is a meal, a favourite, a day's water or steps,
   one weight, one goals entry, or the profile. Deleting a meal leaves a tombstone ("deleted at T") so the deletion travels too;
   a meal edited after its tombstone comes back. The result does not depend on which side is "local": merging is commutative,
   idempotent and associative, so two devices that exchange data in any order end up identical.

   What is never done: a local record is never dropped without something newer saying so (a newer edit or a newer tombstone).

   State shape (all of it already cleaned by core/schema.js):
   { profile, profileAt, goals: [{from, goals}], goalsAt: {from: stamp}, days: {iso: Day},
     saved: [Meal], savedDeleted: {id: stamp}, weights: {iso: kg}, weightsAt: {iso: stamp},
     usage: {day, photos} (the daily photo counter: later day wins, same day the higher count; see core/limits.js) } */
import {
  cleanDay, cleanSaved, cleanWeights, cleanGoalsHistory, cleanTombstones, cleanStamp, isEmptyDay, isId, nullMap, MAX_SAVED,
} from './schema.js';
import { cleanProfile } from './goals.js';
import { emptyUsage, mergeUsage } from './limits.js';

/** A device whose clock runs ahead cannot win for ever: a stamp further in the future than this is rewritten to "now" before merging
    (see capState), and what is left is compared as at most "now plus this". */
export const MAX_FUTURE_MS = 10 * 60 * 1000;

const stampOf = (v) => cleanStamp(v) || 0;
const clamp = (stamp, now) => Math.min(stampOf(stamp), now + MAX_FUTURE_MS);
const json = (v) => JSON.stringify(v);
/** Deterministic tie-break that does not depend on argument order. */
const pickByJson = (a, b) => (json(a) >= json(b) ? a : b);

export const emptyState = () => ({
  profile: null, profileAt: 0, goals: [], goalsAt: nullMap(), days: nullMap(), saved: [], savedDeleted: nullMap(), weights: nullMap(), weightsAt: nullMap(), usage: emptyUsage(),
});

/** The newer of two versions of the same record; equal stamps are settled by content, the same way on every device. */
function newer(a, aAt, b, bAt, now) {
  const x = clamp(aAt, now);
  const y = clamp(bAt, now);
  if (x !== y) return x > y ? a : b;
  return pickByJson(a, b);
}

export function mergeMeal(a, b, now) {
  return newer(a, a.updatedAt, b, b.updatedAt, now);
}

/** Merges two sets of live records with tombstones. Returns { live: {id: record}, dead: {id: stamp} }. */
function mergeRecords(liveA, deadA, liveB, deadB, now) {
  const live = nullMap();
  const dead = nullMap();
  const ids = [...new Set([...Object.keys(liveA), ...Object.keys(liveB), ...Object.keys(deadA), ...Object.keys(deadB)])].filter(isId).sort();
  for (const id of ids) {
    const a = liveA[id];
    const b = liveB[id];
    const record = a && b ? mergeMeal(a, b, now) : a || b;
    const recordAt = record ? clamp(record.updatedAt, now) : -1;
    const deadAt = Math.max(clamp(deadA[id], now), clamp(deadB[id], now), 0);
    const hasTomb = id in deadA || id in deadB;
    if (record && !(hasTomb && deadAt >= recordAt)) live[id] = record;       // edited after it was deleted: it comes back
    else dead[id] = deadAt;
  }
  return { live, dead };
}

/** One value with its edit stamp (water, steps): the later edit wins; with no edit stamps, the larger value (nothing is lost). */
function mergeCounter(aVal, aAt, bVal, bAt, now) {
  const x = clamp(aAt, now);
  const y = clamp(bAt, now);
  if (x > y) return [aVal, stampOf(aAt)];
  if (y > x) return [bVal, stampOf(bAt)];
  return [Math.max(aVal || 0, bVal || 0), Math.max(stampOf(aAt), stampOf(bAt))];
}

export function mergeDay(a, b, now) {
  const x = a || cleanDay({});
  const y = b || cleanDay({});
  const { live, dead } = mergeRecords(x.meals, x.deleted || nullMap(), y.meals, y.deleted || nullMap(), now);
  const [waterMl, waterAt] = mergeCounter(x.waterMl, x.waterAt, y.waterMl, y.waterAt, now);
  const [steps, stepsAt] = mergeCounter(x.steps, x.stepsAt, y.steps, y.stepsAt, now);
  return cleanDay({ meals: live, waterMl, steps, waterAt, stepsAt, deleted: dead });
}

export function mergeDays(a, b, now) {
  const out = nullMap();
  for (const iso of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const day = mergeDay(a[iso], b[iso], now);
    if (day && !isEmptyDay(day)) out[iso] = day;
  }
  return out;
}

export function mergeSaved(listA, deadA, listB, deadB, now) {
  const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]));
  const { live, dead } = mergeRecords(Object.assign(nullMap(), byId(listA)), deadA, Object.assign(nullMap(), byId(listB)), deadB, now);
  const list = Object.values(live).sort((p, q) => stampOf(q.updatedAt) - stampOf(p.updatedAt) || (p.id < q.id ? -1 : 1));
  return { saved: cleanSaved(list.slice(0, MAX_SAVED)), savedDeleted: cleanTombstones(dead) };
}

export function mergeWeights(wA, atA, wB, atB, now) {
  const w = nullMap();
  const at = nullMap();
  for (const iso of new Set([...Object.keys(wA), ...Object.keys(wB)])) {
    const hasA = iso in wA;
    const hasB = iso in wB;
    if (hasA && hasB) {
      const x = clamp(atA[iso], now);
      const y = clamp(atB[iso], now);
      const pickA = x !== y ? x > y : wA[iso] >= wB[iso];
      w[iso] = pickA ? wA[iso] : wB[iso];
      at[iso] = Math.max(stampOf(atA[iso]), stampOf(atB[iso]));
    } else {
      w[iso] = hasA ? wA[iso] : wB[iso];
      at[iso] = stampOf(hasA ? atA[iso] : atB[iso]);
    }
  }
  const weights = cleanWeights(w);
  for (const iso of Object.keys(at)) if (!(iso in weights)) delete at[iso];
  return { weights, weightsAt: at };
}

export function mergeGoals(hA, atA, hB, atB, now) {
  const byFrom = new Map();
  for (const e of hA) byFrom.set(e.from, { e, at: atA[e.from] });
  for (const e of hB) {
    const have = byFrom.get(e.from);
    if (!have) byFrom.set(e.from, { e, at: atB[e.from] });
    else byFrom.set(e.from, { e: newer(have.e, have.at, e, atB[e.from], now), at: Math.max(stampOf(have.at), stampOf(atB[e.from])) });
  }
  const goals = cleanGoalsHistory([...byFrom.values()].map((v) => v.e));
  const goalsAt = nullMap();
  for (const e of goals) goalsAt[e.from] = stampOf(byFrom.get(e.from).at);
  return { goals, goalsAt };
}

export function mergeProfile(a, aAt, b, bAt, now) {
  const pa = cleanProfile(a);
  const pb = cleanProfile(b);
  if (!pa || !pb) return { profile: pa || pb, profileAt: pa ? stampOf(aAt) : pb ? stampOf(bAt) : 0 };
  const profile = newer(pa, aAt, pb, bAt, now);
  return { profile, profileAt: Math.max(stampOf(aAt), stampOf(bAt)) };
}

const fixStamp = (v, now) => { const t = stampOf(v); return t > now + MAX_FUTURE_MS ? now : t; };
const fixMap = (m, now) => { const out = nullMap(); for (const [k, v] of Object.entries(m || {})) out[k] = fixStamp(v, now); return out; };
const fixMeal = (m, now) => (m && m.updatedAt !== undefined ? { ...m, updatedAt: fixStamp(m.updatedAt, now) } : m);
function fixDay(d, now) {
  if (!d) return d;
  const out = { ...d, meals: nullMap() };
  for (const [id, m] of Object.entries(d.meals)) out.meals[id] = fixMeal(m, now);
  if (d.waterAt) out.waterAt = fixStamp(d.waterAt, now);
  if (d.stepsAt) out.stepsAt = fixStamp(d.stepsAt, now);
  if (d.deleted) out.deleted = fixMap(d.deleted, now);
  return out;
}

/** A copy of a state in which no stamp is later than now + MAX_FUTURE_MS: a clock set far ahead cannot make a record win for ever. */
export function capState(state, now) {
  const days = nullMap();
  for (const [iso, d] of Object.entries(state.days || {})) days[iso] = fixDay(d, now);
  return {
    ...state,
    profileAt: fixStamp(state.profileAt, now), goalsAt: fixMap(state.goalsAt, now), weightsAt: fixMap(state.weightsAt, now),
    savedDeleted: fixMap(state.savedDeleted, now), saved: (state.saved || []).map((m) => fixMeal(m, now)), days,
  };
}

/** Merge of two complete states. `now` is the current time in ms (it only bounds stamps from the future). */
export function mergeState(local, cloud, now = Date.now()) {
  const a = capState({ ...emptyState(), ...local }, now);
  const b = capState({ ...emptyState(), ...cloud }, now);
  const { profile, profileAt } = mergeProfile(a.profile, a.profileAt, b.profile, b.profileAt, now);
  const { goals, goalsAt } = mergeGoals(a.goals, a.goalsAt, b.goals, b.goalsAt, now);
  const { saved, savedDeleted } = mergeSaved(a.saved, a.savedDeleted, b.saved, b.savedDeleted, now);
  const { weights, weightsAt } = mergeWeights(a.weights, a.weightsAt, b.weights, b.weightsAt, now);
  return { profile, profileAt, goals, goalsAt, days: mergeDays(a.days, b.days, now), saved, savedDeleted, weights, weightsAt, usage: mergeUsage(a.usage, b.usage) };
}
