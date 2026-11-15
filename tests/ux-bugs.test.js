/* Regression tests for two bugs reported from a real iPhone:
   1. the photo flow said "sign in" to somebody who was signed in (the session was still being restored when the check ran);
   2. messages shown while a sheet or the camera was open were invisible (a modal <dialog> hides everything outside it). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore } from '../app/data/store.js';
import { createCloud } from '../app/data/cloud.js';
import { createVision } from '../app/data/vision.js';
import { toastParent } from '../app/ui/dom.js';
import { createBackend } from './helpers/fake-firebase.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { FAST_CRYPTO } from './helpers/cloud-device.js';
import { memoryUsage } from './helpers/usage.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A cloud whose SDK reports the restored session late, like Firebase does when the page has just started. */
function lateCloud({ delayMs, restored }) {
  const backend = createBackend();
  const uid = { current: restored ? 'alice' : null, next: 'alice' };
  let reported = false;
  const loadSdk = async () => {
    const sdk = backend.sdk(uid);
    sdk.onAuthStateChanged = (auth, cb) => setTimeout(() => { reported = true; cb(uid.current ? { uid: uid.current, displayName: 'Test', email: 'test@example.invalid' } : null); }, delayMs);
    return sdk;
  };
  const store = createStore(memoryStorage(), { uuid: () => 'x', now: () => new Date(1_800_000_000_000) });
  const cloud = createCloud({ store, loadSdk, now: () => 1_800_000_000_000, win: null, doc: null, ...FAST_CRYPTO });
  return { cloud, reported: () => reported };
}

test('cloud.whenSettled: waits for the restored session, and cloud.user is there afterwards', async () => {
  const { cloud } = lateCloud({ delayMs: 40, restored: true });
  assert.equal(cloud.user, null, 'before the SDK reports, nobody is known');
  assert.equal(await cloud.whenSettled(2000), true);
  assert.equal(cloud.user.uid, 'alice');
});

test('cloud.whenSettled: nobody signed in is also an answer (true), and a second call is immediate', async () => {
  const { cloud } = lateCloud({ delayMs: 10, restored: false });
  assert.equal(await cloud.whenSettled(2000), true);
  assert.equal(cloud.user, null);
  assert.equal(await cloud.whenSettled(1), true);
});

test('cloud.whenSettled: gives up after the timeout (false) instead of hanging', async () => {
  const { cloud, reported } = lateCloud({ delayMs: 500, restored: true });
  assert.equal(await cloud.whenSettled(30), false);
  assert.equal(reported(), false);
});

test('cloud.whenSettled: an SDK that cannot load resolves false, never rejects', async () => {
  const store = createStore(memoryStorage(), { uuid: () => 'x', now: () => new Date(1_800_000_000_000) });
  const cloud = createCloud({ store, loadSdk: async () => { throw new Error('offline'); }, now: () => 1, win: null, doc: null, ...FAST_CRYPTO });
  assert.equal(await cloud.whenSettled(30), false);
});

function visionWith(cloud) {
  cloud.firebase ||= async () => assert.fail('the model must not be reached in these tests');   // not copied with a spread: `user` is a live getter
  const jpeg = { type: 'image/jpeg' };
  return createVision({
    cloud, appCheckSiteKey: 'site-key', now: () => 1_000_000,
    compress: async () => ({ blob: jpeg, width: 1, height: 1 }), toBase64: async () => 'QUJD', delay: async () => {},
    win: { location: { hostname: 'imsothe.github.io' }, navigator: { onLine: true } }, usage: memoryUsage(),
  });
}

test('analyze: a session that is still being restored is waited for, not reported as "signed-out"', async () => {
  let user = null;
  const waited = [];
  const vision = visionWith({
    get user() { return user; },
    async whenSettled() { waited.push(true); await tick(); user = null; return true; },       // the SDK settled: really nobody
  });
  assert.deepEqual(await vision.analyze({}), { ok: false, reason: 'signed-out' });
  assert.equal(waited.length, 1, 'it asked the cloud once before deciding');
});

test('analyze: when the wait ends with a person signed in, it goes on (it does not say "signed-out")', async () => {
  let user = null;
  const vision = visionWith({
    get user() { return user; },
    async whenSettled() { await tick(); user = { uid: 'alice' }; return true; },
    firebase: async () => { throw Object.assign(new Error('stop here'), { code: 'test-stop' }); },
  });
  const r = await vision.analyze({});
  assert.notEqual(r.reason, 'signed-out');
});

test('analyze: if the session cannot be checked (no connection), the answer is "offline", not "sign in"', async () => {
  const vision = visionWith({ user: null, async whenSettled() { return false; } });
  assert.deepEqual(await vision.analyze({}), { ok: false, reason: 'offline' });
});

test('toastParent: the toast host lives in the topmost open dialog, else in the page', () => {
  const body = { name: 'body' };
  const dlg = (name) => ({ name });
  assert.equal(toastParent({ body, querySelectorAll: () => [] }), body);
  const a = dlg('a'); const b = dlg('b');
  assert.equal(toastParent({ body, querySelectorAll: (sel) => { assert.equal(sel, 'dialog[open]'); return [a]; } }), a);
  assert.equal(toastParent({ body, querySelectorAll: () => [a, b] }), b, 'a dialog opened over another one wins');
});

test('the toast code keeps the host reachable: it moves into the open dialog and back to the page when that dialog closes', () => {
  const src = readFileSync(fileURLToPath(new URL('../app/ui/dom.js', import.meta.url)), 'utf8');
  assert.match(src, /toastParent\(document\)/);
  assert.match(src, /document\.addEventListener\('close'[\s\S]{0,300}document\.body\.append\(toastHost\)[\s\S]{0,40}true\)/, 'on close (capture phase) the host returns to the body before the dialog is removed');
});

test('the ring turns only its own circle: an icon in the middle (the water drop) is not rotated with it', () => {
  const css = readFileSync(fileURLToPath(new URL('../app/css/components.css', import.meta.url)), 'utf8');
  assert.doesNotMatch(css, /\.ring\s+svg\s*\{[^}]*rotate/, '".ring svg" would also rotate the icon in .ring-center (the tilted drop)');
  assert.match(css, /\.ring\s*>\s*svg\s*\{[^}]*rotate\(-90deg\)/);
});

test('every icon the Home screen names exists in the icon set', () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  const icons = read('../app/ui/icons.js');
  const home = read('../app/ui/screens/home.js');
  const names = [...home.matchAll(/icon: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['meat', 'oil', 'pasta']);
  for (const n of [...names, 'drop']) assert.match(icons, new RegExp(`\n  ${n}: [[]`), `icon "${n}" is drawn`);
});
