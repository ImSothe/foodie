/* foodie · progress ring. One component for the calorie ring, the macro rings and the day strip. */
import { h, s } from './dom.js';

/**
 * @param {object} o
 * @param {number} o.size     outer diameter in px
 * @param {number} o.stroke   ring thickness in px
 * @param {number} o.value    progress, 0..1 (values above 1 draw a full ring)
 * @param {string} [o.color]  CSS color of the bar (defaults to the text color)
 * @param {string} o.label    what a screen reader announces
 * @param {Node|string} [o.center] content shown inside the ring
 * @returns {HTMLElement & { set(value:number, label?:string):void }}
 */
export function ring({ size, stroke, value = 0, color, label, center }) {
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  const common = { cx: size / 2, cy: size / 2, r, 'stroke-width': stroke };
  const bar = s('circle', { class: 'ring-bar', ...common, 'stroke-dasharray': len.toFixed(2), 'stroke-dashoffset': len.toFixed(2) });
  const svg = s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': label || '' },
    s('circle', { class: 'ring-track', ...common }), bar);
  const el = h('div', { class: 'ring', style: color ? { '--ring': color } : null }, svg,
    center != null ? h('div', { class: 'ring-center' }, center) : null);

  el.set = (v, newLabel) => {
    const p = Math.min(1, Math.max(0, Number(v) || 0));
    bar.setAttribute('stroke-dashoffset', (len * (1 - p)).toFixed(2));
    bar.classList.toggle('empty', p === 0);
    if (newLabel) svg.setAttribute('aria-label', newLabel);
  };
  // Start empty and fill on the next frame, so the bar animates in from zero.
  requestAnimationFrame(() => requestAnimationFrame(() => el.set(value)));
  return el;
}
