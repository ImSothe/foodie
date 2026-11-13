/* A small hand-made IndexedDB, in memory, with the failure modes the storage layer has to survive. It implements only what
   app/data/idb-storage.js uses: open (with upgrade), one object store with out-of-line keys, transactions with put/delete/get/getAll/getAllKeys,
   atomic commit, and the request/transaction events. Everything is asynchronous (a macrotask), like the real thing.

   Controls (all optional, all changeable while a test runs):
     openError    an Error: open() fails with it
     blocked      true: open() reports "blocked"
     neverOpens   true: open() never answers (a slow or hung browser)
     failWrites   (puts, deletes) => Error|null: the whole write transaction aborts with that error and nothing is applied (quota, crash)
     afterWrite   (records) => void: runs after a committed write; lets a test corrupt what was stored
     failReads    true: read transactions abort
     openDelayMs  milliseconds before open() answers (a slow browser) */
export function fakeIndexedDB(controls = {}) {
  const databases = new Map();          // name -> { stores: Map(storeName -> Map(key -> value)) }
  const stats = { opens: 0, closes: 0, writes: 0, reads: 0, putKeys: [] };

  const later = (fn) => setTimeout(fn, 0);

  function makeTransaction(db, storeName, mode) {
    const records = db.stores.get(storeName);
    const tx = { error: null, oncomplete: null, onerror: null, onabort: null, mode };
    const staged = { puts: new Map(), deletes: [] };
    let pending = 0;
    let finished = false;
    let scheduled = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (mode === 'readwrite') {
        const err = controls.failWrites ? controls.failWrites(staged.puts, staged.deletes) : null;
        if (err) { tx.error = err; if (tx.onabort) tx.onabort({ target: tx }); return; }
        for (const [k, v] of staged.puts) records.set(k, v);
        for (const k of staged.deletes) records.delete(k);
        stats.writes += 1;
        stats.putKeys.push(...staged.puts.keys());
        if (controls.afterWrite) controls.afterWrite(records);
      } else {
        stats.reads += 1;
        if (controls.failReads) { tx.error = new Error('read failed'); if (tx.onabort) tx.onabort({ target: tx }); return; }
      }
      if (tx.oncomplete) tx.oncomplete({ target: tx });
    };
    const schedule = () => { if (!scheduled) { scheduled = true; later(() => { scheduled = false; if (pending === 0) finish(); }); } };

    const settle = (value, apply) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      pending += 1;
      later(() => {
        if (apply) apply();
        req.result = typeof value === 'function' ? value() : value;
        pending -= 1;
        if (req.onsuccess) req.onsuccess({ target: req });
        if (pending === 0) schedule();
      });
      return req;
    };

    tx.objectStore = (name) => {
      if (name !== storeName) throw new Error(`no such store: ${name}`);
      return {
        put: (value, key) => { if (mode !== 'readwrite') throw new Error('read-only transaction'); staged.puts.set(key, value); staged.deletes = staged.deletes.filter((k) => k !== key); return settle(key); },
        delete: (key) => { if (mode !== 'readwrite') throw new Error('read-only transaction'); staged.deletes.push(key); staged.puts.delete(key); return settle(undefined); },
        get: (key) => settle(() => records.get(key)),
        getAll: () => settle(() => [...records.values()]),
        getAllKeys: () => settle(() => [...records.keys()]),
      };
    };
    schedule();                                       // a transaction with no requests still completes
    return tx;
  }

  const factory = {
    stats,
    controls,
    databases,
    open(name) {
      stats.opens += 1;
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        if (controls.neverOpens) return;
        if (controls.openError) { req.error = controls.openError; if (req.onerror) req.onerror({ target: req }); return; }
        if (controls.blocked) { if (req.onblocked) req.onblocked({ target: req }); return; }
        let entry = databases.get(name);
        const fresh = !entry;
        if (fresh) { entry = { stores: new Map() }; databases.set(name, entry); }
        const db = {
          objectStoreNames: { contains: (n) => entry.stores.has(n) },
          createObjectStore: (n) => { entry.stores.set(n, new Map()); },
          transaction: (storeName, mode) => {
            if (!entry.stores.has(storeName)) throw new Error(`no such store: ${storeName}`);
            if (db.closed) throw new Error('the connection is closed');
            return makeTransaction(entry, storeName, mode);
          },
          close: () => { db.closed = true; stats.closes += 1; },
          closed: false,
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      }, controls.openDelayMs || 0);
      return req;
    },
    /** The records of the object store, for assertions and for seeding. */
    records(name = 'foodie', store = 'kv') {
      let entry = databases.get(name);
      if (!entry) { entry = { stores: new Map() }; databases.set(name, entry); }
      if (!entry.stores.has(store)) entry.stores.set(store, new Map());
      return entry.stores.get(store);
    },
  };
  return factory;
}

/** A localStorage lookalike, with failures on demand. */
export function fakeLocalStorage(initial = {}, { failGet = false, failSet = false, failRemove = false } = {}) {
  const m = new Map(Object.entries(initial));
  const ls = {
    m,
    controls: { failGet, failSet, failRemove },
    getItem: (k) => { if (ls.controls.failGet) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (ls.controls.failSet) throw new Error('quota'); m.set(k, String(v)); },
    removeItem: (k) => { if (ls.controls.failRemove && k !== '__fd_probe__') throw new Error('blocked'); m.delete(k); },
  };
  return ls;
}

/** A BroadcastChannel hub: every channel made with the same name hears the others (not itself), asynchronously. */
export function fakeBroadcastHub() {
  const channels = [];
  class FakeChannel {
    constructor(name) { this.name = name; this.onmessage = null; this.closed = false; channels.push(this); }
    postMessage(data) {
      const copy = structuredClone(data);
      for (const c of channels) if (c !== this && c.name === this.name && !c.closed) setTimeout(() => { if (c.onmessage) c.onmessage({ data: copy }); }, 0);
    }
    close() { this.closed = true; }
  }
  return { Channel: FakeChannel, channels };
}

export const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
