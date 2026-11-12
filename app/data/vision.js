/* foodie · analysing a photo of food with Gemini through Firebase AI Logic.
   What leaves the device: one shrunk copy of the photo (at most about 400 KB, sent inline in one request to Google) and, if the person
   typed one, a line of context. foodie never stores the photo: only a 160 px thumbnail of at most 12 KB can end up in a meal.
   Rules of this module, all of them tested with fakes (tests/vision-data.test.js):
   - it needs a signed-in person (a rule of the app, not something Google enforces for us; see SECURITY.md);
   - App Check is initialised before the model is created, and the call says "not configured" until a site key exists;
   - one analysis at a time, a 3 s cooldown, a 45 s timeout, one retry for a transient failure;
   - every failure becomes a short reason the screen turns into a calm sentence; the answer is parsed by core/vision.js. */
import { APP_CHECK_SITE_KEY } from './firebase-config.js';
import { buildVisionPrompt, parseVision, toSdkSchema, VISION_JSON_SCHEMA } from '../core/vision.js';
import { compressFile, thumbnailDataUrl } from './image.js';

/**
 * The model to ask: named in the Firebase AI Logic documentation as a current model that needs no billing plan, and the one that
 * answered in about a second when tried for real. gemini-3.8-flash (also free) timed out or answered HTTP 500 "high demand" on every
 * try on the day this was built; changing the constant is all it takes to switch.
 */
export const VISION_MODEL = 'gemini-3.5-flash-lite';
export const TIMEOUT_MS = 45000;
export const COOLDOWN_MS = 3000;
export const RETRY_DELAY_MS = 1500;

/** @typedef {'signed-out'|'not-configured'|'busy-local'|'cooldown'|'bad-image'|'quota'|'app-check'|'offline'|'timeout'|'busy'|'blocked'|'bad-answer'|'error'} VisionProblem */

/** Why a call failed, as a reason the screen can act on. Reads the HTTP status, the SDK's error code and the message. */
export function classifyAiError(e, { onLine = true } = {}) {
  const status = Number(e && e.customErrorData && e.customErrorData.status) || Number(e && e.status) || 0;
  const text = `${e && e.code ? e.code : ''} ${e && e.message ? e.message : ''}`;
  if (e && (e.name === 'TimeoutError' || e.code === 'timeout' || /timed? ?out|deadline/i.test(text))) return 'timeout';
  if (/app ?check/i.test(text) || (status === 401)) return 'app-check';
  if (status === 429 || /quota|resource[_ ]exhausted|rate ?limit|too many requests/i.test(text)) return 'quota';
  if (!onLine) return 'offline';
  // The SDK reports an HTTP error as "fetch-error" too: a status means the server answered, so it is not an offline problem.
  if (status >= 500 || /high demand|try again later|unavailable|overloaded|internal/i.test(text)) return 'busy';
  if (status === 403 && /api[-_ ]?not[-_ ]?enabled|permission/i.test(text)) return 'app-check';
  if (!status && ((e && e.name === 'TypeError') || /failed to fetch|network|fetch-error|load failed/i.test(text))) return 'offline';
  if (/safety|blocked|prohibited|recitation/i.test(text)) return 'blocked';
  return 'error';
}

const isLocalhost = (win) => !!(win && win.location && /^(localhost|127\.0\.0\.1)$/.test(win.location.hostname));

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('could not read the picture'));
    r.readAsDataURL(blob);
  });
}

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error('the analysis took too long'), { name: 'TimeoutError' })), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

/**
 * @param {object} o
 * @param {{user:object|null, firebase:()=>Promise<{sdk:object, app:object}>}} o.cloud
 * @param {string} [o.appCheckSiteKey]
 * @param {(deps:{sdk:object, app:object, siteKey:string})=>void} [o.initAppCheck]  the App Check hook: the default registers reCAPTCHA Enterprise
 */
export function createVision({
  cloud, appCheckSiteKey = APP_CHECK_SITE_KEY, now = () => Date.now(), compress = compressFile, toBase64 = blobToBase64,
  delay = (ms) => new Promise((r) => setTimeout(r, ms)), win = globalThis.window, timeoutMs = TIMEOUT_MS, cooldownMs = COOLDOWN_MS,
  initAppCheck = null, makeThumb = defaultThumb,
}) {
  let model = null;
  let appCheckDone = false;
  let inFlight = false;
  let lastEnd = -Infinity;

  function defaultInitAppCheck({ sdk, app, siteKey }) {
    // On localhost Firebase's debug token is used (printed once in the browser console and registered by the owner in the Firebase console), so
    // development never depends on reCAPTCHA scoring. This line never runs on any other host: another host must be in the site key's allowed
    // domains (imsothe.github.io and localhost today) or have its own debug token registered.
    if (isLocalhost(win)) globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    sdk.initializeAppCheck(app, { provider: new sdk.ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true });
  }

  async function ensureModel() {
    const { sdk, app } = await cloud.firebase();
    if (!appCheckDone) { (initAppCheck || defaultInitAppCheck)({ sdk, app, siteKey: appCheckSiteKey }); appCheckDone = true; }       // before the model exists
    if (!model) {
      const prompt = buildVisionPrompt();
      model = sdk.getGenerativeModel(sdk.getAI(app, { backend: new sdk.GoogleAIBackend() }), {
        model: VISION_MODEL,
        systemInstruction: prompt.system,
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: toSdkSchema(VISION_JSON_SCHEMA, sdk.Schema),
          thinkingConfig: { thinkingLevel: sdk.ThinkingLevel.LOW },       // a little reasoning for the weights; MINIMAL is this model's default
        },
        requestOptions: { timeout: timeoutMs },
      });
    }
    return model;
  }

  async function callOnce(m, data, mimeType, user) {
    const out = await withTimeout(m.generateContent([{ type: 'inlineData', inlineData: { data, mimeType } }, user]), timeoutMs);
    return out.response.text();
  }

  return {
    /**
     * @param {Blob} picture  the photo as taken or chosen (it is shrunk here)
     * @param {{context?:string, label?:boolean}} [o]
     * @returns {Promise<{ok:true, result:object, photo:Blob}|{ok:false, reason:VisionProblem}>}
     */
    async analyze(picture, { context = '', label = false } = {}) {
      if (!cloud.user) return { ok: false, reason: 'signed-out' };
      if (!appCheckSiteKey) return { ok: false, reason: 'not-configured' };
      if (inFlight) return { ok: false, reason: 'busy-local' };
      if (now() - lastEnd < cooldownMs) return { ok: false, reason: 'cooldown' };
      inFlight = true;
      try {
        const photo = await compress(picture);
        if (!photo) return { ok: false, reason: 'bad-image' };
        const data = await toBase64(photo.blob);
        const m = await ensureModel();
        const { user } = buildVisionPrompt({ context, label });
        let text;
        try {
          text = await callOnce(m, data, photo.blob.type, user);
        } catch (e) {
          if (classifyAiError(e, { onLine: !win || !win.navigator || win.navigator.onLine !== false }) !== 'busy') throw e;
          await delay(RETRY_DELAY_MS);                                    // one retry, only for a transient failure
          text = await callOnce(m, data, photo.blob.type, user);
        }
        const result = parseVision(text);
        return result.ok ? { ok: true, result, photo: photo.blob } : { ok: false, reason: 'bad-answer' };
      } catch (e) {
        return { ok: false, reason: classifyAiError(e, { onLine: !win || !win.navigator || win.navigator.onLine !== false }) };
      } finally {
        inFlight = false;
        lastEnd = now();
      }
    },
    /** The small JPEG that is kept with the meal, or null. The photo itself is not kept. */
    thumbnail: (photo) => makeThumb(photo),
    get configured() { return !!appCheckSiteKey; },
  };
}

async function defaultThumb(photo) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(photo);
    return await thumbnailDataUrl(bitmap);
  } catch (e) {
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}
