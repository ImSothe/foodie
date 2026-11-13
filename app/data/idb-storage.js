/* foodie · where the data lives on the device: IndexedDB, behind an in-memory cache.
   Why not localStorage any more: it holds about 5 MB for every project of imsothe.github.io together, and a year of use with photo thumbnails
   needs about 6 MB. IndexedDB has room for it and does not block the page while it writes.

   How it works. At start the whole database is read into memory (a few milliseconds, measured in docs of the release), so the store keeps
   its synchronous API and the first screen is drawn from memory. A change is written to memory at once and to IndexedDB shortly after
   (400 ms, in one transaction, only for the keys that changed and only if the text really changed); when the page is hidden or closed
   everything pending is written immediately. Other tabs hear about it through a BroadcastChannel and read the changed keys again.

   Failure modes, none of which stops the app:
   - IndexedDB missing or refusing (Safari private mode, blocked): localStorage if it works, otherwise memory with the "cannot save" warning;
   - IndexedDB slow to open (more than 2.5 s): memory for this visit with the same warning, and the late connection is closed;
   - a write that fails (quota) is reported through onError; the data stays in memory and the next change tries again;
   - a record that is not text is ignored and reported as corrupt; everything read goes through the same cleaners as before.

   One-time migration from the old localStorage keys: copy them (through the cleaners) in ONE transaction together with a marker, read the copy
   back, compare it with what was meant to be written, and only then remove the old keys. If the check fails, the copy is rolled back, localStorage
   stays untouched and keeps being used. A crash between the copy and the removal is harmless: the marker is there next time, the database is the
   truth, and the leftovers are removed without being read again.

   Only this file (and boot.js for the theme) touches localStorage; only this file touches IndexedDB and BroadcastChannel. */
import { DATA_KEYS, MAX_STORED_CHARS, isStoreKey, loadState, serializeState, countsOf, problem } from './state-io.js';

export const DB_NAME = 'foodie';
export const STORE_NAME = 'kv';
export const MARKER_KEY = 'fd.migrated';
export const CHANNEL_NAME = 'foodie-store';
/** All keys together may not be larger than this (far below any browser quota): a guard against runaway data, not a budget. */
export const MAX_TOTAL_CHARS = 64 * 1024 * 1024;
export const FLUSH_DELAY_MS = 400;
export const OPEN_TIMEOUT_MS = 2500;

// ---------- small IndexedDB helpers ----------

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error('indexedDB request failed'));
});

const transactionDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error || new Error('indexedDB transaction failed'));
  tx.onabort = () => reject(tx.error || new Error('indexedDB transaction aborted'));
});

export function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();       // someone is upgrading or deleting the database: let go, so they are not blocked by this tab
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('indexedDB is blocked by another connection'));
  });
}

/** Every record of the database as text; records that are not text are listed in `bad` and ignored. */
export async function readAllEntries(db) {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const os = tx.objectStore(STORE_NAME);
  const [keys, values] = await Promise.all([request(os.getAllKeys()), request(os.getAll())]);
  const entries = new Map();
  const bad = [];
  keys.forEach((k, i) => { if (typeof k === 'string' && typeof values[i] === 'string') entries.set(k, values[i]); else bad.push(String(k)); });
  return { entries, bad };
}

/** One transaction, started synchronously (so it can be started while the page is closing). Resolves when the data is on disk. */
export function writeEntries(db, puts, deletes) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const os = tx.objectStore(STORE_NAME);
  for (const [k, v] of puts) os.put(v, k);
  for (const k of deletes) os.delete(k);
  return transactionDone(tx);
}

// ---------- the storage object the store uses ----------

/**
 * @param {object} o
 * @param {IDBDatabase} o.db
 * @param {Map<string,string>} o.entries  what the database held when it was opened
 * @param {(fn:Function, ms:number)=>any} [o.setTimer]
 * @param {(id:any)=>void} [o.clearTimer]
 * @param {{postMessage:Function, close?:Function, onmessage:any}|null} [o.channel]
 * @param {{document?:object, addEventListener?:Function, removeEventListener?:Function}|null} [o.win]
 */
export function createIdbStorage({
  db, entries, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), delay = FLUSH_DELAY_MS,
  channel = null, win = null, tabId = Math.random().toString(36).slice(2), maxValue = MAX_STORED_CHARS, maxTotal = MAX_TOTAL_CHARS,
}) {
  const map = new Map(entries);          // the current text of every key
  const persisted = new Map(entries);    // what the database holds, as far as this tab knows
  const lazy = new Map();                // key -> function that produces the text; run only when it is written or read
  const dirty = new Set();
  const errorFns = new Set();
  const externalFns = new Set();
  let total = 0;
  for (const v of map.values()) total += v.length;
  let timer = null;
  let flushing = null;
  let closed = false;

  const fail = (e, key) => {
    const error = e instanceof Error ? e : new Error(String(e));
    error.key = key;
    for (const fn of [...errorFns]) { try { fn(error); } catch (x) { /* a broken listener must not stop the storage */ } }
  };
  const store = (k, v) => { total += v.length - (map.has(k) ? map.get(k).length : 0); map.set(k, v); };
  const drop = (k) => { if (map.has(k)) { total -= map.get(k).length; map.delete(k); } };

  function materialize(k) {
    if (!lazy.has(k)) return;
    const thunk = lazy.get(k);
    lazy.delete(k);
    try {
      const v = String(thunk());
      if (v.length > maxValue) throw new Error('value too large to store');
      if (total - (map.has(k) ? map.get(k).length : 0) + v.length > maxTotal) throw new Error('the data on this device is over the size guard');
      store(k, v);
    } catch (e) { fail(e, k); }
  }

  function schedule() {
    if (closed || timer !== null) return;
    timer = setTimer(() => { timer = null; flush(); }, delay);
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();   // Node (tests): never keep the process alive
  }

  function flush() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (flushing) return flushing;
    const puts = new Map();
    const deletes = [];
    for (const k of [...dirty]) {
      materialize(k);
      if (map.has(k)) { if (persisted.get(k) !== map.get(k)) puts.set(k, map.get(k)); } else if (persisted.has(k)) deletes.push(k);
    }
    const keys = [...dirty];
    dirty.clear();
    if (!puts.size && !deletes.length) return Promise.resolve();
    let done;
    try { done = writeEntries(db, puts, deletes); } catch (e) { fail(e); for (const k of keys) dirty.add(k); return Promise.resolve(); }
    flushing = done.then(() => {
      for (const [k, v] of puts) persisted.set(k, v);
      for (const k of deletes) persisted.delete(k);
      if (channel) { try { channel.postMessage({ t: 'changed', from: tabId, keys: [...puts.keys(), ...deletes] }); } catch (e) { /* closed channel */ } }
    }).catch((e) => {
      fail(e);                                  // quota, a closed connection...: the data stays in memory and the next change tries again
      for (const k of keys) dirty.add(k);
    }).finally(() => { flushing = null; if (dirty.size && !closed) { /* retried by the next change, not in a loop */ } });
    return flushing;
  }

  /** Reads the given keys (all by default) from the database again; keys with unwritten local changes keep their local value. */
  async function refresh(keys) {
    const { entries: fresh } = await readAllEntries(db);
    const wanted = keys && keys.length ? keys : [...new Set([...fresh.keys(), ...map.keys()])];
    for (const k of wanted) {
      if (dirty.has(k) || lazy.has(k)) continue;
      if (fresh.has(k)) { store(k, fresh.get(k)); persisted.set(k, fresh.get(k)); } else { drop(k); persisted.delete(k); }
    }
  }

  const onMessage = async (ev) => {
    const m = ev && ev.data;
    if (!m || typeof m !== 'object' || m.t !== 'changed' || m.from === tabId || !Array.isArray(m.keys)) return;
    const keys = m.keys.filter((k) => typeof k === 'string' && DATA_KEYS.includes(k));
    if (!keys.length) return;
    try { await refresh(keys); } catch (e) { return; }
    for (const fn of [...externalFns]) { try { fn(); } catch (e) { /* ignore */ } }
  };
  if (channel) channel.onmessage = onMessage;

  const onHidden = () => { if (win && win.document && win.document.visibilityState === 'hidden') flush(); };
  const onPageHide = () => { flush(); };
  if (win && typeof win.addEventListener === 'function') {
    if (win.document && typeof win.document.addEventListener === 'function') win.document.addEventListener('visibilitychange', onHidden);
    win.addEventListener('pagehide', onPageHide);
  }

  return {
    getItem(k) { materialize(k); return map.has(k) ? map.get(k) : null; },
    setItem(k, value) {
      const v = String(value);
      if (v.length > maxValue) throw new Error('value too large to store');
      if (!lazy.has(k) && map.get(k) === v) return;               // nothing changed: nothing to write, nothing to tell other tabs
      if (total - (map.has(k) ? map.get(k).length : 0) + v.length > maxTotal) throw new Error('the data on this device is over the size guard');
      lazy.delete(k);
      store(k, v);
      dirty.add(k);
      schedule();
    },
    removeItem(k) { lazy.delete(k); drop(k); dirty.add(k); schedule(); },
    /** Like setItem, but the text is produced only when it is written (or read), so a burst of changes serializes once. */
    setLazy(k, thunk) { lazy.set(k, thunk); dirty.add(k); schedule(); },
    keys() { for (const k of [...lazy.keys()]) materialize(k); return [...map.keys()]; },
    flush,
    onError(fn) { errorFns.add(fn); return () => errorFns.delete(fn); },
    onExternalChange(fn) { externalFns.add(fn); return () => externalFns.delete(fn); },
    refresh,
    close() {
      closed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (win && typeof win.removeEventListener === 'function') {
        if (win.document && typeof win.document.removeEventListener === 'function') win.document.removeEventListener('visibilitychange', onHidden);
        win.removeEventListener('pagehide', onPageHide);
      }
      if (channel) { channel.onmessage = null; if (typeof channel.close === 'function') channel.close(); }
    },
    get pending() { return dirty.size + (flushing ? 1 : 0); },
    get bytes() { return total; },
    tabId,
  };
}

// ---------- fallbacks ----------

function safeLocalStorage(ls) {
  try {
    if (!ls) return null;
    const probe = '__fd_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch (e) { return null; }
}

/** localStorage as the store's storage, when IndexedDB cannot be used. Other tabs are noticed through the `storage` event. */
function localStorageAdapter(ls, win) {
  const fns = new Set();
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('storage', (e) => { if (e.storageArea === ls || !e.storageArea) if (isStoreKey(e.key)) for (const fn of [...fns]) fn(); });
  }
  return {
    getItem: (k) => ls.getItem(k),
    setItem: (k, v) => ls.setItem(k, v),
    removeItem: (k) => ls.removeItem(k),
    onExternalChange(fn) { fns.add(fn); return () => fns.delete(fn); },
  };
}

function memoryAdapter() {
  const mem = new Map();
  return { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
}

// ---------- migration from the old localStorage keys ----------

const readLs = (ls, k) => { try { return ls.getItem(k); } catch (e) { return null; } };
function removeLegacy(ls, keys) { for (const k of keys) { try { ls.removeItem(k); } catch (e) { /* the marker makes the next start finish the job */ } } }

/**
 * Copies the old keys into IndexedDB (cleaned), checks the copy, then removes the old keys.
 * @returns {Promise<{ok:true, counts:object}|{ok:false, reason:string}>}  on failure localStorage has not been touched and the copy is rolled back
 */
export async function migrateFromLocalStorage({ db, ls, legacy, now = () => Date.now() }) {
  const source = {};
  for (const k of legacy) source[k] = readLs(ls, k);
  const unreadable = new Set();
  const state = loadState((k) => (k in source ? source[k] : null), (e) => unreadable.add(e.key));
  const all = serializeState(state);
  // A value that cannot be read (broken JSON, absurdly large) is neither copied nor removed: nothing is destroyed that could still be looked at.
  const toMove = legacy.filter((k) => !unreadable.has(k));
  const wanted = new Map(toMove.map((k) => [k, all[k]]));
  for (const v of wanted.values()) if (typeof v !== 'string' || v.length > MAX_STORED_CHARS) return { ok: false, reason: 'a value is too large to copy' };
  const counts = countsOf(state);
  const copied = [...wanted.keys(), MARKER_KEY];
  try {
    await writeEntries(db, new Map([...wanted, [MARKER_KEY, String(now())]]), []);
  } catch (e) {
    return { ok: false, reason: `the copy could not be written: ${e && e.message}` };
  }
  let verdict = null;
  try {
    const { entries } = await readAllEntries(db);
    const back = loadState((k) => (entries.has(k) ? entries.get(k) : null));
    const same = JSON.stringify(countsOf(back)) === JSON.stringify(counts) && [...wanted].every(([k, v]) => entries.get(k) === v) && entries.has(MARKER_KEY);
    if (!same) verdict = 'the copy does not match the original';
  } catch (e) { verdict = `the copy could not be read back: ${e && e.message}`; }
  if (verdict) {
    try { await writeEntries(db, new Map(), copied); } catch (e) { /* a leftover copy without its marker would be re-checked next time */ }
    return { ok: false, reason: verdict };
  }
  removeLegacy(ls, toMove);
  return { ok: true, counts, kept: [...unreadable] };
}

// ---------- opening ----------

const withTimeout = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timedOut: true }), ms);
  promise.then((value) => { clearTimeout(timer); resolve({ value }); }, (error) => { clearTimeout(timer); resolve({ error }); });
});

/**
 * Opens the best storage there is and says which one it is.
 * @param {{indexedDB?:IDBFactory, localStorage?:Storage|null, win?:object|null, BroadcastChannel?:Function, timeoutMs?:number, now?:()=>number}} [env] injected in tests
 * @returns {Promise<{storage:object, mode:'indexeddb'|'localstorage'|'memory', problems:Error[], migration:object|null, timing:object}>}
 */
export async function openPersistentStorage(env = {}) {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const win = env.win !== undefined ? env.win : (typeof window !== 'undefined' && typeof document !== 'undefined' ? globalThis.window : null);
  const inBrowser = !!win;
  const idb = env.indexedDB !== undefined ? env.indexedDB : (inBrowser ? globalThis.indexedDB : undefined);
  const ls = env.localStorage !== undefined ? safeLocalStorage(env.localStorage) : (inBrowser ? safeLocalStorage(globalThis.localStorage) : null);
  const timeoutMs = env.timeoutMs || OPEN_TIMEOUT_MS;
  const timing = { total: 0 };
  const done = (r) => { timing.total = (typeof performance !== 'undefined' ? performance.now() : 0) - started; return { migration: null, problems: [], ...r, timing: { ...timing } }; };

  const noIndexedDb = (why) => {
    if (ls) return done({ storage: localStorageAdapter(ls, win), mode: 'localstorage' });
    // nothing can keep the data: tell the person (in a browser; in Node, as in tests, there is nobody to tell)
    return done({ storage: memoryAdapter(), mode: 'memory', problems: inBrowser ? [problem('write', why)] : [] });
  };

  if (!idb) return noIndexedDb('indexeddb-unavailable');

  const open = (async () => {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const db = await openDatabase(idb);
    timing.open = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    const t1 = typeof performance !== 'undefined' ? performance.now() : 0;
    let { entries, bad } = await readAllEntries(db);
    timing.read = (typeof performance !== 'undefined' ? performance.now() : 0) - t1;
    let migration = null;
    const legacy = ls ? DATA_KEYS.filter((k) => readLs(ls, k) !== null) : [];
    if (legacy.length) {
      if (entries.has(MARKER_KEY)) {
        removeLegacy(ls, legacy);                       // an earlier migration copied everything and was interrupted before removing these
        migration = { ok: true, finishedEarlier: true };
      } else if (!DATA_KEYS.some((k) => entries.has(k))) {
        migration = await migrateFromLocalStorage({ db, ls, legacy, now: env.now });
        if (!migration.ok) { db.close(); return { fallback: true, migration }; }
        ({ entries, bad } = await readAllEntries(db));
      }
    }
    return { db, entries, bad, migration };
  })();

  const r = await withTimeout(open, timeoutMs);
  if (r.timedOut) {
    open.then((late) => { if (late && late.db) late.db.close(); }).catch(() => {});
    return done({ storage: memoryAdapter(), mode: 'memory', problems: [problem('write', 'indexeddb-timeout')] });
  }
  if (r.error) return noIndexedDb('indexeddb-failed');
  if (r.value.fallback) {
    // the copy could not be verified: localStorage stays as it was and keeps being used
    return ls ? done({ storage: localStorageAdapter(ls, win), mode: 'localstorage', migration: r.value.migration }) : noIndexedDb('indexeddb-migration');
  }

  const { db, entries, bad, migration } = r.value;
  const BC = env.BroadcastChannel !== undefined ? env.BroadcastChannel : (inBrowser ? globalThis.BroadcastChannel : undefined);
  let channel = null;
  try { if (typeof BC === 'function') channel = new BC(CHANNEL_NAME); } catch (e) { channel = null; }   // without it, tabs just do not hear each other
  const storage = createIdbStorage({ db, entries, channel, win, delay: env.flushDelay === undefined ? FLUSH_DELAY_MS : env.flushDelay, maxValue: env.maxValue, maxTotal: env.maxTotal });
  return done({
    storage, mode: 'indexeddb', migration,
    problems: bad.map((k) => problem('corrupt', k)),
  });
}
