/* foodie · Progress, Saved and Settings. Progress and Saved are honest empty states until logging exists. */
import { h } from '../dom.js';
import { icon } from '../icons.js';

const emptyState = (iconName, title, text) => h('div', { class: 'card empty-state' },
  h('span', { class: 'empty-icon' }, icon(iconName, 28)),
  h('h2', { class: 'section-title' }, title),
  h('p', { class: 'muted' }, text));

export const progressScreen = () => [
  h('h1', { class: 'title' }, 'Progreso'),
  emptyState('chart', 'Aún no hay nada que medir',
    'Cuando registres comidas verás aquí el calendario con los días que cumpliste tu objetivo, tus calorías medias y la evolución de tu peso.'),
];

export const savedScreen = () => [
  h('h1', { class: 'title' }, 'Guardadas'),
  emptyState('bookmark', 'Tus comidas de siempre, en un toque',
    'Guarda el desayuno o la cena que repites y añádelos a cualquier día sin volver a fotografiarlos.'),
];

const THEMES = [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']];

export function settingsScreen({ version }) {
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
    h('section', { class: 'card' },
      h('h2', { class: 'section-title' }, 'Cuenta'),
      h('p', { class: 'muted' }, 'El inicio de sesión con Google y la copia en la nube todavía no están disponibles en esta versión.')),
    h('a', { class: 'card link-row', href: '#/kit' },
      h('span', null, h('span', { class: 'link-title' }, 'Sistema de diseño'), h('span', { class: 'small muted' }, 'Colores, tipografía y componentes de la app')),
      icon('right', 22)),
    h('p', { class: 'small muted version' }, `foodie ${version}`),
  ];
}
