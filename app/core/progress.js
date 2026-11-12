/* foodie · progress maths (pure): how a day went, the month calendar and weekly averages. */
import { addDays, parse, weekOf, dowIndex } from './dates.js';

export const KCAL_TOLERANCE = 0.10;      // calories within +-10 % of the goal
export const PROTEIN_MIN_SHARE = 0.90;   // and at least 90 % of the protein goal

/**
 * 'ok' when calories are within 10 % of the goal and protein reaches 90 % of its goal,
 * 'off' when something was logged but it missed that, null when nothing was logged.
 */
export function dayStatus(totals, goals) {
  if (!totals || !(totals.kcal > 0) || !goals) return null;
  const kcalOk = Math.abs(totals.kcal - goals.kcal) <= goals.kcal * KCAL_TOLERANCE;
  const proteinOk = totals.protein_g >= goals.protein_g * PROTEIN_MIN_SHARE;
  return kcalOk && proteinOk ? 'ok' : 'off';
}

/** Weeks (Monday first) of a month as arrays of 7 ISO days, with null outside the month. `month` is 0-11. */
export function monthWeeks(year, month) {
  const first = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const weeks = [];
  let cursor = weekOf(first)[0];
  do {
    weeks.push(Array.from({ length: 7 }, (_, i) => {
      const iso = addDays(cursor, i);
      return parse(iso).getMonth() === month ? iso : null;
    }));
    cursor = addDays(cursor, 7);
  } while (parse(cursor).getMonth() === month);
  return weeks;
}

/** { year, month } moved by `delta` months. */
export function shiftMonth({ year, month }, delta) {
  const idx = year * 12 + month + delta;
  return { year: Math.floor(idx / 12), month: ((idx % 12) + 12) % 12 };
}

/**
 * Average calories per logged day for each of the last `count` weeks (Monday to Sunday), oldest first.
 * `kcalOf(iso)` returns the calories of a day, or 0 when nothing was logged. Future days are ignored.
 * @returns {{start:string, avg:number|null, days:number}[]}
 */
export function weeklyAverages(kcalOf, today, count = 8) {
  const thisMonday = weekOf(today)[0];
  const out = [];
  for (let w = count - 1; w >= 0; w -= 1) {
    const start = addDays(thisMonday, -7 * w);
    let sum = 0;
    let days = 0;
    for (let i = 0; i < 7; i += 1) {
      const iso = addDays(start, i);
      if (iso > today) break;
      const k = kcalOf(iso);
      if (k > 0) { sum += k; days += 1; }
    }
    out.push({ start, avg: days ? sum / days : null, days });
  }
  return out;
}

/** Weekday of a day as 0 (Monday) to 6 (Sunday). */
export const weekdayOf = dowIndex;
