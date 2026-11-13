/* foodie · end-to-end encryption of the cloud copy: the primitives. WebCrypto only, no dependency, no storage, no network.

   Key:        PBKDF2-HMAC-SHA-256 (600,000 iterations) from the person's passphrase and a random 16-byte salt -> AES-256-GCM key.
               The key is derived once per device and kept as a NON-extractable CryptoKey (data/keyring.js); the passphrase is never kept.
   Record:     { v: 1, iv, ct }: a fresh random 12-byte IV per record, ct = AES-GCM ciphertext with its 16-byte tag (both base64).
               The plaintext is JSON. Every record is bound to WHERE it lives by the additional authenticated data (see aadFor): the user id,
               the document, the field and the record id, so a record copied to another day, id, field or user fails to open.
   Verifier:   users/{uid}.crypto = { v, salt, iter, check }: `check` is a fixed sentence encrypted with the key, so a passphrase can be
               tested without being stored. Anyone who can read it can try passphrases offline: a weak passphrase is the weak point.

   What this does not hide is listed in SECURITY.md (document ids, sizes, counts, stamps). Nothing here ever throws on hostile input:
   open() and openVerifier() answer undefined / null for anything that does not decrypt and authenticate. */

export const VERSION = 1;
export const KDF_ITERATIONS = 600000;
export const MIN_ITERATIONS = 600000;            // what a client accepts from a verifier it reads (a lower number would make guessing cheaper)
export const MAX_ITERATIONS = 10_000_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const MAX_CT_BYTES = 256 * 1024;          // a sealed record bigger than this is refused before decrypting
export const CHECK_TEXT = 'foodie-passphrase-check-v1';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle || typeof c.getRandomValues !== 'function') throw new Error('WebCrypto is not available');
  return c.subtle;
}

// ---------- base64 (standard alphabet, padded; decoding is strict) ----------
export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Bytes, or null when the text is not canonical base64. */
export function fromB64(text) {
  if (typeof text !== 'string' || text.length > 2_000_000 || !B64.test(text)) return null;
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

export function randomBytes(n) {
  subtle();
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/**
 * The AES-GCM key for a passphrase. `extractable` exists only for the known-answer tests; the app never asks for it.
 * The passphrase is normalised (NFKC) so the same word typed on two keyboards is the same key.
 */
export async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS, { extractable = false } = {}) {
  const pw = textEncoder.encode(String(passphrase).normalize('NFKC'));
  const base = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

/** Where a record lives, as authenticated data: an array is unambiguous where a joined string is not. */
export const aadFor = (uid, doc, field, id = '') => textEncoder.encode(JSON.stringify(['foodie', VERSION, String(uid), String(doc), String(field), String(id)]));

/** @returns {Promise<{v:1, iv:string, ct:string}>} */
export async function seal(key, value, aad) {
  const iv = randomBytes(IV_BYTES);
  const plain = textEncoder.encode(JSON.stringify(value));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_BYTES * 8 }, key, plain));
  return { v: VERSION, iv: toB64(iv), ct: toB64(ct) };
}

/** True for exactly { v: 1, iv, ct } with well-formed base64 of the right sizes (it says nothing about whether it decrypts). */
export function isSealed(blob) {
  if (!isObj(blob)) return false;
  try {
    const keys = Object.keys(blob);
    if (keys.length !== 3 || blob.v !== VERSION) return false;
    const iv = fromB64(blob.iv);
    const ct = fromB64(blob.ct);
    return !!iv && iv.length === IV_BYTES && !!ct && ct.length >= TAG_BYTES && ct.length <= MAX_CT_BYTES;
  } catch (e) {
    return false;
  }
}

/** The value inside a sealed record, or undefined when it is malformed, tampered with, from another place or under another key. */
export async function open(key, blob, aad) {
  try {
    if (!isSealed(blob)) return undefined;
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv), additionalData: aad, tagLength: TAG_BYTES * 8 }, key, fromB64(blob.ct));
    return JSON.parse(textDecoder.decode(plain));
  } catch (e) {
    return undefined;
  }
}

// ---------- the passphrase verifier ----------
const checkAad = (uid) => aadFor(uid, 'user', 'crypto', 'check');

/** What goes in users/{uid}.crypto for a new passphrase. */
export async function makeVerifier(key, uid, salt, iterations = KDF_ITERATIONS) {
  return { v: VERSION, salt: toB64(salt), iter: iterations, check: await seal(key, CHECK_TEXT, checkAad(uid)) };
}

/** The salt and iteration count of a verifier read from the cloud, or null when it is malformed or asks for fewer iterations than allowed. */
export function readVerifier(raw, { minIterations = MIN_ITERATIONS } = {}) {
  try {
    if (!isObj(raw) || raw.v !== VERSION || Object.keys(raw).length !== 4) return null;
    const salt = fromB64(raw.salt);
    if (!salt || salt.length !== SALT_BYTES) return null;
    if (!Number.isInteger(raw.iter) || raw.iter < minIterations || raw.iter > MAX_ITERATIONS) return null;
    if (!isSealed(raw.check)) return null;
    return { salt, iter: raw.iter, check: raw.check };
  } catch (e) {
    return null;
  }
}

/** Does this key open the verifier of this user? */
export async function checkVerifier(key, raw, uid, options) {
  const v = readVerifier(raw, options);
  return !!v && (await open(key, v.check, checkAad(uid))) === CHECK_TEXT;
}

/** Derives the key for a passphrase against a verifier from the cloud; null when the passphrase is wrong or the verifier is not acceptable. */
export async function unlock(passphrase, raw, uid, options) {
  const v = readVerifier(raw, options);
  if (!v) return null;
  const key = await deriveKey(passphrase, v.salt, v.iter);
  return (await open(key, v.check, checkAad(uid))) === CHECK_TEXT ? key : null;
}

/** A new passphrase: its key and the verifier to store. */
export async function createLock(passphrase, uid, iterations = KDF_ITERATIONS) {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(passphrase, salt, iterations);
  return { key, verifier: await makeVerifier(key, uid, salt, iterations) };
}
