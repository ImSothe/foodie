/* foodie · where the encryption key of the cloud copy is kept on this device.
   The key (an AES-GCM CryptoKey derived from the passphrase, NON-extractable) goes in its own small IndexedDB database, "foodie-keys", one record
   per user id. A non-extractable key can be stored and used but its bytes can never be read back, not even by this app or a script on the page:
   it can encrypt and decrypt while the browser holds it, which is the point. The passphrase itself is never stored anywhere, and the key is
   never written to localStorage, Firestore, a log or the exported data. Signing out removes the key from the device.

   If IndexedDB is not available (a private mode, a blocked database) the key lives in memory for this visit only: the person types the passphrase
   again next time. Nothing throws. Only this file and data/idb-storage.js touch IndexedDB. */

export const KEYS_DB = 'foodie-keys';
export const KEYS_STORE = 'keys';
export const OPEN_TIMEOUT_MS = 2500;

/** A stored value is only trusted as a key if it is a secret, non-extractable AES-GCM key (a hostile script could have put anything there). */
const isUsableKey = (k) => {
  try {
    return !!k && typeof k === 'object' && k.type === 'secret' && k.extractable === false && !!k.algorithm && k.algorithm.name === 'AES-GCM' && k.algorithm.length === 256
      && Array.isArray(k.usages) && k.usages.includes('encrypt') && k.usages.includes('decrypt');
  } catch (e) {
    return false;
  }
};
const isUid = (uid) => typeof uid === 'string' && uid.length > 0 && uid.length <= 128;

export function createKeyring({ indexedDB = globalThis.indexedDB, timeoutMs = OPEN_TIMEOUT_MS } = {}) {
  const memory = new Map();
  let dbPromise = null;
  let persistent = !!indexedDB;

  function open() {
    dbPromise ||= new Promise((resolve) => {
      if (!indexedDB) { resolve(null); return; }
      const timer = setTimeout(() => { persistent = false; resolve(null); }, timeoutMs);
      const done = (db) => { clearTimeout(timer); resolve(db); };
      try {
        const req = indexedDB.open(KEYS_DB, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(KEYS_STORE)) req.result.createObjectStore(KEYS_STORE); };
        req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); done(req.result); };
        req.onerror = () => { persistent = false; done(null); };
        req.onblocked = () => { persistent = false; done(null); };
      } catch (e) {
        persistent = false;
        done(null);
      }
    });
    return dbPromise;
  }

  /** Runs one request in one transaction; undefined when the database is unusable. */
  async function run(mode, fn) {
    const db = await open();
    if (!db) return undefined;
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(KEYS_STORE, mode);
        const req = fn(tx.objectStore(KEYS_STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error || new Error('keyring transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('keyring transaction aborted'));
      });
    } catch (e) {
      persistent = false;
      return undefined;
    }
  }

  return {
    /** False once the key could not be written to the database: it then lasts only for this visit. */
    get persistent() { return persistent; },
    /** The key of this user, or null. */
    async load(uid) {
      if (!isUid(uid)) return null;
      if (memory.has(uid)) return memory.get(uid);
      const key = await run('readonly', (os) => os.get(uid));
      if (!isUsableKey(key)) return null;
      memory.set(uid, key);
      return key;
    },
    /** Keeps the key for this user. Resolves to true when it is stored on disk, false when it only lives in memory. */
    async save(uid, key) {
      if (!isUid(uid) || !isUsableKey(key)) throw new TypeError('a non-extractable AES-GCM key is required');
      memory.set(uid, key);
      const stored = await run('readwrite', (os) => os.put(key, uid));
      return stored !== undefined && persistent;
    },
    /** Forgets the key of this user (sign-out). */
    async remove(uid) {
      if (!isUid(uid)) return;
      memory.delete(uid);
      await run('readwrite', (os) => os.delete(uid));
    },
    /** Forgets every key on this device. */
    async clear() {
      memory.clear();
      await run('readwrite', (os) => os.clear());
    },
  };
}

/** A keyring that never touches the disk (tests, and the fallback). */
export const memoryKeyring = () => createKeyring({ indexedDB: null });
