/* The encryption primitives (app/core/crypto.js, WebCrypto) against Node's OWN crypto implementation (node:crypto, OpenSSL), which shares no code
   with the WebCrypto path: known-answer vectors, key derivation, decrypting what the other side encrypted, tampering, location binding, hostile input. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, createCipheriv, createDecipheriv, webcrypto } from 'node:crypto';
import {
  KDF_ITERATIONS, MIN_ITERATIONS, SALT_BYTES, IV_BYTES, TAG_BYTES, MAX_CT_BYTES, toB64, fromB64, randomBytes, deriveKey, aadFor, seal, open, isSealed,
  makeVerifier, readVerifier, checkVerifier, unlock, createLock,
} from '../app/core/crypto.js';
import { makeRng, FUZZ_SEED } from './helpers/prng.js';
import { anyValue } from './helpers/hostile.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const FAST = 1000;                                   // iterations in tests that derive many keys; the defaults are asserted separately
const SALT = unhex('000102030405060708090a0b0c0d0e0f');
const UID = 'uid-alice';
const aad = aadFor(UID, 'days/2026-11-12', 'mealsE', 'm1');

test('the defaults are strong enough: 600,000 PBKDF2 iterations, 16-byte salt, 12-byte IV, 16-byte tag', () => {
  assert.equal(KDF_ITERATIONS, 600000);
  assert.equal(MIN_ITERATIONS, 600000);
  assert.equal(SALT_BYTES, 16);
  assert.equal(IV_BYTES, 12);
  assert.equal(TAG_BYTES, 16);
});

test('base64: round trip, and decoding is strict', () => {
  for (const n of [0, 1, 2, 3, 16, 100, 70000]) { const b = n > 60000 ? new Uint8Array(n).map((_, i) => i % 251) : randomBytes(n); assert.deepEqual(fromB64(toB64(b)), b, `${n} bytes`); }
  assert.equal(toB64(new Uint8Array([104, 105])), 'aGk=');
  for (const bad of ['aGk', 'aGk==', 'aG k=', 'aGk=\n', '-_-_', 'aGk=aGk=', '=', 'a', 'aGk=a', null, undefined, 5, {}, [], 'x'.repeat(2_000_004)]) assert.equal(fromB64(bad), null, String(bad).slice(0, 20));
});

test('known answer: PBKDF2-HMAC-SHA-256 (RFC 7914, "passwd" / "salt" / 1 iteration)', async () => {
  const want = '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783';
  assert.equal(hex(pbkdf2Sync('passwd', 'salt', 1, 64, 'sha256')), want, 'Node agrees with the RFC');
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('passwd'), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('salt'), iterations: 1 }, base, 512);
  assert.equal(hex(new Uint8Array(bits)), want, 'WebCrypto agrees with the RFC');
});

test('known answer: AES-256-GCM (NIST test case 14: zero key, zero IV, 16 zero bytes)', async () => {
  const key = await webcrypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const out = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 }, key, new Uint8Array(16)));
  assert.equal(hex(out.subarray(0, 16)), 'cea7403d4d606b6e074ec5d3baf39d18');
  assert.equal(hex(out.subarray(16)), 'd0d1c8a799996bf0265b98b5d48ab919');
});

test('deriveKey gives the same key bytes as node:crypto PBKDF2 (600,000 iterations, the real default)', async () => {
  const key = await deriveKey('contraseña de prueba', SALT, KDF_ITERATIONS, { extractable: true });
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', key));
  assert.equal(hex(raw), hex(pbkdf2Sync(Buffer.from('contraseña de prueba'.normalize('NFKC')), SALT, KDF_ITERATIONS, 32, 'sha256')));
});

test('the key is not extractable unless a test asks for it, and the passphrase is normalised (NFKC)', async () => {
  const key = await deriveKey('secreto', SALT, FAST);
  assert.equal(key.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', key));
  const a = new Uint8Array(await webcrypto.subtle.exportKey('raw', await deriveKey('ﬁesta ①', SALT, FAST, { extractable: true })));
  const b = new Uint8Array(await webcrypto.subtle.exportKey('raw', await deriveKey('fiesta 1', SALT, FAST, { extractable: true })));
  assert.equal(hex(a), hex(b), 'a ligature and a circled digit typed on another keyboard are the same passphrase');
  const c = new Uint8Array(await webcrypto.subtle.exportKey('raw', await deriveKey('Fiesta 1', SALT, FAST, { extractable: true })));
  assert.notEqual(hex(a), hex(c), 'case still matters');
});

test('what WebCrypto seals, node:crypto opens (and the other way round), with the same additional authenticated data', async () => {
  const keyBytes = pbkdf2Sync('clave larga y rara', SALT, FAST, 32, 'sha256');
  const key = await deriveKey('clave larga y rara', SALT, FAST);
  const value = { id: 'm1', name: 'Pollo con arroz', items: [{ name: 'Pollo', grams: 150 }], thumb: 'data:image/jpeg;base64,AAAA' };
  const blob = await seal(key, value, aad);
  assert.ok(isSealed(blob));
  const raw = fromB64(blob.ct);
  const d = createDecipheriv('aes-256-gcm', keyBytes, fromB64(blob.iv), { authTagLength: 16 });
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
  assert.deepEqual(JSON.parse(plain), value, 'node decrypts what the app sealed');

  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyBytes, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final(), c.getAuthTag()]);
  assert.deepEqual(await open(key, { v: 1, iv: toB64(iv), ct: toB64(ct) }, aad), value, 'the app opens what node sealed');
});

test('seal and open: round trip for every JSON shape, a fresh IV each time, nothing readable in the ciphertext', async () => {
  const key = await deriveKey('x', SALT, FAST);
  for (const v of [0, 'texto', true, [1, 2, 3], { a: { b: [null, 'ñ'] } }, '', 'ünïcödé 🍎', { n: 1.5 }]) assert.deepEqual(await open(key, await seal(key, v, aad), aad), v);
  const ivs = new Set();
  const cts = new Set();
  for (let i = 0; i < 300; i += 1) { const b = await seal(key, 'mismo texto', aad); ivs.add(b.iv); cts.add(b.ct); }
  assert.equal(ivs.size, 300, 'no IV is ever reused');
  assert.equal(cts.size, 300, 'the same plaintext never gives the same ciphertext');
  const secret = 'Pechuga de pollo con salsa secreta';
  const blob = await seal(key, { name: secret }, aad);
  assert.ok(!JSON.stringify(blob).includes('Pechuga') && !Buffer.from(fromB64(blob.ct)).toString('latin1').includes('Pechuga'));
  assert.deepEqual(Object.keys(blob).sort(), ['ct', 'iv', 'v']);
});

test('tampering: every single bit flipped in the ciphertext or the IV makes opening fail cleanly', async () => {
  const key = await deriveKey('x', SALT, FAST);
  const blob = await seal(key, { name: 'x', kcal: 100 }, aad);
  const ct = fromB64(blob.ct); const iv = fromB64(blob.iv);
  let tried = 0;
  for (let i = 0; i < ct.length * 8; i += 1) {
    const copy = new Uint8Array(ct); copy[i >> 3] ^= 1 << (i & 7);
    assert.equal(await open(key, { ...blob, ct: toB64(copy) }, aad), undefined, `ct bit ${i}`); tried += 1;
  }
  for (let i = 0; i < iv.length * 8; i += 1) {
    const copy = new Uint8Array(iv); copy[i >> 3] ^= 1 << (i & 7);
    assert.equal(await open(key, { ...blob, iv: toB64(copy) }, aad), undefined, `iv bit ${i}`); tried += 1;
  }
  assert.ok(tried > 300);
  assert.equal(await open(key, { ...blob, ct: toB64(ct.subarray(0, ct.length - 1)) }, aad), undefined, 'truncated');
  assert.equal(await open(key, { ...blob, ct: toB64(new Uint8Array([...ct, 0])) }, aad), undefined, 'extended');
  assert.deepEqual(await open(key, blob, aad), { name: 'x', kcal: 100 }, 'the original still opens');
});

test('location binding: a record moved to another user, document, field or id does not open', async () => {
  const key = await deriveKey('x', SALT, FAST);
  const blob = await seal(key, 'comida', aadFor('alice', 'days/2026-11-12', 'mealsE', 'm1'));
  assert.equal(await open(key, blob, aadFor('alice', 'days/2026-11-12', 'mealsE', 'm1')), 'comida');
  assert.equal(await open(key, blob, aadFor('bob', 'days/2026-11-12', 'mealsE', 'm1')), undefined, 'another user');
  assert.equal(await open(key, blob, aadFor('alice', 'days/2026-11-13', 'mealsE', 'm1')), undefined, 'another day');
  assert.equal(await open(key, blob, aadFor('alice', 'meta/saved', 'mealsE', 'm1')), undefined, 'another document');
  assert.equal(await open(key, blob, aadFor('alice', 'days/2026-11-12', 'itemsE', 'm1')), undefined, 'another field');
  assert.equal(await open(key, blob, aadFor('alice', 'days/2026-11-12', 'mealsE', 'm2')), undefined, 'another id');
  assert.equal(await open(key, blob, new Uint8Array()), undefined, 'no data at all');
  assert.notDeepEqual(aadFor('a', 'b|c', 'd', 'e'), aadFor('a|b', 'c', 'd', 'e'), 'the encoding cannot be confused by separators');
});

test('wrong passphrase, wrong salt, wrong iteration count: nothing opens', async () => {
  const key = await deriveKey('correcta', SALT, FAST);
  const blob = await seal(key, 'dato', aad);
  assert.equal(await open(await deriveKey('incorrecta', SALT, FAST), blob, aad), undefined);
  assert.equal(await open(await deriveKey('correcta', randomBytes(16), FAST), blob, aad), undefined);
  assert.equal(await open(await deriveKey('correcta', SALT, FAST + 1), blob, aad), undefined);
  assert.equal(await open(await deriveKey('Correcta', SALT, FAST), blob, aad), undefined);
  assert.equal(await open(await deriveKey('correcta ', SALT, FAST), blob, aad), undefined);
  assert.equal(await open(key, blob, aad), 'dato');
});

test('hostile blobs: open never throws and isSealed rejects every malformed shape', async () => {
  const key = await deriveKey('x', SALT, FAST);
  const good = await seal(key, 'v', aad);
  const bad = [
    null, undefined, 0, 'x', [], {}, { v: 1 }, { ...good, extra: 1 }, { ...good, v: 2 }, { ...good, v: '1' }, { ...good, iv: good.iv.slice(4) }, { ...good, iv: toB64(randomBytes(11)) },
    { ...good, iv: toB64(randomBytes(13)) }, { ...good, ct: toB64(randomBytes(15)) }, { ...good, ct: 'not base64!' }, { ...good, ct: toB64(new Uint8Array(MAX_CT_BYTES + 1)) },
    { v: 1, iv: good.iv }, { v: 1, ct: good.ct }, { ...good, iv: 5 }, { ...good, ct: null }, { __proto__: { v: 1 }, iv: good.iv, ct: good.ct },
    { get v() { throw new Error('boom'); }, iv: good.iv, ct: good.ct },
  ];
  for (const b of bad) {
    assert.equal(isSealed(b), false);
    assert.equal(await open(key, b, aad), undefined);
  }
  const rng = makeRng(FUZZ_SEED);
  for (let i = 0; i < 1500; i += 1) {
    const v = anyValue(rng);
    assert.equal(await open(key, v, aad), undefined);
    const shaped = { v: 1, iv: rng.chance(0.5) ? good.iv : anyValue(rng), ct: rng.chance(0.5) ? good.ct : anyValue(rng) };
    const out = await open(key, shaped, aad);                                      // may legitimately open only the untouched pair
    assert.ok(out === undefined || (shaped.iv === good.iv && shaped.ct === good.ct));
  }
  assert.equal(await open(undefined, good, aad), undefined, 'no key');
  assert.equal(await open({}, good, aad), undefined, 'not a key');
});

test('plaintext that is not JSON is refused after authentication, not trusted', async () => {
  const keyBytes = pbkdf2Sync('x', SALT, FAST, 32, 'sha256');
  const key = await deriveKey('x', SALT, FAST);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyBytes, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update('{not json', 'utf8'), c.final(), c.getAuthTag()]);
  assert.equal(await open(key, { v: 1, iv: toB64(iv), ct: toB64(ct) }, aad), undefined);
});

test('the verifier: the right passphrase unlocks, a wrong one does not, and it is tied to the user', async () => {
  const { key, verifier } = await createLock('mi contraseña', UID, FAST);
  assert.deepEqual(Object.keys(verifier).sort(), ['check', 'iter', 'salt', 'v']);
  assert.equal(verifier.iter, FAST);
  assert.equal(fromB64(verifier.salt).length, 16);
  assert.ok(await checkVerifier(key, verifier, UID, { minIterations: FAST }));
  const same = await unlock('mi contraseña', verifier, UID, { minIterations: FAST });
  assert.ok(same);
  assert.deepEqual(await open(same, await seal(key, 'cruzado', aad), aad), 'cruzado', 'two derivations of the same passphrase are the same key');
  assert.equal(await unlock('otra contraseña', verifier, UID, { minIterations: FAST }), null);
  assert.equal(await unlock('mi contraseña', verifier, 'uid-bob', { minIterations: FAST }), null, 'a verifier copied to another account does not unlock');
  assert.equal(await checkVerifier(await deriveKey('otra', fromB64(verifier.salt), FAST), verifier, UID, { minIterations: FAST }), false);
  assert.ok(!JSON.stringify(verifier).includes('foodie-passphrase-check'));
});

test('a verifier asking for fewer iterations than allowed, or malformed, is refused before any key is derived', async () => {
  const { verifier } = await createLock('x', UID, FAST);
  assert.equal(readVerifier(verifier), null, 'the default minimum is 600,000');
  assert.ok(readVerifier(verifier, { minIterations: FAST }));
  for (const bad of [null, [], 'x', {}, { ...verifier, iter: 5 }, { ...verifier, iter: 1.5 }, { ...verifier, iter: '1000' }, { ...verifier, iter: 10_000_001 }, { ...verifier, v: 2 },
    { ...verifier, salt: toB64(randomBytes(8)) }, { ...verifier, salt: 'zz' }, { ...verifier, check: { v: 1 } }, { ...verifier, extra: 1 }]) {
    assert.equal(readVerifier(bad, { minIterations: FAST }), null);
    assert.equal(await unlock('x', bad, UID, { minIterations: FAST }), null);
  }
  const weak = await makeVerifier(await deriveKey('x', SALT, 1), UID, SALT, 1);
  assert.equal(await unlock('x', weak, UID), null, 'a server that rewrote the verifier to a cheap one does not get the passphrase derived that way');
});

// ---------- static guards ----------
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const appDir = fileURLToPath(new URL('../app/', import.meta.url));
const appFiles = (dir = appDir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return f === 'vendor' ? [] : appFiles(p);
  return p.endsWith('.js') ? [p] : [];
});

test('static: WebCrypto (crypto.subtle) is used only in app/core/crypto.js', () => {
  const users = appFiles().filter((p) => /crypto\.subtle|\.subtle\b|SubtleCrypto/.test(readFileSync(p, 'utf8'))).map((p) => relative(appDir, p).split(sep).join('/'));
  assert.deepEqual(users, ['core/crypto.js']);
});

test('static: the key derivation never asks for an extractable key in the app', () => {
  for (const p of appFiles()) {
    const src = readFileSync(p, 'utf8');
    assert.doesNotMatch(src, /extractable:\s*true/, relative(appDir, p));
    assert.doesNotMatch(src, /exportKey\(/, relative(appDir, p));
  }
});
