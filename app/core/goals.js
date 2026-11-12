/* foodie · goals engine (pure logic, no DOM, no storage).
   From a profile it estimates daily calories, macros, water and steps. Every number is an estimate from
   standard formulas (Mifflin-St Jeor for energy), not medical advice: the UI says so and lets the user edit them. */
import { NUTRIENTS } from './nutrition.js';

export const SEXES = ['male', 'female'];
export const ACTIVITY_FACTOR = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
export const ACTIVITIES = Object.keys(ACTIVITY_FACTOR);
export const GOALS = ['lose', 'maintain', 'gain'];

/** Calorie change per goal, as a share of maintenance. The second list entry of lose/gain is the default. */
export const PACES = { lose: [0.10, 0.20, 0.25], maintain: [], gain: [0.05, 0.10, 0.15] };
export const DEFAULT_PACE = { lose: 0.20, maintain: null, gain: 0.10 };

export const LIMITS = { age: [14, 100], heightCm: [120, 230], weightKg: [30, 300] };

const PROTEIN_G_PER_KG = { lose: 2.0, maintain: 1.6, gain: 1.8 };
const FAT_G_PER_KG = 0.9;
const MIN_FAT_SHARE = 0.20;
const MAX_FAT_SHARE = 0.35;      // keeps carbs from vanishing for heavy people, where g/kg overshoots
const MAX_PROTEIN_SHARE = 0.35;  // same reason: g per kg of total weight overshoots at high body weight
const KCAL_FLOOR = { male: 1500, female: 1200 };
const BMR_FLOOR_FACTOR = 1.05;
const WATER_L_PER_KG = 0.033;
const WATER_BONUS_L = { sedentary: 0, light: 0.25, moderate: 0.5, active: 0.75, very_active: 1.0 };
const WATER_RANGE_L = [1.5, 4.0];
const STEPS_BASE = { lose: 10000, maintain: 8000, gain: 7000 };

/** Where reference intakes differ by sex (EFSA dietary reference values), overriding the label values in NUTRIENTS. */
const SEX_TARGETS = {
  male: { iron_mg: 11, magnesium_mg: 350, vit_a_ug: 750, vit_c_mg: 110 },
  female: { iron_mg: 16, magnesium_mg: 300, vit_a_ug: 650, vit_c_mg: 95 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** Number from a number or a typed string ("72,5" works). Anything else is null. */
export function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const inRange = (v, [lo, hi]) => v !== null && v >= lo && v <= hi;

/** Age in whole years in `year` (birth year based, so a stored profile never goes stale). */
export const ageOf = (profile, year = new Date().getFullYear()) => year - profile.birthYear;

/**
 * Validate a profile coming from a form or from storage. Returns a clean copy, or null if anything is
 * missing or absurd. Accepts `birthYear` or `age`; stores `birthYear`.
 */
export function cleanProfile(raw, year = new Date().getFullYear()) {
  if (!raw || typeof raw !== 'object') return null;
  if (!SEXES.includes(raw.sex) || !ACTIVITIES.includes(raw.activity) || !GOALS.includes(raw.goal)) return null;
  let birthYear = toNum(raw.birthYear);
  if (birthYear === null || !Number.isInteger(birthYear)) {
    const age = toNum(raw.age);
    birthYear = age !== null && Number.isInteger(age) ? year - age : null;
  }
  if (birthYear === null || !inRange(year - birthYear, LIMITS.age)) return null;
  const heightCm = toNum(raw.heightCm);
  const weightKg = toNum(raw.weightKg);
  if (!inRange(heightCm, LIMITS.heightCm) || !inRange(weightKg, LIMITS.weightKg)) return null;
  let pace = null;
  if (raw.goal !== 'maintain') pace = PACES[raw.goal].includes(toNum(raw.pace)) ? toNum(raw.pace) : DEFAULT_PACE[raw.goal];
  return { sex: raw.sex, birthYear, heightCm: round1(heightCm), weightKg: round1(weightKg), activity: raw.activity, goal: raw.goal, pace };
}

/** Basal metabolic rate, Mifflin-St Jeor: 10·kg + 6.25·cm − 5·age + 5 (men) or − 161 (women). */
export function bmr({ sex, heightCm, weightKg, age }) {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
}

/** Calories per day for a goal, before safety limits. */
export function goalKcal(tdee, goal, pace) {
  if (goal === 'lose') return tdee * (1 - pace);
  if (goal === 'gain') return tdee * (1 + pace);
  return tdee;
}

export function waterLitres(weightKg, activity) {
  return round1(clamp(weightKg * WATER_L_PER_KG + WATER_BONUS_L[activity], WATER_RANGE_L[0], WATER_RANGE_L[1]));
}

export function stepsTarget(goal, activity) {
  return Math.max(5000, STEPS_BASE[goal] - (activity === 'sedentary' ? 2000 : 0));
}

/**
 * Daily targets for a profile (null if the profile is not valid).
 * kcal is rounded to the nearest 10 and never below the safety floor (`floored` says when that happened).
 */
export function computePlan(profile, year = new Date().getFullYear()) {
  const p = cleanProfile(profile, year);
  if (!p) return null;
  const base = bmr({ sex: p.sex, heightCm: p.heightCm, weightKg: p.weightKg, age: ageOf(p, year) });
  const tdee = base * ACTIVITY_FACTOR[p.activity];
  const raw = goalKcal(tdee, p.goal, p.pace);
  const floor = Math.max(KCAL_FLOOR[p.sex], base * BMR_FLOOR_FACTOR);
  const floored = raw < floor;
  const kcal = floored ? Math.ceil(floor / 10) * 10 : Math.round(raw / 10) * 10;

  const proteinKcal = Math.min(PROTEIN_G_PER_KG[p.goal] * p.weightKg * 4, MAX_PROTEIN_SHARE * kcal);
  const fatKcal = clamp(FAT_G_PER_KG * p.weightKg * 9, MIN_FAT_SHARE * kcal, MAX_FAT_SHARE * kcal);
  const carbsKcal = Math.max(0, kcal - proteinKcal - fatKcal);
  return {
    bmr: base, tdee, kcal, floored,
    protein_g: Math.round(proteinKcal / 4),
    carbs_g: Math.round(carbsKcal / 4),
    fat_g: Math.round(fatKcal / 9),
    waterL: waterLitres(p.weightKg, p.activity),
    steps: stepsTarget(p.goal, p.activity),
  };
}

/** The part of a plan that is stored as "goals" (no derived figures). */
export const toGoals = (plan) => (plan
  ? { kcal: plan.kcal, protein_g: plan.protein_g, carbs_g: plan.carbs_g, fat_g: plan.fat_g, waterL: plan.waterL, steps: plan.steps }
  : null);

/** Daily calories for every pace of a goal, so the UI can show what each choice means. */
export function pacePreview(profile, goal, year = new Date().getFullYear()) {
  return (PACES[goal] || []).map((pace) => {
    const plan = computePlan({ ...profile, goal, pace }, year);
    return { pace, kcal: plan ? plan.kcal : null, floored: plan ? plan.floored : false };
  });
}

/** Reference intake per nutrient for this sex, as { key: target }. Ceilings (sodium, sugars, saturated fat) are included. */
export function microTargets(sex) {
  const out = {};
  for (const n of NUTRIENTS) if (n.nrv) out[n.key] = n.nrv;
  return Object.assign(out, SEX_TARGETS[sex] || {});
}
