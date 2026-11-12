/* Static checks on firestore.rules. These read the rules as text: they catch a rule that was opened up or a validation that
   was dropped, but they do NOT run the rules. Running them needs the Firestore emulator (see SECURITY.md, "Planned"). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.equal(writes.length, 4, 'user, day, saved and weights documents');
  const validators = writes.map((s) => (s.cond.match(/valid(User|Day|Saved|Weights)\(request\.resource\.data\)/) || [])[1]);
  assert.deepEqual(validators.sort(), ['Day', 'Saved', 'User', 'Weights']);
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
  assert.equal([...rules.matchAll(/d\.keys\(\)\.hasOnly\(/g)].length, 4);
});

test('rules: only the known paths', () => {
  const paths = [...rules.matchAll(/match\s+(\/[^\s{]*(?:\{[^}]+\}[^\s{]*)*)\s*\{/g)].map((m) => m[1]).sort();
  assert.deepEqual(paths, ['/databases/{database}/documents', '/days/{iso}', '/meta/saved', '/meta/weights', '/users/{uid}', '/{document=**}'].sort());
});

test('rules: reads and deletes never look at request.resource (it is null there)', () => {
  const noPayload = statements.filter((s) => !s.ops.some((o) => ['create', 'update', 'write'].includes(o)));
  assert.ok(noPayload.length >= 7);
  for (const s of noPayload) assert.doesNotMatch(s.cond, /request\.resource/, s.ops.join(','));
});
