/* foodie · add food without AI: search a basic food, choose the grams, add more foods, pick the meal, done.
   Everything happens in one bottom sheet; the table of foods is fetched once and cached by the service worker. */
import { h, mount, openSheet, toast } from '../dom.js';
import { icon } from '../icons.js';
import { numberField } from '../fields.js';
import { buildIndex, searchFoods } from '../../core/search.js';
import { scale, sumItems, fmtNum } from '../../core/nutrition.js';
import { defaultSlot, SLOTS, cleanFood } from '../../core/schema.js';
import { dayTitle, addDays } from '../../core/dates.js';
import { recentMeals, copyOfMeal } from '../../core/recents.js';

const FOODS_URL = 'data/foods.es.json';
const MAX_GRAMS = 5000;
const MAX_FOODS = 2000;
const STEP = 5;
const pad = (n) => String(n).padStart(2, '0');

let foodsPromise = null;
/** Table of foods, indexed for search. Fetched once; a failed fetch is retried next time. */
function loadFoods() {
  if (!foodsPromise) {
    foodsPromise = fetch(FOODS_URL)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      // every field goes through the same cleaning as text typed by the user before it can reach a meal or the screen
      .then((list) => buildIndex((Array.isArray(list) ? list.slice(0, MAX_FOODS) : []).map(cleanFood).filter(Boolean)))
      .catch((e) => { foodsPromise = null; throw e; });
  }
  return foodsPromise;
}

const kcalOf = (food, grams) => scale(food.per100, grams).kcal || 0;
const roundStep = (g) => Math.max(STEP, Math.round(g / STEP) * STEP);
const sliderMax = (food, grams) => Math.max(500, Math.ceil(Math.max(food.portion.grams * 4, grams * 2) / STEP) * STEP);

function totalsBox(read) {
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

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string} o.day     ISO day the meal is added to
 * @param {string} o.today
 * @param {string} [o.notice]  one calm line shown above the search (why the person landed here)
 */
export function openAddFood({ store, day, today, notice = '' }) {
  /** @type {{food:object, grams:number}[]} */
  const basket = [];
  let slot = defaultSlot(new Date().getHours());
  let mealName = null;               // null: use the automatic name
  let index = null;
  const body = h('div', { class: 'addfood' });
  const sheet = openSheet({ title: 'Añadir alimento', content: body });
  const show = (...nodes) => mount(body, ...nodes);

  const basketTotals = () => sumItems(basket.map((b) => ({ grams: b.grams, per100: b.food.per100 }))).totals;
  const autoName = () => {
    const names = basket.slice(0, 3).map((b) => b.food.name);
    return names.join(', ') + (basket.length > 3 ? ` y ${basket.length - 3} más` : '');
  };

  // ---------- one-tap repeats: what was eaten lately, and the day before ----------
  /** Adds copies of `meals` to the day and closes the sheet; the toast can undo all of them. */
  function repeat(meals, text) {
    const added = [];
    for (const m of meals) {
      const copy = store.addMeal(day, copyOfMeal(m, meals.length === 1 ? defaultSlot(new Date().getHours()) : undefined));
      if (copy) added.push(copy);
    }
    sheet.close();
    if (added.length) toast(text(added.length), { label: 'Deshacer', fn: () => { for (const c of added) store.deleteMeal(day, c.id); } });
    else toast('No se pudo añadir la comida. Ese día puede tener ya 100 comidas.');
  }

  function recentsBlock() {
    const before = addDays(day, -1);
    const yesterday = store.mealsOf(before).filter((m) => m.items && m.items.length);
    const recents = recentMeals(store);
    if (!yesterday.length && !recents.length) return null;
    const yKcal = fmtNum(yesterday.reduce((sum, m) => sum + sumItems(m.items).totals.kcal, 0));
    return h('div', { class: 'recents' },
      yesterday.length ? h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => repeat(yesterday, (n) => `${n} ${n === 1 ? 'comida repetida' : 'comidas repetidas'}`) },
        icon('copy', 20), day === today ? 'Repetir lo de ayer' : 'Repetir el día anterior', h('span', { class: 'small muted' }, `${yesterday.length} ${yesterday.length === 1 ? 'comida' : 'comidas'}, ${yKcal} kcal`)) : null,
      recents.length ? h('h3', { class: 'section-title recents-title' }, 'Recientes') : null,
      recents.length ? h('ul', { class: 'food-list' }, recents.map(({ meal, kcal }) => h('li', null,
        h('button', { type: 'button', class: 'food-row', 'aria-label': `Añadir ${meal.name} otra vez, ${fmtNum(kcal)} kcal`, onClick: () => repeat([meal], () => 'Comida añadida') },
          h('span', { class: 'food-name' }, meal.name),
          h('span', { class: 'small muted' }, `${meal.items.length} ${meal.items.length === 1 ? 'alimento' : 'alimentos'}, ${fmtNum(kcal)} kcal`),
          icon('plus', 20))))) : null);
  }

  // ---------- step 1: search ----------
  function searchStep(query = '') {
    if (!index) {
      show(h('p', { class: 'muted', 'aria-live': 'polite' }, 'Cargando alimentos…'));
      loadFoods().then((i) => { index = i; searchStep(query); }).catch(() => show(
        h('p', { class: 'field-error' }, 'No se pudo cargar la lista de alimentos. Comprueba tu conexión y vuelve a intentarlo.'),
        h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => searchStep(query) }, 'Reintentar')));
      return;
    }
    const input = h('input', {
      type: 'search', class: 'input text-input', id: 'food-q', placeholder: 'Pollo, arroz, manzana…', value: query,
      inputmode: 'search', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Buscar alimento',
    });
    const results = h('ul', { class: 'food-list' });
    const status = h('p', { class: 'small muted', 'aria-live': 'polite' });
    const recents = basket.length ? null : recentsBlock();        // not while a meal is being put together: the basket is the task then
    const paint = () => {
      if (recents) recents.hidden = !!input.value.trim();
      const found = searchFoods(index, input.value, 60);
      mount(results, found.map((food) => h('li', null, h('button', { type: 'button', class: 'food-row', onClick: () => gramsStep(food, null) },
        h('span', { class: 'food-name' }, food.name),
        h('span', { class: 'small muted' }, `${food.portion.label}: ${fmtNum(kcalOf(food, food.portion.grams))} kcal`),
        icon('right', 20)))));
      status.textContent = input.value.trim() && !found.length
        ? `No hemos encontrado «${input.value.trim()}». Prueba con otra palabra, por ejemplo el nombre en singular.`
        : input.value.trim() ? `${found.length} ${found.length === 1 ? 'resultado' : 'resultados'}` : '';
    };
    input.addEventListener('input', paint);
    show(
      notice ? h('p', { class: 'note small' }, notice) : null,
      h('p', { class: 'small muted sheet-lead' }, `Se añadirá al día: ${dayTitle(day, today)}. Los valores son medias de tablas de composición.`),
      input, status, recents, results,
      basket.length ? h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: reviewStep },
          `Terminar la comida (${basket.length} ${basket.length === 1 ? 'alimento' : 'alimentos'}, ${fmtNum(basketTotals().kcal)} kcal)`)) : null);
    paint();
    input.focus();
  }

  // ---------- step 2: grams ----------
  function gramsStep(food, editIdx) {
    let grams = editIdx === null ? food.portion.grams : basket[editIdx].grams;
    const max = sliderMax(food, grams);
    const field = numberField({ label: 'Gramos', unit: 'g', inputmode: 'decimal', value: grams });
    const range = h('input', { type: 'range', class: 'range', min: 0, max, step: STEP, value: grams, 'aria-label': `Gramos de ${food.name}` });
    const addBtn = h('button', { type: 'button', class: 'btn btn-primary' }, editIdx === null ? 'Añadir a la comida' : 'Guardar cambios');
    const totals = totalsBox(() => scale(food.per100, grams));

    const paint = (fromField) => {
      if (!fromField) field.setValue(grams);
      range.value = grams;
      range.style.setProperty('--fill', `${Math.min(100, (grams / max) * 100)}%`);
      totals.paint();
    };
    const setGrams = (g, fromField = false) => {
      grams = Math.min(MAX_GRAMS, Math.max(0, Math.round(g * 10) / 10));
      field.setError('');
      addBtn.disabled = grams <= 0;
      paint(fromField);
    };
    field.input.addEventListener('input', () => {
      const v = field.read();
      if (v === null || v <= 0 || v > MAX_GRAMS) { field.setError(`Escribe los gramos, un número entre 1 y ${fmtNum(MAX_GRAMS)}.`); addBtn.disabled = true; return; }
      setGrams(v, true);
    });
    range.addEventListener('input', () => setGrams(Number(range.value)));
    const quick = (label, factor) => {
      const g = roundStep(food.portion.grams * factor);
      return h('button', { type: 'button', class: 'chip-btn quick', onClick: () => setGrams(g) }, label, h('span', { class: 'small muted' }, `${fmtNum(g)} g`));
    };
    const stepBtn = (delta, name, label) => h('button', { type: 'button', class: 'step', 'aria-label': `${label} ${STEP} g`, onClick: () => setGrams(Math.max(0, grams + delta)) }, icon(name, 18));

    addBtn.addEventListener('click', () => {
      if (grams <= 0) return;
      if (editIdx === null) basket.push({ food, grams }); else basket[editIdx].grams = grams;
      if (editIdx === null) searchStep(''); else reviewStep();
    });
    show(
      h('h3', { class: 'section-title food-title' }, food.name),
      h('p', { class: 'small muted' }, `Ración habitual: ${food.portion.label}`),
      totals.el,
      field.el,
      h('div', { class: 'quick-row' }, quick('½ ración', 0.5), quick('1 ración', 1), quick('2 raciones', 2)),
      h('div', { class: 'ing-ctrl' }, stepBtn(-STEP, 'minus', 'Quitar'), range, stepBtn(STEP, 'plus', 'Añadir')),
      h('div', { class: 'sheet-actions' }, addBtn,
        h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => (editIdx === null ? searchStep('') : reviewStep()) }, 'Volver')));
    paint(false);
    setGrams(grams);
  }

  // ---------- step 3: review, meal and "Añadir al día" ----------
  function reviewStep() {
    if (!basket.length) { searchStep(''); return; }
    const t = totalsBox(basketTotals);
    t.paint();
    const nameInput = h('input', { type: 'text', class: 'input text-input', id: 'meal-name', maxlength: 80, value: mealName === null ? autoName() : mealName });
    nameInput.addEventListener('input', () => { mealName = nameInput.value; });
    const rows = basket.map((b, k) => h('li', { class: 'basket-row' },
      h('button', { type: 'button', class: 'basket-main', 'aria-label': `Cambiar los gramos de ${b.food.name}`, onClick: () => gramsStep(b.food, k) },
        h('span', { class: 'food-name' }, b.food.name),
        h('span', { class: 'small muted' }, `${fmtNum(b.grams)} g, ${fmtNum(kcalOf(b.food, b.grams))} kcal`)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Quitar ${b.food.name}`, onClick: () => { basket.splice(k, 1); reviewStep(); } }, icon('trash', 20))));

    const add = () => {
      const meal = store.addMeal(day, {
        name: (nameInput.value.trim() || autoName()), slot, source: 'db',
        time: `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`,
        items: basket.map((b) => ({ name: b.food.name, grams: b.grams, gramsMin: 0, gramsMax: sliderMax(b.food, b.grams), per100: b.food.per100 })),
      });
      sheet.close();
      if (meal) toast('Comida añadida', { label: 'Deshacer', fn: () => store.deleteMeal(day, meal.id) });
      else toast('No se pudo guardar la comida. Ese día puede tener ya 100 comidas.');
    };
    show(
      h('h3', { class: 'section-title food-title' }, 'Tu comida'),
      t.el,
      h('ul', { class: 'basket' }, rows),
      h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => searchStep('') }, icon('plus', 20), 'Añadir otro alimento'),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'meal-name' }, 'Nombre'), nameInput),
      h('fieldset', { class: 'seg-field' },
        h('legend', { class: 'field-label' }, 'Qué comida es'),
        h('div', { class: 'seg seg-4' }, SLOTS.map((s) => h('label', null,
          h('input', { type: 'radio', name: 'slot', value: s, checked: s === slot, class: 'sr-only', onChange: () => { slot = s; } }),
          h('span', null, s))))),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: add }, 'Añadir al día'),
        h('p', { class: 'small muted center' }, `Día: ${dayTitle(day, today)}.`)));
  }

  searchStep('');
  return sheet;
}
