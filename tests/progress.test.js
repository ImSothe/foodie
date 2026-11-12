import test from 'node:test';
import assert from 'node:assert/strict';
import { dayStatus, monthWeeks, shiftMonth, weeklyAverages } from '../app/core/progress.js';
import { monthTitle, shortDate } from '../app/core/dates.js';

const goals = { kcal: 2000, protein_g: 150 };

test('dayStatus: ok within 10 % of calories and 90 % of protein', () => {
  assert.equal(dayStatus({ kcal: 2000, protein_g: 150 }, goals), 'ok');
  assert.equal(dayStatus({ kcal: 1800, protein_g: 135 }, goals), 'ok');      // both exactly on the limit
  assert.equal(dayStatus({ kcal: 2200, protein_g: 200 }, goals), 'ok');
});

test('dayStatus: off when calories or protein miss, null when nothing was logged', () => {
  assert.equal(dayStatus({ kcal: 1799, protein_g: 150 }, goals), 'off');
  assert.equal(dayStatus({ kcal: 2201, protein_g: 150 }, goals), 'off');
  assert.equal(dayStatus({ kcal: 2000, protein_g: 134 }, goals), 'off');
  assert.equal(dayStatus({ kcal: 300, protein_g: 10 }, goals), 'off');
  assert.equal(dayStatus({ kcal: 0, protein_g: 0 }, goals), null);
  assert.equal(dayStatus(null, goals), null);
  assert.equal(dayStatus({ kcal: 2000, protein_g: 150 }, null), null);
});

test('monthWeeks: Monday-first grid, every day of the month exactly once', () => {
  const weeks = monthWeeks(2026, 10);                           // november 2026 starts on a Sunday
  assert.ok(weeks.every((w) => w.length === 7));
  assert.deepEqual(weeks[0], [null, null, null, null, null, null, '2026-11-01']);
  const days = weeks.flat().filter(Boolean);
  assert.equal(days.length, 30);
  assert.equal(new Set(days).size, 30);
  assert.equal(days[0], '2026-11-01');
  assert.equal(days[29], '2026-11-30');
  assert.deepEqual(weeks[weeks.length - 1].slice(0, 2), ['2026-11-30', null]);
});

test('monthWeeks: february in a leap year and a month that starts on Monday', () => {
  assert.equal(monthWeeks(2028, 1).flat().filter(Boolean).length, 29);
  const jun = monthWeeks(2026, 5);                              // 1 June 2026 is a Monday
  assert.equal(jun[0][0], '2026-06-01');
  assert.equal(monthWeeks(2026, 1).length, 5);                  // 1 Feb 2026 is a Sunday
  assert.equal(monthWeeks(2027, 1).length, 4);                  // 1 Feb 2027 is a Monday: exactly four full weeks
});

test('shiftMonth wraps over years in both directions', () => {
  assert.deepEqual(shiftMonth({ year: 2026, month: 10 }, 1), { year: 2026, month: 11 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 5 }, -18), { year: 2024, month: 11 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 5 }, 0), { year: 2026, month: 5 });
});

test('weeklyAverages: eight weeks oldest first, averages only over logged days', () => {
  const today = '2026-11-12';                                   // Thursday
  const data = { '2026-11-09': 2000, '2026-11-10': 1800, '2026-11-12': 2200, '2026-11-02': 1500, '2026-10-30': 0 };
  const weeks = weeklyAverages((iso) => data[iso] || 0, today);
  assert.equal(weeks.length, 8);
  assert.equal(weeks[7].start, '2026-11-09');
  assert.equal(weeks[7].avg, 2000);                             // (2000 + 1800 + 2200) / 3
  assert.equal(weeks[7].days, 3);
  assert.equal(weeks[6].start, '2026-11-02');
  assert.equal(weeks[6].avg, 1500);
  assert.equal(weeks[5].avg, null);                             // nothing logged
  assert.equal(weeks[0].start, '2026-09-21');
});

test('weeklyAverages ignores days after today', () => {
  const weeks = weeklyAverages(() => 2000, '2026-11-10');       // Tuesday
  assert.equal(weeks[7].days, 2);
  assert.equal(weeks[6].days, 7);
});

test('date labels in Spanish', () => {
  assert.equal(monthTitle(2026, 10), 'noviembre de 2026');
  assert.equal(shortDate('2026-11-07'), '7 nov');
  assert.equal(shortDate('2026-09-21'), '21 sep');
});
