/* foodie · DOM helpers. Everything is built with createElement and text nodes, never from HTML strings,
   so text that comes from the user, a product database or the AI can never run as code. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const AS_PROPERTY = new Set(['value', 'checked', 'disabled', 'hidden', 'open', 'textContent', 'tabIndex']);

// What can execute or load something stays out of reach of whatever a caller passes in.
const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'style']);
const ATTRIBUTE_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data', 'cite', 'manifest', 'ping']);
const DROPPED_ATTRIBUTES = new Set(['srcdoc', 'srcset', 'innerhtml', 'outerhtml', 'is']);
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SAFE_SCHEME = /^(blob:|data:image\/(png|jpeg|jpg|gif|webp|avif)[;,])/i;  // raster images only: no data:text/html, no SVG documents

/** Relative URLs, "#fragment", blob: and raster data:image/ only. Everything else (javascript:, data:text/html, other hosts) is refused. */
export function isSafeUrl(value) {
  if (typeof value !== 'string') return false;
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) return false;   // browsers ignore tabs and newlines inside a scheme: "java\nscript:"
  const url = value.trim();
  if (SCHEME.test(url)) return SAFE_SCHEME.test(url);
  return !url.startsWith('//') && !url.startsWith('\\');         // "//host" and "\\host" point to another origin
}

function setProps(el, props) {
  if (!props || typeof props !== 'object') return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    const name = k.toLowerCase();
    if (name === 'class') el.setAttribute('class', String(v));
    else if (name === 'dataset') { if (typeof v === 'object') Object.assign(el.dataset, v); }
    else if (name === 'style') { if (typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val)); }
    else if (typeof v === 'function') { if (name.startsWith('on')) el.addEventListener(name.slice(2), v); }
    else if (name.startsWith('on') || DROPPED_ATTRIBUTES.has(name)) continue;   // an "onclick" that is not a function would become an inline handler
    else if (AS_PROPERTY.has(k)) el[k] = v;
    else if (!ATTRIBUTE_NAME.test(k)) continue;
    else if (URL_ATTRIBUTES.has(name) && !isSafeUrl(String(v))) continue;
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

function checkTag(tag) {
  if (typeof tag !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag) || FORBIDDEN_TAGS.has(tag.toLowerCase())) throw new Error(`foodie: refusing to create <${String(tag).slice(0, 20)}>`);
}

/** HTML element: h('button', { class: 'btn', onClick: fn }, 'Guardar') */
export function h(tag, props, ...children) {
  checkTag(tag);
  const el = document.createElement(tag);
  setProps(el, props);
  append(el, children);
  return el;
}

/** SVG element. */
export function s(tag, props, ...children) {
  checkTag(tag);
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
