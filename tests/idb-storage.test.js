/* The IndexedDB storage layer against a hand-made fake database (tests/helpers/fake-idb.js): write-behind, failure modes, size guards,
   the one-time migration from localStorage (success, failed check, failed copy, interrupted), and other tabs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openPersistentStorage, createIdbStorage, openDatabase, readAllEntries, MARKER_KEY, DB_NAME, STORE_NAME, FLUSH_DELAY_MS, OPEN_TIMEOUT_MS, MAX_TOTAL_CHARS, migrateFromLocalStorage,
} from '../app/data/idb-storage.js';
import { createStore } from '../app/data/store.js';
import { STORAGE_KEYS, DATA_KEYS, MAX_STORED_CHARS, loadState, countsOf } from '../app/data/state-io.js';
import { fakeIndexedDB, fakeLocalStorage, fakeBroadcastHub, settle } from './helpers/fake-idb.js';
import { buildYear, bytesOf, THUMB } from './helpers/year-data.js';

const DAY = '2026-11-12';
const per100 = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
const meal = (name = 'Pollo') => ({ name, slot: 'Almuerzo', source: 'db', items: [{ name, grams: 150, per100 }] });
const profile = { sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain' };
let n = 0;
const storeEnv = () => ({ uuid: () => `id-${++n}`, now: () => new Date(2026, 10, 12, 9, 30) });

function fakeWin() {
  const listeners = {};
  const docListeners = {};
  return {
    document: { visibilityState: 'visible', addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); }, removeEventListener() {} },
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); }, removeEventListener() {},
    fire: (t, ev = {}) => (listeners[t] || []).forEach((fn) => fn(ev)),
    fireDoc: (t) => (docListeners[t] || []).forEach((fn) => fn({})),
  };
}

/** Opens the storage on a fake database and attaches a store to it, like main.js does. */
async function boot(idb, { ls = fakeLocalStorage(), hub = null, win = fakeWin(), ...env } = {}) {
  const r = await openPersistentStorage({ indexedDB: idb, localStorage: ls, win, BroadcastChannel: hub ? hub.Channel : null, flushDelay: 5, ...env });
  const store = createStore(r.storage, storeEnv());
  store.attach(r.storage, r);
  return { r, store, ls, win };
}

const records = (idb) => idb.records(DB_NAME, STORE_NAME);

// ---------- the ordinary life of the data ----------

test('empty database: opens as IndexedDB, with nothing in it, and the store works', async () => {
  const idb = fakeIndexedDB();
  const { r, store } = await boot(idb);
  assert.equal(r.mode, 'indexeddb');
  assert.deepEqual(r.problems, []);
  assert.equal(r.migration, null);
  assert.equal(typeof r.timing.total, 'number');
  assert.equal(store.getProfile(), null);
  store.addMeal(DAY, meal());
  assert.equal(store.mealsOf(DAY).length, 1);
});

test('write-behind: a change is in memory at once, on disk after the delay, and only the changed keys are written', async () => {
  const idb = fakeIndexedDB();
  const { r, store } = await boot(idb);
  store.saveProfile(profile);
  store.addMeal(DAY, meal());
  assert.equal(records(idb).size, 0, 'nothing on disk yet');
  assert.equal(store.mealsOf(DAY).length, 1, 'but memory has it');
  await settle(40);
  assert.ok(records(idb).has(STORAGE_KEYS.days));
  assert.ok(records(idb).has(STORAGE_KEYS.profile));
  assert.ok(!records(idb).has(STORAGE_KEYS.saved), 'untouched keys are not written');
  const before = idb.stats.writes;
  store.addWater(DAY, 250);
  await settle(40);
  assert.equal(idb.stats.writes, before + 1);
  assert.deepEqual(idb.stats.putKeys.slice(-2).sort(), [STORAGE_KEYS.days, STORAGE_KEYS.sync].sort().filter((k) => idb.stats.putKeys.slice(-2).includes(k)));
  assert.equal(r.storage.pending, 0);
});

test('a burst of changes is one write, and writing the same text again writes nothing', async () => {
  const idb = fakeIndexedDB();
  const { store, r } = await boot(idb);
  store.addMeal(DAY, meal());
  const m = store.mealsOf(DAY)[0];
  for (let i = 0; i < 50; i += 1) store.updateMeal(DAY, { ...m, items: [{ ...m.items[0], grams: 100 + i }] }, { silent: true });   // 50 slider moves
  await settle(40);
  const writes = idb.stats.writes;
  assert.ok(writes <= 2, `${writes} writes`);
  const stored = JSON.parse(records(idb).get(STORAGE_KEYS.days));
  assert.equal(Object.values(stored[DAY].meals)[0].items[0].grams, 149);
  r.storage.setItem(STORAGE_KEYS.days, records(idb).get(STORAGE_KEYS.days));     // identical text
  await settle(30);
  assert.equal(idb.stats.writes, writes, 'identical text is not rewritten');
});

test('what was written is read back by the next start, through the cleaners', async () => {
  const idb = fakeIndexedDB();
  const a = await boot(idb);
  a.store.saveProfile(profile);
  a.store.addMeal(DAY, meal('Arroz'));
  a.store.saveMeal(a.store.mealsOf(DAY)[0]);
  a.store.logWeight(DAY, 79.5);
  await a.r.storage.flush();
  const b = await boot(idb);
  assert.equal(b.store.getProfile().sex, 'male');
  assert.equal(b.store.mealsOf(DAY)[0].name, 'Arroz');
  assert.equal(b.store.getSaved().length, 1);
  assert.equal(b.store.getWeights()[DAY], 79.5);
});

test('closing the page flushes at once: pagehide and the page becoming hidden', async () => {
  const idb = fakeIndexedDB();
  const win = fakeWin();
  const { store } = await boot(idb, { win, flushDelay: 60_000 });
  store.addMeal(DAY, meal());
  assert.equal(records(idb).size, 0);
  win.fire('pagehide');
  await settle(20);
  assert.ok(records(idb).has(STORAGE_KEYS.days), 'pagehide wrote it');
  store.addWater(DAY, 500);
  win.document.visibilityState = 'hidden';
  win.fireDoc('visibilitychange');
  await settle(20);
  assert.equal(JSON.parse(records(idb).get(STORAGE_KEYS.days))[DAY].waterMl, 500, 'hiding the page wrote it');
});

test('clearAll removes the data from the database too (the theme is not ours to remove)', async () => {
  const idb = fakeIndexedDB();
  const ls = fakeLocalStorage({ 'fd.theme': 'dark' });
  const { store, r } = await boot(idb, { ls });
  store.saveProfile(profile);
  store.addMeal(DAY, meal());
  await r.storage.flush();
  assert.ok(records(idb).size > 0);
  store.clearAll();
  await r.storage.flush();
  for (const k of DATA_KEYS) assert.ok(!records(idb).has(k), k);
  assert.equal(ls.m.get('fd.theme'), 'dark');
  const again = await boot(idb, { ls });
  assert.equal(again.store.getProfile(), null);
});

test('exportAll gives everything that is stored, from memory', async () => {
  const idb = fakeIndexedDB();
  const { store } = await boot(idb);
  store.saveProfile(profile);
  store.addMeal(DAY, meal());
  const out = store.exportAll();
  assert.equal(Object.keys(out.days).length, 1);
  assert.equal(out.profile.sex, 'male');
});

// ---------- failure modes ----------

test('no IndexedDB: localStorage is used when it works, memory with the warning when nothing can keep the data', async () => {
  const ls = fakeLocalStorage();
  const a = await openPersistentStorage({ indexedDB: null, localStorage: ls, win: fakeWin() });
  assert.equal(a.mode, 'localstorage');
  a.storage.setItem('fd.x', '1');
  assert.equal(ls.m.get('fd.x'), '1');
  const b = await openPersistentStorage({ indexedDB: null, localStorage: null, win: fakeWin() });
  assert.equal(b.mode, 'memory');
  assert.equal(b.problems[0].kind, 'write', 'the store will say it cannot save');
  const store = createStore(b.storage, storeEnv());
  const kinds = [];
  store.onStorageError((e) => kinds.push(e.kind));
  store.attach(b.storage, b);
  assert.ok(kinds.includes('write'));
  assert.equal(store.persistent, false);
  const c = await openPersistentStorage({ indexedDB: null, localStorage: null, win: null });     // Node, tests: nobody to warn
  assert.deepEqual(c.problems, []);
});

test('open fails or is blocked (Safari private mode, another tab holding an old version): localStorage takes over', async () => {
  for (const controls of [{ openError: new Error('SecurityError') }, { blocked: true }]) {
    const ls = fakeLocalStorage({ [STORAGE_KEYS.days]: '{}' });
    const r = await openPersistentStorage({ indexedDB: fakeIndexedDB(controls), localStorage: ls, win: fakeWin() });
    assert.equal(r.mode, 'localstorage', JSON.stringify(Object.keys(controls)));
    assert.equal(r.storage.getItem(STORAGE_KEYS.days), '{}');
  }
  const none = await openPersistentStorage({ indexedDB: fakeIndexedDB({ openError: new Error('x') }), localStorage: null, win: fakeWin() });
  assert.equal(none.mode, 'memory');
  assert.equal(none.problems[0].kind, 'write');
});

test('IndexedDB that is slow to open: the app does not wait for it, uses memory with the warning, and closes the late connection', async () => {
  const idb = fakeIndexedDB({ openDelayMs: 120 });
  const started = Date.now();
  const r = await openPersistentStorage({ indexedDB: idb, localStorage: fakeLocalStorage(), win: fakeWin(), timeoutMs: 40 });
  assert.ok(Date.now() - started < 110, 'it gave up at the timeout');
  assert.equal(r.mode, 'memory');
  assert.equal(r.problems[0].kind, 'write');
  assert.equal(r.problems[0].key, 'indexeddb-timeout');
  await settle(200);
  assert.equal(idb.stats.closes, 1, 'the connection that opened late was closed');
  assert.equal(OPEN_TIMEOUT_MS, 2500);
  assert.equal(FLUSH_DELAY_MS, 400);
});

test('a hung IndexedDB never freezes the boot: store.ready style wait ends at the timeout', async () => {
  const r = await openPersistentStorage({ indexedDB: fakeIndexedDB({ neverOpens: true }), localStorage: null, win: fakeWin(), timeoutMs: 30 });
  assert.equal(r.mode, 'memory');
});

test('quota exceeded: reported as a write problem, the data stays in memory, and the next change tries again', async () => {
  const idb = fakeIndexedDB();
  const { store, r } = await boot(idb);
  const errors = [];
  store.onStorageError((e) => errors.push(e.kind));
  idb.controls.failWrites = () => Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
  store.addMeal(DAY, meal('A'));
  await settle(40);
  assert.ok(errors.includes('write'));
  assert.equal(store.persistent, false);
  assert.equal(store.mealsOf(DAY).length, 1, 'still there in memory');
  assert.equal(records(idb).size, 0);
  idb.controls.failWrites = null;
  store.addMeal(DAY, meal('B'));
  await settle(40);
  const stored = JSON.parse(records(idb).get(STORAGE_KEYS.days));
  assert.equal(Object.keys(stored[DAY].meals).length, 2, 'the failed write was retried together with the new one');
  assert.equal(r.storage.pending, 0);
});

test('records that are not text are ignored and reported as corrupt; hostile text goes through the cleaners', async () => {
  const idb = fakeIndexedDB();
  records(idb).set(STORAGE_KEYS.days, { not: 'text' });
  records(idb).set(STORAGE_KEYS.saved, 42);
  records(idb).set(STORAGE_KEYS.weights, '{"__proto__": 80, "2026-11-12": 79}');
  records(idb).set(STORAGE_KEYS.profile, '{broken');
  const { r, store } = await boot(idb);
  assert.deepEqual(r.problems.map((p) => p.kind).sort(), ['corrupt', 'corrupt']);
  assert.deepEqual(Object.keys(store.getDays()), []);
  assert.deepEqual(Object.keys(store.getWeights()), ['2026-11-12']);
  assert.equal(store.getProfile(), null);
  assert.equal(({}).polluted, undefined);
});

test('size guards: one key and all keys together have a limit, and going over is refused, not written', async () => {
  const s = createIdbStorage({ db: null, entries: new Map(), setTimer: () => 0, clearTimer() {}, maxValue: 100, maxTotal: 150 });
  s.setItem('a', 'x'.repeat(100));
  assert.throws(() => s.setItem('b', 'x'.repeat(101)), /too large/);
  assert.throws(() => s.setItem('b', 'x'.repeat(60)), /size guard/);
  s.setItem('b', 'x'.repeat(50));
  assert.equal(s.bytes, 150);
  s.setItem('a', 'x'.repeat(10));                           // replacing frees the old size
  assert.equal(s.bytes, 60);
  const errors = [];
  s.onError((e) => errors.push(`${e.key}:${e.message}`));
  s.setLazy('c', () => 'x'.repeat(500));                    // the lazy text is checked when it is produced
  assert.equal(s.getItem('c'), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^c:.*too large/);
  assert.ok(MAX_STORED_CHARS >= 32 * 1024 * 1024 && MAX_TOTAL_CHARS > MAX_STORED_CHARS);
});

// ---------- migration from localStorage ----------

function seededLocalStorage(year = buildYear({ days: 20 })) {
  return fakeLocalStorage({ ...year.text, 'fd.theme': 'dark', 'other-app': 'keep' });
}

test('migration: the old keys are copied through the cleaners, the copy is verified, then the old keys are removed', async () => {
  const year = buildYear({ days: 40 });
  const ls = seededLocalStorage(year);
  const idb = fakeIndexedDB();
  const { r, store } = await boot(idb, { ls });
  assert.equal(r.mode, 'indexeddb');
  assert.equal(r.migration.ok, true);
  assert.deepEqual(r.migration.counts, { days: 40, meals: 160, thumbs: 40, saved: 30, weights: 14, goals: 1, profile: 1, products: 0 });
  for (const k of Object.values(STORAGE_KEYS)) assert.ok(!ls.m.has(k), `${k} was removed from localStorage`);
  assert.equal(ls.m.get('fd.theme'), 'dark', 'the theme stays where boot.js reads it');
  assert.equal(ls.m.get('other-app'), 'keep');
  assert.ok(records(idb).has(MARKER_KEY));
  for (const k of Object.keys(year.text)) assert.equal(records(idb).get(k), year.text[k], `${k} was copied exactly`);
  assert.deepEqual(countsOf(loadState((k) => (records(idb).has(k) ? records(idb).get(k) : null))), countsOf({ ...loadState(() => null), days: year.days, saved: year.saved, weights: year.weights, goals: [1], profile: {}, products: {} }) && r.migration.counts);
  assert.equal(Object.keys(store.getDays()).length, 40);
  // a second start migrates nothing and still has the data
  const again = await boot(idb, { ls });
  assert.equal(again.r.migration, null);
  assert.equal(Object.keys(again.store.getDays()).length, 40);
  assert.equal(again.store.getSaved().length, 30);
});

test('migration: hostile and broken old data is cleaned, and a value that cannot be read is left in localStorage untouched', async () => {
  const ls = fakeLocalStorage({
    [STORAGE_KEYS.days]: JSON.stringify({ [DAY]: { meals: { ok: { id: 'ok', name: 'Bien', items: [{ name: 'x', grams: 1, per100 }] }, '__proto__': { id: '__proto__', name: 'x', items: [{ name: 'x', grams: 1, per100 }] } } }, bogus: {} }),
    [STORAGE_KEYS.weights]: '{broken json',
    [STORAGE_KEYS.goals]: '"not goals"',
  });
  const idb = fakeIndexedDB();
  const { r, store } = await boot(idb, { ls });
  assert.equal(r.migration.ok, true);
  assert.deepEqual(r.migration.kept, [STORAGE_KEYS.weights]);
  assert.deepEqual(Object.keys(store.getDays()), [DAY]);
  assert.deepEqual(Object.keys(store.getDays()[DAY].meals), ['ok']);
  assert.equal(ls.m.get(STORAGE_KEYS.weights), '{broken json', 'what could not be read is not destroyed');
  assert.ok(!ls.m.has(STORAGE_KEYS.days));
  assert.equal(({}).polluted, undefined);
});

test('migration: if the check of the copy fails, the copy is rolled back, localStorage is untouched and keeps being used', async () => {
  const year = buildYear({ days: 10 });
  const ls = seededLocalStorage(year);
  const idb = fakeIndexedDB({ afterWrite: (rec) => { if (rec.has(STORAGE_KEYS.days)) rec.set(STORAGE_KEYS.days, '{}'); } });   // the "disk" loses the days
  const { r, store } = await boot(idb, { ls });
  assert.equal(r.mode, 'localstorage');
  assert.equal(r.migration.ok, false);
  assert.match(r.migration.reason, /does not match/);
  for (const k of Object.keys(year.text)) assert.equal(ls.m.get(k), year.text[k], `${k} is untouched`);
  assert.equal(records(idb).size, 0, 'the bad copy and its marker are gone');
  assert.equal(Object.keys(store.getDays()).length, 10, 'the app runs on localStorage');
  store.addMeal(DAY, meal('Nueva'));
  assert.ok(JSON.parse(ls.m.get(STORAGE_KEYS.days))[DAY], 'and new data goes there');
});

test('migration: if the copy cannot be written, localStorage is untouched and keeps being used; a later healthy start migrates', async () => {
  const year = buildYear({ days: 10 });
  const ls = seededLocalStorage(year);
  const idb = fakeIndexedDB({ failWrites: () => Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }) });
  const first = await boot(idb, { ls });
  assert.equal(first.r.mode, 'localstorage');
  assert.match(first.r.migration.reason, /could not be written/);
  assert.equal(records(idb).size, 0);
  for (const k of Object.keys(year.text)) assert.equal(ls.m.get(k), year.text[k]);
  idb.controls.failWrites = null;
  const second = await boot(idb, { ls });
  assert.equal(second.r.mode, 'indexeddb');
  assert.equal(Object.keys(second.store.getDays()).length, 10);
  assert.ok(!ls.m.has(STORAGE_KEYS.days));
});

test('migration interrupted between the copy and the removal: no data lost, none duplicated, the next start finishes', async () => {
  const year = buildYear({ days: 15 });
  const ls = seededLocalStorage(year);
  const idb = fakeIndexedDB();
  ls.controls.failRemove = true;                                           // the "crash": the old keys cannot be removed
  const first = await boot(idb, { ls });
  assert.equal(first.r.mode, 'indexeddb');
  assert.ok(ls.m.has(STORAGE_KEYS.days), 'the old keys are still there');
  assert.equal(Object.keys(first.store.getDays()).length, 15);
  // the person keeps using the app after the "crash"
  first.store.addMeal(DAY, meal('Después del fallo'));
  await first.r.storage.flush();
  ls.controls.failRemove = false;
  const second = await boot(idb, { ls });
  assert.equal(second.r.migration.finishedEarlier, true);
  for (const k of Object.values(STORAGE_KEYS)) assert.ok(!ls.m.has(k), `${k} removed on the next start`);
  const days = second.store.getDays();
  assert.equal(Object.keys(days).length, 15, '15 days (the last one is today), not 30');
  const total = Object.values(days).reduce((a, d) => a + Object.keys(d.meals).length, 0);
  assert.equal(total, 15 * 4 + 1, 'no meal lost, none doubled');
  assert.ok(Object.values(days[DAY].meals).some((m) => m.name === 'Después del fallo'), 'the edit made after the interruption survived: the database is the truth');
});

test('migration interrupted before the copy is committed: the database stays empty and the next start migrates normally', async () => {
  const year = buildYear({ days: 8 });
  const ls = seededLocalStorage(year);
  const idb = fakeIndexedDB({ failWrites: () => new Error('the tab was closed') });
  const first = await boot(idb, { ls });
  assert.equal(first.r.mode, 'localstorage');
  assert.equal(records(idb).size, 0, 'a transaction that did not commit leaves nothing behind');
  idb.controls.failWrites = null;
  const second = await boot(idb, { ls });
  assert.equal(second.r.mode, 'indexeddb');
  assert.equal(Object.keys(second.store.getDays()).length, 8);
});

test('migration: a database that already has data but no marker is never overwritten by old localStorage keys', async () => {
  const idb = fakeIndexedDB();
  records(idb).set(STORAGE_KEYS.days, JSON.stringify({ [DAY]: { meals: { z: { id: 'z', name: 'En la base', items: [{ name: 'x', grams: 1, per100 }] } } } }));
  const ls = fakeLocalStorage({ [STORAGE_KEYS.days]: JSON.stringify({ '2020-01-01': { meals: { y: { id: 'y', name: 'Viejo', items: [{ name: 'x', grams: 1, per100 }] } } } }) });
  const { store, r } = await boot(idb, { ls });
  assert.equal(r.migration, null);
  assert.deepEqual(Object.keys(store.getDays()), [DAY]);
  assert.ok(ls.m.has(STORAGE_KEYS.days), 'and the old keys are left alone');
});

test('migrateFromLocalStorage on its own: nothing to move gives an empty successful copy; a huge value is refused before any write', async () => {
  const idb = fakeIndexedDB();
  const db = await openDatabase(idb);
  const ls = fakeLocalStorage({ [STORAGE_KEYS.ui]: '{"mode":"code"}' });
  const ok = await migrateFromLocalStorage({ db, ls, legacy: [STORAGE_KEYS.ui] });
  assert.equal(ok.ok, true);
  assert.equal(records(idb).get(STORAGE_KEYS.ui), '{"mode":"code"}');
  const { entries } = await readAllEntries(db);
  assert.ok(entries.has(MARKER_KEY));
  const idb2 = fakeIndexedDB();
  const db2 = await openDatabase(idb2);
  const huge = fakeLocalStorage({ [STORAGE_KEYS.products]: `{"x":"${'a'.repeat(MAX_STORED_CHARS)}"}` });
  const r = await migrateFromLocalStorage({ db: db2, ls: huge, legacy: [STORAGE_KEYS.products] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.kept, [STORAGE_KEYS.products], 'too large to read: left where it is');
  assert.ok(huge.m.has(STORAGE_KEYS.products));
});

// ---------- other tabs ----------

test('another tab: a change flushed in one tab reaches the other as a normal store change, with no echo', async () => {
  const idb = fakeIndexedDB();
  const hub = fakeBroadcastHub();
  const a = await boot(idb, { hub });
  const b = await boot(idb, { hub });
  let changes = 0;
  b.store.subscribe(() => { changes += 1; });
  a.store.saveProfile(profile);
  a.store.addMeal(DAY, meal('Desde la pestaña A'));
  await a.r.storage.flush();
  await settle(30);
  assert.equal(b.store.mealsOf(DAY)[0].name, 'Desde la pestaña A');
  assert.equal(b.store.getProfile().sex, 'male');
  assert.ok(changes >= 1);
  // B reacts to what it heard the way cloud sync does (applies a merged state that equals its own). The first time, keys that were never stored
  // get their empty default written once; after that an unchanged state writes nothing and says nothing, so two tabs cannot ping-pong.
  b.store.applySyncState(b.store.getSyncState());
  await b.r.storage.flush();
  await settle(30);
  a.store.applySyncState(a.store.getSyncState());
  await a.r.storage.flush();
  await settle(30);
  const posted = hub.channels.length;
  const before = idb.stats.writes;
  b.store.applySyncState(b.store.getSyncState());
  await b.r.storage.flush();
  await settle(30);
  assert.equal(idb.stats.writes, before, 'an unchanged state is not written, so there is no echo to the other tab');
  assert.equal(hub.channels.length, posted);
});

test('another tab: a local change that is not on disk yet is not overwritten by what the other tab says', async () => {
  const idb = fakeIndexedDB();
  const hub = fakeBroadcastHub();
  const a = await boot(idb, { hub, flushDelay: 60_000 });
  const b = await boot(idb, { hub });
  b.store.addMeal(DAY, meal('De B'));
  await b.r.storage.flush();
  a.store.addWater(DAY, 777);                                  // A has an unwritten change to the same key
  await settle(30);
  assert.equal(a.store.getDay(DAY).waterMl, 777, 'A keeps its own unwritten change');
});

test('another tab: messages that are not ours (wrong shape, unknown keys, from itself) are ignored', async () => {
  const idb = fakeIndexedDB();
  const hub = fakeBroadcastHub();
  const a = await boot(idb, { hub });
  let heard = 0;
  a.r.storage.onExternalChange(() => { heard += 1; });
  const outsider = new hub.Channel('foodie-store');
  for (const data of [null, 'x', 5, {}, { t: 'changed' }, { t: 'changed', from: 'o', keys: 'days' }, { t: 'changed', from: 'o', keys: ['fd.theme', 'other', '__proto__'] }, { t: 'other', from: 'o', keys: [STORAGE_KEYS.days] }]) outsider.postMessage(data);
  await settle(30);
  assert.equal(heard, 0);
  outsider.postMessage({ t: 'changed', from: 'outsider', keys: [STORAGE_KEYS.days] });
  await settle(30);
  assert.equal(heard, 1);
});

test('no BroadcastChannel: everything else works', async () => {
  const idb = fakeIndexedDB();
  const { store, r } = await boot(idb, { hub: null });
  store.addMeal(DAY, meal());
  await r.storage.flush();
  assert.ok(records(idb).has(STORAGE_KEYS.days));
});

// ---------- a year of data ----------

test('a year of heavy use (4 meals a day, a thumbnail on every day) loads, reads back identically and stays under the size guard', async (t) => {
  const year = buildYear({ days: 365, mealsPerDay: 4, thumbsPerDay: 1 });
  const idb = fakeIndexedDB();
  for (const [k, v] of Object.entries(year.text)) records(idb).set(k, v);
  const t0 = performance.now();
  const { store, r } = await boot(idb);
  const ms = performance.now() - t0;
  assert.equal(Object.keys(store.getDays()).length, 365);
  assert.equal(countsOf(loadState((k) => r.storage.getItem(k))).meals, 1460);
  assert.equal(countsOf(loadState((k) => r.storage.getItem(k))).thumbs, 365);
  assert.ok(r.storage.bytes < 12 * 1024 * 1024, `${r.storage.bytes} characters`);
  t.diagnostic(`year of data: ${bytesOf(year.text)} characters on disk (${Math.round(bytesOf(year.text) / 365)} per day), open + read + clean in ${ms.toFixed(0)} ms with a fake database`);
  assert.ok(ms < 3000, `${ms} ms`);
  assert.equal(THUMB.length, 12 * 1024);
});
