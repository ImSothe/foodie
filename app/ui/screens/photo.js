/* foodie · from a photo to a logged meal. The photo is analysed by an AI model, the answer becomes one slider per ingredient, and the
   person fixes what is off and taps "Añadir al día". When the AI cannot tell what is on the plate (a wrapped burrito, a sealed package,
   something that is not food, a low confidence) it asks for context BEFORE showing numbers as if they were reliable.
   The photo lives in memory while this sheet is open and is never stored; only a 160 px thumbnail is kept with the meal. */
import { h, mount, openSheet, toast } from '../dom.js';
import { icon } from '../icons.js';
import { scanFrame } from '../scan-frame.js';
import { mealEditor } from '../meal-editor.js';
import { slotSelector, hhmm } from '../meal-parts.js';
import { googleSignInButton } from './cloud-card.js';
import { confidenceWord, needsContextScreen, visionMeal, MAX_CONTEXT } from '../../core/vision.js';

/** [title, text, retryable] for every reason an analysis can fail. */
const PROBLEMS = {
  quota: ['Se agotó el límite gratuito de hoy', 'El análisis de fotos es gratuito y tiene un límite diario compartido. Prueba mañana, o busca el alimento a mano.', false],
  offline: ['Sin conexión', 'Analizar una foto necesita internet. Puedes buscar el alimento a mano o escanear un código.', true],
  timeout: ['La IA tarda demasiado', 'No ha respondido a tiempo. Prueba otra vez.', true],
  busy: ['La IA está saturada ahora mismo', 'Prueba otra vez en un momento.', true],
  'app-check': ['La IA no está disponible ahora mismo', 'No hemos podido comprobar que la petición viene de la app. Busca a mano mientras tanto.', false],
  blocked: ['La IA no quiso analizar esta foto', 'Prueba con otra foto o busca el alimento a mano.', false],
  'bad-answer': ['No pudimos leer la respuesta de la IA', 'Prueba otra vez.', true],
  'bad-image': ['No pudimos leer esa imagen', 'Prueba con otra foto.', false],
  empty: ['No hemos encontrado comida', 'Ni con ese contexto hemos podido estimarlo. Busca el alimento a mano o prueba con otra foto.', false],
  error: ['No se pudo analizar la foto', 'Prueba otra vez en un momento, o busca el alimento a mano.', true],
};

const CONTEXT_COPY = {
  'not-food': ['No parece que haya comida', 'No hemos visto comida en la foto. Cuéntanos qué es y lo calculamos.'],
  'needs-context': ['No se ve qué lleva', 'Dentro no se ve qué hay. Cuéntanos qué es o qué lleva para calcularlo bien.'],
  'low-confidence': ['No estamos muy seguros', 'La foto no deja ver bien el plato. Si nos cuentas qué es, la estimación mejora.'],
};

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string} o.day
 * @param {object} o.cloud    needs `user`, `onChange`, `prepare`, `signIn`
 * @param {object} o.vision   from data/vision.js
 * @param {Blob} o.picture    the photo as taken or chosen
 * @param {boolean} [o.label] the picture is a nutrition table (the same analysis, with a different instruction)
 * @param {()=>void} o.onSearch
 * @param {(mode:'photo'|'code')=>void} o.onRetake
 */
export function openPhoto({ store, day, cloud, vision, picture, label = false, onSearch, onRetake }) {
  const body = h('div', { class: 'photo' });
  const sheet = openSheet({ title: label ? 'Etiqueta' : 'Tu plato', content: body });
  const preview = URL.createObjectURL(picture);
  let closed = false;
  let stopWaiting = () => {};
  let thumbPromise = null;              // the 160 px thumbnail, made from the shrunk copy the AI saw (the photo itself is not kept)
  sheet.el.addEventListener('close', () => { closed = true; stopWaiting(); URL.revokeObjectURL(preview); });

  const img = () => h('div', { class: 'photo-preview' }, h('img', { src: preview, alt: '' }));
  const leave = (fn) => () => { sheet.close(); fn(); };
  const searchBtn = (primary = false) => h('button', { type: 'button', class: `btn ${primary ? 'btn-primary' : 'btn-secondary'}`, onClick: leave(onSearch) }, icon('search', 20), 'Buscar a mano');
  const retakeBtn = () => h('button', { type: 'button', class: 'btn btn-secondary', onClick: leave(() => onRetake('photo')) }, icon('camera', 20), 'Hacer otra foto');

  // ---------- screens ----------
  function signedOut() {
    mount(body, img(),
      h('div', { class: 'photo-card card' },
        h('h3', { class: 'section-title' }, 'Entra con Google para analizar fotos'),
        h('p', { class: 'muted' }, 'La foto se envía a Gemini, de Google, para estimar los ingredientes y los gramos. Solo hace falta entrar una vez. foodie no guarda la foto.'),
        googleSignInButton(cloud)),
      h('div', { class: 'sheet-actions' }, searchBtn()));
    const off = cloud.onChange(() => { if (cloud.user) { off(); stopWaiting = () => {}; if (!closed) analyze(''); } });
    stopWaiting = off;
  }

  function notConfigured() {
    mount(body, img(),
      h('div', { class: 'photo-card' },
        h('h3', { class: 'section-title' }, 'La IA no está configurada todavía'),
        h('p', { class: 'muted' }, 'Esta versión aún no tiene activado el análisis de fotos. Puedes buscar el alimento a mano o escanear su código de barras.')),
      h('div', { class: 'sheet-actions' }, searchBtn(true), h('button', { type: 'button', class: 'btn btn-secondary', onClick: leave(() => onRetake('code')) }, icon('barcode', 20), 'Escanear un código')));
  }

  function problem(reason, context) {
    const [title, text, retryable] = PROBLEMS[reason] || PROBLEMS.error;
    mount(body, img(),
      h('div', { class: 'photo-card' }, h('h3', { class: 'section-title' }, title), h('p', { class: 'muted' }, text)),
      h('div', { class: 'sheet-actions' },
        retryable ? h('button', { type: 'button', class: 'btn btn-primary', onClick: () => analyze(context) }, 'Reintentar') : null,
        searchBtn(!retryable), retakeBtn()));
  }

  function analyzing(status = 'Analizando la foto') {
    mount(body, scanFrame({ src: preview, status }),
      h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => sheet.close() }, 'Cancelar')));
  }

  function contextScreen(result) {
    const kind = !result.isFood ? 'not-food' : result.needsContext ? 'needs-context' : 'low-confidence';
    const [title, text] = CONTEXT_COPY[kind];
    const input = h('input', { type: 'text', class: 'input text-input', id: 'photo-context', maxlength: MAX_CONTEXT, placeholder: 'Ej.: burrito de pollo con arroz', autocomplete: 'off' });
    const error = h('p', { class: 'field-error small', 'aria-live': 'polite' });
    const calc = () => {
      const text = input.value.trim();
      if (!text) { error.textContent = 'Escribe qué es o qué lleva, aunque sea en pocas palabras.'; input.setAttribute('aria-invalid', 'true'); return; }
      analyze(text, { final: true });
    };
    input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid'); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); calc(); } });
    mount(body, img(),
      h('div', { class: 'photo-card' },
        h('h3', { class: 'section-title' }, title),
        h('p', { class: 'muted' }, text),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'photo-context' }, '¿Qué es o qué lleva?'), input, error)),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: calc }, 'Calcular con este contexto'),
        result.isFood && result.items.length ? h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => resultScreen(result) }, 'Usar la estimación tal cual') : searchBtn()));
    input.focus();
  }

  function resultScreen(result) {
    const draft = { items: result.items.map((it) => ({ ...it, name: it.hidden && !/estimad/i.test(it.name) ? `${it.name} (estimado)` : it.name })) };
    const name = h('input', { type: 'text', class: 'input text-input', id: 'photo-name', maxlength: 80, value: result.dish, 'aria-label': 'Nombre de la comida' });
    const slot = slotSelector();
    const doubtful = draft.items.filter((it) => it.inconsistent);
    const add = h('button', { type: 'button', class: 'btn btn-primary' }, 'Añadir al día');
    add.addEventListener('click', async () => {
      add.disabled = true;
      const thumb = thumbPromise ? await thumbPromise.catch(() => null) : null;
      const meal = store.addMeal(day, visionMeal({ ...result, items: draft.items }, { name: name.value, slot: slot.value, time: hhmm(), thumb }));
      sheet.close();
      if (meal) toast('Comida añadida', { label: 'Deshacer', fn: () => store.deleteMeal(day, meal.id) });
      else toast('No se pudo guardar la comida. Ese día puede tener ya 100 comidas.');
    });
    mount(body,
      h('div', { class: 'photo-head' }, img(), h('div', { class: 'photo-title' },
        name, h('p', { class: `photo-confidence small ${result.confidence < 0.45 ? 'is-low' : ''}` }, icon('chart', 16), confidenceWord(result.confidence)))),
      h('p', { class: 'small muted' }, 'Estimado por IA a partir de la foto. Mueve los controles para corregir los gramos: las cifras se recalculan al momento.'),
      mealEditor(draft, () => {}),
      result.notes ? h('p', { class: 'small muted' }, result.notes) : null,
      draft.items.some((it) => it.hidden) ? h('p', { class: 'small muted' }, 'Lo marcado como estimado (aceite, salsa) no se ve en la foto pero suele llevarlo.') : null,
      doubtful.length ? h('p', { class: 'small photo-warn' }, `Revisa ${doubtful.map((d) => d.name).join(', ')}: las calorías no cuadran del todo con los macros.`) : null,
      slot.el,
      h('div', { class: 'sheet-actions' }, add, h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => sheet.close() }, 'Cancelar')));
  }

  // ---------- the flow ----------
  async function analyze(context, { final = false } = {}) {
    if (closed) return;
    analyzing(context ? 'Calculando con tu contexto' : 'Analizando la foto');
    const r = await vision.analyze(picture, { context, label });
    if (closed) return;
    if (!r.ok) {
      if (r.reason === 'signed-out') { signedOut(); return; }
      if (r.reason === 'not-configured') { notConfigured(); return; }
      if (r.reason === 'cooldown' || r.reason === 'busy-local') { const t = setTimeout(() => analyze(context, { final }), 3100); stopWaiting = () => clearTimeout(t); return; }
      problem(r.reason, context);
      return;
    }
    thumbPromise = vision.thumbnail(r.photo);
    if (final && !r.result.items.length) { problem('empty', context); return; }
    if (!final && needsContextScreen(r.result)) contextScreen(r.result); else resultScreen(r.result);
  }

  analyze('');
  return sheet;
}
