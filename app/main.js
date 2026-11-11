/* foodie · app shell: routes, tab bar, the "+" menu and the service worker. */
import { h, $, mount, openSheet, toast } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { homeScreen } from './ui/screens/home.js';
import { kitScreen } from './ui/screens/kit.js';
import { progressScreen, savedScreen, settingsScreen } from './ui/screens/simple.js';
import { isoDate, streak } from './core/dates.js';
import { DEMO_GOALS, demoMeals, demoLoggedDays } from './data/demo.js';

export const APP_VERSION = '0.1.0';

const today = isoDate();
const state = { selected: today };
const view = $('#view');

const ROUTES = {
  '/': {
    title: 'Inicio',
    render: () => homeScreen({
      selected: state.selected, today, goals: DEMO_GOALS, sample: true,
      mealsOf: (iso) => demoMeals(iso, today),
      onSelect: (iso) => { state.selected = iso; render(); },
      onChange: () => render(),
    }),
  },
  '/progreso': { title: 'Progreso', render: progressScreen },
  '/guardadas': { title: 'Guardadas', render: savedScreen },
  '/ajustes': { title: 'Ajustes', render: () => settingsScreen({ version: APP_VERSION }) },
  '/kit': { title: 'Sistema de diseño', render: kitScreen, tab: '/ajustes' },
};

const TABS = [
  { path: '/', label: 'Inicio', icon: 'home' },
  { path: '/progreso', label: 'Progreso', icon: 'chart' },
  null, // the "+" button sits in the middle
  { path: '/guardadas', label: 'Guardadas', icon: 'bookmark' },
  { path: '/ajustes', label: 'Ajustes', icon: 'settings' },
];

const ADD_OPTIONS = [
  { icon: 'camera', title: 'Foto del plato', text: 'La IA estima los ingredientes y sus gramos' },
  { icon: 'barcode', title: 'Código de barras', text: 'Datos exactos del envase' },
  { icon: 'label', title: 'Etiqueta nutricional', text: 'Lee la tabla de un envase sin código' },
  { icon: 'search', title: 'Buscar alimento', text: 'Alimentos básicos y tus comidas guardadas' },
];

const currentPath = () => {
  const p = location.hash.replace(/^#/, '') || '/';
  return ROUTES[p] ? p : '/';
};

function openAddMenu() {
  const sheet = openSheet({
    title: 'Añadir comida',
    content: h('ul', { class: 'options' }, ADD_OPTIONS.map((o) => h('li', null,
      h('button', { type: 'button', class: 'option', onClick: () => { sheet.close(); toast('Todavía no disponible en esta versión'); } },
        h('span', { class: 'option-icon' }, icon(o.icon, 24)),
        h('span', { class: 'option-text' }, h('span', { class: 'option-title' }, o.title), h('span', { class: 'small muted' }, o.text)),
        icon('right', 20))))),
  });
}

function buildChrome() {
  mount($('#tabs'), h('div', { class: 'frame' }, TABS.map((t) => (t
    ? h('a', { class: 'tab', href: `#${t.path}`, dataset: { path: t.path } }, icon(t.icon, 24), h('span', null, t.label))
    : h('button', { type: 'button', class: 'fab', 'aria-label': 'Añadir comida', onClick: openAddMenu }, icon('plus', 28))))));

  const days = streak(demoLoggedDays(today), today);
  mount($('#top-actions'), h('span', { class: 'streak', title: 'Días seguidos registrando' },
    icon('flame', 18, true), h('span', { class: 'num' }, String(days)), h('span', { class: 'sr-only' }, ' días seguidos')));

  const top = $('#top');
  const onScroll = () => top.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

let lastPath = null;
function render() {
  const path = currentPath();
  const route = ROUTES[path];
  mount(view, route.render());
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
render();
window.addEventListener('hashchange', render);
registerServiceWorker();
