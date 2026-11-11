import test from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, isIso, addDays, weekOf, dowIndex, dayNumber, dayTitle, fullDate, streak } from '../app/core/dates.js';

test('isoDate uses the local day, also late at night', () => {
  assert.equal(isoDate(new Date(2026, 10, 11, 23, 59)), '2026-11-11');
  assert.equal(isoDate(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
});

test('isIso accepts real days only', () => {
  assert.ok(isIso('2026-11-11'));
  assert.ok(isIso('2028-02-29'));
  for (const bad of ['2026-02-30', '2026-13-01', '26-11-11', '2026-11-11T10:00', '', null, 20261111]) assert.ok(!isIso(bad), String(bad));
});

test('addDays crosses months, years and daylight-saving changes', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30');   // clocks change on 29 March in Spain
  assert.equal(addDays('2026-10-24', 2), '2026-10-26');   // and back on 25 October
  assert.equal(addDays('2026-11-11', 0), '2026-11-11');
});

test('weekOf returns Monday to Sunday for any day of that week', () => {
  const week = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'];
  for (const day of week) assert.deepEqual(weekOf(day), week);
  assert.equal(dowIndex('2026-11-09'), 0);
  assert.equal(dowIndex('2026-11-15'), 6);
  assert.equal(dayNumber('2026-11-09'), 9);
  assert.deepEqual(weekOf('2026-01-01').slice(0, 2), ['2025-12-29', '2025-12-30']);
});

test('day titles', () => {
  assert.equal(dayTitle('2026-11-11', '2026-11-11'), 'Hoy');
  assert.equal(dayTitle('2026-11-10', '2026-11-11'), 'Ayer');
  assert.equal(dayTitle('2026-11-03', '2026-11-11'), 'martes 3 de noviembre');
  assert.equal(fullDate('2026-11-11'), 'miércoles 11 de noviembre de 2026');
});

test('streak counts consecutive logged days and does not break while today is still empty', () => {
  const today = '2026-11-11';
  assert.equal(streak([], today), 0);
  assert.equal(streak(['2026-11-11'], today), 1);
  assert.equal(streak(['2026-11-11', '2026-11-10', '2026-11-09'], today), 3);
  assert.equal(streak(['2026-11-10', '2026-11-09'], today), 2);            // nothing logged yet today
  assert.equal(streak(['2026-11-09', '2026-11-08'], today), 0);            // yesterday was missed
  assert.equal(streak(new Set(['2026-11-11', '2026-11-09']), today), 1);   // a gap ends it
});
