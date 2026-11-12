/* foodie · form fields. Numbers are typed as text with a numeric keypad (so "72,5" works on every phone),
   at 16 px or more so iOS does not zoom in, with the error shown right under the field. */
import { h } from './dom.js';
import { toNum } from '../core/goals.js';

let counter = 0;

/**
 * @param {object} o
 * @param {string} o.label
 * @param {string} [o.unit]       shown after the input ("kg", "kcal")
 * @param {string|number} [o.value]
 * @param {'decimal'|'numeric'} [o.inputmode]
 * @param {string} [o.hint]       one line under the label
 * @param {(el:HTMLInputElement)=>void} [o.onInput]
 * @param {boolean} [o.big]       larger text, for one-question screens
 */
export function numberField({ label, unit, value = '', inputmode = 'decimal', hint, onInput, big = false }) {
  counter += 1;
  const id = `fd-field-${counter}`;
  const note = h('p', { class: 'field-error small', id: `${id}-err`, 'aria-live': 'polite' });
  const input = h('input', {
    id, class: 'input num' + (big ? ' input-big' : ''), type: 'text', inputmode, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    value: value === null || value === undefined ? '' : String(value).replace('.', ','), 'aria-describedby': `${id}-err`,
  });
  if (onInput) input.addEventListener('input', () => onInput(input));
  const field = {
    input,
    el: h('div', { class: 'field' },
      h('label', { class: 'field-label', for: id }, label),
      hint ? h('p', { class: 'small muted' }, hint) : null,
      h('div', { class: 'field-row' }, input, unit ? h('span', { class: 'field-unit', 'aria-hidden': 'true' }, unit) : null),
      note),
    /** Typed number, or null when empty or not a number. */
    read: () => toNum(input.value),
    setError(message) {
      note.textContent = message || '';
      if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    },
    setValue(v) { input.value = v === null || v === undefined ? '' : String(v).replace('.', ','); },
  };
  return field;
}
