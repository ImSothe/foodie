/* foodie · icon set drawn for this app (24 px grid, 1.9 px stroke, round joins). */
import { s } from './dom.js';

const P = (d) => ['path', { d }];
const C = (cx, cy, r) => ['circle', { cx, cy, r }];

const ICONS = {
  home: [P('M4 11.2 12 4l8 7.2V19a1 1 0 0 1-1 1h-4.6v-5.4H9.6V20H5a1 1 0 0 1-1-1z')],
  chart: [P('M5 20v-8'), P('M12 20V4'), P('M19 20v-5')],
  bookmark: [P('M7 4h10a1 1 0 0 1 1 1v15l-6-4.2L6 20V5a1 1 0 0 1 1-1z')],
  settings: [P('M4 7.5h9'), P('M18.5 7.5H20'), P('M4 16.5h1.5'), P('M11 16.5h9'), C(15.75, 7.5, 2.4), C(8.25, 16.5, 2.4)],
  plus: [P('M12 5v14'), P('M5 12h14')],
  minus: [P('M5 12h14')],
  camera: [P('M4 9a2 2 0 0 1 2-2h2.2l1.4-2h4.800l1.4 2H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z'), C(12, 13, 3.3)],
  barcode: [P('M4 6v12'), P('M7.5 6v12'), P('M11 6v12'), P('M13.5 6v12'), P('M17 6v12'), P('M20 6v12')],
  label: [P('M7 3.5h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z'), P('M9.200 8h5.600'), P('M9.200 12h5.600'), P('M9.200 16h3')],
  search: [C(11, 11, 6.2), P('m20 20-4.400-4.400')],
  chevron: [P('m6 9 6 6 6-6')],
  right: [P('m9 6 6 6-6 6')],
  close: [P('M6 6l12 12'), P('M18 6 6 18')],
  check: [P('m5 12.500 4.500 4.500L19 7.500')],
  flame: [P('M12.300 3c.5 3.200-1.700 4.700-3.300 6.900A6.300 6.300 0 0 0 12 20.500a6.300 6.300 0 0 0 5.700-8.900c-.600 1.100-1.400 1.800-2.400 2.100.400-3.900-.900-8.100-3-10.700z')],
  copy: [P('M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z'), P('M5 15V5a1 1 0 0 1 1-1h10')],
};

/** Decorative icon (hidden from screen readers: the control around it carries the name). */
export function icon(name, size = 24, filled = false) {
  const parts = ICONS[name] || [];
  return s('svg', {
    class: 'icon', width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
    fill: filled ? 'currentColor' : 'none', stroke: filled ? 'none' : 'currentColor',
    'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }, parts.map(([tag, attrs]) => s(tag, attrs)));
}
