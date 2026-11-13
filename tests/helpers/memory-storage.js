/* In-memory storage with the same three methods as localStorage, with optional failures.

   With FOODIE_BACKEND=idb in the environment the very same helper hands out the REAL storage layer of the app instead
   (app/data/idb-storage.js: write-behind cache, lazy serialization, size guards), wrapped to look the same to the tests. That is how
   tests/idb-backend.test.js runs the unchanged store and hostile-data tests against the new backend, without a browser and without
   waiting for the disk: the database behind it is never reached (its timer never fires), so what is exercised is everything the store
   can see of it. */
import { createIdbStorage } from '../../app/data/idb-storage.js';

function idbBacked(initial, { failGet = false, failSet = false, failRemove = false }) {
  const inner = createIdbStorage({
    db: { transaction: () => { throw new Error('the database is not reached in this mode'); } },
    entries: new Map(Object.entries(initial)),
    setTimer: () => 0, clearTimer: () => {},
  });
  const m = {
    get: (k) => { const v = inner.getItem(k); return v === null ? undefined : v; },
    has: (k) => inner.getItem(k) !== null,
    set: (k, v) => { inner.setItem(k, v); return m; },
    delete: (k) => { inner.removeItem(k); return true; },
    keys: () => inner.keys()[Symbol.iterator](),
  };
  return {
    m,
    inner,
    getItem: (k) => { if (failGet) throw new Error('getItem blocked'); return inner.getItem(k); },
    setItem: (k, v) => { if (failSet) throw new Error('quota exceeded'); inner.setItem(k, v); },
    setLazy: (k, thunk) => { if (failSet) throw new Error('quota exceeded'); inner.setLazy(k, thunk); },
    removeItem: (k) => { if (failRemove) throw new Error('removeItem blocked'); inner.removeItem(k); },
    onError: (fn) => inner.onError(fn),
    onExternalChange: (fn) => inner.onExternalChange(fn),
  };
}

export function memoryStorage(initial = {}, failures = {}) {
  if (process.env.FOODIE_BACKEND === 'idb') return idbBacked(initial, failures);
  const { failGet = false, failSet = false, failRemove = false } = failures;
  const m = new Map(Object.entries(initial));
  return {
    m,
    getItem: (k) => { if (failGet) throw new Error('getItem blocked'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (failSet) throw new Error('quota exceeded'); m.set(k, String(v)); },
    removeItem: (k) => { if (failRemove) throw new Error('removeItem blocked'); m.delete(k); },
  };
}
