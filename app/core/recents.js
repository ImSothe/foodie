/* foodie · "recents": the meals a person logged lately, newest first, one per distinct meal (pure logic, no DOM, no storage).
   Nothing is stored for this: it is read from the days that already exist. */
import { sumItems } from './nutrition.js';

export const MAX_RECENTS = 8;
const LOOKBACK_DAYS = 45;          // only the last stretch of logged days is read: this runs when a sheet opens

const key = (meal) => `${String(meal.name).trim().toLowerCase()}|${meal.items.map((it) => `${String(it.name).toLowerCase()}:${Math.round(it.grams)}`).join(',')}`;

/**
 * @param {{loggedDays:()=>string[], mealsOf:(iso:string)=>object[]}} store
 * @param {number} [limit]
 * @returns {{meal:object, iso:string, kcal:number}[]}  the same dish at the same grams is listed once; a different portion of it is another entry
 */
export function recentMeals(store, limit = MAX_RECENTS) {
  const days = [...store.loggedDays()].sort().reverse().slice(0, LOOKBACK_DAYS);
  const seen = new Set();
  const out = [];
  for (const iso of days) {
    const meals = [...store.mealsOf(iso)].sort((a, b) => String(b.time).localeCompare(String(a.time)));
    for (const meal of meals) {
      if (!meal.items || !meal.items.length) continue;
      const k = key(meal);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ meal, iso, kcal: sumItems(meal.items).totals.kcal });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** A copy of a meal ready to be added to another day: new id and time are given by the store, the thumbnail is kept. */
export function copyOfMeal(meal, slot) {
  const copy = structuredClone(meal);
  delete copy.id;
  delete copy.time;
  delete copy.updatedAt;
  if (slot) copy.slot = slot;
  return copy;
}
