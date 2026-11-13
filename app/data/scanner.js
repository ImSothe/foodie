/* foodie · barcode scanning. A throttled loop that asks a detector about the current video frame, stops at the first valid
   product code, and ignores everything else (a QR with a link, a Wi-Fi code, a damaged barcode): scanned text is never opened,
   never navigated to, never shown as markup.
   The detector is the browser's own BarcodeDetector when it supports our formats, otherwise a vendored ZXing WebAssembly
   ponyfill that is loaded only when needed (app/vendor/lazy/, served from this origin). */
import { normalizeCode } from '../core/off.js';

// Retail codes first, then the other common linear symbologies (ITF-14 on cases, Code 128/39/93, Codabar, GS1 DataBar) and 2D codes.
// Only a numeric GTIN with a valid check digit (or a GS1 link holding one) becomes a product; anything else is reported as "not a product".
export const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'code_128', 'code_39', 'code_93', 'codabar',
  'databar', 'databar_expanded', 'databar_limited', 'qr_code', 'data_matrix', 'pdf417', 'aztec', 'micro_qr_code'];
export const SCAN_INTERVAL_MS = 125;             // about 8 frames a second: plenty for a barcode, kind to the battery
const MAX_CONSECUTIVE_ERRORS = 20;
const IGNORED_NOTICE_GAP_MS = 3000;

/** The ponyfill, with its WebAssembly pointed at our own copy instead of a CDN. */
export async function loadPonyfill() {
  const m = await import('../vendor/lazy/barcode-detector.js');
  const wasm = new URL('../vendor/lazy/zxing_reader.wasm', import.meta.url).href;
  m.setZXingModuleOverrides({ locateFile: (name, prefix) => (name.endsWith('.wasm') ? wasm : prefix + name) });
  return m.BarcodeDetector;
}

/**
 * @param {{win?:object, loadPonyfill?:()=>Promise<Function>}} [o]
 * @returns {Promise<{detector:{detect:(v:any)=>Promise<{rawValue:string,format?:string}[]>}, kind:'native'|'wasm'}>}
 */
export async function createDetector({ win = globalThis, load = loadPonyfill } = {}) {
  const Native = win && win.BarcodeDetector;
  if (typeof Native === 'function') {
    try {
      const supported = typeof Native.getSupportedFormats === 'function' ? await Native.getSupportedFormats() : FORMATS;
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.includes('ean_13') && formats.includes('qr_code')) return { detector: new Native({ formats }), kind: 'native' };
    } catch (e) { /* a native detector that misbehaves is replaced by the ponyfill */ }
  }
  const Poly = await load();
  return { detector: new Poly({ formats: FORMATS }), kind: 'wasm' };
}

/**
 * @param {object} o
 * @param {{videoWidth?:number, readyState:number}} o.video
 * @param {{detect:(v:any)=>Promise<{rawValue:string, format?:string}[]>}} o.detector
 * @param {(code:string, info:{format:string})=>void} o.onCode   called once, with a valid product code
 * @param {(kind:'qr'|'other')=>void} [o.onIgnored]               something was seen that is not a product code (rate limited)
 * @param {(e:Error)=>void} [o.onError]                           the detector keeps failing
 */
export function createScanner({
  video, detector, onCode, onIgnored = () => {}, onError = () => {}, intervalMs = SCAN_INTERVAL_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), now = () => Date.now(),
}) {
  let timer = null;
  let running = false;
  let busy = false;
  let errors = 0;
  let lastNotice = -Infinity;

  async function tick() {
    timer = null;
    if (!running) return;
    if (!busy && video.readyState >= 2) {          // HAVE_CURRENT_DATA: there is a frame to look at
      busy = true;
      try {
        const found = await detector.detect(video);
        errors = 0;
        if (!running) return;
        for (const r of Array.isArray(found) ? found : []) {
          const raw = r && typeof r.rawValue === 'string' ? r.rawValue : '';
          const code = normalizeCode(raw, String(r.format || ''));
          if (code) { running = false; onCode(code, { format: String(r.format || '') }); return; }
          if (raw && now() - lastNotice > IGNORED_NOTICE_GAP_MS) { lastNotice = now(); onIgnored(r.format === 'qr_code' ? 'qr' : 'other'); }
        }
      } catch (e) {
        errors += 1;
        if (errors >= MAX_CONSECUTIVE_ERRORS) { running = false; onError(e instanceof Error ? e : new Error('detector failed')); return; }
      } finally { busy = false; }
    }
    if (running) timer = setTimer(tick, intervalMs);
  }

  return {
    start() { if (running) return; running = true; errors = 0; timer = setTimer(tick, 0); },
    stop() { running = false; if (timer !== null) { clearTimer(timer); timer = null; } },
    get running() { return running; },
  };
}
