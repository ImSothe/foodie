/* foodie · week strip: Monday to Sunday, each day with a small ring of how much of the calorie goal is covered. */
import { h } from './dom.js';
import { ring } from './ring.js';
import { weekOf, DOW_LETTERS, dayNumber, fullDate } from '../core/dates.js';

/**
 * @param {object} o
 * @param {string} o.selected  ISO day shown
 * @param {string} o.today     ISO day of today
 * @param {(iso:string)=>number} o.progressOf  share of the calorie goal covered that day (0..1+)
 * @param {(iso:string)=>void} o.onSelect
 */
export function dayStrip({ selected, today, progressOf, onSelect }) {
  return h('nav', { class: 'days', 'aria-label': 'Días de la semana' }, weekOf(selected).map((iso, i) => {
    const future = iso > today;
    const p = future ? 0 : progressOf(iso);
    return h('button', {
      type: 'button', class: 'day', disabled: future,
      'aria-pressed': String(iso === selected), 'aria-label': fullDate(iso) + (iso === today ? ' (hoy)' : ''),
      dataset: iso === today ? { today: '' } : null,
      onClick: () => onSelect(iso),
    },
    h('span', { class: 'day-letter', 'aria-hidden': 'true' }, DOW_LETTERS[i]),
    ring({ size: 36, stroke: 3.5, value: p, label: `${Math.round(p * 100)} % del objetivo`, center: String(dayNumber(iso)) }));
  }));
}
