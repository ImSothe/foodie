/* foodie · cloud copy: Google sign-in and sync with Firestore.
   Local-first: the app never waits for this. The Firebase SDK (about 220 KB) is only loaded when the person has signed in
   before or opens the sign-in card, and a failed or missing connection just leaves the data on the device.

   One sync = pull what changed in the cloud, merge it with the local data (core/merge.js: newest edit wins per record, deletions
   travel as tombstones), save the merge locally, then push only the difference. It is idempotent: running it twice, or from two
   devices at once, converges to the same data. */
import { FIREBASE_CONFIG } from './firebase-config.js';
import { mergeState } from '../core/merge.js';
import { dayPatchDiff, userPatch, userDocsDiffer, savedPatchDiff, weightsPatchDiff, usagePatch, DELETE } from '../core/cloudmap.js';
import { openCloud, hasLegacy, sealDayPatch, sealUserPatch, sealSavedPatch, sealWeightsPatch, legacyCleanup } from '../core/cloudseal.js';
import { createLock, unlock as unlockKey, checkVerifier, KDF_ITERATIONS, MIN_ITERATIONS } from '../core/crypto.js';
import { checkPassphrase } from '../core/passphrase.js';
import { createKeyring } from './keyring.js';

const PULL_MARGIN_MS = 10 * 60 * 1000;     // devices' clocks differ a little: re-read the last few minutes
const PUSH_DELAY_MS = 3000;                // wait for a burst of edits to settle
const MIN_GAP_MS = 60 * 1000;              // do not sync on every tab switch
const BATCH = 400;
const WRONG_PASSPHRASE_DELAY_MS = 1000;      // a wrong passphrase costs a second: guessing through the app is slow, and it looks deliberate

/** @typedef {'off'|'signed-out'|'syncing'|'synced'|'offline'|'error'|'setup'|'locked'} CloudStatus  setup: the account has no passphrase yet; locked: it has one and this device does not know it */

export function createCloud({ store, loadSdk = () => import('../vendor/firebase.js'), now = () => Date.now(), config = FIREBASE_CONFIG, win = globalThis.window, doc: documentRef = globalThis.document,
  keyring = createKeyring(), kdfIterations = KDF_ITERATIONS, minIterations = MIN_ITERATIONS, delay = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
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
  let ctx = null;                          // { key, uid }: the encryption key of this account, once the passphrase is known on this device
  let pendingVerifier = null;              // a new passphrase's verifier, written together with the first encrypted upload
  let failedRecords = 0;                   // records of the last pull that did not open (tampered, another key): dropped, never shown
  let migration = { pending: 0 };          // plaintext records still in the cloud after the last sync (0 = nothing left); -1 = the cleanup itself failed
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
    if (!user) { ctx = null; pendingVerifier = null; set('signed-out'); return; }
    if (ctx && ctx.uid !== user.uid) { ctx = null; pendingVerifier = null; }
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

  // ---------- the encryption key of this account on this device ----------
  /** Makes `ctx` the key of this account if the key kept on this device opens the verifier the cloud holds. */
  async function useStoredKey(uid, verifierRaw) {
    const key = await keyring.load(uid);
    if (!key) return false;
    if (await checkVerifier(key, verifierRaw, uid, { minIterations })) { ctx = { key, uid }; return true; }
    await keyring.remove(uid);                       // the cloud copy was reset from another device: this key is obsolete
    return false;
  }

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
      const usageRef = doc(db, 'users', uid, 'meta', 'usage');
      const daysRef = collection(db, 'users', uid, 'days');

      // 1. Who holds the key? Nothing else is read before this is settled: without the passphrase the cloud copy is not touched.
      const userSnap = await getDoc(userRef);
      const userRaw = userSnap.exists() ? userSnap.data() : null;
      const verifierRaw = userRaw && userRaw.crypto;
      if (!ctx || ctx.uid !== uid) {
        ctx = null;
        if (verifierRaw === undefined || verifierRaw === null) { set('setup'); return; }          // no passphrase yet: a new account, or data from before encryption
        if (!(await useStoredKey(uid, verifierRaw))) { set('locked'); return; }
      } else if (!pendingVerifier && !(await checkVerifier(ctx.key, verifierRaw, uid, { minIterations }))) {
        ctx = null;                                                                                 // someone reset or replaced the cloud copy
        await keyring.remove(uid);
        set(verifierRaw === undefined || verifierRaw === null ? 'setup' : 'locked');
        return;
      }

      // 2. Read everything else, open it, merge it with the local data.
      const [savedSnap, weightsSnap, usageSnap, daysSnap] = await Promise.all([
        getDoc(savedRef), getDoc(weightsRef), getDoc(usageRef),
        getDocs(full ? daysRef : query(daysRef, where('updatedAt', '>', Math.max(0, info.lastPull - PULL_MARGIN_MS)))),
      ]);
      const raw = {
        user: userRaw,
        saved: savedSnap.exists() ? savedSnap.data() : null,
        weights: weightsSnap.exists() ? weightsSnap.data() : null,
        usage: usageSnap.exists() ? usageSnap.data() : null,
        days: Object.fromEntries(daysSnap.docs.map((d) => [d.id, d.data()])),
      };
      const opened = await openCloud(raw, ctx);
      failedRecords = opened.failed;
      const cloud = opened.enc;                                                // what the cloud holds, encrypted
      const everything = mergeState(opened.enc, opened.legacy, started);       // plus plaintext from before encryption, which is still data
      const legacyIds = opened.legacyIds;

      const sent = store.dirtyDays();
      const merged = mergeState(store.getSyncState(), everything, started);
      suppress = true;
      try { store.applySyncState(merged); } finally { suppress = false; }

      // 3. Write the difference, sealed.
      const t = now();
      const writes = [];
      const verifier = pendingVerifier;
      if ((userDocsDiffer(cloud, merged) && (merged.profile || merged.goals.length)) || verifier) {
        writes.push([userRef, await sealUserPatch(userPatch(merged, t), ctx, verifier)]);
      }
      const sp = savedPatchDiff(cloud, merged, t); if (sp) writes.push([savedRef, await sealSavedPatch(sp, ctx, legacyIds.saved)]);
      const wp = weightsPatchDiff(cloud, merged, t); if (wp) writes.push([weightsRef, await sealWeightsPatch(wp, ctx)]);
      const up = usagePatch(cloud, merged, t); if (up) writes.push([usageRef, up]);
      // plaintext days that an old app version wrote are sealed too, even when this device did not touch them
      const dayIsos = full ? Object.keys(merged.days) : [...new Set([...Object.keys(sent), ...Object.keys(legacyIds.days)])];
      for (const iso of dayIsos) {
        const day = merged.days[iso];
        const patch = day ? dayPatchDiff(cloud.days[iso], day, t) : null;
        if (patch) writes.push([doc(db, 'users', uid, 'days', iso), await sealDayPatch(iso, patch, ctx, legacyIds.days[iso])]);
      }
      await commit(writes);
      if (verifier) pendingVerifier = null;
      store.clearDirty(sent);
      store.setSyncInfo({ uid, lastPull: started });

      // 4. Plaintext left from before encryption: removed only for records read back, opened and compared. A failure here leaves it untouched.
      migration = { pending: 0 };
      if (hasLegacy(legacyIds)) {
        try {
          const fresh = writes.length ? await readBack(uid, legacyIds) : raw;
          const reread = writes.length ? await openCloud(fresh, ctx) : opened;
          const { writes: cleanup, unverified } = legacyCleanup(legacyIds, reread.enc, merged, uid, now());
          await commit(cleanup.map((w) => [doc(db, ...w.path), w.patch]));
          migration = { pending: unverified };
        } catch (e) {
          migration = { pending: -1 };
        }
      }
      lastSyncAt = now();
      if (migration.pending !== 0) set('error', 'migration-incomplete'); else set('synced');
    } catch (e) {
      const code = e && typeof e.code === 'string' ? e.code : 'unknown';
      set((win && win.navigator && win.navigator.onLine === false) || /unavailable|network/.test(code) ? 'offline' : 'error', code);
    } finally {
      running = false;
      if (again) { again = false; schedule(PUSH_DELAY_MS); }
    }
  }

  async function commit(writes) {
    const { writeBatch } = sdk;
    for (let i = 0; i < writes.length; i += BATCH) {
      const batch = writeBatch(db);
      for (const [ref, patch] of writes.slice(i, i + BATCH)) batch.set(ref, toFirestore(patch), { merge: true });
      await batch.commit();
    }
  }

  /** The documents that held plaintext, read again from the server (not from memory) so the check compares what is really stored. */
  async function readBack(uid, legacyIds) {
    const { doc, getDoc } = sdk;
    const get = async (...path) => { const s = await getDoc(doc(db, ...path)); return s.exists() ? s.data() : null; };
    const days = {};
    await Promise.all(Object.keys(legacyIds.days).map(async (iso) => { const d = await get('users', uid, 'days', iso); if (d) days[iso] = d; }));
    return { user: await get('users', uid), saved: await get('users', uid, 'meta', 'saved'), weights: await get('users', uid, 'meta', 'weights'), days };
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
    /** 'setup' (the account has no passphrase: ask for a new one), 'locked' (ask for the existing one) or null. */
    get needsPassphrase() { return status === 'setup' || status === 'locked' ? status : null; },
    /** True once the key of this account is on this device and the cloud copy is being kept encrypted. */
    get encrypted() { return ctx !== null; },
    /** Records of the last pull that could not be opened (they are dropped, never shown). */
    get failedRecords() { return failedRecords; },
    /** { pending }: plaintext records still in the cloud after the last sync. 0 when everything is encrypted; -1 when the cleanup failed. */
    get migration() { return migration; },
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
    /**
     * A new passphrase for this account (first time, or a migration of plaintext data): derives the key, keeps it on this device, uploads
     * everything encrypted, reads it back, and only then removes the plaintext.
     * @returns {Promise<{ok:true, synced:boolean}|{ok:false, reason:'signed-out'|'weak'|'exists'|'error'}>}
     */
    async setupPassphrase(passphrase) {
      if (!user) return { ok: false, reason: 'signed-out' };
      if (!checkPassphrase(passphrase).ok) return { ok: false, reason: 'weak' };
      try {
        await prepare();
        while (running) await delay(10);
        const { uid } = user;
        const existing = await sdk.getDoc(sdk.doc(db, 'users', uid));
        if (existing.exists() && existing.data().crypto) return { ok: false, reason: 'exists' };   // another device was faster: unlock instead
        const { key, verifier } = await createLock(passphrase, uid, kdfIterations);
        ctx = { key, uid };
        pendingVerifier = verifier;
        await keyring.save(uid, key);
        store.setSyncInfo({ uid, lastPull: 0 });
        await syncNow();
        while (running) await delay(10);
        return { ok: true, synced: status === 'synced' };
      } catch (e) {
        ctx = null; pendingVerifier = null;
        return { ok: false, reason: 'error' };
      }
    },
    /**
     * The passphrase of an account that already has one (a second device, a reinstall).
     * @returns {Promise<{ok:true, synced:boolean}|{ok:false, reason:'signed-out'|'wrong'|'no-passphrase'|'error'}>}
     */
    async unlock(passphrase) {
      if (!user) return { ok: false, reason: 'signed-out' };
      try {
        await prepare();
        while (running) await delay(10);
        const { uid } = user;
        const snap = await sdk.getDoc(sdk.doc(db, 'users', uid));
        const verifierRaw = snap.exists() ? snap.data().crypto : undefined;
        if (verifierRaw === undefined || verifierRaw === null) return { ok: false, reason: 'no-passphrase' };
        const key = await unlockKey(typeof passphrase === 'string' ? passphrase : '', verifierRaw, uid, { minIterations });
        if (!key) { await delay(WRONG_PASSPHRASE_DELAY_MS); return { ok: false, reason: 'wrong' }; }
        ctx = { key, uid };
        await keyring.save(uid, key);
        store.setSyncInfo({ uid, lastPull: 0 });
        await syncNow();
        while (running) await delay(10);
        return { ok: true, synced: status === 'synced' };
      } catch (e) {
        return { ok: false, reason: 'error' };
      }
    },
    /**
     * "Olvidé mi contraseña": the cloud copy cannot be opened without it, so it is deleted and this device's data is uploaded again under a new
     * passphrase. The caller must have said so clearly and only offer it when there is local data to upload.
     */
    async resetEncryption(passphrase) {
      if (!user) return { ok: false, reason: 'signed-out' };
      if (!checkPassphrase(passphrase).ok) return { ok: false, reason: 'weak' };
      try {
        await prepare();
        while (running) await delay(10);
        const { uid } = user;
        const { doc, collection, getDocs, writeBatch } = sdk;
        const days = await getDocs(collection(db, 'users', uid, 'days'));
        const refs = [...days.docs.map((d) => doc(db, 'users', uid, 'days', d.id)), doc(db, 'users', uid, 'meta', 'saved'), doc(db, 'users', uid, 'meta', 'weights'),
          doc(db, 'users', uid, 'meta', 'usage'), doc(db, 'users', uid)];
        for (let i = 0; i < refs.length; i += BATCH) {
          const batch = writeBatch(db);
          for (const ref of refs.slice(i, i + BATCH)) batch.delete(ref);
          await batch.commit();
        }
        ctx = null; pendingVerifier = null;
        await keyring.remove(uid);
      } catch (e) {
        return { ok: false, reason: 'error' };
      }
      return this.setupPassphrase(passphrase);
    },
    async signOut() {
      clearTimeout(timer);
      if (user) { try { await keyring.remove(user.uid); } catch (e) { /* the key is forgotten in memory below anyway */ } }
      ctx = null; pendingVerifier = null;
      if (sdk && auth) await sdk.signOut(auth);
      user = null;
      store.setSyncInfo({ uid: store.getSyncInfo().uid, lastPull: 0 });   // keep whose data this is: another account must never inherit it
      set('signed-out');
    },
    syncNow,
  };
}
