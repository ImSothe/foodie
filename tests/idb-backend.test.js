/* Runs every test that uses the shared storage helper again, with the helper handing out the REAL IndexedDB-backed storage layer
   (write-behind cache, lazy serialization, size guards) instead of a Map. The store, hostile-data, fuzzing, cloud-sync and cache tests are
   the unchanged ones: if the new backend changed any behaviour the store can see, one of them fails here.
   (The database behind the layer is never reached in this mode; tests/idb-storage.test.js covers the database itself with a fake IndexedDB.) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js') && f !== 'idb-backend.test.js' && /memory-storage\.js/.test(readFileSync(join(dir, f), 'utf8')));

test('the tests that use the storage helper are found', () => {
  assert.ok(files.length >= 4, files.join(', '));
  for (const f of ['store.test.js', 'security.test.js']) assert.ok(files.includes(f), f);
});

// The reporter is named on purpose: the default one depends on the Node version and on whether stdout is a terminal (TAP on Node 22 in CI,
// spec locally on Node 26), and this test reads the spec summary lines.
for (const f of files) {
  test(`${f} passes unchanged against the IndexedDB storage layer`, () => {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', join(dir, f)], { env: { ...process.env, FOODIE_BACKEND: 'idb', NODE_TEST_CONTEXT: undefined }, encoding: 'utf8' });
    const summary = (r.stdout.match(/^ℹ (tests|pass|fail) \d+$/gm) || []).join(', ');
    assert.equal(r.status, 0, `${f} failed with the IndexedDB backend (${summary})\n${r.stdout.split('\n').filter((l) => /^✖/.test(l)).join('\n')}`);
    assert.match(r.stdout, /ℹ fail 0/);
  });
}
