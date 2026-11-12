/* foodie · Home: the day at a glance. Calories left, the three macros, water, steps, vitamins and minerals, and the meals. */
import { h, openSheet, toast } from '../dom.js';
import { icon } from '../icons.js';
import { ring } from '../ring.js';
import { dayStrip } from '../daystrip.js';
import { mealEditor } from '../meal-editor.js';
import { numberField } from '../fields.js';
import { NUTRIENTS, sumItems, sumMeals, microCoverage, progress, fmtNum, fmtAmount } from '../../core/nutrition.js';
import { microTargets } from '../../core/goals.js';
import { dayTitle, addDays, isIso } from '../../core/dates.js';

const MACROS = [
  { key: 'protein_g', label: 'Proteína', cls: 'is-protein', color: 'var(--protein)' },
  { key: 'carbs_g', label: 'Carbos', cls: 'is-carbs', color: 'var(--carbs)' },
  { key: 'fat_g', label: 'Grasa', cls: 'is-fat', color: 'var(--fat)' },
];
const SOURCE_ICON = { ai: 'camera', barcode: 'barcode', label: 'label', db: 'search', manual: 'search' };
const MICRO_GROUPS = [['other', 'Fibra, azúcares y grasa saturada'], ['mineral', 'Minerales'], ['vitamin', 'Vitaminas']];
let microsOpen = false; // survives redraws, so adding water does not fold the panel
const nfLitres = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2, useGrouping: 'always' });
const litres = (ml) => nfLitres.format(ml / 1000);

/** "hoy", "ayer" or "el martes 3 de noviembre", for sentences. */
const inDay = (iso, today) => (iso === today ? 'hoy' : iso === addDays(today, -1) ? 'ayer' : `el ${dayTitle(iso, today)}`);

function calorieCard(totals, goals, fresh) {
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
      size: 124, stroke: 13, value: p, color: over ? 'var(--warn)' : null, animate: fresh,
      label: `${Math.round(p * 100)} % del objetivo de calorías`,
      center: h('span', { class: 'num hero-pct' }, `${Math.round(p * 100)} %`),
    }));
}

function macroCard(m, totals, goals, fresh) {
  const eaten = totals[m.key];
  const left = goals[m.key] - eaten;
  return h('section', { class: `card macro ${m.cls}`, 'aria-label': m.label },
    ring({ size: 52, stroke: 6, value: progress(eaten, goals[m.key]), color: m.color, animate: fresh,
      label: `${fmtNum(eaten)} de ${fmtNum(goals[m.key])} g de ${m.label.toLowerCase()}` }),
    h('p', { class: 'num macro-num' }, fmtNum(Math.abs(left)), h('span', { class: 'unit' }, ' g')),
    h('p', { class: 'macro-label' }, m.label, ' ', h('span', { class: 'muted' }, left < 0 ? 'de más' : 'restante')));
}

// ---------- water and steps ----------

function waterSheet({ store, selected, day, goals }) {
  const field = numberField({ label: 'Agua bebida en total, en ml', unit: 'ml', inputmode: 'numeric', value: day.waterMl,
    hint: `Tu objetivo son ${litres(goals.waterL * 1000)} litros.` });
  field.input.addEventListener('input', () => field.setError(''));
  const sheet = openSheet({
    title: 'Corregir el agua',
    content: h('form', { class: 'sheet-form', novalidate: true, onSubmit: (e) => {
      e.preventDefault();
      const v = field.read();
      if (v === null || v < 0 || v > 20000) { field.setError('Escribe los mililitros bebidos, entre 0 y 20.000. Por ejemplo: 1500.'); return; }
      store.setWater(selected, v);
      sheet.close();
    } },
    field.el,
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Guardar'),
    h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => { store.setWater(selected, 0); sheet.close(); } }, 'Poner a cero')),
  });
  field.input.focus();
}

function waterCard({ store, selected, day, goals, fresh }) {
  const target = goals.waterL * 1000;
  const p = progress(day.waterMl, target);
  const add = (ml) => {
    store.addWater(selected, ml);
    toast(`Añadidos ${ml} ml de agua`, { label: 'Deshacer', fn: () => store.addWater(selected, -ml) });
  };
  const quick = (ml) => h('button', { type: 'button', class: 'chip-btn', dataset: { focus: `water-${ml}` }, onClick: () => add(ml) }, `+${ml} ml`);
  return h('section', { class: 'card tracker', 'aria-label': 'Agua' },
    h('div', { class: 'tracker-head' },
      ring({ size: 56, stroke: 7, value: p, animate: fresh, label: `${Math.round(p * 100)} % del objetivo de agua`, center: icon('drop', 22) }),
      h('div', { class: 'tracker-text' },
        h('p', { class: 'tracker-title' }, 'Agua'),
        h('p', { class: 'num tracker-num' }, litres(day.waterMl), h('span', { class: 'unit' }, ` de ${litres(target)} litros`)))),
    h('div', { class: 'tracker-actions' }, quick(250), quick(500),
      h('button', { type: 'button', class: 'chip-btn chip-btn-quiet', dataset: { focus: 'water-fix' }, onClick: () => waterSheet({ store, selected, day, goals }) }, 'Corregir')));
}

function stepsSheet({ store, selected, day, goals }) {
  const field = numberField({ label: 'Pasos de este día', unit: 'pasos', inputmode: 'numeric', value: day.steps || '',
    hint: `Tu objetivo son ${fmtNum(goals.steps)} pasos.` });
  field.input.addEventListener('input', () => field.setError(''));
  const sheet = openSheet({
    title: 'Anotar los pasos',
    content: h('form', { class: 'sheet-form', novalidate: true, onSubmit: (e) => {
      e.preventDefault();
      const v = field.read();
      if (v === null || v < 0 || v > 200000) { field.setError('Escribe los pasos del día, entre 0 y 200.000. Por ejemplo: 7500.'); return; }
      store.setSteps(selected, v);
      sheet.close();
    } },
    field.el,
    h('p', { class: 'small muted' }, 'Por ahora los pasos se escriben a mano. Puedes mirarlos en la app de salud de tu móvil.'),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Guardar')),
  });
  field.input.focus();
}

function stepsCard({ store, selected, day, goals, fresh }) {
  const p = progress(day.steps, goals.steps);
  return h('button', { type: 'button', class: 'card tracker tracker-btn', dataset: { focus: 'steps' }, onClick: () => stepsSheet({ store, selected, day, goals }) },
    h('span', { class: 'tracker-head' },
      ring({ size: 56, stroke: 7, value: p, animate: fresh, label: `${Math.round(p * 100)} % del objetivo de pasos`, center: icon('steps', 22) }),
      h('span', { class: 'tracker-text' },
        h('span', { class: 'tracker-title' }, 'Pasos'),
        h('span', { class: 'num tracker-num' }, fmtNum(day.steps), h('span', { class: 'unit' }, ` de ${fmtNum(goals.steps)}`)))),
    h('span', { class: 'small muted' }, 'Toca para anotarlos. Por ahora los pasos se escriben a mano.'));
}

// ---------- vitamins and minerals ----------

function microPanel(totals, meals, targets) {
  const noData = [...new Set(meals.flatMap((m) => m.items).filter((it) => microCoverage(it.per100) < 0.5).map((it) => it.name))];
  const row = (n) => {
    const p = progress(totals[n.key], targets[n.key]);
    const over = n.limit && p > 1;
    return h('li', { class: 'micro' + (over ? ' is-over' : '') },
      h('span', { class: 'micro-name' }, n.label),
      h('span', { class: 'micro-val num' }, fmtAmount(totals[n.key], n.key)),
      h('span', { class: 'bar', role: 'img', 'aria-label': `${Math.round(p * 100)} % ${n.limit ? 'del máximo recomendado' : 'del valor de referencia'}` },
        h('span', { class: 'bar-fill', style: { width: `${Math.min(100, p * 100)}%` } })),
      h('span', { class: 'micro-pct num' }, `${Math.round(p * 100)} %`));
  };
  return h('details', { class: 'card micros', open: microsOpen, onToggle: (e) => { microsOpen = e.target.open; } },
    h('summary', null,
      h('span', null, h('span', { class: 'section-title' }, 'Vitaminas y minerales'),
        h('span', { class: 'small muted micros-hint' }, 'Porcentaje de tu valor de referencia diario')),
      icon('chevron', 22)),
    MICRO_GROUPS.map(([group, title]) => h('div', { class: 'micro-group' },
      h('h3', { class: 'micro-title' }, title),
      h('ul', null, NUTRIENTS.filter((n) => n.group === group && targets[n.key]).map(row)))),
    noData.length ? h('p', { class: 'small muted' },
      `${noData.join(', ')} no ${noData.length > 1 ? 'traen' : 'trae'} datos de vitaminas y minerales, así que los totales reales pueden ser algo mayores.`) : null);
}

// ---------- meals ----------

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
 * @param {ReturnType<import('../../data/store.js').createStore>} o.store
 * @param {string} o.selected  ISO day shown
 * @param {string} o.today
 * @param {boolean} o.fresh    first paint of this screen: rings fill in from zero (redraws keep them where they are)
 * @param {(iso:string)=>void} o.onSelect
 * @param {()=>void} o.onChange   something was edited silently: draw the day again
 * @param {()=>void} o.onAdd      open the "+" menu
 */
export function homeScreen({ store, selected, today, fresh, onSelect, onChange, onAdd }) {
  const goals = store.goalsFor(selected);
  const meals = store.mealsOf(selected);
  const day = store.getDay(selected);
  const { totals } = sumMeals(meals);
  const targets = microTargets(store.getProfile().sex);

  // ---- meal sheet: edit grams, duplicate, favourite, delete ----
  const openDuplicate = (meal) => {
    const start = selected === today ? addDays(today, -1) : today;
    const input = h('input', { type: 'date', class: 'input text-input', id: 'dup-date', value: start, max: today });
    const note = h('p', { class: 'field-error small', 'aria-live': 'polite' });
    const sheet = openSheet({
      title: 'Duplicar en otro día',
      content: h('form', { class: 'sheet-form', novalidate: true, onSubmit: (e) => {
        e.preventDefault();
        const iso = input.value;
        if (!isIso(iso) || iso > today) { note.textContent = 'Elige un día que ya haya llegado, por ejemplo hoy o ayer.'; return; }
        const copy = store.duplicateMeal(selected, meal.id, iso);
        sheet.close();
        if (copy) toast(`Comida duplicada ${inDay(iso, today)}`, iso === selected ? undefined : { label: 'Ver', fn: () => onSelect(iso) });
        else toast('No se pudo duplicar la comida. Ese día puede tener ya 100 comidas.');
      } },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'dup-date' }, 'Día'), input, note),
      h('div', { class: 'quick-row' },
        h('button', { type: 'button', class: 'chip-btn', onClick: () => { input.value = today; } }, 'Hoy'),
        h('button', { type: 'button', class: 'chip-btn', onClick: () => { input.value = addDays(today, -1); } }, 'Ayer')),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Duplicar')),
    });
  };

  const openMeal = (meal) => {
    const draft = structuredClone(meal);
    let dirty = false;
    const sheet = openSheet({
      title: meal.name,
      content: h('div', null,
        h('p', { class: 'small muted sheet-lead' }, meal.source === 'ai'
          ? `Estimado a partir de la foto, con una confianza del ${Math.round((meal.confidence || 0) * 100)} %. Corrige los gramos si no cuadran.`
          : 'Ajusta los gramos de cada ingrediente.'),
        mealEditor(draft, () => { dirty = true; store.updateMeal(selected, draft, { silent: true }); }),
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => { sheet.close(); openDuplicate(draft); } }, icon('copy', 20), 'Duplicar en otro día'),
          h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => {
            const r = store.saveMeal(draft);
            sheet.close();
            toast(!r ? 'No se pudo guardar la comida.' : r.added ? 'Guardada en favoritas' : r.full ? 'Ya tienes 300 comidas guardadas. Quita alguna para guardar otra.' : 'Ya estaba en favoritas');
          } }, icon('bookmark', 20), 'Guardar en favoritas'),
          h('button', { type: 'button', class: 'btn btn-quiet btn-delete', onClick: () => {
            sheet.close();
            const removed = store.deleteMeal(selected, meal.id);
            if (removed) toast('Comida eliminada', { label: 'Deshacer', fn: () => store.addMeal(selected, removed) });
          } }, icon('trash', 20), 'Eliminar'))),
      onClose: () => { if (dirty) onChange(); },
    });
  };

  const isToday = selected === today;
  return [
    h('h1', { class: 'title' }, dayTitle(selected, today)),
    dayStrip({
      selected, today, onSelect, animate: fresh,
      progressOf: (iso) => progress(sumMeals(store.mealsOf(iso)).totals.kcal, store.goalsFor(iso).kcal),
    }),
    calorieCard(totals, goals, fresh),
    h('div', { class: 'macros' }, MACROS.map((m) => macroCard(m, totals, goals, fresh))),
    waterCard({ store, selected, day, goals, fresh }),
    stepsCard({ store, selected, day, goals, fresh }),
    microPanel(totals, meals, targets),
    h('section', { class: 'meals', 'aria-label': 'Comidas del día' },
      h('h2', { class: 'section-title' }, isToday ? 'Comidas de hoy' : 'Comidas'),
      meals.length
        ? h('ul', { class: 'meal-list' }, meals.map((m) => mealRow(m, openMeal)))
        : h('div', { class: 'card empty-state' },
          h('span', { class: 'empty-icon' }, icon('plus', 28)),
          h('h3', { class: 'section-title' }, isToday ? 'Todavía no has comido nada hoy' : 'No hay comidas este día'),
          h('p', { class: 'muted' }, isToday
            ? 'Añade tu primera comida: busca un alimento y en segundos verás sus calorías y macros.'
            : 'Si te acuerdas de lo que comiste, puedes añadirlo ahora.'),
          h('button', { type: 'button', class: 'btn btn-primary empty-cta', onClick: onAdd }, icon('plus', 20), isToday ? 'Añadir la primera comida' : 'Añadir una comida'))),
  ];
}

