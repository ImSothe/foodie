/* foodie · app shell: routes, tab bar, the "+" menu, first-run onboarding and the service worker. */
import { h, $, mount, openSheet, toast } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { homeScreen } from './ui/screens/home.js';
import { kitScreen } from './ui/screens/kit.js';
import { progressScreen } from './ui/screens/progress.js';
import { savedScreen } from './ui/screens/saved.js';
import { settingsScreen } from './ui/screens/settings.js';
import { onboardingScreen } from './ui/screens/onboarding.js';
import { openAddFood } from './ui/screens/add-food.js';
import { isoDate, streak } from './core/dates.js';
import { resolveRoute } from './core/router.js';
import { store, isStoreKey } from './data/store.js';

export const APP_VERSION = '0.2.0';

const today = isoDate();
const state = { selected: today };
const view = $('#view');

const goHome = (iso) => { state.selected = iso; if (location.hash === '#/' || location.hash === '') render(true); else location.hash = '#/'; };

const ROUTES = {
  '/': {
    title: 'Inicio',
    render: (fresh) => homeScreen({
      store, selected: state.selected, today, fresh, onAdd: openAddMenu,
      onSelect: (iso) => { state.selected = iso; render(false); },
      onChange: () => render(false),
    }),
  },
  '/progreso': {
    title: 'Progreso',
    render: (fresh) => progressScreen({ store, today, fresh, onChange: () => render(false), onOpenDay: goHome }),
  },
  '/guardadas': { title: 'Guardadas', render: () => savedScreen({ store, selected: state.selected, today }) },
  '/ajustes': { title: 'Ajustes', render: () => settingsScreen({ store, version: APP_VERSION, today }) },
  '/perfil': {
    title: 'Tu plan', tab: '/ajustes',
    render: () => onboardingScreen({
      store, today, existing: { profile: store.getProfile(), goals: store.goalsFor(today) },
      onDone: () => { toast('Cambios guardados'); location.hash = '#/ajustes'; },
      onCancel: () => { location.hash = '#/ajustes'; },
    }),
  },
  '/kit': { title: 'Sistema de diseño', render: kitScreen, tab: '/ajustes' },
};

const TABS = [
  { path: '/', label: 'Inicio', icon: 'home' },
  { path: '/progreso', label: 'Progreso', icon: 'chart' },
  null, // the "+" button sits in the middle
  { path: '/guardadas', label: 'Guardadas', icon: 'bookmark' },
  { path: '/ajustes', label: 'Ajustes', icon: 'settings' },
];

const soon = () => toast('Todavía no disponible en esta versión');
const ADD_OPTIONS = [
  { icon: 'camera', title: 'Foto del plato', text: 'La IA estima los ingredientes y sus gramos', run: soon },
  { icon: 'barcode', title: 'Código de barras', text: 'Datos exactos del envase', run: soon },
  { icon: 'label', title: 'Etiqueta nutricional', text: 'Lee la tabla de un envase sin código', run: soon },
  { icon: 'search', title: 'Buscar alimento', text: 'Alimentos básicos de España, con sus gramos', run: () => openAddFood({ store, day: state.selected > today ? today : state.selected, today }) },
];

const ROUTE_NAMES = Object.keys(ROUTES);
const currentPath = () => resolveRoute(location.hash, ROUTE_NAMES);

function openAddMenu() {
  const sheet = openSheet({
    title: 'Añadir comida',
    content: h('ul', { class: 'options' }, ADD_OPTIONS.map((o) => h('li', null,
      h('button', { type: 'button', class: 'option', onClick: () => { sheet.close(); o.run(); } },
        h('span', { class: 'option-icon' }, icon(o.icon, 24)),
        h('span', { class: 'option-text' }, h('span', { class: 'option-title' }, o.title), h('span', { class: 'small muted' }, o.text)),
        icon('right', 20))))),
  });
}

const streakDays = h('span', { class: 'num' }, '0');
function buildChrome() {
  mount($('#tabs'), h('div', { class: 'frame' }, TABS.map((t) => (t
    ? h('a', { class: 'tab', href: `#${t.path}`, dataset: { path: t.path } }, icon(t.icon, 24), h('span', null, t.label))
    : h('button', { type: 'button', class: 'fab', 'aria-label': 'Añadir comida', onClick: openAddMenu }, icon('plus', 28))))));

  mount($('#top-actions'), h('span', { class: 'streak', title: 'Días seguidos registrando' },
    icon('flame', 18, true), streakDays, h('span', { class: 'sr-only' }, ' días seguidos')));

  const top = $('#top');
  const onScroll = () => top.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

let lastPath = null;
/** @param {boolean} [fresh] true when the screen was just entered (rings animate in); false when redrawing after a change */
function render(fresh = true) {
  const onboarding = !store.getProfile();
  document.body.classList.toggle('is-onboarding', onboarding);
  streakDays.textContent = String(streak(store.loggedDays(), today));

  if (onboarding) {
    // Only draw it once: redraws while the user is answering would wipe their answers.
    if (lastPath !== 'onboarding') {
      mount(view, onboardingScreen({ store, today, onDone: () => { lastPath = null; location.hash = '#/'; render(true); } }));
      document.title = 'Bienvenida · foodie';
      lastPath = 'onboarding';
    }
    return;
  }

  const path = currentPath();
  const route = ROUTES[path];
  const entering = lastPath !== path;
  const refocus = !entering && document.activeElement && view.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  mount(view, route.render(fresh));
  if (refocus) { const el = view.querySelector(`[data-focus="${refocus}"]`); if (el && !el.disabled) el.focus({ preventScroll: true }); }

  const activeTab = route.tab || path;
  for (const a of document.querySelectorAll('#tabs .tab')) {
    if (a.dataset.path === activeTab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = path === '/' ? 'foodie' : `${route.title} · foodie`;
  if (lastPath !== null && lastPath !== path) window.scrollTo(0, 0);
  lastPath = path;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (local && !new URLSearchParams(location.search).has('sw')) return; // while developing, always load fresh files
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Hay una versión nueva de foodie', { label: 'Actualizar', fn: () => location.reload() });
  });
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

buildChrome();
store.subscribe(() => render(false));
store.onStorageError((error) => toast(error.kind === 'write'
  ? 'Este navegador no deja guardar datos. Lo que añadas se perderá al cerrar la página.'
  : 'Había datos guardados que no se pudieron leer y se han ignorado. Si faltan comidas, exporta tus datos desde Ajustes antes de seguir.'));
// Another tab changed the data: read it again.
window.addEventListener('storage', (e) => { if (isStoreKey(e.key)) store.reload(); });
window.addEventListener('hashchange', () => render(true));
render(true);
registerServiceWorker();
