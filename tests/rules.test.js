/* Static checks on firestore.rules, in the default suite (no Java, no network). They read the rules as text: they catch a rule that was
   opened up or a validation that was dropped, but they do NOT run the rules.
   The rules ARE executed, against the real Firestore emulator, by tests/rules/ (npm run test:rules; CI job "rules"): who can read and write
   what, every validator at its limits, and the real patches of app/core/cloudmap.js replayed from two devices. That tooling is kept out of
   the app and out of this suite; the last test below only guards how it is installed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rules = readFileSync(fileURLToPath(new URL('../firestore.rules', import.meta.url)), 'utf8').replace(/\/\/.*$/gm, '');
const statements = [...rules.matchAll(/allow\s+([a-z, ]+):\s*if\s+([^;]+);/g)].map((m) => ({ ops: m[1].split(',').map((o) => o.trim()), cond: m[2].trim() }));
const guarded = statements.filter((s) => s.cond !== 'false');

test('rules: version 2 and Cloud Firestore service', () => {
  assert.match(rules, /rules_version\s*=\s*'2';/);
  assert.match(rules, /service\s+cloud\.firestore/);
});

test('rules: deny by default', () => {
  assert.match(rules, /match\s+\/\{document=\*\*\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;\s*\}/);
  assert.equal(statements.filter((s) => s.cond === 'false').length, 1, 'exactly one deny-all statement');
});

test('rules: nothing is ever open', () => {
  assert.doesNotMatch(rules, /if\s+true/);
  assert.ok(guarded.every((s) => s.cond !== 'request.auth != null'), 'being signed in is not enough');
});

test('rules: every allow outside the final deny-all calls isOwner(uid)', () => {
  assert.ok(guarded.length >= 10, `expected at least 10 guarded statements, found ${guarded.length}`);
  for (const s of guarded) assert.match(s.cond, /isOwner\(uid\)/, `${s.ops.join(',')}: ${s.cond}`);
});

test('rules: isOwner compares the signed-in uid with the path uid', () => {
  assert.match(rules, /request\.auth\s*!=\s*null\s*&&\s*request\.auth\.uid\s*==\s*uid/);
});

test('rules: every create and update validates the document', () => {
  const writes = guarded.filter((s) => s.ops.some((o) => ['create', 'update', 'write'].includes(o)));
  assert.equal(writes.length, 5, 'user, day, saved, weights and usage documents');
  const validators = writes.map((s) => (s.cond.match(/valid(User|Day|Saved|Weights|Usage)\(request\.resource\.data\)/) || [])[1]);
  assert.deepEqual(validators.sort(), ['Day', 'Saved', 'Usage', 'User', 'Weights']);
});

test('rules: a day document id must be a date', () => {
  assert.match(rules, /iso\.matches\('\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$'\)/);
});

test('rules: caps are present', () => {
  for (const cap of ["optMap(d, 'meals', 100)", "optMap(d, 'items', 300)", "optMap(d, 'w', 4000)", "optNumber(d, 'waterMl', 0, 20000)", "optNumber(d, 'steps', 0, 200000)"]) {
    assert.ok(rules.includes(cap), `missing ${cap}`);
  }
});

test('rules: every document type lists its keys, so unknown fields are refused', () => {
  assert.equal([...rules.matchAll(/d\.keys\(\)\.hasOnly\(/g)].length, 5);
});

test('rules: only the known paths', () => {
  const paths = [...rules.matchAll(/match\s+(\/[^\s{]*(?:\{[^}]+\}[^\s{]*)*)\s*\{/g)].map((m) => m[1]).sort();
  assert.deepEqual(paths, ['/databases/{database}/documents', '/days/{iso}', '/meta/saved', '/meta/usage', '/meta/weights', '/users/{uid}', '/{document=**}'].sort());
});

test('rules: reads and deletes never look at request.resource (it is null there)', () => {
  const noPayload = statements.filter((s) => !s.ops.some((o) => ['create', 'update', 'write'].includes(o)));
  assert.ok(noPayload.length >= 7);
  for (const s of noPayload) assert.doesNotMatch(s.cond, /request\.resource/, s.ops.join(','));
});

test('the emulator tooling stays in tests/rules/: pinned exactly, locked, and absent from the app and the root package', () => {
  const root = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(root.dependencies, undefined);
  assert.equal(root.devDependencies, undefined);
  assert.equal(root.scripts.test, 'node --test', 'the default suite does not start an emulator');
  assert.match(root.scripts['test:rules'], /tests[/]rules/);
  const dir = new URL('./rules/', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
  assert.equal(pkg.private, true);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@firebase/rules-unit-testing', 'firebase', 'firebase-tools']);
  for (const [name, version] of Object.entries(pkg.devDependencies)) assert.match(version, /^[0-9]+[.][0-9]+[.][0-9]+$/, `${name} must be pinned to an exact version`);
  assert.equal(pkg.dependencies, undefined);
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', dir), 'utf8'));
  assert.equal(lock.lockfileVersion >= 3, true);
  for (const [name, version] of Object.entries(pkg.devDependencies)) assert.equal(lock.packages[`node_modules/${name}`].version, version, `lockfile has ${name}@${version}`);
  assert.ok(existsSync(new URL('rules.spec.mjs', dir)) && existsSync(new URL('replay.spec.mjs', dir)));
});

test('rules: the encryption rollout is explicit: one literal switch, phase 1 until every phone has the encrypting app', () => {
  const flags = [...rules.matchAll(/function plaintextAllowed\(\)\s*\{\s*return\s+(true|false);\s*\}/g)];
  assert.equal(flags.length, 1, 'exactly one plaintextAllowed() with a literal answer');
  assert.equal(flags[0][1], 'true', 'PHASE 1 (plaintext and encrypted documents accepted). Phase 2 is the commit that flips this to false, published only after the friends updated.');
  assert.equal([...rules.matchAll(/plaintextAllowed\(\)/g)].length, 5, 'declared once and used by the four document validators');
});

test('rules: encrypted shapes are validated (sealed blobs, the verifier, caps), and the verifier cannot ask for fewer than 600,000 iterations', () => {
  assert.match(rules, /function isSealed\(b, maxCt\)/);
  assert.match(rules, /b\.iv\.size\(\)\s*==\s*16/);
  assert.match(rules, /c\.iter is int && c\.iter >= 600000/);
  for (const cap of ["optMap(d, 'mealsE', 100)", "optMap(d, 'itemsE', 300)", "optMap(d, 'wE', 4000)", "optMap(d, 'goalsE', 1000)", "optSealed(d, 'waterE', 1024)", "optSealed(d, 'profileE', 4096)"]) assert.ok(rules.includes(cap), cap);
});
