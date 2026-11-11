/* foodie · DOM helpers. Everything is built with createElement and text nodes, never from HTML strings,
   so text that comes from the user, a product database or the AI can never run as code. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const AS_PROPERTY = new Set(['value', 'checked', 'disabled', 'hidden', 'open', 'textContent', 'tabIndex']);

function setProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val));
    else if (typeof v === 'function') { if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v); }
    else if (AS_PROPERTY.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** HTML element: h('button', { class: 'btn', onClick: fn }, 'Guardar') */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  setProps(el, props);
  append(el, children);
  return el;
}

/** SVG element. */
export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setProps(el, props);
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
  return target;
}

/** Bottom sheet on a native <dialog>: focus trap, Esc and top layer come from the browser. */
export function openSheet({ title, content, onClose }) {
  const body = h('div', { class: 'sheet-body' },
    h('div', { class: 'sheet-grab', 'aria-hidden': 'true' }),
    title ? h('h2', { class: 'section-title sheet-title' }, title) : null,
    content);
  const dlg = h('dialog', { class: 'sheet', 'aria-label': title || 'Opciones' }, body);
  const close = () => { if (dlg.open) dlg.close(); };
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // tap outside the sheet
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close };
}

let toastTimer = 0;
/** Short message above the tab bar. `action` = { label, fn } adds one button. */
export function toast(message, action) {
  const host = $('#toasts');
  if (!host) return;
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast' }, h('span', null, message),
    action ? h('button', { class: 'toast-action', onClick: () => { host.replaceChildren(); action.fn(); } }, action.label) : null);
  host.replaceChildren(el);
  toastTimer = setTimeout(() => { if (el.isConnected) el.remove(); }, action ? 7000 : 3200);
}
