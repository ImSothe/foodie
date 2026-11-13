/* foodie · the passphrase of the cloud copy, in one calm sheet.
   Three situations, one screen each:
   - setup:  first sign-in on an account with no passphrase (or data from before encryption): choose one;
   - locked: a second phone, a reinstall: type the one that exists (it is remembered on this device afterwards);
   - reset:  "Olvidé mi contraseña": delete the cloud copy and upload this phone's data again under a new passphrase.
   The passphrase goes only to the cloud object (which derives a key from it and keeps the key, never the text). Here it lives in a password
   field and is cleared as soon as it has been used. */
import { h, openSheet, toast } from '../dom.js';
import { icon } from '../icons.js';
import { checkPassphrase } from '../../core/passphrase.js';

const LEVEL_WORD = ['Muy común', 'Corta', 'Buena', 'Muy buena'];

/** Is there anything on this phone that could be uploaded again? (The reset is only offered then.) */
export const hasLocalData = (store) => !!store.getProfile() || store.loggedDays().length > 0 || store.getSaved().length > 0;

function field({ id, label, autocomplete }) {
  const input = h('input', { type: 'password', class: 'input text-input', id, autocomplete, autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done' });
  const error = h('p', { class: 'field-error small', 'aria-live': 'polite' });
  return {
    el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), input, error),
    input,
    value: () => input.value,
    clear: () => { input.value = ''; },
    setError(text) { error.textContent = text; if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); },
  };
}

/** A "Mostrar" switch for one or two password fields. */
function showToggle(...fields) {
  const button = h('button', { type: 'button', class: 'btn btn-quiet', 'aria-pressed': 'false' }, 'Mostrar lo que escribo');
  button.addEventListener('click', () => {
    const shown = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(shown));
    button.textContent = shown ? 'Ocultar lo que escribo' : 'Mostrar lo que escribo';
    for (const f of fields) f.input.type = shown ? 'text' : 'password';
  });
  return button;
}

/**
 * @param {object} o
 * @param {object} o.cloud   needs setupPassphrase, unlock, resetEncryption
 * @param {object} o.store
 * @param {'setup'|'locked'|'reset'} o.mode
 */
export function openPassphraseSheet({ cloud, store, mode }) {
  const body = h('div', { class: 'passphrase' });
  const sheet = openSheet({ title: 'Tus datos en la nube', content: body });
  let busy = false;

  const later = () => h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => sheet.close() }, 'Ahora no');
  const lockLine = (text) => h('p', { class: 'passphrase-line' }, icon('lock', 18), h('span', null, text));
  const swap = (...children) => { body.replaceChildren(...children.flat().filter(Boolean)); };

  /** Runs `job` with the buttons disabled and the label changed; the passphrase fields are cleared once it succeeded. */
  async function work(buttons, label, job) {
    if (busy) return;
    busy = true;
    const texts = buttons.map((b) => b.textContent);
    for (const b of buttons) b.disabled = true;
    buttons[0].textContent = label;
    try { await job(); } finally {
      busy = false;
      buttons.forEach((b, i) => { b.disabled = false; b.textContent = texts[i]; });
    }
  }

  function strengthLine(first) {
    const line = h('p', { class: 'small muted', 'aria-live': 'polite' });
    first.input.addEventListener('input', () => {
      const v = first.value();
      first.setError('');
      if (!v) { line.textContent = ''; return; }
      const r = checkPassphrase(v);
      line.textContent = r.ok ? `${LEVEL_WORD[r.level]}. ${r.hint}` : r.hint;
    });
    return line;
  }

  // ---------- choose one ----------
  function setupScreen({ afterReset = false } = {}) {
    const first = field({ id: 'pp-new', label: afterReset ? 'Contraseña nueva' : 'Contraseña', autocomplete: 'new-password' });
    const again = field({ id: 'pp-again', label: 'Repítela', autocomplete: 'new-password' });
    const go = h('button', { type: 'button', class: `btn ${afterReset ? 'btn-danger' : 'btn-primary'}` },
      afterReset ? 'Borrar la copia en la nube y subir mis datos' : 'Cifrar y guardar mis datos');
    const submit = () => {
      const r = checkPassphrase(first.value());
      if (!r.ok) { first.setError(r.hint); first.input.focus(); return; }
      if (first.value() !== again.value()) { again.setError('Las dos contraseñas no son iguales.'); again.input.focus(); return; }
      work([go, cancel], 'Cifrando…', async () => {
        const result = await (afterReset ? cloud.resetEncryption(first.value()) : cloud.setupPassphrase(first.value()));
        if (result.ok) {
          first.clear(); again.clear();
          sheet.close();
          toast(result.synced ? 'Copia cifrada activada.' : 'Copia cifrada activada. Se subirá cuando haya conexión.');
        } else if (result.reason === 'exists') {
          first.clear(); again.clear();
          toast('Esta cuenta ya tiene una contraseña: escríbela para abrir tus datos.');
          unlockScreen();
        } else if (result.reason === 'weak') first.setError('Usa al menos 8 caracteres.');
        else first.setError('No se pudo. Revisa tu conexión e inténtalo otra vez.');
      });
    };
    go.addEventListener('click', submit);
    for (const f of [first, again]) f.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const cancel = afterReset ? h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => unlockScreen() }, 'Volver') : later();
    again.input.addEventListener('input', () => again.setError(''));
    swap(
      h('h3', { class: 'section-title' }, afterReset ? 'Empezar la copia de nuevo' : 'Protege tus datos con una contraseña'),
      afterReset ? h('p', { class: 'muted' }, 'Se borrará la copia que hay en la nube y se subirán otra vez los datos que tienes en este móvil, con una contraseña nueva. Lo que solo estuviera en la nube y no aquí se perderá.')
        : [lockLine('Tus datos se cifran en tu móvil antes de subirse.'), lockLine('Ni siquiera el autor de la app puede leerlos.'),
          lockLine('Si olvidas la contraseña, la copia en la nube no se puede recuperar. Tus datos en este móvil se quedan.')],
      first.el, strengthLine(first), again.el, showToggle(first, again),
      h('div', { class: 'sheet-actions' }, go, cancel));
    first.input.focus();
  }

  // ---------- type the existing one ----------
  function unlockScreen() {
    const pass = field({ id: 'pp-open', label: 'Contraseña', autocomplete: 'current-password' });
    const go = h('button', { type: 'button', class: 'btn btn-primary' }, 'Abrir mis datos');
    const submit = () => {
      if (!pass.value()) { pass.setError('Escribe tu contraseña.'); pass.input.focus(); return; }
      work([go, cancel], 'Abriendo…', async () => {
        const result = await cloud.unlock(pass.value());
        if (result.ok) { pass.clear(); sheet.close(); toast(result.synced ? 'Datos abiertos.' : 'Datos abiertos. Se sincronizarán cuando haya conexión.'); } else if (result.reason === 'no-passphrase') { pass.clear(); setupScreen(); } else if (result.reason === 'wrong') { pass.setError('Esa no es la contraseña. Inténtalo otra vez.'); pass.input.select(); } else pass.setError('No se pudo. Revisa tu conexión e inténtalo otra vez.');
      });
    };
    go.addEventListener('click', submit);
    pass.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    pass.input.addEventListener('input', () => pass.setError(''));
    const cancel = later();
    swap(
      h('h3', { class: 'section-title' }, 'Escribe tu contraseña para abrir tus datos'),
      h('p', { class: 'muted' }, 'La elegiste al activar la copia en la nube. En este móvil se recordará para la próxima vez.'),
      pass.el, showToggle(pass),
      hasLocalData(store)
        ? h('div', { class: 'passphrase-forgot' },
          h('p', { class: 'small muted' }, '¿No la recuerdas? Nadie puede recuperarla, ni siquiera el autor. Puedes empezar la copia de nuevo con los datos de este móvil.'),
          h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => setupScreen({ afterReset: true }) }, 'Olvidé mi contraseña'))
        : h('p', { class: 'small muted' }, 'Si la has olvidado, la copia en la nube no se puede recuperar: nadie puede abrirla sin la contraseña, ni siquiera el autor.'),
      h('div', { class: 'sheet-actions' }, go, cancel));
    pass.input.focus();
  }

  if (mode === 'locked') unlockScreen(); else if (mode === 'reset') setupScreen({ afterReset: true }); else setupScreen();
  return sheet;
}
