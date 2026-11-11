/* foodie · nutrition core (pure logic, no DOM). Runs in the browser and in Node tests.
   One rule for the whole app: every food is "composition per 100 g + grams on the plate".
   Totals are always derived, never stored, so changing grams never needs the AI again. */

/** Every nutrient the app tracks. `nrv` is the EU daily reference value (Regulation 1169/2011);
    `limit: true` marks nutrients where the reference is a ceiling, not a target. */
export const NUTRIENTS = [
  { key: 'kcal', label: 'Calorías', unit: 'kcal', group: 'energy' },
  { key: 'protein_g', label: 'Proteína', unit: 'g', group: 'macro' },
  { key: 'carbs_g', label: 'Carbohidratos', unit: 'g', group: 'macro' },
  { key: 'fat_g', label: 'Grasa', unit: 'g', group: 'macro' },
  { key: 'fiber_g', label: 'Fibra', unit: 'g', group: 'other', nrv: 25 },
  { key: 'sugars_g', label: 'Azúcares', unit: 'g', group: 'other', nrv: 90, limit: true },
  { key: 'sat_fat_g', label: 'Grasa saturada', unit: 'g', group: 'other', nrv: 20, limit: true },
  { key: 'sodium_mg', label: 'Sodio', unit: 'mg', group: 'mineral', nrv: 2400, limit: true },
  { key: 'potassium_mg', label: 'Potasio', unit: 'mg', group: 'mineral', nrv: 2000 },
  { key: 'calcium_mg', label: 'Calcio', unit: 'mg', group: 'mineral', nrv: 800 },
  { key: 'iron_mg', label: 'Hierro', unit: 'mg', group: 'mineral', nrv: 14 },
  { key: 'magnesium_mg', label: 'Magnesio', unit: 'mg', group: 'mineral', nrv: 375 },
  { key: 'vit_a_ug', label: 'Vitamina A', unit: 'µg', group: 'vitamin', nrv: 800 },
  { key: 'vit_c_mg', label: 'Vitamina C', unit: 'mg', group: 'vitamin', nrv: 80 },
  { key: 'vit_d_ug', label: 'Vitamina D', unit: 'µg', group: 'vitamin', nrv: 5 },
  { key: 'vit_e_mg', label: 'Vitamina E', unit: 'mg', group: 'vitamin', nrv: 12 },
  { key: 'vit_b1_mg', label: 'Vitamina B1', unit: 'mg', group: 'vitamin', nrv: 1.1 },
  { key: 'vit_b2_mg', label: 'Vitamina B2', unit: 'mg', group: 'vitamin', nrv: 1.4 },
  { key: 'vit_b3_mg', label: 'Vitamina B3', unit: 'mg', group: 'vitamin', nrv: 16 },
  { key: 'vit_b6_mg', label: 'Vitamina B6', unit: 'mg', group: 'vitamin', nrv: 1.4 },
  { key: 'vit_b9_ug', label: 'Vitamina B9', unit: 'µg', group: 'vitamin', nrv: 200 },
  { key: 'vit_b12_ug', label: 'Vitamina B12', unit: 'µg', group: 'vitamin', nrv: 2.5 },
];

export const KEYS = NUTRIENTS.map((n) => n.key);
export const MACRO_KEYS = ['protein_g', 'carbs_g', 'fat_g'];
const BY_KEY = new Map(NUTRIENTS.map((n) => [n.key, n]));
export const nutrient = (key) => BY_KEY.get(key) || null;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Amount of each known nutrient in `grams` of a food. Unknown nutrients stay out of the result. */
export function scale(per100, grams) {
  const g = num(grams) || 0;
  const out = {};
  if (!per100) return out;
  for (const k of KEYS) {
    const v = num(per100[k]);
    if (v !== null) out[k] = (v * g) / 100;
  }
  return out;
}

/** Totals for a list of items ({ grams, per100 }). `missing[k]` counts the items with no data for k,
    so the UI can show a total as a lower bound instead of pretending it is exact. */
export function sumItems(items) {
  const totals = {};
  const missing = {};
  for (const k of KEYS) { totals[k] = 0; missing[k] = 0; }
  for (const it of items || []) {
    const part = scale(it && it.per100, it && it.grams);
    for (const k of KEYS) {
      if (k in part) totals[k] += part[k];
      else missing[k] += 1;
    }
  }
  return { totals, missing };
}

export const sumMeals = (meals) => sumItems((meals || []).flatMap((m) => m.items || []));

const MICRO_KEYS = NUTRIENTS.filter((n) => n.group === 'mineral' || n.group === 'vitamin').map((n) => n.key);

/** Share (0..1) of vitamins and minerals a food has data for. Packaged products often carry none. */
export function microCoverage(per100) {
  if (!per100) return 0;
  return MICRO_KEYS.filter((k) => num(per100[k]) !== null).length / MICRO_KEYS.length;
}

/** Energy implied by the macros (Atwater factors). */
export const kcalFromMacros = (per100) =>
  4 * (num(per100 && per100.protein_g) || 0) + 4 * (num(per100 && per100.carbs_g) || 0) + 9 * (num(per100 && per100.fat_g) || 0);

/** True when the stated calories and the macros disagree too much to trust (AI or label mistake). */
export function macroMismatch(per100) {
  const stated = num(per100 && per100.kcal);
  if (stated === null) return false;
  const implied = kcalFromMacros(per100);
  const diff = Math.abs(stated - implied);
  return diff > 25 && diff > 0.2 * Math.max(stated, implied);
}

/** Keep a weight inside its allowed range and on the slider step. */
export function clampGrams(grams, min = 0, max = 2000, step = 5) {
  const lo = Math.max(0, num(min) || 0);
  const hi = Math.max(lo, num(max) === null ? 2000 : max);
  const g = Math.min(hi, Math.max(lo, num(grams) || 0));
  return Math.min(hi, Math.max(lo, Math.round(g / step) * step));
}

/** Share of a goal already covered, 0..1+ (can pass 1 when over). */
export const progress = (consumed, goal) => (num(goal) ? (num(consumed) || 0) / goal : 0);

const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0, useGrouping: 'always' });
const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1, useGrouping: 'always' });

/** Number as people read it: whole numbers from 10 up, one decimal below. */
export function fmtNum(v) {
  const n = num(v) === null ? 0 : v;
  return Math.abs(n) >= 10 || Number.isInteger(n) ? nf0.format(Math.round(n)) : nf1.format(n);
}

export const fmtAmount = (v, key) => `${fmtNum(v)} ${(nutrient(key) || { unit: '' }).unit}`.trim();
