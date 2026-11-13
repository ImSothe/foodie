/* foodie · the camera view that "+" opens: full screen, rear camera, four modes at the bottom (Foto, Código, Etiqueta, Buscar).
   Foto and Etiqueta take a picture (or let you choose one from the gallery), Código reads a barcode on its own, Buscar leaves for the search.
   The camera is released the moment the view closes, the route changes or the page is hidden. If there is no camera or no permission
   the view says so in one calm line and the gallery and the search still work: nothing here is an error wall. */
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { numberField } from '../fields.js';
import { openCamera, stopStream, attachStream } from '../../data/camera.js';
import { createScanner, createDetector } from '../../data/scanner.js';
import { frameToBlob } from '../../data/image.js';
import { normalizeCode } from '../../core/off.js';
import { leftText } from '../../core/limits.js';

const MODES = [['photo', 'Foto', 'camera'], ['code', 'Código', 'barcode'], ['label', 'Etiqueta', 'label'], ['search', 'Buscar', 'search']];
const HINT = {
  photo: 'Encuadra el plato y haz la foto',
  label: 'Encuadra la tabla nutricional del envase',
  code: 'Apunta al código de barras',
};
const NO_CAMERA = {
  denied: 'La cámara está bloqueada. Puedes permitirla en los ajustes del navegador, elegir una foto de la galería o buscar a mano.',
  none: 'No encontramos ninguna cámara. Puedes elegir una foto de la galería o buscar a mano.',
  busy: 'Otra aplicación está usando la cámara. Ciérrala o elige una foto de la galería, o busca a mano.',
  unsupported: 'Este navegador no da acceso a la cámara. Puedes elegir una foto de la galería o buscar a mano.',
  unknown: 'No pudimos abrir la cámara. Puedes elegir una foto de la galería o buscar a mano.',
};

/**
 * @param {object} o
 * @param {'photo'|'code'|'label'} [o.mode]
 * @param {(code:string)=>void} o.onCode               a valid product code was read (or typed)
 * @param {(picture:Blob, info:{label:boolean})=>void} o.onPhoto  a picture was taken or chosen
 * @param {(mode:'photo'|'code'|'label')=>void} [o.onMode]  the person switched mode (so "+" can open in it next time)
 * @param {()=>number|null} [o.photosLeft]    how many photo analyses are left today (null: do not say)
 * @param {(notice?:string)=>void} o.onSearch          the person chose "Buscar" (or there is no camera and they asked for it)
 * @param {{mediaDevices?:object, vibrate?:(ms:number)=>void, detector?:object}} [o.env]  injected in tests
 */
export function openCameraView({ mode: startMode = 'photo', onCode, onPhoto, onSearch, onMode = () => {}, photosLeft = () => null, env = {} }) {
  const mediaDevices = env.mediaDevices !== undefined ? env.mediaDevices : navigator.mediaDevices;
  const vibrate = env.vibrate || ((ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* not everywhere */ } });
  let mode = startMode === 'code' || startMode === 'label' ? startMode : 'photo';
  let stream = null;
  let scanner = null;
  let detectorInfo = null;
  let starting = false;
  let closed = false;
  let cameraOff = false;
  let hintTimer = 0;

  const video = h('video', { class: 'cam-video', autoplay: true, muted: true, playsinline: true, 'aria-hidden': 'true' });
  const hint = h('p', { class: 'cam-hint', 'aria-live': 'polite' });
  // the daily limit of photo analyses is shown where the photo is taken (Foto and Etiqueta use the AI; Código and Buscar never do)
  const hintFor = (m) => {
    const base = HINT[m] || '';
    const left = m === 'photo' || m === 'label' ? photosLeft() : null;
    if (left === null || left === undefined) return base;
    return left > 0 ? `${base} · ${leftText(left)}` : 'Hoy no quedan fotos: usa Código o Buscar';
  };
  const say = (text, { temporary = false } = {}) => {
    clearTimeout(hintTimer);
    hint.textContent = text;
    if (temporary) hintTimer = setTimeout(() => { if (!closed) hint.textContent = cameraOff ? '' : hintFor(mode); }, 2500);
  };

  // ---------- what can be on screen ----------
  const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabIndex: -1, 'aria-hidden': 'true' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) done(() => onPhoto(file, { label: mode === 'label' }));
  });
  const gallery = h('button', { type: 'button', class: 'cam-side cam-gallery', 'aria-label': 'Elegir una foto de la galería', onClick: () => fileInput.click() }, icon('image', 26));
  const shutter = h('button', { type: 'button', class: 'cam-shutter', 'aria-label': 'Hacer la foto', onClick: takePhoto }, h('span', { class: 'cam-shutter-ring' }));

  const codeField = numberField({ label: 'Escribe el código de barras', inputmode: 'numeric', hint: 'Los números que hay bajo las barras.' });
  const codeForm = h('form', { class: 'cam-code-form', novalidate: true, onSubmit: (e) => {
    e.preventDefault();
    const code = normalizeCode(String(codeField.input.value).replace(/\s+/g, ''));
    if (!code) { codeField.setError('Ese código no es válido. Revisa los números e inténtalo otra vez.'); return; }
    done(() => onCode(code));
  } }, codeField.el, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Buscar producto'));
  codeField.input.addEventListener('input', () => codeField.setError(''));

  const fallback = h('div', { class: 'cam-fallback' });
  const nocamText = h('p', { class: 'cam-nocam-text' });
  fallback.append(h('span', { class: 'empty-icon cam-fallback-icon' }, icon('camera', 28)), nocamText);

  const modeButtons = MODES.map(([key, label, iconName]) => h('button', {
    type: 'button', class: 'cam-mode', dataset: { mode: key }, 'aria-pressed': String(key === mode), onClick: () => setMode(key),
  }, icon(iconName, 20), h('span', null, label)));

  const closeBtn = h('button', { type: 'button', class: 'cam-close', 'aria-label': 'Cerrar la cámara', onClick: () => close() }, icon('close', 24));
  const dlg = h('dialog', { class: 'cam', 'aria-label': 'Cámara', dataset: { mode, camera: 'starting' } },
    h('div', { class: 'cam-stage' }, video, h('div', { class: 'cam-reticle', 'aria-hidden': 'true' }), fallback),
    h('div', { class: 'cam-top' }, closeBtn, hint),
    h('div', { class: 'cam-bottom' },
      h('div', { class: 'cam-actions' }, gallery, shutter, h('span', { class: 'cam-side' })),
      codeForm,
      h('nav', { class: 'cam-modes', 'aria-label': 'Modo' }, modeButtons)),
    fileInput);

  // ---------- life cycle ----------
  function release() {
    clearTimeout(hintTimer);
    if (scanner) scanner.stop();
    scanner = null;
    stopStream(stream);
    stream = null;
    video.srcObject = null;
  }
  function close() { if (dlg.open) dlg.close(); else cleanup(); }
  function cleanup() {
    if (closed) return;
    closed = true;
    release();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('hashchange', onRoute);
    dlg.remove();
  }
  /** Closes the camera, then runs what was chosen: the next screen opens with the camera already off. */
  function done(next) { vibrate(40); close(); next(); }
  const onVisibility = () => { if (document.hidden) release(); else if (!closed) startCamera(); };
  const onRoute = () => close();
  dlg.addEventListener('close', cleanup);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('hashchange', onRoute);

  async function startCamera() {
    if (closed || starting || stream) return;
    starting = true;
    const r = await openCamera(mediaDevices);
    starting = false;
    if (closed || document.hidden) { if (r.ok) stopStream(r.stream); return; }
    if (!r.ok) { cameraOff = true; dlg.dataset.camera = 'off'; nocamText.textContent = NO_CAMERA[r.problem] || NO_CAMERA.unknown; say(''); return; }
    cameraOff = false;
    stream = r.stream;
    dlg.dataset.camera = 'on';
    await attachStream(video, stream);
    say(hintFor(mode));
    if (mode === 'code') startScanning();
  }

  async function startScanning() {
    if (!stream || closed) return;
    if (scanner) scanner.stop();
    say('Preparando el lector…');
    try {
      detectorInfo ||= env.detector ? { detector: env.detector, kind: 'fake' } : await createDetector();
    } catch (e) {
      say('No se pudo preparar el lector de códigos. Puedes buscar el producto a mano.');
      return;
    }
    if (closed || mode !== 'code' || !stream) return;
    scanner = createScanner({
      video, detector: detectorInfo.detector,
      onCode: (code) => done(() => onCode(code)),
      onIgnored: (kind) => say(kind === 'qr' ? 'Ese QR no es de un producto' : 'Ese código no es de un producto', { temporary: true }),
      onError: () => say('El lector de códigos dejó de funcionar. Puedes buscar el producto a mano.'),
    });
    scanner.start();
    say(HINT.code);
  }

  function setMode(next) {
    if (next === 'search') { done(() => onSearch(cameraOff ? 'La cámara no está disponible: busca el alimento a mano.' : '')); return; }
    mode = next;
    onMode(next);
    dlg.dataset.mode = next;
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === next));
    if (scanner) { scanner.stop(); scanner = null; }
    say(cameraOff ? '' : hintFor(next));
    if (next === 'code') startScanning();
  }

  async function takePhoto() {
    if (!stream) return;
    shutter.disabled = true;
    const picture = await frameToBlob(video);
    shutter.disabled = false;
    if (!picture) { say('No se pudo hacer la foto. Inténtalo otra vez.', { temporary: true }); return; }
    done(() => onPhoto(picture.blob, { label: mode === 'label' }));
  }

  document.body.append(dlg);
  dlg.showModal();
  say(hintFor(mode));
  startCamera();
  return { close, el: dlg, get mode() { return mode; }, get streaming() { return !!stream; } };
}
