/* foodie · design system gallery: every building block in one place, in the current theme. */
import { h, openSheet, toast } from '../dom.js';
import { icon } from '../icons.js';
import { ring } from '../ring.js';
import { mealEditor } from '../meal-editor.js';
import { scanFrame } from '../scan-frame.js';

const SWATCHES = [
  ['--bg', 'Fondo'], ['--card', 'Tarjeta'], ['--inset', 'Hueco'], ['--ink', 'Tinta'], ['--ink-2', 'Tinta 2'],
  ['--protein', 'Proteína'], ['--carbs', 'Carbos'], ['--fat', 'Grasa'], ['--ok', 'Cumplido'], ['--warn', 'Desvío'], ['--bad', 'Error'],
];

const sampleMeal = () => ({
  name: 'Pollo con arroz', source: 'ai', confidence: 0.82,
  items: [
    { name: 'Pechuga de pollo a la plancha', grams: 160, gramsMin: 80, gramsMax: 260, per100: { kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 } },
    { name: 'Arroz blanco cocido', grams: 150, gramsMin: 60, gramsMax: 320, per100: { kcal: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3 } },
    { name: 'Aceite de oliva', grams: 10, gramsMin: 0, gramsMax: 30, per100: { kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100 } },
  ],
});

const block = (title, ...content) => h('section', { class: 'card kit-block' }, h('h2', { class: 'section-title' }, title), content);

export function kitScreen() {
  const demoRing = ring({ size: 96, stroke: 10, value: 0.62, label: 'Anillo de ejemplo', center: h('span', { class: 'num' }, '62 %') });
  const slider = h('input', { type: 'range', class: 'range', min: 0, max: 100, value: 62, 'aria-label': 'Progreso del anillo de ejemplo', style: { '--fill': '62%' } });
  slider.addEventListener('input', () => {
    slider.style.setProperty('--fill', `${slider.value}%`);
    demoRing.set(slider.value / 100);
    demoRing.querySelector('.ring-center span').textContent = `${slider.value} %`;
  });

  return [
    h('h1', { class: 'title' }, 'Sistema de diseño'),
    h('p', { class: 'muted' }, 'Las piezas con las que está hecha la app. Cambia el tema en Ajustes para verlas en claro y en oscuro.'),

    block('Color', h('ul', { class: 'swatches' }, SWATCHES.map(([token, name]) =>
      h('li', null, h('span', { class: 'swatch', style: { background: `var(${token})` } }), h('span', { class: 'small' }, name))))),

    block('Tipografía',
      h('p', { class: 'num kit-display' }, '1.240'),
      h('p', { class: 'title' }, 'Bricolage Grotesque'),
      h('p', { class: 'muted' }, 'Para cifras y títulos. El texto de lectura usa la tipografía del sistema, así que en cada móvil se lee como una app nativa.')),

    block('Anillo de progreso',
      h('div', { class: 'kit-row' }, demoRing,
        ring({ size: 52, stroke: 6, value: 0.4, color: 'var(--protein)', label: 'Proteína, 40 %' }),
        ring({ size: 52, stroke: 6, value: 0.7, color: 'var(--carbs)', label: 'Carbos, 70 %' }),
        ring({ size: 52, stroke: 6, value: 0.55, color: 'var(--fat)', label: 'Grasa, 55 %' })),
      slider),

    block('Botones',
      h('div', { class: 'kit-col' },
        h('button', { type: 'button', class: 'btn btn-primary' }, 'Añadir al día'),
        h('button', { type: 'button', class: 'btn btn-secondary' }, icon('copy', 20), 'Duplicar en otro día'),
        h('button', { type: 'button', class: 'btn btn-quiet' }, 'Descartar'))),

    block('Corrección de gramos',
      h('p', { class: 'small muted' }, 'Mueve un control: calorías y macros se recalculan al instante, sin volver a consultar a la IA.'),
      mealEditor(sampleMeal())),

    block('Análisis de una foto',
      h('p', { class: 'small muted' }, 'Lo que se ve mientras la IA estima el plato.'),
      scanFrame({ status: 'Identificando ingredientes' })),

    block('Avisos y hojas',
      h('div', { class: 'kit-col' },
        h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => toast('Comida añadida', { label: 'Deshacer', fn: () => toast('Comida quitada') }) }, 'Mostrar un aviso'),
        h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => openSheet({ title: 'Hoja inferior', content: h('p', { class: 'muted' }, 'Se cierra tocando fuera o con la tecla Esc.') }) }, 'Abrir una hoja'))),
  ];
}
