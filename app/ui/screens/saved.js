/* foodie · Guardadas: meals you repeat, one tap to add them to the day you are looking at. */
import { h, toast } from '../dom.js';
import { icon } from '../icons.js';
import { sumItems, fmtNum } from '../../core/nutrition.js';
import { dayTitle } from '../../core/dates.js';

const MACROS = [
  { key: 'protein_g', label: 'Proteína', cls: 'is-protein' },
  { key: 'carbs_g', label: 'Carbos', cls: 'is-carbs' },
  { key: 'fat_g', label: 'Grasa', cls: 'is-fat' },
];

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string} o.selected  day the meals are added to
 * @param {string} o.today
 */
export function savedScreen({ store, selected, today }) {
  const saved = store.getSaved();
  const dayName = dayTitle(selected, today).toLowerCase();

  const add = (meal) => {
    const now = new Date();
    const copy = store.addMeal(selected, {
      name: meal.name, slot: meal.slot, source: meal.source, items: structuredClone(meal.items),
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    });
    if (copy) toast(`Añadida a ${dayName}`, { label: 'Deshacer', fn: () => store.deleteMeal(selected, copy.id) });
  };
  const remove = (meal) => {
    const removed = store.removeSaved(meal.id);
    if (removed) toast('Quitada de guardadas', { label: 'Deshacer', fn: () => store.saveMeal(removed, { keepId: true }) });
  };

  const row = (meal) => {
    const { totals } = sumItems(meal.items);
    return h('li', { class: 'saved-row' },
      h('button', { type: 'button', class: 'card meal saved-add', 'aria-label': `Añadir ${meal.name} a ${dayName}`, onClick: () => add(meal) },
        h('span', { class: 'meal-thumb' }, icon('plus', 24)),
        h('span', { class: 'meal-body' },
          h('span', { class: 'meal-name' }, meal.name),
          h('span', { class: 'small muted' }, `${meal.items.length} ${meal.items.length === 1 ? 'alimento' : 'alimentos'}, ${meal.slot}`),
          h('span', { class: 'meal-macros' }, MACROS.map((m) =>
            h('span', { class: `chip ${m.cls}` }, h('span', { class: 'sr-only' }, `${m.label}: `), `${fmtNum(totals[m.key])} g`)))),
        h('span', { class: 'meal-kcal' }, h('span', { class: 'num' }, fmtNum(totals.kcal)), h('span', { class: 'small muted' }, 'kcal'))),
      h('button', { type: 'button', class: 'icon-btn saved-del', 'aria-label': `Quitar ${meal.name} de guardadas`, onClick: () => remove(meal) }, icon('trash', 20)));
  };

  return [
    h('h1', { class: 'title' }, 'Guardadas'),
    saved.length
      ? h('p', { class: 'muted' }, `Toca una comida para añadirla a: ${dayTitle(selected, today)}.`)
      : null,
    saved.length
      ? h('ul', { class: 'meal-list' }, saved.map(row))
      : h('div', { class: 'card empty-state' },
        h('span', { class: 'empty-icon' }, icon('bookmark', 28)),
        h('h2', { class: 'section-title' }, 'Aún no tienes comidas guardadas'),
        h('p', { class: 'muted' }, 'Abre una comida en Inicio y pulsa Guardar en favoritas. Después podrás añadirla a cualquier día con un toque.')),
  ];
}
