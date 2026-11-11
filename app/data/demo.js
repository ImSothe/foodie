/* foodie · sample data for the design preview. It goes away when real accounts and logging arrive.
   Compositions per 100 g are rounded values from standard food tables, good enough to exercise the UI. */
import { addDays } from '../core/dates.js';
import { KEYS } from '../core/nutrition.js';

const F = {
  avena: { kcal: 379, protein_g: 13.2, carbs_g: 67.7, fat_g: 6.5, fiber_g: 10.1, sugars_g: 1, sat_fat_g: 1.1, sodium_mg: 6, potassium_mg: 362, calcium_mg: 52, iron_mg: 4.3, magnesium_mg: 138, vit_e_mg: 0.4, vit_b1_mg: 0.46, vit_b2_mg: 0.15, vit_b3_mg: 1.1, vit_b6_mg: 0.1, vit_b9_ug: 32 },
  leche: { kcal: 46, protein_g: 3.3, carbs_g: 4.8, fat_g: 1.6, fiber_g: 0, sugars_g: 4.8, sat_fat_g: 1, sodium_mg: 45, potassium_mg: 155, calcium_mg: 120, magnesium_mg: 11, vit_a_ug: 20, vit_b2_mg: 0.18, vit_b12_ug: 0.4 },
  platano: { kcal: 89, protein_g: 1.1, carbs_g: 22.8, fat_g: 0.3, fiber_g: 2.6, sugars_g: 12.2, sat_fat_g: 0.1, sodium_mg: 1, potassium_mg: 358, calcium_mg: 5, iron_mg: 0.3, magnesium_mg: 27, vit_a_ug: 3, vit_c_mg: 8.7, vit_b6_mg: 0.37, vit_b9_ug: 20 },
  pollo: { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6, fiber_g: 0, sugars_g: 0, sat_fat_g: 1, sodium_mg: 74, potassium_mg: 256, calcium_mg: 15, iron_mg: 1, magnesium_mg: 29, vit_a_ug: 6, vit_b3_mg: 13.7, vit_b6_mg: 0.6, vit_b12_ug: 0.3 },
  arroz: { kcal: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3, fiber_g: 0.4, sugars_g: 0.1, sat_fat_g: 0.1, sodium_mg: 1, potassium_mg: 35, calcium_mg: 10, iron_mg: 0.2, magnesium_mg: 12, vit_b1_mg: 0.02, vit_b3_mg: 0.4 },
  aceite: { kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100, fiber_g: 0, sugars_g: 0, sat_fat_g: 13.8, sodium_mg: 2, vit_e_mg: 14.4 },
  brocoli: { kcal: 35, protein_g: 2.4, carbs_g: 7.2, fat_g: 0.4, fiber_g: 3.3, sugars_g: 1.4, sat_fat_g: 0.1, sodium_mg: 41, potassium_mg: 293, calcium_mg: 40, iron_mg: 0.7, magnesium_mg: 21, vit_a_ug: 77, vit_c_mg: 64.9, vit_e_mg: 1.5, vit_b6_mg: 0.2, vit_b9_ug: 108 },
  yogur: { kcal: 97, protein_g: 9, carbs_g: 3.9, fat_g: 5, fiber_g: 0, sugars_g: 3.9, sat_fat_g: 3.2, sodium_mg: 35, calcium_mg: 100 },
  nueces: { kcal: 654, protein_g: 15.2, carbs_g: 13.7, fat_g: 65.2, fiber_g: 6.7, sugars_g: 2.6, sat_fat_g: 6.1, sodium_mg: 2, potassium_mg: 441, calcium_mg: 98, iron_mg: 2.9, magnesium_mg: 158, vit_e_mg: 0.7, vit_b6_mg: 0.54, vit_b9_ug: 98 },
  salmon: { kcal: 206, protein_g: 22.1, carbs_g: 0, fat_g: 12.4, fiber_g: 0, sugars_g: 0, sat_fat_g: 2.5, sodium_mg: 61, potassium_mg: 384, calcium_mg: 15, iron_mg: 0.3, magnesium_mg: 30, vit_a_ug: 69, vit_d_ug: 13.1, vit_b3_mg: 8, vit_b6_mg: 0.6, vit_b12_ug: 2.8 },
  patata: { kcal: 87, protein_g: 1.9, carbs_g: 20.1, fat_g: 0.1, fiber_g: 1.8, sugars_g: 0.9, sat_fat_g: 0, sodium_mg: 4, potassium_mg: 379, calcium_mg: 5, iron_mg: 0.3, magnesium_mg: 22, vit_c_mg: 13, vit_b6_mg: 0.3 },
};

// Foods from a composition table are complete: a nutrient that is not listed is zero. The yogurt stands for
// a packaged product read from its barcode, which only brings what the label prints.
const LABEL_ONLY = new Set(['yogur']);
for (const [key, food] of Object.entries(F)) {
  if (!LABEL_ONLY.has(key)) for (const k of KEYS) if (!(k in food)) food[k] = 0;
}

const item = (name, key, grams, spread = 0.5) => ({
  name, grams, per100: F[key],
  gramsMin: Math.max(5, Math.round((grams * (1 - spread)) / 5) * 5),
  gramsMax: Math.round((grams * (1 + spread)) / 5) * 5,
});

const breakfast = () => ({ id: 'm-desayuno', name: 'Avena con leche y plátano', slot: 'Desayuno', time: '08:10', source: 'db',
  items: [item('Copos de avena', 'avena', 60), item('Leche semidesnatada', 'leche', 250), item('Plátano', 'platano', 120)] });
const lunch = () => ({ id: 'm-almuerzo', name: 'Pollo con arroz y brócoli', slot: 'Almuerzo', time: '14:05', source: 'ai', confidence: 0.82,
  items: [item('Pechuga de pollo a la plancha', 'pollo', 160), item('Arroz blanco cocido', 'arroz', 180), item('Brócoli cocido', 'brocoli', 120), item('Aceite de oliva', 'aceite', 10, 1)] });
const snack = () => ({ id: 'm-snack', name: 'Yogur griego con nueces', slot: 'Snack', time: '17:30', source: 'barcode',
  items: [item('Yogur griego natural', 'yogur', 170), item('Nueces', 'nueces', 20)] });
const dinner = () => ({ id: 'm-cena', name: 'Salmón al horno con patata', slot: 'Cena', time: '21:15', source: 'ai', confidence: 0.76,
  items: [item('Salmón al horno', 'salmon', 150), item('Patata cocida', 'patata', 220), item('Aceite de oliva', 'aceite', 10, 1)] });

export const DEMO_GOALS = { kcal: 2100, protein_g: 150, carbs_g: 230, fat_g: 65 };

const cache = new Map();

/** Sample meals for a day: today is still missing dinner, past days vary a little, future days are empty. */
export function demoMeals(iso, today) {
  if (cache.has(iso)) return cache.get(iso);
  let meals = [];
  if (iso === today) meals = [breakfast(), lunch(), snack()];
  else if (iso < today) {
    const seed = [...iso].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7);
    const factor = 0.82 + (seed % 7) * 0.05; // 0.82 .. 1.12
    meals = [breakfast(), lunch(), snack(), dinner()];
    if (seed % 5 === 0) meals.splice(2, 1);
    for (const m of meals) for (const it of m.items) it.grams = Math.round((it.grams * factor) / 5) * 5;
  }
  cache.set(iso, meals);
  return meals;
}

/** Days with something logged in the sample data (for the streak). */
export const demoLoggedDays = (today) => Array.from({ length: 12 }, (_, i) => addDays(today, -i));
