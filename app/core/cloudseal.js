/* foodie · the encrypted shape of the cloud documents, and the way between it and the plain shape of core/cloudmap.js.
   merge.js and cloudmap.js keep working on DECRYPTED data; this module is the boundary: documents that come back from Firestore are opened here,
   and the patches cloudmap produces are sealed here before anything is written. Pure (no DOM, no storage, no network); async because WebCrypto is.

   Plain shape (what the app wrote until encryption, and what other fields still carry)    Encrypted shape (the key `key` of core/crypto.js)
   users/{uid}            profile, goals: [...], profileAt, goalsAt: {from: stamp}, updatedAt     profileE, goalsE: {from: sealed}, + the same stamps, crypto
   users/{uid}/days/{iso} meals: {id: Meal}, waterMl, steps, waterAt, stepsAt, deleted, updatedAt mealsE: {id: sealed + updatedAt}, waterE, stepsE, + the same stamps, deleted
   users/{uid}/meta/saved items: {id: Meal}, deleted, updatedAt                                    itemsE: {id: sealed + updatedAt}, deleted
   users/{uid}/meta/weights w: {iso: kg}, at: {iso: stamp}, updatedAt                              wE: {iso: sealed}, at
   users/{uid}/meta/usage day, photos, updatedAt  (not sensitive: stays plain)

   A sealed record is { v, iv, ct }; its plaintext is { at, value } (the edit stamp travels inside too). The stamps that sit next to a sealed
   record in the clear are hints for the server and for incremental pulls: they are never trusted here, only the stamp inside is. Every record is
   bound by its additional authenticated data to (user, document, field, id), so it cannot be moved. A record that does not open (tampered,
   another key, malformed, or not sealed at all in a place where it must be) is dropped and counted in `failed`; it never becomes data, never
   throws, and is never allowed to overwrite local data.

   Two outputs of opening: `enc` (what the cloud holds encrypted) and `legacy` (plaintext records still in the cloud from before encryption,
   or written later by an old copy of the app). The sync merges both, writes everything back sealed, verifies it, and only then deletes the plaintext. */
import { aadFor, seal, open, isSealed } from './crypto.js';
import { stateFromCloud, DELETE } from './cloudmap.js';
import { isIso } from './dates.js';
import { isId, nullMap } from './schema.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stampOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const ENTRY_KEYS = new Set(['v', 'iv', 'ct', 'updatedAt']);

const USER = 'user';
const SAVED = 'meta/saved';
const WEIGHTS = 'meta/weights';
const dayDoc = (iso) => `days/${iso}`;

// ---------- opening ----------

/** The sealed part of a map entry ({v, iv, ct} plus an optional clear `updatedAt` hint), or null when the entry has anything else in it. */
function sealedPart(entry) {
  if (!isObj(entry)) return null;
  for (const k of Object.keys(entry)) if (!ENTRY_KEYS.has(k)) return null;
  const blob = { v: entry.v, iv: entry.iv, ct: entry.ct };
  return isSealed(blob) ? blob : null;
}

/** Opens one sealed value; `{ at, value }` or null. `at` is the stamp that was sealed with it. */
async function openOne(ctx, doc, field, id, blob) {
  if (!isSealed(blob)) return null;
  const inner = await open(ctx.key, blob, aadFor(ctx.uid, doc, field, id));
  return isObj(inner) && 'value' in inner ? { at: stampOf(inner.at), value: inner.value } : null;
}

/** Opens a map of sealed entries. Returns { values: {id: {at, value}}, failed }. */
async function openMap(ctx, doc, field, map, idOk = isId) {
  const values = nullMap();
  let failed = 0;
  if (map === undefined) return { values, failed };
  if (!isObj(map)) return { values, failed: 1 };
  await Promise.all(Object.entries(map).map(async ([id, entry]) => {
    if (!idOk(id)) { failed += 1; return; }
    const blob = sealedPart(entry);
    const got = blob ? await openOne(ctx, doc, field, id, blob) : null;
    if (got) values[id] = got; else failed += 1;
  }));
  return { values, failed };
}

/** Opens a sealed value stored directly in a field. { at, value } | null | undefined (absent). */
async function openField(ctx, doc, field, blob) {
  if (blob === undefined) return undefined;
  return openOne(ctx, doc, field, '', blob);
}

/**
 * @param {{user?:*, days?:Object<string,*>, saved?:*, weights?:*, usage?:*}} raw documents as the SDK returned them (untrusted)
 * @param {{key: CryptoKey, uid: string}} ctx
 * @returns {Promise<{enc: object, legacy: object, legacyIds: object, failed: number}>}
 */
export async function openCloud(raw, ctx) {
  try {
    return await openCloudUnsafe(raw, ctx);
  } catch (e) {                                   // a getter that throws, say: nothing is trusted, nothing breaks
    return { enc: stateFromCloud({}), legacy: stateFromCloud({}), legacyIds: { user: { profile: false, goals: false }, days: {}, saved: { ids: [], field: false }, weights: { ids: [], field: false } }, failed: 1 };
  }
}

async function openCloudUnsafe(raw, ctx) {
  let r = {};
  try { r = isObj(raw) ? raw : {}; } catch (e) { r = {}; }
  let failed = 0;
  const count = (n) => { failed += n; };
  const enc = { user: null, days: {}, saved: null, weights: null, usage: r.usage };
  const legacy = { user: null, days: {}, saved: null, weights: null };
  const legacyIds = { user: { profile: false, goals: false }, days: {}, saved: { ids: [], field: false }, weights: { ids: [], field: false } };

  // Each document is opened on its own: whatever goes wrong inside one (a malformed value, a getter that throws) costs that document, not the sync.
  const safely = async (fn) => { try { await fn(); } catch (e) { failed += 1; } };

  // --- users/{uid}
  await safely(async () => { if (!isObj(r.user)) return;
    const u = r.user;
    const eu = { profileAt: 0, goalsAt: {}, goals: [], updatedAt: u.updatedAt };
    const profile = await openField(ctx, USER, 'profileE', u.profileE);
    if (profile === null) count(1);
    else if (profile) { eu.profile = profile.value; eu.profileAt = profile.at; }
    const goals = await openMap(ctx, USER, 'goalsE', u.goalsE, isIso);
    count(goals.failed);
    for (const [from, g] of Object.entries(goals.values)) { eu.goals.push(g.value); eu.goalsAt[from] = g.at; }
    enc.user = eu;
    legacy.user = { profile: u.profile, profileAt: u.profileAt, goals: u.goals, goalsAt: u.goalsAt, updatedAt: u.updatedAt };
    legacyIds.user = { profile: u.profile !== undefined, goals: Array.isArray(u.goals) && u.goals.length > 0 };
  });

  // --- users/{uid}/days/{iso}
  const days = isObj(r.days) ? r.days : {};
  await Promise.all(Object.entries(days).map(([iso, d]) => safely(async () => {
    if (!isIso(iso) || !isObj(d)) return;
    const doc = dayDoc(iso);
    const meals = await openMap(ctx, doc, 'mealsE', d.mealsE);
    const water = await openField(ctx, doc, 'waterE', d.waterE);
    const steps = await openField(ctx, doc, 'stepsE', d.stepsE);
    count(meals.failed + (water === null ? 1 : 0) + (steps === null ? 1 : 0));
    const e = { meals: Object.fromEntries(Object.entries(meals.values).map(([id, m]) => [id, m.value])), deleted: d.deleted, updatedAt: d.updatedAt };
    if (water) { e.waterMl = water.value; e.waterAt = water.at; }
    if (steps) { e.steps = steps.value; e.stepsAt = steps.at; }
    enc.days[iso] = e;
    const l = { meals: d.meals, deleted: d.deleted, updatedAt: d.updatedAt };
    if (d.waterMl !== undefined) { l.waterMl = d.waterMl; l.waterAt = d.waterAt; }
    if (d.steps !== undefined) { l.steps = d.steps; l.stepsAt = d.stepsAt; }
    legacy.days[iso] = l;
    const ids = isObj(d.meals) ? Object.keys(d.meals).filter(isId) : [];
    if (d.meals !== undefined || d.waterMl !== undefined || d.steps !== undefined) legacyIds.days[iso] = { meals: ids, field: d.meals !== undefined, water: d.waterMl !== undefined, steps: d.steps !== undefined };
  })));

  // --- users/{uid}/meta/saved
  await safely(async () => {
    if (!isObj(r.saved)) return;
    const s = r.saved;
    const items = await openMap(ctx, SAVED, 'itemsE', s.itemsE);
    count(items.failed);
    enc.saved = { items: Object.fromEntries(Object.entries(items.values).map(([id, m]) => [id, m.value])), deleted: s.deleted };
    legacy.saved = { items: s.items, deleted: s.deleted };
    legacyIds.saved = { ids: isObj(s.items) ? Object.keys(s.items).filter(isId) : [], field: s.items !== undefined };
  });

  // --- users/{uid}/meta/weights
  await safely(async () => {
    if (!isObj(r.weights)) return;
    const w = r.weights;
    const kg = await openMap(ctx, WEIGHTS, 'wE', w.wE, isIso);
    count(kg.failed);
    const at = {};
    const values = {};
    for (const [iso, v] of Object.entries(kg.values)) { values[iso] = v.value; at[iso] = v.at; }
    enc.weights = { w: values, at };
    legacy.weights = { w: w.w, at: w.at };
    legacyIds.weights = { ids: isObj(w.w) ? Object.keys(w.w).filter(isIso) : [], field: w.w !== undefined };
  });

  let states;
  try { states = { enc: stateFromCloud(enc), legacy: stateFromCloud(legacy) }; } catch (e) { failed += 1; states = { enc: stateFromCloud({}), legacy: stateFromCloud({}) }; }
  return { ...states, legacyIds, failed };
}

/** True when nothing plaintext is left to clean up. */
export const hasLegacy = (ids) => !!ids && (ids.user.profile || ids.user.goals || ids.saved.field || ids.weights.field || Object.keys(ids.days).length > 0);

// ---------- sealing ----------

const sealed = async (ctx, doc, field, id, at, value) => seal(ctx.key, { at: stampOf(at), value }, aadFor(ctx.uid, doc, field, id));
const entry = async (ctx, doc, field, id, at, value) => ({ ...(await sealed(ctx, doc, field, id, at, value)), updatedAt: stampOf(at) });

/** A patch of a day (core/cloudmap.js dayPatchFromDirty / dayPatchDiff) in encrypted form. */
export async function sealDayPatch(iso, patch, ctx, legacyDay = null) {
  const doc = dayDoc(iso);
  const out = { updatedAt: patch.updatedAt };
  const put = (field, id, v) => { (out[field] ||= {})[id] = v; };
  if (patch.meals) {
    await Promise.all(Object.entries(patch.meals).map(async ([id, meal]) => {
      if (meal === DELETE) { put('mealsE', id, DELETE); if (legacyDay && legacyDay.meals.includes(id)) put('meals', id, DELETE); }      // a deletion also clears a plaintext copy left from before
      else put('mealsE', id, await entry(ctx, doc, 'mealsE', id, meal.updatedAt, meal));
    }));
  }
  if (patch.deleted) out.deleted = patch.deleted;
  if ('waterMl' in patch) { out.waterE = await sealed(ctx, doc, 'waterE', '', patch.waterAt, patch.waterMl); out.waterAt = patch.waterAt; }
  if ('steps' in patch) { out.stepsE = await sealed(ctx, doc, 'stepsE', '', patch.stepsAt, patch.steps); out.stepsAt = patch.stepsAt; }
  return out;
}

/** The user document (profile and goals history) in encrypted form, with the verifier when there is one to write. */
export async function sealUserPatch(patch, ctx, verifier = null) {
  const out = { updatedAt: patch.updatedAt };
  if (patch.profile) { out.profileE = await sealed(ctx, USER, 'profileE', '', patch.profileAt, patch.profile); out.profileAt = patch.profileAt; }
  if (patch.goals) {
    out.goalsE = {};
    await Promise.all(patch.goals.map(async (g) => { out.goalsE[g.from] = await sealed(ctx, USER, 'goalsE', g.from, (patch.goalsAt || {})[g.from], g); }));
    out.goalsAt = patch.goalsAt;
  }
  if (verifier) out.crypto = verifier;
  return out;
}

export async function sealSavedPatch(patch, ctx, legacySaved = null) {
  const out = { updatedAt: patch.updatedAt };
  if (patch.items) {
    await Promise.all(Object.entries(patch.items).map(async ([id, meal]) => {
      if (meal === DELETE) { (out.itemsE ||= {})[id] = DELETE; if (legacySaved && legacySaved.ids.includes(id)) (out.items ||= {})[id] = DELETE; }
      else (out.itemsE ||= {})[id] = await entry(ctx, SAVED, 'itemsE', id, meal.updatedAt, meal);
    }));
  }
  if (patch.deleted) out.deleted = patch.deleted;
  return out;
}

export async function sealWeightsPatch(patch, ctx) {
  const out = { updatedAt: patch.updatedAt };
  if (patch.w) {
    await Promise.all(Object.entries(patch.w).map(async ([iso, kg]) => { (out.wE ||= {})[iso] = await sealed(ctx, WEIGHTS, 'wE', iso, (patch.at || {})[iso], kg); }));
  }
  if (patch.at) out.at = patch.at;
  return out;
}

// ---------- leaving plaintext behind ----------

/**
 * Plaintext records that are safe to delete: those whose sealed copy was read back (`enc`, from openCloud on a fresh read) and equals what the
 * merge holds (`merged`). Returns [{ path, patch }] for the plaintext fields to remove, and `unverified`, the number of records left in place.
 * Nothing is ever deleted that was not read back, decrypted and compared.
 */
export function legacyCleanup(legacyIds, enc, merged, uid, now) {
  const json = (v) => JSON.stringify(v);
  const writes = [];
  let unverified = 0;
  const same = (a, b) => a !== undefined && b !== undefined && json(a) === json(b);
  /** Removes the whole plaintext field when every record in it is verified (an empty map left behind would break the strict rules later). */
  const sweep = (patch, field, ids, removable) => {
    const ok = ids.filter(removable);
    unverified += ids.length - ok.length;
    if (ok.length === ids.length) patch[field] = DELETE;
    else for (const id of ok) (patch[field] ||= {})[id] = DELETE;
  };

  for (const [iso, ids] of Object.entries(legacyIds.days)) {
    const have = enc.days[iso];
    const want = merged.days[iso];
    const patch = { updatedAt: now };
    if (ids.field) {
      sweep(patch, 'meals', ids.meals, (id) => (have && want && same(have.meals[id], want.meals[id])) || (want && want.deleted && id in want.deleted));
    }
    if (ids.water) { if (have && want && have.waterMl === want.waterMl && (have.waterAt || 0) === (want.waterAt || 0)) patch.waterMl = DELETE; else unverified += 1; }
    if (ids.steps) { if (have && want && have.steps === want.steps && (have.stepsAt || 0) === (want.stepsAt || 0)) patch.steps = DELETE; else unverified += 1; }
    if (Object.keys(patch).length > 1) writes.push({ path: ['users', uid, 'days', iso], patch });
  }
  if (legacyIds.saved.field) {
    const patch = { updatedAt: now };
    const have = Object.fromEntries(enc.saved.map((m) => [m.id, m]));
    const want = Object.fromEntries(merged.saved.map((m) => [m.id, m]));
    sweep(patch, 'items', legacyIds.saved.ids, (id) => same(have[id], want[id]) || (merged.savedDeleted && id in merged.savedDeleted));
    if (Object.keys(patch).length > 1) writes.push({ path: ['users', uid, 'meta', 'saved'], patch });
  }
  if (legacyIds.weights.field) {
    const patch = { updatedAt: now };
    sweep(patch, 'w', legacyIds.weights.ids, (iso) => enc.weights[iso] !== undefined && enc.weights[iso] === merged.weights[iso]);
    if (Object.keys(patch).length > 1) writes.push({ path: ['users', uid, 'meta', 'weights'], patch });
  }
  const userPatch = { updatedAt: now };
  if (legacyIds.user.profile) { if (same(enc.profile, merged.profile)) userPatch.profile = DELETE; else unverified += 1; }
  if (legacyIds.user.goals) { if (same(enc.goals, merged.goals)) userPatch.goals = DELETE; else unverified += 1; }
  if (Object.keys(userPatch).length > 1) writes.push({ path: ['users', uid], patch: userPatch });
  return { writes, unverified };
}
