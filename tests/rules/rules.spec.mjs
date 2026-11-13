/* firestore.rules against the real Firestore emulator: who can read and write what, and what each validator accepts and refuses.
   (tests/rules.test.js, in the default suite, only reads the rules as text; this file executes them.) */
import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after } from 'node:test';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, collectionGroup, query, where, deleteField, writeBatch,
} from 'firebase/firestore';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { createEnv, seed, VALID, pathsOf, ALICE, BOB, DAY, meal, many, profile } from './helpers.mjs';

let env; let aliceDb; let bobDb; let anonDb;
before(async () => {
  env = await createEnv();
  aliceDb = env.authenticatedContext(ALICE).firestore();       // one instance per user: a batch cannot mix instances
  bobDb = env.authenticatedContext(BOB).firestore();
  anonDb = env.unauthenticatedContext().firestore();
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const alice = () => aliceDb;
const bob = () => bobDb;
const anon = () => anonDb;
const P = pathsOf(ALICE);
const KINDS = Object.keys(VALID);

describe('owner', () => {
  for (const kind of KINDS) {
    it(`can create, read, update and delete their ${kind} document`, async () => {
      const ref = doc(alice(), P[kind]);
      await assertSucceeds(setDoc(ref, VALID[kind]()));
      await assertSucceeds(getDoc(ref));
      await assertSucceeds(setDoc(ref, { updatedAt: 1_800_000_000_001 }, { merge: true }));
      await assertSucceeds(updateDoc(ref, { updatedAt: 1_800_000_000_002 }));
      await assertSucceeds(deleteDoc(ref));
    });
  }

  it('can list their own days, with the incremental query the sync uses', async () => {
    await seed(env, P.day, VALID.day());
    await assertSucceeds(getDocs(collection(alice(), 'users', ALICE, 'days')));
    await assertSucceeds(getDocs(query(collection(alice(), 'users', ALICE, 'days'), where('updatedAt', '>', 1))));
  });

  it('can write many documents in one batch (what a sync does)', async () => {
    const batch = writeBatch(alice());
    batch.set(doc(alice(), P.user), VALID.user(), { merge: true });
    batch.set(doc(alice(), P.saved), VALID.saved(), { merge: true });
    batch.set(doc(alice(), P.weights), VALID.weights(), { merge: true });
    for (let d = 1; d <= 28; d += 1) batch.set(doc(alice(), `users/${ALICE}/days/2026-10-${String(d).padStart(2, '0')}`), VALID.day(), { merge: true });
    await assertSucceeds(batch.commit());
  });

  it('a batch with one bad document is refused as a whole', async () => {
    const batch = writeBatch(alice());
    batch.set(doc(alice(), P.saved), VALID.saved(), { merge: true });
    batch.set(doc(alice(), P.day), { ...VALID.day(), hacked: true }, { merge: true });
    await assertFails(batch.commit());
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(doc(ctx.firestore(), P.saved));
      if (snap.exists()) throw new Error('the valid half of a refused batch was written');
    });
  });

  it('cannot list the users collection or every day of every user (collection group)', async () => {
    await seed(env, P.day, VALID.day());
    await assertFails(getDocs(collection(alice(), 'users')));
    await assertFails(getDocs(collectionGroup(alice(), 'days')));
    await assertFails(getDocs(collectionGroup(alice(), 'meta')));
  });
});

describe('another signed-in user', () => {
  for (const kind of KINDS) {
    it(`cannot read, write, merge or delete the ${kind} document of someone else`, async () => {
      await seed(env, P[kind], VALID[kind]());
      const ref = doc(bob(), P[kind]);
      await assertFails(getDoc(ref));
      await assertFails(setDoc(ref, VALID[kind]()));
      await assertFails(setDoc(ref, { updatedAt: 5 }, { merge: true }));
      await assertFails(updateDoc(ref, { updatedAt: 5 }));
      await assertFails(deleteDoc(ref));
    });
    it(`cannot create the ${kind} document of someone who has none yet`, async () => {
      await assertFails(setDoc(doc(bob(), P[kind]), VALID[kind]()));
    });
  }

  it('cannot list the days of someone else, whatever the query', async () => {
    await seed(env, P.day, VALID.day());
    await assertFails(getDocs(collection(bob(), 'users', ALICE, 'days')));
    await assertFails(getDocs(query(collection(bob(), 'users', ALICE, 'days'), where('updatedAt', '>', 0))));
    await assertFails(getDocs(collectionGroup(bob(), 'days')));
  });

  it('keeps working on their own data at the same time', async () => {
    await assertSucceeds(setDoc(doc(bob(), pathsOf(BOB).day), VALID.day()));
    await assertFails(getDoc(doc(bob(), P.day)));
  });

  it('cannot smuggle a write to someone else inside their own batch', async () => {
    const batch = writeBatch(bob());
    batch.set(doc(bob(), pathsOf(BOB).saved), VALID.saved());
    batch.set(doc(bob(), P.saved), VALID.saved());
    await assertFails(batch.commit());
  });
});

describe('not signed in', () => {
  for (const kind of KINDS) {
    it(`cannot read, write or delete the ${kind} document`, async () => {
      await seed(env, P[kind], VALID[kind]());
      const ref = doc(anon(), P[kind]);
      await assertFails(getDoc(ref));
      await assertFails(setDoc(ref, VALID[kind]()));
      await assertFails(updateDoc(ref, { updatedAt: 5 }));
      await assertFails(deleteDoc(ref));
    });
  }
  it('cannot list days, users or collection groups', async () => {
    await seed(env, P.day, VALID.day());
    await assertFails(getDocs(collection(anon(), 'users', ALICE, 'days')));
    await assertFails(getDocs(collection(anon(), 'users')));
    await assertFails(getDocs(collectionGroup(anon(), 'days')));
  });
});

describe('unknown paths are closed to everyone, the owner included', () => {
  const unknown = [
    'users/alice-uid/other/x', 'users/alice-uid/meta/other', 'users/alice-uid/meta/saved/sub/x', 'users/alice-uid/days/2026-11-12/sub/x',
    'users/alice-uid/photos/p1', 'public/x', 'foo/bar', 'users/alice-uid/meta/usage-typo', 'config/app', 'admins/alice-uid',
  ];
  for (const path of unknown) {
    it(`${path}`, async () => {
      for (const db of [alice(), bob(), anon()]) {
        await assertFails(setDoc(doc(db, path), { updatedAt: 1 }));
        await assertFails(getDoc(doc(db, path)));
      }
      await seed(env, path, { updatedAt: 1 });
      await assertFails(getDoc(doc(alice(), path)));
      await assertFails(deleteDoc(doc(alice(), path)));
    });
  }
  it('a day id must look like a date', async () => {
    for (const id of ['x', '2026-11-1', '2026-1-12', '20261112', '2026-11-12-', ' 2026-11-12', '2026-11-12x', '../meta', '']) {
      if (id === '') continue;                                  // an empty segment is not a path
      await assertFails(setDoc(doc(alice(), `users/${ALICE}/days/${encodeURIComponent(id)}`), VALID.day()));
    }
    await assertSucceeds(setDoc(doc(alice(), `users/${ALICE}/days/2026-11-12`), VALID.day()));
    // shape only: the rules do not know the calendar (the app's cleaners reject 2026-13-45 on every read)
    await assertSucceeds(setDoc(doc(alice(), `users/${ALICE}/days/2026-13-45`), VALID.day()));
  });
});

/* ---- validators: every limit of every document, at the edge and one past it ---- */
const okDay = (extra) => ({ ...VALID.day(), ...extra });
const cases = {
  user: [
    ['a profile that is a map', { profile: { sex: 'x' } }, true],
    ['a profile with the optional steps choice (trackSteps)', { profile: { ...profile, trackSteps: true } }, true],
    ['an old profile without trackSteps', { profile }, true],
    ['a profile that is not a map', { profile: 'text' }, false],
    ['a profile that is a list', { profile: [1] }, false],
    ['goals: a list of 1,000', { goals: Array.from({ length: 1000 }, () => ({ from: '2026-01-01' })) }, true],
    ['goals: 1,001 entries', { goals: Array.from({ length: 1001 }, () => ({ from: '2026-01-01' })) }, false],
    ['goals that are a map', { goals: { a: 1 } }, false],
    ['goalsAt with 1,000 entries', { goalsAt: many(1000, () => 5) }, true],
    ['goalsAt with 1,001 entries', { goalsAt: many(1001, () => 5) }, false],
    ['goalsAt that is a list', { goalsAt: [1] }, false],
    ['profileAt 0', { profileAt: 0 }, true],
    ['profileAt negative', { profileAt: -1 }, false],
    ['profileAt in year 3000', { profileAt: 32503680000000 }, true],
    ['profileAt past year 3000', { profileAt: 32503680000001 }, false],
    ['profileAt as text', { profileAt: '5' }, false],
    ['profileAt NaN', { profileAt: NaN }, false],
    ['profileAt Infinity', { profileAt: Infinity }, false],
    ['updatedAt null', { updatedAt: null }, false],
    ['an unknown field', { admin: true }, false],
    ['a field with a near-miss name', { Profile: {} }, false],
  ],
  day: [
    ['100 meals', { meals: many(100) }, true],
    ['101 meals', { meals: many(101) }, false],
    ['meals that are a list', { meals: [meal('a')] }, false],
    ['meals as text', { meals: 'x' }, false],
    ['500 tombstones', { deleted: many(500, () => 5) }, true],
    ['501 tombstones', { deleted: many(501, () => 5) }, false],
    ['waterMl 0', { waterMl: 0 }, true],
    ['waterMl 20000', { waterMl: 20000 }, true],
    ['waterMl 20001', { waterMl: 20001 }, false],
    ['waterMl -1', { waterMl: -1 }, false],
    ['waterMl as text', { waterMl: '1500' }, false],
    ['waterMl NaN', { waterMl: NaN }, false],
    ['steps 200000', { steps: 200000 }, true],
    ['steps 200001', { steps: 200001 }, false],
    ['steps -1', { steps: -1 }, false],
    ['steps true', { steps: true }, false],
    ['waterAt past year 3000', { waterAt: 32503680000001 }, false],
    ['stepsAt negative', { stepsAt: -5 }, false],
    ['updatedAt as a map', { updatedAt: {} }, false],
    ['an unknown field', { photo: 'data:...' }, false],
  ],
  saved: [
    ['300 favourites', { items: many(300) }, true],
    ['301 favourites', { items: many(301) }, false],
    ['items as a list', { items: [] }, false],
    ['500 tombstones', { deleted: many(500, () => 5) }, true],
    ['501 tombstones', { deleted: many(501, () => 5) }, false],
    ['updatedAt negative', { updatedAt: -1 }, false],
    ['an unknown field', { extra: 1 }, false],
  ],
  usage: [
    ['10 photos today', { photos: 10 }, true],
    ['0 photos', { photos: 0 }, true],
    ['1,000 photos (the cap)', { photos: 1000 }, true],
    ['1,001 photos', { photos: 1001 }, false],
    ['-1 photos', { photos: -1 }, false],
    ['2.5 photos', { photos: 2.5 }, false],
    ['photos as text', { photos: '3' }, false],
    ['photos NaN', { photos: NaN }, false],
    ['a day that looks like a date', { day: '2027-01-31' }, true],
    ['a day that is not a date', { day: 'today' }, false],
    ['a day with trailing text', { day: '2026-11-12 x' }, false],
    ['a day that is a number', { day: 20261112 }, false],
    ['updatedAt past year 3000', { updatedAt: 32503680000001 }, false],
    ['an unknown field', { extra: 1 }, false],
  ],
  weights: [
    ['4,000 weights', { w: many(4000, () => 80), at: many(4000, () => 5) }, true],
    ['4,001 weights', { w: many(4001, () => 80) }, false],
    ['4,001 weight stamps', { at: many(4001, () => 5) }, false],
    ['w as a list', { w: [80] }, false],
    ['at as text', { at: 'x' }, false],
    ['updatedAt past year 3000', { updatedAt: 32503680000001 }, false],
    ['an unknown field', { extra: 1 }, false],
  ],
};
// the day cases are merged onto a valid day, the others onto their own valid document
describe('validators', () => {
  for (const kind of KINDS) {
    for (const [label, patch, ok] of cases[kind]) {
      it(`${kind}: ${label} is ${ok ? 'accepted' : 'refused'}`, async () => {
        const data = { ...VALID[kind](), ...patch };
        await (ok ? assertSucceeds : assertFails)(setDoc(doc(alice(), P[kind]), data));
      });
    }
  }

  it('a usage document without its day or its photos is refused', async () => {
    await assertFails(setDoc(doc(alice(), P.usage), { photos: 3 }));
    await assertFails(setDoc(doc(alice(), P.usage), { day: DAY }));
    await assertFails(setDoc(doc(alice(), P.usage), {}));
  });

  it('an empty day document is valid (every field is optional), but not one with only unknown fields', async () => {
    await assertSucceeds(setDoc(doc(alice(), P.day), {}));
    await assertFails(setDoc(doc(alice(), P.day), { nope: 1 }));
  });

  it('an update is judged on the document that RESULTS from the merge, not on the patch', async () => {
    await seed(env, P.day, { ...VALID.day(), meals: many(100) });
    const ref = doc(alice(), P.day);
    // the patch adds one meal: the patch alone is tiny, the result has 101 meals
    await assertFails(setDoc(ref, { meals: { extra: meal('extra') } }, { merge: true }));
    await assertFails(updateDoc(ref, { 'meals.extra': meal('extra') }));
    // replacing an existing one stays at 100
    await assertSucceeds(setDoc(ref, { meals: { k0: meal('k0') } }, { merge: true }));
    // removing one with deleteField (what a deletion does) and adding another keeps it legal
    await assertSucceeds(setDoc(ref, { meals: { k1: deleteField(), extra: meal('extra') } }, { merge: true }));
  });

  it('a merge that adds an unknown field to an existing valid document is refused', async () => {
    await seed(env, P.day, VALID.day());
    await assertFails(setDoc(doc(alice(), P.day), { hacked: 1 }, { merge: true }));
    await assertFails(updateDoc(doc(alice(), P.day), { hacked: 1 }));
  });

  it('deleteField on a field removes it and the result is still valid', async () => {
    await seed(env, P.day, VALID.day());
    await assertSucceeds(updateDoc(doc(alice(), P.day), { waterMl: deleteField(), waterAt: deleteField() }));
  });

  it('what the rules deliberately do NOT look at: the inside of a meal (the app cleaners do)', async () => {
    // documented limit (SECURITY.md): a user can store anything in their OWN meals map, up to the entry cap and Firestore's 1 MiB.
    await assertSucceeds(setDoc(doc(alice(), P.day), { meals: { whatever: { not: 'a meal', n: [1, 2, 3] } } }));
  });

  it('Firestore itself refuses a day document over 1 MiB, whatever the rules say', async () => {
    const big = 'A'.repeat(20 * 1024);
    await assert.rejects(setDoc(doc(alice(), P.day), { meals: many(60, (i) => ({ id: `m${i}`, thumb: big })) }), /maximum entity size is 1048576 bytes/);
  });

  it('a day of 20 full-size thumbnails (the app cap) fits', async () => {
    const thumb = `data:image/jpeg;base64,${'A'.repeat(12 * 1024 - 23)}`;
    await assertSucceeds(setDoc(doc(alice(), P.day), { meals: many(100, (i) => meal(`m${i}`, i < 20 ? { thumb } : {})) }));
  });
});
