/* foodie · Ajustes: theme, profile and goals, your data (export and delete), design system link. */
import { h, toast } from '../dom.js';
import { icon } from '../icons.js';
import { fmtNum } from '../../core/nutrition.js';
import { ageOf, DEFAULT_PACE } from '../../core/goals.js';
import { SEX_LABEL, GOAL_LABEL, ACTIVITY_INFO } from './onboarding.js';

const THEMES = [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']];
const CONFIRM_MS = 6000;
const PACE_WORD = { lose: { 0.1: 'suave', 0.2: 'moderado', 0.25: 'rápido' }, gain: { 0.05: 'suave', 0.1: 'moderado', 0.15: 'rápido' } };
const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function profileCard(store, today) {
  const p = store.getProfile();
  const g = store.goalsFor(today);
  const rows = p ? [
    ['Datos', `${SEX_LABEL[p.sex]}, ${ageOf(p)} años, ${nf1.format(p.heightCm)} cm, ${nf1.format(p.weightKg)} kg`],
    ['Actividad', ACTIVITY_INFO[p.activity][0]],
    ['Objetivo', GOAL_LABEL[p.goal] + (p.goal !== 'maintain' ? `, ritmo ${PACE_WORD[p.goal][p.pace || DEFAULT_PACE[p.goal]] || 'moderado'}` : '')],
    ['Cada día', `${fmtNum(g.kcal)} kcal, ${fmtNum(g.protein_g)} g de proteína, ${fmtNum(g.carbs_g)} g de carbohidratos, ${fmtNum(g.fat_g)} g de grasa, ${nf1.format(g.waterL)} litros de agua y ${fmtNum(g.steps)} pasos`],
  ] : [];
  return h('section', { class: 'card' },
    h('h2', { class: 'section-title' }, 'Perfil y objetivos'),
    h('dl', { class: 'facts' }, rows.map(([k, v]) => h('div', null, h('dt', { class: 'small muted' }, k), h('dd', null, v)))),
    h('p', { class: 'small muted' }, 'Si cambias tus objetivos, los días anteriores conservan los que tenían.'),
    h('a', { class: 'btn btn-secondary link-btn', href: '#/perfil' }, icon('edit', 20), 'Editar perfil y objetivos'));
}

function dataCard(store, today) {
  const exportBtn = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => {
    download(`foodie-datos-${today}.json`, JSON.stringify(store.exportAll(), null, 2));
    toast('Datos exportados. Búscalos en tus descargas.');
  } }, icon('download', 20), 'Exportar mis datos');

  let armed = false;
  let timer = 0;
  const hint = h('p', { class: 'small muted', 'aria-live': 'polite' },
    'Borra tu perfil, objetivos, comidas, guardadas y pesos de este dispositivo. No se puede deshacer: exporta antes tus datos si quieres conservarlos.');
  const wipe = h('button', { type: 'button', class: 'btn btn-quiet btn-delete' }, icon('trash', 20), 'Borrar mis datos de este dispositivo');
  const disarm = () => {
    armed = false;
    wipe.classList.remove('btn-danger');
    wipe.replaceChildren(icon('trash', 20), 'Borrar mis datos de este dispositivo');
  };
  wipe.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      wipe.classList.add('btn-danger');
      wipe.replaceChildren(icon('trash', 20), 'Toca otra vez para borrar todo');
      hint.textContent = 'Toca el botón otra vez en los próximos segundos para confirmar. Si no, no se borrará nada.';
      timer = setTimeout(() => { disarm(); hint.textContent = 'No se ha borrado nada.'; }, CONFIRM_MS);
      return;
    }
    clearTimeout(timer);
    store.clearAll();
    toast('Datos borrados de este dispositivo');
  });

  return h('section', { class: 'card data-card' },
    h('h2', { class: 'section-title' }, 'Tus datos'),
    h('p', { class: 'muted' }, 'Todo se guarda solo en este dispositivo. Puedes llevártelo en un archivo.'),
    store.persistent ? null : h('p', { class: 'note small' }, 'Tu navegador no deja guardar datos ahora mismo, así que se perderán al cerrar la página. Desactiva el modo privado o permite el almacenamiento del sitio.'),
    exportBtn, wipe, hint);
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {string} o.version
 * @param {string} o.today
 */
export function settingsScreen({ store, version, today }) {
  const current = window.fdTheme ? window.fdTheme.get() : 'auto';
  return [
    h('h1', { class: 'title' }, 'Ajustes'),
    h('section', { class: 'card' },
      h('fieldset', { class: 'seg-field' },
        h('legend', { class: 'section-title' }, 'Apariencia'),
        h('div', { class: 'seg' }, THEMES.map(([value, label]) => h('label', null,
          h('input', { type: 'radio', name: 'theme', value, checked: value === current, class: 'sr-only',
            onChange: () => window.fdTheme && window.fdTheme.set(value) }),
          h('span', null, label)))),
        h('p', { class: 'small muted' }, 'Automático sigue el tema de tu móvil.'))),
    profileCard(store, today),
    dataCard(store, today),
    h('section', { class: 'card' },
      h('h2', { class: 'section-title' }, 'Cuenta'),
      h('p', { class: 'muted' }, 'El inicio de sesión con Google y la copia en la nube todavía no están disponibles en esta versión.')),
    h('a', { class: 'card link-row', href: '#/kit' },
      h('span', null, h('span', { class: 'link-title' }, 'Sistema de diseño'), h('span', { class: 'small muted' }, 'Colores, tipografía y componentes de la app')),
      icon('right', 22)),
    h('p', { class: 'small muted version' }, `foodie ${version}`),
  ];
}
