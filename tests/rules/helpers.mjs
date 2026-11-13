/* Shared setup for the emulator tests: a test environment loaded with the REAL firestore.rules of the repository,
   and valid documents shaped exactly like app/core/cloudmap.js writes them. */
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';

export const RULES = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
export const PROJECT = 'demo-foodie';
export const ALICE = 'alice-uid';
export const BOB = 'bob-uid';
export const DAY = '2026-11-12';

export async function createEnv() {
  return initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: RULES, host: '127.0.0.1', port: 8080 } });
}

/** Fill a document with the rules switched off (a fixture, not a test of the rules). */
export async function seed(env, path, data) {
  const { doc, setDoc } = await import('firebase/firestore');
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
}

const per100 = { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 };
export const meal = (id, extra = {}) => ({ id, name: `Comida ${id}`, slot: 'Almuerzo', source: 'db', updatedAt: 1_800_000_000_000, items: [{ name: 'Pollo', grams: 150, per100 }], ...extra });
export const profile = { sex: 'male', birthYear: 1990, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain', pace: 0.2 };

/** One valid document of each kind: what the app writes. */
export const VALID = {
  user: () => ({ profile, profileAt: 1_800_000_000_000, goals: [{ from: '2026-01-01', goals: { kcal: 2000, protein_g: 120, carbs_g: 200, fat_g: 70, waterL: 2.2, steps: 8000 } }], goalsAt: { '2026-01-01': 1_800_000_000_000 }, updatedAt: 1_800_000_000_000 }),
  day: () => ({ meals: { a: meal('a'), b: meal('b') }, deleted: { c: 1_800_000_000_000 }, waterMl: 1500, waterAt: 1_800_000_000_000, steps: 6000, stepsAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 }),
  saved: () => ({ items: { s1: meal('s1') }, deleted: { s2: 1_800_000_000_000 }, updatedAt: 1_800_000_000_000 }),
  weights: () => ({ w: { [DAY]: 79.5 }, at: { [DAY]: 1_800_000_000_000 }, updatedAt: 1_800_000_000_000 }),
};

export const pathsOf = (uid) => ({
  user: `users/${uid}`,
  day: `users/${uid}/days/${DAY}`,
  saved: `users/${uid}/meta/saved`,
  weights: `users/${uid}/meta/weights`,
});

/** n entries `{ id0: value, id1: value, ... }` */
export const many = (n, value = () => ({ x: 1 })) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, value(i)]));
