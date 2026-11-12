/* foodie · what a scanned barcode shows: the product, how much of it, and "Añadir al día". From the scan to the log it is two taps:
   the scan itself (automatic) and this button. A product that cannot be found says so calmly and offers the two ways out. */
import { h, mount, openSheet, toast } from '../dom.js';
import { icon } from '../icons.js';
import { gramsControl } from '../grams-control.js';
import { slotSelector, hhmm } from '../meal-parts.js';
import { fmtNum } from '../../core/nutrition.js';
import { servingOptions, defaultGrams, sliderMax, missingNotes, productMeal } from '../../core/serving.js';

const PROBLEMS = {
  'not-found': ['No conocemos este producto', 'Open Food Facts todavía no tiene este código. Puedes buscarlo a mano o hacer una foto del plato.'],
  'no-nutrition': ['Este producto no trae datos nutricionales', 'Open Food Facts lo conoce, pero sin información de calorías ni macros. Puedes buscarlo a mano o hacer una foto del plato.'],
  offline: ['Sin conexión', 'No hemos podido consultar el producto y no lo habías escaneado antes. Vuelve a intentarlo con conexión, o búscalo a mano.'],
  timeout: ['Open Food Facts tarda en responder', 'Prueba otra vez en un momento, o búscalo a mano.'],
  error: ['No se pudo consultar el producto', 'Prueba otra vez en un momento, o búscalo a mano.'],
  invalid: ['Ese código no es de un producto', 'Prueba otra vez o búscalo a mano.'],
};
const RETRYABLE = new Set(['offline', 'timeout', 'error']);

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string} o.day  ISO day the meal is added to
 * @param {string} o.code  a valid product code (already checked by the scanner)
 * @param {{lookup:(code:string)=>Promise<object>}} o.offClient
 * @param {()=>void} o.onSearch  "Buscar a mano"
 * @param {()=>void} o.onPhoto   "Hacer una foto"
 */
export function openProduct({ store, day, code, offClient, onSearch, onPhoto }) {
  const body = h('div', { class: 'product' });
  const sheet = openSheet({ title: 'Producto', content: body });
  const attribution = h('p', { class: 'small muted product-credit' }, 'Datos de Open Food Facts, bajo licencia ODbL.');
  let closed = false;
  sheet.el.addEventListener('close', () => { closed = true; });

  const problem = (reason) => {
    const [title, text] = PROBLEMS[reason] || PROBLEMS.error;
    mount(body,
      h('div', { class: 'product-problem' },
        h('span', { class: 'empty-icon' }, icon('barcode', 28)),
        h('h3', { class: 'section-title' }, title),
        h('p', { class: 'muted' }, text),
        h('p', { class: 'small muted' }, `Código ${code}`)),
      h('div', { class: 'sheet-actions' },
        RETRYABLE.has(reason) ? h('button', { type: 'button', class: 'btn btn-primary', onClick: load }, 'Reintentar') : null,
        h('button', { type: 'button', class: `btn ${RETRYABLE.has(reason) ? 'btn-secondary' : 'btn-primary'}`, onClick: () => { sheet.close(); onSearch(); } }, icon('search', 20), 'Buscar a mano'),
        h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => { sheet.close(); onPhoto(); } }, icon('camera', 20), 'Hacer una foto')));
  };

  const result = (product) => {
    const options = servingOptions(product);
    let grams = defaultGrams(product);
    const max = sliderMax(product, grams);
    const slot = slotSelector();
    const add = h('button', { type: 'button', class: 'btn btn-primary' }, 'Añadir al día');
    const control = gramsControl({
      per100: product.per100, name: product.name, grams, max, options,
      onChange: (g) => { grams = g; add.disabled = !g; },
    });
    add.addEventListener('click', () => {
      if (!grams) return;
      const meal = store.addMeal(day, productMeal(product, grams, { slot: slot.value, time: hhmm() }));
      sheet.close();
      if (meal) toast('Comida añadida', { label: 'Deshacer', fn: () => store.deleteMeal(day, meal.id) });
      else toast('No se pudo guardar la comida. Ese día puede tener ya 100 comidas.');
    });
    const notes = missingNotes(product);
    mount(body,
      h('div', { class: 'product-head' },
        product.imageUrl ? h('img', { class: 'product-img', src: product.imageUrl, alt: '', width: 64, height: 64, referrerpolicy: 'no-referrer', loading: 'lazy', onError: (e) => e.target.remove() }) : null,
        h('div', { class: 'product-title' },
          h('h3', { class: 'section-title' }, product.name),
          product.brand ? h('p', { class: 'muted' }, product.brand) : null,
          h('p', { class: 'small muted' }, `Por 100 g: ${fmtNum(product.per100.kcal)} kcal`))),
      control.el,
      notes.length ? h('div', { class: 'product-notes small muted' }, notes.map((n) => h('p', null, n))) : null,
      slot.el,
      attribution,
      h('div', { class: 'sheet-actions' }, add, h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => sheet.close() }, 'Cancelar')));
  };

  async function load() {
    mount(body, h('p', { class: 'muted', role: 'status' }, 'Buscando el producto…'), h('div', { class: 'skeleton-rows', 'aria-hidden': 'true' },
      h('span', { class: 'skeleton w-70' }), h('span', { class: 'skeleton w-45' }), h('span', { class: 'skeleton w-60' })));
    const r = await offClient.lookup(code);
    if (closed) return;
    if (r.ok) result(r.product); else problem(r.reason);
  }
  load();
  return sheet;
}
