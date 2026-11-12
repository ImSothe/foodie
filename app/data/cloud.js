/* foodie · cloud copy: Google sign-in and sync with Firestore.
   Local-first: the app never waits for this. The Firebase SDK (about 220 KB) is only loaded when the person has signed in
   before or opens the sign-in card, and a failed or missing connection just leaves the data on the device.

   One sync = pull what changed in the cloud, merge it with the local data (core/merge.js: newest edit wins per record, deletions
   travel as tombstones), save the merge locally, then push only the difference. It is idempotent: running it twice, or from two
   devices at once, converges to the same data. */
import { FIREBASE_CONFIG } from './firebase-config.js';
import { mergeState } from '../core/merge.js';
import { stateFromCloud, dayPatchDiff, userPatch, userDocsDiffer, savedPatchDiff, weightsPatchDiff, DELETE } from '../core/cloudmap.js';

const PULL_MARGIN_MS = 10 * 60 * 1000;     // devices' clocks differ a little: re-read the last few minutes
const PUSH_DELAY_MS = 3000;                // wait for a burst of edits to settle
const MIN_GAP_MS = 60 * 1000;              // do not sync on every tab switch
const BATCH = 400;

/** @typedef {'off'|'signed-out'|'syncing'|'synced'|'offline'|'error'} CloudStatus */

export function createCloud({ store, loadSdk = () => import('../vendor/firebase.js'), now = () => Date.now(), config = FIREBASE_CONFIG, win = globalThis.window, doc: documentRef = globalThis.document } = {}) {
  const listeners = new Set();
  let sdk = null;
  let sdkPromise = null;
  let app = null;
  let auth = null;
  let db = null;
  let user = null;
  let status = /** @type {CloudStatus} */ ('off');
  let lastError = '';
  let lastSyncAt = 0;
  let running = false;
  let again = false;
  let timer = 0;
  let suppress = false;                    // the store is being written by the sync itself

  const set = (next, error = '') => { status = next; lastError = error; for (const fn of [...listeners]) { try { fn(); } catch (e) { /* a broken listener must not stop the sync */ } } };

  async function prepare() {
    if (sdk) return sdk;
    sdkPromise ||= loadSdk().then((m) => {
      sdk = m;
      app = m.initializeApp(config);
      auth = m.initializeAuth(app, { persistence: [m.indexedDBLocalPersistence, m.browserLocalPersistence], popupRedirectResolver: m.browserPopupRedirectResolver });
      db = m.getFirestore(app);
      m.onAuthStateChanged(auth, onAuth);
      return m;
    }).catch((e) => { sdkPromise = null; throw e; });
    return sdkPromise;
  }

  function onAuth(u) {
    user = u ? { uid: u.uid, name: u.displayName || '', email: u.email || '' } : null;
    if (!user) { set('signed-out'); return; }
    const info = store.getSyncInfo();
    if (info.uid && info.uid !== user.uid) store.clearAll();      // another account on this device: never mix their data
    if (info.uid !== user.uid) store.setSyncInfo({ uid: user.uid, lastPull: 0 });
    set('synced');
    schedule(0);
  }

  const toFirestore = (v) => {
    if (v === DELETE) return sdk.deleteField();
    if (Array.isArray(v)) return v.map(toFirestore);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toFirestore(x);
      return out;
    }
    return v;
  };

  async function syncNow() {
    if (!user) return;
    if (running) { again = true; return; }
    running = true;
    set('syncing');
    try {
      const { uid } = user;
      const info = store.getSyncInfo();
      const full = !info.lastPull || info.uid !== uid;
      const started = now();
      const { doc, getDoc, getDocs, collection, query, where, writeBatch } = sdk;
      const userRef = doc(db, 'users', uid);
      const savedRef = doc(db, 'users', uid, 'meta', 'saved');
      const weightsRef = doc(db, 'users', uid, 'meta', 'weights');
      const daysRef = collection(db, 'users', uid, 'days');

      const [userSnap, savedSnap, weightsSnap, daysSnap] = await Promise.all([
        getDoc(userRef), getDoc(savedRef), getDoc(weightsRef),
        getDocs(full ? daysRef : query(daysRef, where('updatedAt', '>', Math.max(0, info.lastPull - PULL_MARGIN_MS)))),
      ]);
      const cloud = stateFromCloud({
        user: userSnap.exists() ? userSnap.data() : null,
        saved: savedSnap.exists() ? savedSnap.data() : null,
        weights: weightsSnap.exists() ? weightsSnap.data() : null,
        days: Object.fromEntries(daysSnap.docs.map((d) => [d.id, d.data()])),
      });

      const sent = store.dirtyDays();
      const merged = mergeState(store.getSyncState(), cloud, started);
      suppress = true;
      try { store.applySyncState(merged); } finally { suppress = false; }

      const t = now();
      const writes = [];
      if (userDocsDiffer(cloud, merged) && (merged.profile || merged.goals.length)) writes.push([userRef, userPatch(merged, t)]);
      const sp = savedPatchDiff(cloud, merged, t); if (sp) writes.push([savedRef, sp]);
      const wp = weightsPatchDiff(cloud, merged, t); if (wp) writes.push([weightsRef, wp]);
      for (const iso of full ? Object.keys(merged.days) : Object.keys(sent)) {
        const day = merged.days[iso];
        const patch = day ? dayPatchDiff(cloud.days[iso], day, t) : null;
        if (patch) writes.push([doc(db, 'users', uid, 'days', iso), patch]);
      }
      for (let i = 0; i < writes.length; i += BATCH) {
        const batch = writeBatch(db);
        for (const [ref, patch] of writes.slice(i, i + BATCH)) batch.set(ref, toFirestore(patch), { merge: true });
        await batch.commit();
      }
      store.clearDirty(sent);
      store.setSyncInfo({ uid, lastPull: started });
      lastSyncAt = now();
      set('synced');
    } catch (e) {
      const code = e && typeof e.code === 'string' ? e.code : 'unknown';
      set((win && win.navigator && win.navigator.onLine === false) || /unavailable|network/.test(code) ? 'offline' : 'error', code);
    } finally {
      running = false;
      if (again) { again = false; schedule(PUSH_DELAY_MS); }
    }
  }

  function schedule(delay) {
    if (!user) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, delay);
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref();   // Node (tests): do not keep the process alive
  }

  store.subscribe(() => { if (!suppress && user) schedule(PUSH_DELAY_MS); });
  if (win && win.addEventListener) win.addEventListener('online', () => schedule(0));
  if (documentRef && documentRef.addEventListener) {
    documentRef.addEventListener('visibilitychange', () => { if (documentRef.visibilityState === 'visible' && user && now() - lastSyncAt > MIN_GAP_MS) schedule(0); });
  }

  return {
    get status() { return status; },
    get error() { return lastError; },
    get user() { return user; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Call when the sign-in card is shown, so the popup can open straight from the tap (browsers block popups that follow a wait). */
    prepare,
    /** The loaded SDK and the Firebase app, for the parts that need them besides sync (the photo analysis). */
    async firebase() { const m = await prepare(); return { sdk: m, app }; },
    /** Start in the background if this device was signed in before; costs nothing otherwise. */
    start() { const info = store.getSyncInfo(); if (info.uid && info.lastPull > 0) prepare().catch((e) => set('error', (e && e.code) || 'load')); },
    async signIn() {
      try {
        await prepare();
        const provider = new sdk.GoogleAuthProvider();
        await sdk.signInWithPopup(auth, provider);
        return { ok: true };
      } catch (e) {
        const code = e && typeof e.code === 'string' ? e.code : 'unknown';
        return { ok: false, code, cancelled: code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' };
      }
    },
    async signOut() {
      clearTimeout(timer);
      if (sdk && auth) await sdk.signOut(auth);
      user = null;
      store.setSyncInfo({ uid: store.getSyncInfo().uid, lastPull: 0 });   // keep whose data this is: another account must never inherit it
      set('signed-out');
    },
    syncNow,
  };
}
