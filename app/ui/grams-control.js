/* foodie · "how much?" for one food: a typed value, quick portions, a slider and two small steps, all showing the totals as they change.
   Used for a scanned product; the grams are the only thing that moves, the composition per 100 g is fixed. */
import { h } from './dom.js';
import { icon } from './icons.js';
import { numberField } from './fields.js';
import { totalsBox } from './meal-parts.js';
import { scale, fmtNum } from '../core/nutrition.js';

const STEP = 5;
const MAX_GRAMS = 5000;

/**
 * @param {object} o
 * @param {object} o.per100
 * @param {string} o.name        for the slider's accessible name
 * @param {number} o.grams       starting amount
 * @param {number} o.max         slider maximum
 * @param {{label:string, grams:number}[]} [o.options]  quick portions
 * @param {(grams:number|null)=>void} [o.onChange]       called with the new amount, or null while the typed value is not valid
 */
export function gramsControl({ per100, name, grams: start, max, options = [], onChange = () => {} }) {
  let grams = start;
  const field = numberField({ label: 'Gramos', unit: 'g', inputmode: 'decimal', value: grams });
  const range = h('input', { type: 'range', class: 'range', min: 0, max, step: STEP, value: grams, 'aria-label': `Gramos de ${name}` });
  const totals = totalsBox(() => scale(per100, grams));

  const paint = (fromField) => {
    if (!fromField) field.setValue(grams);
    range.value = grams;
    range.style.setProperty('--fill', `${Math.min(100, (grams / max) * 100)}%`);
    totals.paint();
  };
  const set = (g, fromField = false) => {
    grams = Math.min(MAX_GRAMS, Math.max(0, Math.round(g * 10) / 10));
    field.setError('');
    paint(fromField);
    onChange(grams > 0 ? grams : null);
  };
  field.input.addEventListener('input', () => {
    const v = field.read();
    if (v === null || v <= 0 || v > MAX_GRAMS) { field.setError(`Escribe los gramos, un número entre 1 y ${fmtNum(MAX_GRAMS)}.`); onChange(null); return; }
    set(v, true);
  });
  range.addEventListener('input', () => set(Number(range.value)));
  const stepBtn = (delta, iconName, label) => h('button', { type: 'button', class: 'step', 'aria-label': `${label} ${STEP} g`, onClick: () => set(Math.max(0, grams + delta)) }, icon(iconName, 18));
  const quick = options.length
    ? h('div', { class: 'quick-row' }, options.map((o) => h('button', { type: 'button', class: 'chip-btn quick', onClick: () => set(o.grams) }, o.label)))
    : null;

  paint(false);
  return {
    get grams() { return grams; },
    el: h('div', { class: 'grams-control' }, totals.el, quick, field.el, h('div', { class: 'ing-ctrl' }, stepBtn(-STEP, 'minus', 'Quitar'), range, stepBtn(STEP, 'plus', 'Añadir'))),
  };
}
