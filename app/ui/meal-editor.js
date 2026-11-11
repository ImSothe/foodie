/* foodie · ingredient editor. Each ingredient keeps its composition per 100 g, so moving a slider only
   changes grams and every number on screen is recalculated locally: no network, no AI call. */
import { h } from './dom.js';
import { icon } from './icons.js';
import { scale, sumItems, clampGrams, fmtNum } from '../core/nutrition.js';

const STEP = 5;

function ingredientRow(item, onChange) {
  const min = item.gramsMin ?? 0;
  const max = item.gramsMax ?? Math.max(500, item.grams * 2);
  const grams = h('span', { class: 'num ing-grams' });
  const kcal = h('span', { class: 'ing-kcal muted small' });
  const range = h('input', {
    type: 'range', class: 'range', min, max, step: STEP, value: item.grams,
    'aria-label': `Gramos de ${item.name}`,
  });

  const paint = () => {
    grams.textContent = `${fmtNum(item.grams)} g`;
    kcal.textContent = `${fmtNum(scale(item.per100, item.grams).kcal || 0)} kcal`;
    range.value = item.grams;
    range.style.setProperty('--fill', `${max > min ? ((item.grams - min) / (max - min)) * 100 : 0}%`);
  };
  const set = (g) => { item.grams = clampGrams(g, min, max, STEP); paint(); onChange(); };

  range.addEventListener('input', () => set(Number(range.value)));
  const stepBtn = (delta, name, label) => h('button', {
    type: 'button', class: 'step', 'aria-label': `${label} ${STEP} g de ${item.name}`, onClick: () => set(item.grams + delta),
  }, icon(name, 18));

  paint();
  return h('li', { class: 'ing' },
    h('div', { class: 'ing-head' }, h('span', { class: 'ing-name' }, item.name), grams),
    h('div', { class: 'ing-ctrl' }, stepBtn(-STEP, 'minus', 'Quitar'), range, stepBtn(STEP, 'plus', 'Añadir')),
    kcal);
}

/** @returns {HTMLElement} editor for `meal.items`; calls `onChange()` after every edit. */
export function mealEditor(meal, onChange = () => {}) {
  const stat = (cls, label) => {
    const value = h('span', { class: 'num' });
    return { value, el: h('div', { class: `total ${cls}` }, value, h('span', { class: 'small muted' }, label)) };
  };
  const kcal = stat('total-kcal', 'kcal');
  const p = stat('is-protein', 'Proteína');
  const c = stat('is-carbs', 'Carbos');
  const f = stat('is-fat', 'Grasa');

  const paintTotals = () => {
    const { totals } = sumItems(meal.items);
    kcal.value.textContent = fmtNum(totals.kcal);
    p.value.textContent = `${fmtNum(totals.protein_g)} g`;
    c.value.textContent = `${fmtNum(totals.carbs_g)} g`;
    f.value.textContent = `${fmtNum(totals.fat_g)} g`;
  };
  const changed = () => { paintTotals(); onChange(); };

  paintTotals();
  return h('div', { class: 'meal-editor' },
    h('div', { class: 'totals', 'aria-live': 'polite' }, kcal.el, p.el, c.el, f.el),
    h('ul', { class: 'ings' }, meal.items.map((it) => ingredientRow(it, changed))));
}
