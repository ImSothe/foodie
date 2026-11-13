/* foodie · app shell: routes, tab bar, the "+" menu, first-run onboarding and the service worker. */
import { h, $, mount, toast } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { homeScreen } from './ui/screens/home.js';
import { kitScreen } from './ui/screens/kit.js';
import { progressScreen } from './ui/screens/progress.js';
import { savedScreen } from './ui/screens/saved.js';
import { settingsScreen } from './ui/screens/settings.js';
import { onboardingScreen } from './ui/screens/onboarding.js';
import { openAddFood } from './ui/screens/add-food.js';
import { openCameraView } from './ui/screens/camera.js';
import { openProduct } from './ui/screens/product.js';
import { openPhoto } from './ui/screens/photo.js';
import { isoDate, streak } from './core/dates.js';
import { resolveRoute } from './core/router.js';
import { store } from './data/store.js';
import { createCloud } from './data/cloud.js';
import { createOffClient } from './data/off-client.js';
import { createVision } from './data/vision.js';

export const APP_VERSION = '0.2.0';

const today = isoDate();
const cloud = createCloud({ store });
const offClient = createOffClient({ store });
const vision = createVision({ cloud });
const state = { selected: today };
const view = $('#view');

const goHome = (iso) => { state.selected = iso; if (location.hash === '#/' || location.hash === '') render(true); else location.hash = '#/'; };

const ROUTES = {
  '/': {
    title: 'Inicio',
    render: (fresh) => homeScreen({
      store, selected: state.selected, today, fresh, onAdd: () => openCapture(),
      onSelect: (iso) => { state.selected = iso; render(false); },
      onChange: () => render(false),
    }),
  },
  '/progreso': {
    title: 'Progreso',
    render: (fresh) => progressScreen({ store, today, fresh, onChange: () => render(false), onOpenDay: goHome }),
  },
  '/guardadas': { title: 'Guardadas', render: () => savedScreen({ store, selected: state.selected, today }) },
  '/ajustes': { title: 'Ajustes', render: () => settingsScreen({ store, cloud, version: APP_VERSION, today }) },
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

const ROUTE_NAMES = Object.keys(ROUTES);
const currentPath = () => resolveRoute(location.hash, ROUTE_NAMES);

/** The day a new meal goes to: the one on screen, never one that has not happened yet. */
const addDay = () => (state.selected > today ? today : state.selected);
const openSearch = (notice = '') => openAddFood({ store, day: addDay(), today, notice });

/** "+": the camera opens straight away. Code reads a barcode on its own, Foto and Etiqueta take a picture, Buscar leaves for the search. */
function openCapture(mode = store.getCameraMode()) {
  openCameraView({
    mode,
    onMode: (m) => store.setCameraMode(m),
    onSearch: openSearch,
    onCode: (code) => openProduct({ store, day: addDay(), code, offClient, onSearch: () => openSearch(), onPhoto: () => openCapture('photo') }),
    onPhoto: (picture, { label }) => openPhoto({ store, day: addDay(), cloud, vision, picture, label, onSearch: () => openSearch(), onRetake: (m) => openCapture(m) }),
  });
}

const streakDays = h('span', { class: 'num' }, '0');
function buildChrome() {
  mount($('#tabs'), h('div', { class: 'frame' }, TABS.map((t) => (t
    ? h('a', { class: 'tab', href: `#${t.path}`, dataset: { path: t.path } }, icon(t.icon, 24), h('span', null, t.label))
    : h('button', { type: 'button', class: 'fab', 'aria-label': 'Añadir comida con la cámara', onClick: () => openCapture() }, icon('plus', 28))))));

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
// Registered before the data is opened: a storage that cannot keep the data (or an unreadable value) is reported as soon as it is known.
store.onStorageError((error) => toast(error.kind === 'write'
  ? 'Este navegador no deja guardar datos. Lo que añadas se perderá al cerrar la página.'
  : 'Había datos guardados que no se pudieron leer y se han ignorado. Si faltan comidas, exporta tus datos desde Ajustes antes de seguir.'));
// The data is read from IndexedDB into memory first (a few milliseconds; it gives up after 2.5 s and the app opens anyway, saying it cannot save).
// Another tab changing the data is heard by the storage itself (BroadcastChannel) and arrives as a normal store change.
await store.ready;
store.subscribe(() => render(false));
window.addEventListener('hashchange', () => render(true));
cloud.onChange(() => { if (currentPath() === '/ajustes') render(false); });
render(true);
registerServiceWorker();
setTimeout(() => cloud.start(), 1500);        // after the first paint; only does anything on a device that signed in before
