/* foodie · ingredient editor. Each ingredient keeps its composition per 100 g, so changing its grams (typed, slider or steps)
   only changes one number and every figure on screen is recalculated locally: no network, no AI call.
   The slider starts from the range an estimate suggested but is never a wall: type any amount up to MAX_GRAMS, or remove an ingredient
   the estimate invented. */
import { h, mount } from './dom.js';
import { icon } from './icons.js';
import { scale, sumItems, clampGrams, fmtNum } from '../core/nutrition.js';
import { toNum } from '../core/goals.js';

const STEP = 5;
export const MAX_GRAMS = 5000;
const roundUp = (n) => Math.ceil(n / STEP) * STEP;
/** Slider maximum for an ingredient: the estimate's upper range, at least double the current amount, never less than 100 g. */
export const sliderMaxFor = (item) => Math.min(MAX_GRAMS, Math.max(roundUp(item.gramsMax ?? 0), roundUp(item.grams * 2), 100));

function ingredientRow(item, onChange, onRemove) {
  let max = sliderMaxFor(item);
  const kcal = h('span', { class: 'ing-kcal muted small' });
  const field = h('input', {
    type: 'text', class: 'input num ing-input', inputmode: 'decimal', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    'aria-label': `Gramos de ${item.name}`, value: String(item.grams).replace('.', ','),
  });
  const range = h('input', { type: 'range', class: 'range', min: 0, max, step: STEP, value: item.grams, 'aria-label': `Gramos de ${item.name} (deslizador)` });

  const paint = ({ keepField = false } = {}) => {
    if (item.grams > max) max = sliderMaxFor(item);
    range.max = String(max);
    range.value = item.grams;
    range.style.setProperty('--fill', `${Math.min(100, (item.grams / max) * 100)}%`);
    if (!keepField) field.value = String(item.grams).replace('.', ',');
    kcal.textContent = `${fmtNum(scale(item.per100, item.grams).kcal || 0)} kcal`;
  };
  const set = (g, o) => { item.grams = Math.min(MAX_GRAMS, Math.max(0, Math.round(g * 10) / 10)); paint(o); onChange(); };

  range.addEventListener('input', () => set(Number(range.value)));
  field.addEventListener('input', () => {
    const v = toNum(field.value);
    if (v === null || v < 0 || v > MAX_GRAMS) { field.setAttribute('aria-invalid', 'true'); return; }     // wait: the person is still typing
    field.removeAttribute('aria-invalid');
    set(v, { keepField: true });
  });
  field.addEventListener('blur', () => { field.removeAttribute('aria-invalid'); paint(); });                // show the amount that counts
  const stepBtn = (delta, name, label) => h('button', {
    type: 'button', class: 'step', 'aria-label': `${label} ${STEP} g de ${item.name}`,
    onClick: () => set(clampGrams(item.grams + delta, 0, MAX_GRAMS, STEP)),
  }, icon(name, 18));

  paint();
  return h('li', { class: 'ing' },
    h('div', { class: 'ing-head' },
      h('span', { class: 'ing-name' }, item.name),
      h('span', { class: 'ing-amount' }, field, h('span', { class: 'field-unit', 'aria-hidden': 'true' }, 'g'))),
    h('div', { class: 'ing-ctrl' }, stepBtn(-STEP, 'minus', 'Quitar'), range, stepBtn(STEP, 'plus', 'Añadir')),
    h('div', { class: 'ing-foot' },
      onRemove ? h('button', { type: 'button', class: 'chip-btn chip-btn-quiet ing-remove', 'aria-label': `Quitar ${item.name} de la comida`, onClick: onRemove }, icon('trash', 16), 'Quitar') : h('span'),
      kcal));
}

/** @returns {HTMLElement} editor for `meal.items`; calls `onChange()` after every edit (a removed ingredient included). */
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

  const list = h('ul', { class: 'ings' });
  function drawList() {
    mount(list, meal.items.map((it) => ingredientRow(it, changed, meal.items.length > 1 ? () => {
      const at = meal.items.indexOf(it);
      if (at < 0 || meal.items.length < 2) return;                     // a meal keeps at least one ingredient
      meal.items.splice(at, 1);
      drawList();
      changed();
    } : null)));
  }

  paintTotals();
  drawList();
  return h('div', { class: 'meal-editor' }, h('div', { class: 'totals', 'aria-live': 'polite' }, kcal.el, p.el, c.el, f.el), list);
}
