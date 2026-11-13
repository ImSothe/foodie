/* Steps are optional and typed by hand: a profile field decides whether the app shows them (Home card, plan summary, onboarding goal). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanProfile, stepsTarget } from '../app/core/goals.js';
import { mergeProfile } from '../app/core/merge.js';
import { createStore } from '../app/data/store.js';
import { createCloud } from '../app/data/cloud.js';
import { createBackend } from './helpers/fake-firebase.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { enter, FAST_CRYPTO } from './helpers/cloud-device.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const profile = { sex: 'female', birthYear: 1996, heightCm: 165, weightKg: 60, activity: 'light', goal: 'lose', pace: 0.2 };
const DAY = '2026-11-12';
const mk = (storage = memoryStorage()) => createStore(storage, { uuid: (() => { let n = 0; return () => `u${++n}`; })(), now: () => new Date(2026, 10, 12, 9, 0) });
const goalsWithSteps = (steps) => ({ kcal: 1800, protein_g: 120, carbs_g: 180, fat_g: 60, waterL: 2.2, steps });
const defaultSteps = stepsTarget('lose', 'light');

test('profile: trackSteps is kept only when it is a boolean, and older profiles are untouched', () => {
  assert.equal('trackSteps' in cleanProfile(profile), false, 'no field in, no field out');
  assert.equal(cleanProfile({ ...profile, trackSteps: true }).trackSteps, true);
  assert.equal(cleanProfile({ ...profile, trackSteps: false }).trackSteps, false);
  for (const bad of ['true', 1, 0, null, {}, [], 'yes']) assert.equal('trackSteps' in cleanProfile({ ...profile, trackSteps: bad }), false, String(bad));
  const once = cleanProfile({ ...profile, trackSteps: true });
  assert.deepEqual(cleanProfile(once), once, 'idempotent');
});

test('store: a new profile does not follow steps; the explicit choice wins over everything', () => {
  const s = mk();
  assert.equal(s.stepsTracked(), false, 'no profile yet');
  assert.equal(s.setTrackSteps(true), null, 'nothing to attach the choice to');
  s.saveProfile({ ...profile, trackSteps: false });
  s.setGoals(goalsWithSteps(defaultSteps), DAY);
  assert.equal(s.stepsTracked(), false);
  s.setSteps(DAY, 5000);
  assert.equal(s.stepsTracked(), false, 'an explicit OFF stays OFF even with steps stored');
  assert.equal(s.setTrackSteps(true), true);
  assert.equal(s.stepsTracked(), true);
  assert.equal(s.getProfile().trackSteps, true);
  assert.equal(s.setTrackSteps(false), false);
  assert.equal(s.stepsTracked(), false);
});

test('store: data from before the choice existed counts as ON when steps were used, otherwise OFF', () => {
  const plain = mk(); plain.saveProfile(profile); plain.setGoals(goalsWithSteps(defaultSteps), DAY);
  assert.equal('trackSteps' in plain.getProfile(), false);
  assert.equal(plain.stepsTracked(), false, 'never touched steps');
  const typed = mk(); typed.saveProfile(profile); typed.setGoals(goalsWithSteps(defaultSteps), DAY); typed.setSteps(DAY, 6400);
  assert.equal(typed.stepsTracked(), true, 'has steps on some day');
  const zero = mk(); zero.saveProfile(profile); zero.setGoals(goalsWithSteps(defaultSteps), DAY); zero.setSteps(DAY, 0);
  assert.equal(zero.stepsTracked(), false, 'a zero is not use');
  const goal = mk(); goal.saveProfile(profile); goal.setGoals(goalsWithSteps(defaultSteps + 4000), DAY);
  assert.equal(goal.stepsTracked(), true, 'the steps goal was changed by the person');
});

test('store: the choice survives a reload, is stamped for sync, and is cleared with the data', () => {
  const storage = memoryStorage();
  const s = mk(storage);
  s.saveProfile(profile);
  const before = s.getSyncState().profileAt;
  s.setTrackSteps(true);
  assert.ok(s.getSyncState().profileAt > before, 'the profile edit time moves, so the merge sees it');
  assert.equal(mk(storage).stepsTracked(), true);
  s.clearAll();
  assert.equal(s.stepsTracked(), false);
});

test('merge: the newer profile carries its choice', () => {
  const a = cleanProfile({ ...profile, trackSteps: false });
  const b = cleanProfile({ ...profile, trackSteps: true });
  assert.equal(mergeProfile(a, 100, b, 200, 1e12).profile.trackSteps, true);
  assert.equal(mergeProfile(a, 300, b, 200, 1e12).profile.trackSteps, false);
  assert.equal(mergeProfile(b, 200, a, 100, 1e12).profile.trackSteps, true, 'same either way round');
});

test('cloud: turning steps on at one phone reaches the other, and old documents without the field still load', async () => {
  const backend = createBackend(); const clock = { t: new Date(2026, 10, 12, 10, 0).getTime() };
  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
  const phone = (name) => {
    let n = 0; const uid = { current: null, next: 'alice' };
    const store = createStore(memoryStorage(), { uuid: () => `${name}-${++n}`, now: () => new Date(clock.t) });
    const cloud = createCloud({ store, loadSdk: async () => backend.sdk(uid), now: () => clock.t, win: null, doc: null, ...FAST_CRYPTO });
    return { store, async signIn() { await cloud.signIn(); await tick(); await enter(cloud); }, async sync() { clock.t += 1000; await cloud.syncNow(); while (cloud.status === 'syncing') await tick(5); } };
  };
  const a = phone('a'); const b = phone('b');
  await a.signIn(); await b.signIn();
  a.store.saveProfile({ ...profile, trackSteps: false });
  await a.sync(); await b.sync();
  assert.equal(b.store.stepsTracked(), false);
  a.store.setTrackSteps(true);
  await a.sync(); await b.sync();
  assert.equal(b.store.stepsTracked(), true);
  assert.equal('profile' in backend.docs.get('users/alice'), false, 'the profile is sealed in the cloud');
  // an older copy of the app writes a plaintext profile without the field, later than ours: it wins like any newer edit
  backend.docs.set('users/alice', { ...backend.docs.get('users/alice'), profile, profileAt: clock.t + 5000 });
  await b.sync();
  assert.equal('trackSteps' in b.store.getProfile(), false);
});

test('static: OFF hides the Home card, the steps line of the plan summary and the steps goal of the plan screen', () => {
  const home = read('../app/ui/screens/home.js');
  assert.match(home, /store\.stepsTracked\(\) \? stepsCard\(/);
  assert.equal([...home.matchAll(/(?<!function )stepsCard\(\{ store/g)].length, 1, 'the card is built in one place only, behind the check');
  const settings = read('../app/ui/screens/settings.js');
  assert.match(settings, /tracking \? ` y \$\{fmtNum\(g\.steps\)\} pasos` : ''/);
  assert.match(settings, /Seguir mis pasos/);
  assert.match(settings, /no puede leer la app Salud de Apple ni Health Connect/);
  const onboarding = read('../app/ui/screens/onboarding.js');
  assert.match(onboarding, /tracking \? fields\.steps\.el : null/);
  assert.match(onboarding, /const tracking = edit \? store\.stepsTracked\(\) : false;/, 'a new profile starts with steps off');
});

test('static: the docs say plainly that steps are manual and optional, and claim nothing about reading them from the phone', () => {
  const readme = read('../README.md');
  assert.match(readme, /Steps are optional and typed by hand/);
  assert.match(readme, /no access to Apple Health or Health Connect/);
  assert.doesNotMatch(readme, /steps (are |is )?(read|synced|imported) (automatically|from (the )?(phone|Apple|Health))/i);
});
