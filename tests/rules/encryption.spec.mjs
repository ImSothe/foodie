/* The encrypted shapes in firestore.rules, in both phases of the rollout:
     phase 1  plaintext documents (app versions from before encryption) and encrypted ones are both accepted;
     phase 2  only encrypted ones. The rules file differs between the phases in one line (plaintextAllowed), so both are tested whichever
              phase the file in the repository is in. */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { doc, setDoc, updateDoc, getDoc, deleteField } from 'firebase/firestore';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { createEnv, rulesFor, seed, VALID, pathsOf, ALICE, DAY, meal, many, profile } from './helpers.mjs';

const P = pathsOf(ALICE);
const b64 = (n) => 'A'.repeat(n);
/** A sealed blob of the right shape (the rules check the shape; only the app can tell whether it decrypts). */
const sealed = (ctChars = 60) => ({ v: 1, iv: b64(16), ct: b64(ctChars) });
const entry = (updatedAt = 1_800_000_000_000) => ({ ...sealed(), updatedAt });
const verifier = (over = {}) => ({ v: 1, salt: b64(24), iter: 600000, check: sealed(60), ...over });

const ENC = {
  user: () => ({ profileE: sealed(), profileAt: 1_800_000_000_000, goalsE: { '2026-01-01': sealed() }, goalsAt: { '2026-01-01': 1_800_000_000_000 }, crypto: verifier(), updatedAt: 1_800_000_000_000 }),
  day: () => ({ mealsE: { a: entry(), b: entry() }, deleted: { c: 1_800_000_000_000 }, waterE: sealed(40), waterAt: 1_800_000_000_000, stepsE: sealed(40), stepsAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 }),
  saved: () => ({ itemsE: { s1: entry() }, deleted: { s2: 1_800_000_000_000 }, updatedAt: 1_800_000_000_000 }),
  weights: () => ({ wE: { [DAY]: sealed() }, at: { [DAY]: 1_800_000_000_000 }, updatedAt: 1_800_000_000_000 }),
};
const PLAIN = { user: VALID.user, day: VALID.day, saved: VALID.saved, weights: VALID.weights };
const KINDS = Object.keys(ENC);

for (const phase of [1, 2]) {
  describe(`phase ${phase}`, () => {
    let env; let db;
    before(async () => { env = await createEnv(rulesFor(phase), `demo-foodie-phase${phase}`); db = env.authenticatedContext(ALICE).firestore(); });
    after(async () => { await env.cleanup(); });
    beforeEach(async () => { await env.clearFirestore(); });

    for (const kind of KINDS) {
      it(`accepts an encrypted ${kind} document, a merge into it, and a merge that adds a field`, async () => {
        const ref = doc(db, P[kind]);
        await assertSucceeds(setDoc(ref, ENC[kind]()));
        await assertSucceeds(setDoc(ref, { updatedAt: 1_800_000_000_001 }, { merge: true }));
        await assertSucceeds(getDoc(ref));
      });
    }

    it('the app\'s encrypted write shapes in full: entries added, entries removed with deleteField, a sealed field replaced', async () => {
      await assertSucceeds(setDoc(doc(db, P.day), ENC.day()));
      await assertSucceeds(setDoc(doc(db, P.day), { mealsE: { z: entry(), a: deleteField() }, waterE: sealed(48), updatedAt: 1_800_000_000_002 }, { merge: true }));
      await assertSucceeds(updateDoc(doc(db, P.day), { 'mealsE.q': entry() }));
    });

    // ---- sealed blobs: exactly v / iv / ct of the right sizes ----
    const badBlobs = [
      ['an extra key', { ...sealed(40), extra: 1 }], ['a missing key', { v: 1, iv: b64(16) }], ['version 2', { ...sealed(40), v: 2 }], ['version as text', { ...sealed(40), v: '1' }],
      ['an IV of 15 characters', { ...sealed(40), iv: b64(15) }], ['an IV of 17 characters', { ...sealed(40), iv: b64(17) }], ['a ciphertext that cannot hold a tag', { ...sealed(40), ct: b64(20) }],
      ['a ciphertext over the field cap', { ...sealed(40), ct: b64(1025) }], ['text instead of a blob', 'sealed'], ['a list', [1, 2]], ['a number', 5], ['null', null],
      ['a blob with numbers', { v: 1, iv: 5, ct: 6 }],
    ];
    for (const [label, blob] of badBlobs) {
      it(`refuses waterE as ${label}`, async () => { await assertFails(setDoc(doc(db, P.day), { ...ENC.day(), waterE: blob })); });
      it(`refuses stepsE as ${label}`, async () => { await assertFails(setDoc(doc(db, P.day), { ...ENC.day(), stepsE: blob })); });
    }
    it('refuses profileE over its cap, accepts it at the cap', async () => {
      await assertSucceeds(setDoc(doc(db, P.user), { ...ENC.user(), profileE: sealed(4096) }));
      await assertFails(setDoc(doc(db, P.user), { ...ENC.user(), profileE: sealed(4097) }));
      await assertFails(setDoc(doc(db, P.user), { ...ENC.user(), profileE: { ...sealed(), extra: 1 } }));
    });

    // ---- the verifier ----
    const badVerifiers = [
      ['fewer than 600,000 iterations', verifier({ iter: 599999 })], ['a million iterations as text', verifier({ iter: '1000000' })], ['a fractional count', verifier({ iter: 600000.5 })],
      ['more than 10,000,000 iterations', verifier({ iter: 10000001 })], ['a salt of 23 characters', verifier({ salt: b64(23) })], ['a salt of 25 characters', verifier({ salt: b64(25) })],
      ['version 2', verifier({ v: 2 })], ['an extra key', verifier({ extra: 1 }) ], ['a malformed check', verifier({ check: { v: 1 } })], ['a check that is plain text', verifier({ check: 'foodie' })],
      ['text instead of a map', 'verifier'],
    ];
    for (const [label, crypto] of badVerifiers) it(`refuses a verifier with ${label}`, async () => { await assertFails(setDoc(doc(db, P.user), { ...ENC.user(), crypto })); });
    it('accepts the verifier at its limits', async () => {
      await assertSucceeds(setDoc(doc(db, P.user), { ...ENC.user(), crypto: verifier({ iter: 10000000 }) }));
      await assertSucceeds(setDoc(doc(db, P.user), { ...ENC.user(), crypto: verifier({ iter: 600000 }) }));
    });
    it('a verifier is optional in the schema (the app writes it with the first encrypted upload)', async () => {
      const { crypto, ...without } = ENC.user();
      await assertSucceeds(setDoc(doc(db, P.user), without));
    });

    // ---- caps on the entry maps ----
    it('caps the number of encrypted entries like the plaintext ones', async () => {
      await assertSucceeds(setDoc(doc(db, P.day), { mealsE: many(100, () => entry()) }));
      await assertFails(setDoc(doc(db, P.day), { mealsE: many(101, () => entry()) }));
      await assertSucceeds(setDoc(doc(db, P.saved), { itemsE: many(300, () => entry()) }));
      await assertFails(setDoc(doc(db, P.saved), { itemsE: many(301, () => entry()) }));
      await assertSucceeds(setDoc(doc(db, P.weights), { wE: many(4000, () => sealed()) }));
      await assertFails(setDoc(doc(db, P.weights), { wE: many(4001, () => sealed()) }));
      await assertFails(setDoc(doc(db, P.user), { goalsE: many(1001, () => sealed()) }));
    });
    it('refuses unknown fields in an encrypted document, including near misses of the new names', async () => {
      for (const kind of KINDS) for (const f of ['mealsF', 'waterE2', 'ProfileE', 'crypto2', 'photo']) await assertFails(setDoc(doc(db, P[kind]), { ...ENC[kind](), [f]: 1 }));
    });

    it('the usage counter is plaintext in both phases', async () => {
      await assertSucceeds(setDoc(doc(db, P.usage), VALID.usage()));
    });

    // ---- the plaintext shape, which is what the two phases differ on ----
    if (phase === 1) {
      for (const kind of KINDS) it(`still accepts a plaintext ${kind} document (an old app version)`, async () => { await assertSucceeds(setDoc(doc(db, P[kind]), PLAIN[kind]())); });
      it('accepts both shapes in one document (a migration in progress)', async () => {
        await assertSucceeds(setDoc(doc(db, P.day), { ...VALID.day(), ...ENC.day() }));
        await assertSucceeds(setDoc(doc(db, P.user), { ...VALID.user(), ...ENC.user() }));
      });
    } else {
      for (const kind of KINDS) it(`refuses a plaintext ${kind} document`, async () => { await assertFails(setDoc(doc(db, P[kind]), PLAIN[kind]())); });
      const plainFields = { day: { meals: { a: meal('a') } }, day2: { waterMl: 100 }, day3: { steps: 100 }, user: { profile }, user2: { goals: [] }, saved: { items: { a: meal('a') } }, weights: { w: { [DAY]: 80 } } };
      for (const [name, extra] of Object.entries(plainFields)) {
        const kind = name.replace(/[0-9]/g, '');
        it(`refuses an encrypted ${kind} document that also carries plaintext (${Object.keys(extra)[0]})`, async () => { await assertFails(setDoc(doc(db, P[kind]), { ...ENC[kind](), ...extra })); });
      }
      it('refuses even an EMPTY plaintext map, so cleaning up must remove the whole field', async () => {
        await assertFails(setDoc(doc(db, P.day), { ...ENC.day(), meals: {} }));
        await assertFails(setDoc(doc(db, P.saved), { ...ENC.saved(), items: {} }));
      });
    }

    // ---- cleaning up plaintext left from before (the migration's last step) ----
    it(`${phase === 1 ? 'accepts' : 'is the only update accepted on'} a document that still holds plaintext: removing it whole`, async () => {
      await seed(env, P.day, { ...VALID.day(), ...ENC.day() });
      const ref = doc(db, P.day);
      if (phase === 2) await assertFails(updateDoc(ref, { updatedAt: 1_800_000_000_009 }));     // an unrelated edit leaves plaintext in the result
      await assertSucceeds(updateDoc(ref, { meals: deleteField(), waterMl: deleteField(), steps: deleteField(), updatedAt: 1_800_000_000_009 }));
      await assertSucceeds(updateDoc(ref, { updatedAt: 1_800_000_000_010 }));                  // clean now, in either phase
      await seed(env, P.user, { ...VALID.user(), ...ENC.user() });
      await assertSucceeds(updateDoc(doc(db, P.user), { profile: deleteField(), goals: deleteField(), updatedAt: 1_800_000_000_009 }));
      await seed(env, P.saved, { ...VALID.saved(), ...ENC.saved() });
      await assertSucceeds(updateDoc(doc(db, P.saved), { items: deleteField(), updatedAt: 1_800_000_000_009 }));
      await seed(env, P.weights, { ...VALID.weights(), ...ENC.weights() });
      await assertSucceeds(updateDoc(doc(db, P.weights), { w: deleteField(), updatedAt: 1_800_000_000_009 }));
    });
  });
}

describe('the rules file in the repository', () => {
  it('states which phase it is in', async () => {
    const { FILE_PHASE } = await import('./helpers.mjs');
    assert.ok(FILE_PHASE === 1 || FILE_PHASE === 2);
  });
});
