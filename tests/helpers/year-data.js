/* A year of heavy use, as the app would have stored it: 4 meals a day, 365 days, a photo thumbnail on some meals (the size limit, 12 KB),
   favourites, a weight every few days. Used by the storage tests and as the model for the browser measurements in the release notes. */
import { addDays } from '../../app/core/dates.js';
import { cleanDays, cleanSaved, cleanWeights, THUMB_MAX_CHARS, MAX_THUMBS_PER_DAY } from '../../app/core/schema.js';
import { STORAGE_KEYS } from '../../app/data/state-io.js';

const per100 = (k) => ({ kcal: 100 + k, protein_g: 10, carbs_g: 12 + (k % 5), fat_g: 3, fiber_g: 1, sugars_g: 2, sat_fat_g: 1, sodium_mg: 100, potassium_mg: 200, calcium_mg: 50, iron_mg: 1, magnesium_mg: 20, vit_c_mg: 5 });
export const THUMB = `data:image/jpeg;base64,${'A'.repeat(THUMB_MAX_CHARS - 'data:image/jpeg;base64,'.length)}`;

export function buildYear({ days = 365, mealsPerDay = 4, thumbsPerDay = 1, end = '2026-11-12', now = 1_760_000_000_000 } = {}) {
  const raw = {};
  for (let d = 0; d < days; d += 1) {
    const iso = addDays(end, -d);
    const meals = {};
    for (let m = 0; m < mealsPerDay; m += 1) {
      const id = `m${d}x${m}`;
      meals[id] = {
        id, name: `Comida ${d}-${m} con arroz y pollo`, slot: ['Desayuno', 'Almuerzo', 'Snack', 'Cena'][m % 4], time: `${String(8 + m * 3).padStart(2, '0')}:15`,
        source: m === 1 && thumbsPerDay > 0 ? 'ai' : 'db', updatedAt: now - d * 86_400_000 + m,
        ...(m < thumbsPerDay ? { thumb: THUMB } : {}),
        items: [
          { name: 'Pechuga de pollo a la plancha', grams: 150, gramsMin: 0, gramsMax: 500, per100: per100(d) },
          { name: 'Arroz blanco cocido', grams: 180, gramsMin: 0, gramsMax: 500, per100: per100(d + 1) },
          { name: 'Aceite de oliva (estimado)', grams: 10, gramsMin: 0, gramsMax: 40, per100: per100(d + 2) },
        ],
      };
    }
    raw[iso] = { meals, waterMl: 1500 + d, steps: 6000 + d, waterAt: now - d * 86_400_000, stepsAt: now - d * 86_400_000 };
  }
  const daysClean = cleanDays(raw);
  const saved = cleanSaved(Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `Favorita ${i}`, slot: 'Almuerzo', source: 'db', items: [{ name: 'Pollo', grams: 150, per100: per100(i) }] })));
  const weights = cleanWeights(Object.fromEntries(Array.from({ length: Math.ceil(days / 3) }, (_, i) => [addDays(end, -i * 3), 80 - (i % 10) / 10])));
  const profile = { sex: 'female', birthYear: 1996, heightCm: 165, weightKg: 60, activity: 'light', goal: 'lose', pace: 0.2 };
  const goals = [{ from: addDays(end, -days), goals: { kcal: 1800, protein_g: 120, carbs_g: 180, fat_g: 60, waterL: 2.2, steps: 8000 } }];
  const text = {
    [STORAGE_KEYS.profile]: JSON.stringify(profile), [STORAGE_KEYS.goals]: JSON.stringify(goals), [STORAGE_KEYS.days]: JSON.stringify(daysClean),
    [STORAGE_KEYS.saved]: JSON.stringify(saved), [STORAGE_KEYS.weights]: JSON.stringify(weights),
  };
  return { text, days: daysClean, saved, weights, meals: days * mealsPerDay, thumbsPerDay: Math.min(thumbsPerDay, MAX_THUMBS_PER_DAY) };
}

export const bytesOf = (text) => Object.values(text).reduce((a, v) => a + v.length, 0);
