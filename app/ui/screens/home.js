/* foodie · Home: the day at a glance. Calories left, the three macros, vitamins and minerals, and the meals. */
import { h, openSheet } from '../dom.js';
import { icon } from '../icons.js';
import { ring } from '../ring.js';
import { dayStrip } from '../daystrip.js';
import { mealEditor } from '../meal-editor.js';
import { NUTRIENTS, sumItems, sumMeals, microCoverage, progress, fmtNum, fmtAmount } from '../../core/nutrition.js';
import { dayTitle } from '../../core/dates.js';

const MACROS = [
  { key: 'protein_g', label: 'Proteína', cls: 'is-protein', color: 'var(--protein)' },
  { key: 'carbs_g', label: 'Carbos', cls: 'is-carbs', color: 'var(--carbs)' },
  { key: 'fat_g', label: 'Grasa', cls: 'is-fat', color: 'var(--fat)' },
];
const SOURCE_ICON = { ai: 'camera', barcode: 'barcode', label: 'label', db: 'search', manual: 'search' };
const MICRO_GROUPS = [['other', 'Fibra, azúcares y grasa saturada'], ['mineral', 'Minerales'], ['vitamin', 'Vitaminas']];

function calorieCard(totals, goals) {
  const left = goals.kcal - totals.kcal;
  const over = left < 0;
  const p = progress(totals.kcal, goals.kcal);
  return h('section', { class: 'card hero', 'aria-label': 'Calorías' },
    h('div', { class: 'hero-main' },
      h('p', { class: 'num hero-num' }, fmtNum(Math.abs(left))),
      h('p', { class: 'hero-label' }, over ? 'kcal por encima del objetivo' : 'kcal restantes'),
      h('dl', { class: 'hero-stats' },
        h('div', null, h('dt', null, 'Consumidas'), h('dd', { class: 'num' }, fmtNum(totals.kcal))),
        h('div', null, h('dt', null, 'Objetivo'), h('dd', { class: 'num' }, fmtNum(goals.kcal))))),
    ring({
      size: 124, stroke: 13, value: p, color: over ? 'var(--warn)' : null,
      label: `${Math.round(p * 100)} % del objetivo de calorías`,
      center: h('span', { class: 'num hero-pct' }, `${Math.round(p * 100)} %`),
    }));
}

function macroCard(m, totals, goals) {
  const eaten = totals[m.key];
  const left = goals[m.key] - eaten;
  return h('section', { class: `card macro ${m.cls}`, 'aria-label': m.label },
    ring({ size: 52, stroke: 6, value: progress(eaten, goals[m.key]), color: m.color,
      label: `${fmtNum(eaten)} de ${fmtNum(goals[m.key])} g de ${m.label.toLowerCase()}` }),
    h('p', { class: 'num macro-num' }, fmtNum(Math.abs(left)), h('span', { class: 'unit' }, ' g')),
    h('p', { class: 'macro-label' }, m.label, ' ', h('span', { class: 'muted' }, left < 0 ? 'de más' : 'restante')));
}

function microPanel(totals, meals) {
  const noData = [...new Set(meals.flatMap((m) => m.items).filter((it) => microCoverage(it.per100) < 0.5).map((it) => it.name))];
  const row = (n) => {
    const p = progress(totals[n.key], n.nrv);
    const over = n.limit && p > 1;
    return h('li', { class: 'micro' + (over ? ' is-over' : '') },
      h('span', { class: 'micro-name' }, n.label),
      h('span', { class: 'micro-val num' }, fmtAmount(totals[n.key], n.key)),
      h('span', { class: 'bar', role: 'img', 'aria-label': `${Math.round(p * 100)} % ${n.limit ? 'del máximo recomendado' : 'del valor de referencia'}` },
        h('span', { class: 'bar-fill', style: { width: `${Math.min(100, p * 100)}%` } })),
      h('span', { class: 'micro-pct num' }, `${Math.round(p * 100)} %`));
  };
  return h('details', { class: 'card micros' },
    h('summary', null,
      h('span', null, h('span', { class: 'section-title' }, 'Vitaminas y minerales'),
        h('span', { class: 'small muted micros-hint' }, 'Porcentaje del valor de referencia diario')),
      icon('chevron', 22)),
    MICRO_GROUPS.map(([group, title]) => h('div', { class: 'micro-group' },
      h('h3', { class: 'micro-title' }, title),
      h('ul', null, NUTRIENTS.filter((n) => n.group === group && n.nrv).map(row)))),
    noData.length ? h('p', { class: 'small muted' },
      `${noData.join(', ')} no ${noData.length > 1 ? 'traen' : 'trae'} datos de vitaminas y minerales, así que los totales reales pueden ser algo mayores.`) : null);
}

function mealRow(meal, onOpen) {
  const { totals } = sumItems(meal.items);
  return h('li', null, h('button', { type: 'button', class: 'card meal', onClick: () => onOpen(meal) },
    h('span', { class: 'meal-thumb' }, icon(SOURCE_ICON[meal.source] || 'search', 24)),
    h('span', { class: 'meal-body' },
      h('span', { class: 'meal-name' }, meal.name),
      h('span', { class: 'small muted' }, `${meal.slot}, ${meal.time}`),
      h('span', { class: 'meal-macros' }, MACROS.map((m) =>
        h('span', { class: `chip ${m.cls}` }, h('span', { class: 'sr-only' }, `${m.label}: `), `${fmtNum(totals[m.key])} g`)))),
    h('span', { class: 'meal-kcal' }, h('span', { class: 'num' }, fmtNum(totals.kcal)), h('span', { class: 'small muted' }, 'kcal'))));
}

/**
 * @param {object} o
 * @param {string} o.selected  ISO day shown
 * @param {string} o.today
 * @param {object} o.goals     daily goals { kcal, protein_g, carbs_g, fat_g }
 * @param {(iso:string)=>object[]} o.mealsOf
 * @param {(iso:string)=>void} o.onSelect
 * @param {()=>void} o.onChange   something was edited: draw the day again
 * @param {boolean} o.sample      the data on screen is sample data
 */
export function homeScreen({ selected, today, goals, mealsOf, onSelect, onChange, sample }) {
  const meals = mealsOf(selected);
  const { totals } = sumMeals(meals);

  const openMeal = (meal) => {
    let dirty = false;
    openSheet({
      title: meal.name,
      content: h('div', null,
        h('p', { class: 'small muted sheet-lead' }, meal.source === 'ai'
          ? `Estimado a partir de la foto, con una confianza del ${Math.round((meal.confidence || 0) * 100)} %. Corrige los gramos si no cuadran.`
          : 'Ajusta los gramos de cada ingrediente.'),
        mealEditor(meal, () => { dirty = true; })),
      onClose: () => { if (dirty) onChange(); },
    });
  };

  return [
    h('h1', { class: 'title' }, dayTitle(selected, today)),
    dayStrip({ selected, today, onSelect, progressOf: (iso) => progress(sumMeals(mealsOf(iso)).totals.kcal, goals.kcal) }),
    calorieCard(totals, goals),
    h('div', { class: 'macros' }, MACROS.map((m) => macroCard(m, totals, goals))),
    microPanel(totals, meals),
    h('section', { class: 'meals', 'aria-label': 'Comidas del día' },
      h('h2', { class: 'section-title' }, selected === today ? 'Comidas de hoy' : 'Comidas'),
      sample ? h('p', { class: 'note small' }, 'Vista previa del diseño: estas comidas son de ejemplo. Tus datos reales llegan al conectar tu cuenta.') : null,
      meals.length
        ? h('ul', { class: 'meal-list' }, meals.map((m) => mealRow(m, openMeal)))
        : h('p', { class: 'empty muted' }, selected > today
          ? 'Este día todavía no ha llegado.'
          : 'No hay nada registrado este día. Pulsa + para añadir una comida.')),
  ];
}
