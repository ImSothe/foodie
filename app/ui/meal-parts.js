/* foodie · small pieces shared by the screens that add a meal: the totals box and the meal-slot selector. */
import { h } from './dom.js';
import { fmtNum } from '../core/nutrition.js';
import { SLOTS, defaultSlot } from '../core/schema.js';

/** kcal and the three macros, repainted by `paint()` from whatever `read()` returns ({ kcal, protein_g, carbs_g, fat_g }). */
export function totalsBox(read) {
  const stat = (cls, label) => {
    const value = h('span', { class: 'num' });
    return { value, el: h('div', { class: `total ${cls}` }, value, h('span', { class: 'small muted' }, label)) };
  };
  const kcal = stat('total-kcal', 'kcal');
  const p = stat('is-protein', 'Proteína');
  const c = stat('is-carbs', 'Carbos');
  const f = stat('is-fat', 'Grasa');
  return {
    el: h('div', { class: 'totals', 'aria-live': 'polite' }, kcal.el, p.el, c.el, f.el),
    paint() {
      const t = read();
      kcal.value.textContent = fmtNum(t.kcal);
      p.value.textContent = `${fmtNum(t.protein_g)} g`;
      c.value.textContent = `${fmtNum(t.carbs_g)} g`;
      f.value.textContent = `${fmtNum(t.fat_g)} g`;
    },
  };
}

/** The four meals as a segmented control, preselected by the time of day: nobody has to touch it for the usual case. */
export function slotSelector(initial = defaultSlot(new Date().getHours()), name = 'slot') {
  let value = initial;
  return {
    get value() { return value; },
    el: h('fieldset', { class: 'seg-field' },
      h('legend', { class: 'sr-only' }, 'Qué comida es'),
      h('div', { class: 'seg seg-4' }, SLOTS.map((s) => h('label', null,
        h('input', { type: 'radio', name, value: s, checked: s === value, class: 'sr-only', onChange: () => { value = s; } }),
        h('span', null, s))))),
  };
}

export const hhmm = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
