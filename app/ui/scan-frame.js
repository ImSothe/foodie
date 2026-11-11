/* foodie · what the user sees while a photo is being analysed: the photo (or a placeholder) with focus
   corners, a scanning line, and skeleton rows where the ingredients will appear. */
import { h } from './dom.js';

/**
 * @param {object} o
 * @param {string} [o.src]     object URL of the photo; a neutral placeholder is drawn without it
 * @param {string} [o.status]  short line under the photo
 */
export function scanFrame({ src, status = 'Analizando la foto' } = {}) {
  const corner = (pos) => h('span', { class: `scan-corner ${pos}`, 'aria-hidden': 'true' });
  return h('div', { class: 'scan', role: 'status' },
    h('div', { class: 'scan-photo' },
      src ? h('img', { src, alt: '' }) : null,
      corner('tl'), corner('tr'), corner('bl'), corner('br'),
      h('span', { class: 'scan-line', 'aria-hidden': 'true' })),
    h('p', { class: 'scan-status' }, status),
    h('div', { class: 'skeleton-rows', 'aria-hidden': 'true' },
      h('span', { class: 'skeleton w-70' }), h('span', { class: 'skeleton w-45' }), h('span', { class: 'skeleton w-60' })));
}
