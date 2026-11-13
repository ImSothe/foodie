/* A tiny in-memory stand-in for the parts of the Firebase SDK that app/data/cloud.js uses, with Firestore's merge semantics:
   set(..., { merge: true }) merges maps field by field, arrays are replaced whole, deleteField() removes a key. */
const DELETE_MARK = { __deleteField: true };
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && v !== DELETE_MARK;
const clone = (v) => JSON.parse(JSON.stringify(v));

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === DELETE_MARK) delete target[k];
    else if (isPlain(v)) { if (!isPlain(target[k])) target[k] = {}; merge(target[k], v); }
    else target[k] = clone(v);
  }
  return target;
}

export function createBackend() {
  const docs = new Map();                 // path -> data
  // failIn: let this many Firestore calls succeed, then fail the next one with 'unavailable' (a connection that drops half-way through a sync)
  const stats = { reads: 0, writes: 0, failNext: null, failIn: null, offline: false, calls: 0 };
  const check = () => {
    stats.calls += 1;
    if (stats.failIn !== null) { if (stats.failIn === 0) { stats.failIn = null; throw Object.assign(new Error('unavailable'), { code: 'unavailable' }); } stats.failIn -= 1; }
    if (stats.offline) throw Object.assign(new Error('offline'), { code: 'unavailable' });
    if (stats.failNext) { const code = stats.failNext; stats.failNext = null; throw Object.assign(new Error(code), { code }); }
  };
  const snap = (path) => ({ id: path.split('/').pop(), exists: () => docs.has(path), data: () => clone(docs.get(path)) });

  const sdk = (uidRef) => {
    let authCb = null;
    return {
      initializeApp: () => ({}),
      initializeAuth: () => ({}),
      indexedDBLocalPersistence: {}, browserLocalPersistence: {}, browserPopupRedirectResolver: {},
      GoogleAuthProvider: class {},
      onAuthStateChanged: (auth, cb) => { authCb = cb; cb(uidRef.current ? { uid: uidRef.current, displayName: 'Test', email: 'test@example.invalid' } : null); },
      signInWithPopup: async () => { uidRef.current = uidRef.next; authCb({ uid: uidRef.current, displayName: 'Test', email: 'test@example.invalid' }); },
      signOut: async () => { uidRef.current = null; authCb(null); },
      getFirestore: () => ({}),
      doc: (db, ...segs) => ({ path: segs.join('/') }),
      collection: (db, ...segs) => ({ path: segs.join('/'), isCollection: true }),
      where: (field, op, value) => ({ field, op, value }),
      query: (col, ...filters) => ({ ...col, filters }),
      deleteField: () => DELETE_MARK,
      getDoc: async (ref) => { check(); stats.reads += 1; return snap(ref.path); },
      getDocs: async (q) => {
        check();
        const out = [];
        for (const path of docs.keys()) {
          if (!path.startsWith(`${q.path}/`) || path.slice(q.path.length + 1).includes('/')) continue;
          if ((q.filters || []).some((f) => !(docs.get(path)[f.field] > f.value))) continue;
          out.push(snap(path));
        }
        stats.reads += out.length || 1;
        return { docs: out };
      },
      writeBatch: () => {
        const ops = [];
        return {
          delete(ref) { ops.push([ref.path, null, { remove: true }]); },
          set(ref, data, opts) { ops.push([ref.path, data, opts]); },
          async commit() {
            check();
            for (const [path, data, opts] of ops) {
              stats.writes += 1;
              if (opts && opts.remove) { docs.delete(path); continue; }
              docs.set(path, opts && opts.merge ? merge(docs.get(path) || {}, data) : clone(data));
            }
          },
        };
      },
    };
  };
  return { docs, stats, sdk };
}
