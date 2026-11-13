/* Where the encryption key lives on the device: its own IndexedDB database, non-extractable keys only, never anything else. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyring, memoryKeyring, KEYS_DB, KEYS_STORE } from '../app/data/keyring.js';
import { deriveKey, randomBytes, seal, open, aadFor } from '../app/core/crypto.js';
import { fakeIndexedDB } from './helpers/fake-idb.js';

const key = () => deriveKey('x', randomBytes(16), 1000);
const AAD = aadFor('u', 'days/2026-11-12', 'mealsE', 'a');

test('a saved key comes back after a restart (a new keyring on the same database) and still works', async () => {
  const idb = fakeIndexedDB();
  const first = createKeyring({ indexedDB: idb });
  const k = await key();
  const blob = await seal(k, 'dato', AAD);
  assert.equal(await first.save('alice', k), true, 'stored on disk');
  assert.equal(first.persistent, true);
  const second = createKeyring({ indexedDB: idb });
  const back = await second.load('alice');
  assert.ok(back);
  assert.equal(back.extractable, false);
  assert.equal(await open(back, blob, AAD), 'dato');
  assert.equal(await second.load('bob'), null, 'a key belongs to its user');
  assert.deepEqual([...idb.records(KEYS_DB, KEYS_STORE).keys()], ['alice']);
  assert.equal(idb.databases.has('foodie'), false, 'the data database is not touched');
});

test('only non-extractable AES-GCM keys are accepted for saving, and only such keys are trusted when loading', async () => {
  const idb = fakeIndexedDB();
  const ring = createKeyring({ indexedDB: idb });
  const exportable = await deriveKey('x', randomBytes(16), 1000, { extractable: true });
  await assert.rejects(ring.save('alice', exportable), TypeError);
  await assert.rejects(ring.save('alice', 'a passphrase'), TypeError);
  await assert.rejects(ring.save('alice', null), TypeError);
  await assert.rejects(ring.save('', await key()), TypeError);
  assert.equal(idb.records(KEYS_DB, KEYS_STORE).size, 0);
  // whatever else is found in the database (a hostile script wrote it) is ignored
  const store = idb.records(KEYS_DB, KEYS_STORE);
  for (const bad of ['text', 5, { type: 'secret' }, exportable, { type: 'secret', extractable: false, algorithm: { name: 'AES-GCM', length: 128 }, usages: ['encrypt', 'decrypt'] }, null]) {
    store.set('mallory', bad);
    assert.equal(await createKeyring({ indexedDB: idb }).load('mallory'), null);
  }
});

test('remove and clear forget the key, on disk too', async () => {
  const idb = fakeIndexedDB();
  const ring = createKeyring({ indexedDB: idb });
  await ring.save('alice', await key());
  await ring.save('bob', await key());
  await ring.remove('alice');
  assert.equal(await ring.load('alice'), null);
  assert.equal(await createKeyring({ indexedDB: idb }).load('alice'), null, 'gone after a restart');
  assert.ok(await createKeyring({ indexedDB: idb }).load('bob'));
  await ring.clear();
  assert.equal(idb.records(KEYS_DB, KEYS_STORE).size, 0);
  assert.equal(await ring.load('bob'), null);
  await ring.remove(undefined);                       // hostile arguments are not errors
  assert.equal(await ring.load(undefined), null);
  assert.equal(await ring.load({ toString: () => 'alice' }), null);
});

test('without IndexedDB, or with one that fails, the key lasts for this visit only and nothing throws', async () => {
  const k = await key();
  const none = memoryKeyring();
  assert.equal(none.persistent, false);
  assert.equal(await none.save('alice', k), false);
  assert.equal(await none.load('alice'), k, 'still usable in this visit');
  for (const controls of [{ openError: new Error('denied') }, { blocked: true }]) {
    const ring = createKeyring({ indexedDB: fakeIndexedDB(controls) });
    assert.equal(await ring.save('alice', k), false);
    assert.equal(ring.persistent, false);
    assert.equal(await ring.load('alice'), k);
  }
  const hung = createKeyring({ indexedDB: fakeIndexedDB({ neverOpens: true }), timeoutMs: 30 });
  assert.equal(await hung.save('alice', k), false);
  assert.equal(await hung.load('alice'), k);
  const failing = fakeIndexedDB({ failWrites: () => new Error('quota') });
  const ring = createKeyring({ indexedDB: failing });
  assert.equal(await ring.save('alice', k), false, 'a failed write is reported as not persisted');
  assert.equal(await ring.load('alice'), k);
  const throwing = createKeyring({ indexedDB: { open: () => { throw new Error('boom'); } } });
  assert.equal(await throwing.save('alice', k), false);
});
