/* foodie · looking a scanned code up in Open Food Facts (ODbL, https://world.openfoodfacts.org).
   A product seen before is answered from the local cache at once (and offline); otherwise one request, with a timeout,
   asking only for the fields the app uses. The answer is cleaned by core/off.js before anything else sees it. */
import { normalizeCode, offUrl, productFromOff } from '../core/off.js';

export const LOOKUP_TIMEOUT_MS = 8000;

/** @typedef {{ok:true, product:object, cached:boolean}|{ok:false, reason:'invalid'|'not-found'|'no-nutrition'|'offline'|'timeout'|'error'}} LookupResult */

/**
 * @param {object} o
 * @param {{getProduct:(code:string)=>object|null, putProduct:(p:object)=>object|null}} o.store
 * @param {typeof fetch} [o.fetchFn]
 * @param {number} [o.timeoutMs]
 * @param {{navigator?:{onLine?:boolean}}} [o.win]
 */
export function createOffClient({ store, fetchFn = (...a) => fetch(...a), timeoutMs = LOOKUP_TIMEOUT_MS, win = globalThis.window } = {}) {
  /** @returns {Promise<LookupResult>} */
  async function lookup(rawCode) {
    const code = normalizeCode(String(rawCode));
    if (!code) return { ok: false, reason: 'invalid' };
    const known = store.getProduct(code);
    if (known) return { ok: true, product: known, cached: true };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(offUrl(code), { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
      if (response.status === 404) return { ok: false, reason: 'not-found' };
      if (!response.ok) return { ok: false, reason: 'error' };
      const parsed = productFromOff(await response.json(), code);
      if (!parsed.ok) return { ok: false, reason: parsed.reason === 'invalid' ? 'error' : parsed.reason };
      return { ok: true, product: store.putProduct(parsed) || parsed, cached: false };
    } catch (e) {
      if (controller.signal.aborted) return { ok: false, reason: 'timeout' };
      // fetch rejects with a TypeError when there is no network (or a blocked request): both mean "could not reach it"
      const unreachable = (win && win.navigator && win.navigator.onLine === false) || (e && e.name === 'TypeError');
      return { ok: false, reason: unreachable ? 'offline' : 'error' };
    } finally { clearTimeout(timer); }
  }
  return { lookup };
}
