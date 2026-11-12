/* foodie · week strip: Monday to Sunday, each day with a small ring of how much of the calorie goal is covered.
   Arrows (or a swipe) move one week at a time, "Hoy" comes back. */
import { h } from './dom.js';
import { icon } from './icons.js';
import { ring } from './ring.js';
import { weekOf, addDays, DOW_LETTERS, dayNumber, fullDate, shortDate } from '../core/dates.js';

const SWIPE_MIN_PX = 50;

/**
 * @param {object} o
 * @param {string} o.selected  ISO day shown
 * @param {string} o.today     ISO day of today
 * @param {(iso:string)=>number} o.progressOf  share of the calorie goal covered that day (0..1+)
 * @param {(iso:string)=>void} o.onSelect
 * @param {boolean} [o.animate] fill the rings in from zero
 */
export function dayStrip({ selected, today, progressOf, onSelect, animate = true }) {
  const week = weekOf(selected);
  const isThisWeek = week.includes(today);
  const canGoForward = week[6] < today;
  // One week at a time, landing on the same weekday (or on today when that would be in the future).
  const shift = (delta) => {
    if (delta > 0 && !canGoForward) return;
    const target = addDays(selected, 7 * delta);
    onSelect(target > today ? today : target);
  };

  const header = h('div', { class: 'week-nav' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Semana anterior', dataset: { focus: 'week-prev' }, onClick: () => shift(-1) }, icon('left', 22)),
    h('p', { class: 'week-label', 'aria-live': 'polite' }, isThisWeek ? 'Esta semana' : `${shortDate(week[0])} al ${shortDate(week[6])}`),
    selected !== today
      ? h('button', { type: 'button', class: 'week-today', dataset: { focus: 'week-today' }, onClick: () => onSelect(today) }, 'Volver a hoy')
      : null,
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Semana siguiente', disabled: !canGoForward, dataset: { focus: 'week-next' }, onClick: () => shift(1) }, icon('right', 22)));

  const days = h('nav', { class: 'days', 'aria-label': 'Días de la semana' }, week.map((iso, i) => {
    const future = iso > today;
    const p = future ? 0 : progressOf(iso);
    return h('button', {
      type: 'button', class: 'day', disabled: future,
      'aria-pressed': String(iso === selected), 'aria-label': fullDate(iso) + (iso === today ? ' (hoy)' : ''),
      dataset: iso === today ? { today: '' } : null,
      onClick: () => onSelect(iso),
    },
    h('span', { class: 'day-letter', 'aria-hidden': 'true' }, DOW_LETTERS[i]),
    ring({ size: 36, stroke: 3.5, value: p, animate, label: `${Math.round(p * 100)} % del objetivo`, center: String(dayNumber(iso)) }));
  }));

  let x0 = 0;
  let y0 = 0;
  days.addEventListener('touchstart', (e) => { x0 = e.changedTouches[0].clientX; y0 = e.changedTouches[0].clientY; }, { passive: true });
  days.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) shift(dx < 0 ? 1 : -1);
  }, { passive: true });

  return h('div', { class: 'week' }, header, days);
}
