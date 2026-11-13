# Security

foodie is a static web app (HTML, CSS and JavaScript served by GitHub Pages). Everything you enter stays in your browser's IndexedDB (the theme choice alone stays in `localStorage`). An account is optional: if you sign in with Google, a copy is kept in Firestore under your own user id, and nothing else in the app talks to the network. This page says what is defended, how that is checked, and what is not.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue for a security problem. This is a one-person project; expect a reply in days, not hours.

## What is defended

Every row names the test that fails if the defence is removed. Tests are in `tests/`; run them with `npm test`.

| Risk | Defence | Test |
|---|---|---|
| Script injection through text (meal names, food names, backups) | The UI is built only with `createElement` and text nodes; no `innerHTML`, no `eval`; strict CSP with no inline code | `static.test.js` (CSP, no HTML from strings), `dom.test.js` (text becomes text nodes) |
| An attribute or tag that executes code | `app/ui/dom.js` drops `on*` attributes that are not functions, `srcdoc`, invalid attribute names; refuses `script`, `iframe`, `object`, `embed`, `style`, `link`, `meta`, `base`; URL attributes accept only relative URLs, `#fragments`, `blob:` and raster `data:image/` | `dom.test.js` |
| Crafted link (`#constructor`, `#__proto__`, huge or malformed hashes) | Routes are resolved by comparing with an explicit list, never by object lookup | `router.test.js` |
| Hostile data in local storage (a corrupted database, a script on the same origin) | Everything read back is validated: ids match `^[A-Za-z0-9_-]{1,64}$` and never `__proto__`, `constructor`, `toString`...; maps of days, meals and weights have no prototype; numbers are finite and in range; unknown fields are dropped | `security.test.js` (fuzzing of every cleaner with 33,000 seeded inputs: never throws, valid shape, idempotent, prototype untouched; store under attack) |
| Control, zero-width and bidi characters in names (spoofing, broken layout) | Names are single-line: those characters are removed, whitespace collapsed, text cut by code points | `security.test.js` (defect 3 tests, XSS corpus) |
| Runaway data (memory, slow start) | Caps: 100 meals per day, 4,000 days and weights, 300 favourites, 32 MB per stored value and 64 MB in total (larger values are not parsed or written, and the problem is reported), at most 20 photo thumbnails per day and among the favourites | `security.test.js` (defect 5 tests) |
| Another app or the network reading data through this one | CSP `connect-src 'self'`, no cookies, `window.name`; `indexedDB`, `BroadcastChannel`, `postMessage` and `localStorage` appear only in `app/data/idb-storage.js` (and `localStorage` also in `app/boot.js` for the theme), `app/data/store.js` touches no storage API; keys start with `fd.` | `static.test.js` (security guards) |
| Service worker serving or caching something it should not | Only same-origin GET requests are answered; only the app's own files are stored; only `foodie-*` caches are deleted | `static.test.js` |
| Dependency and CI supply chain | No runtime dependencies; GitHub Actions pinned by commit hash with least privilege | `static.test.js` |

Fuzzing is deterministic. If it ever fails, the message prints the seed; replay with `FOODIE_FUZZ_SEED=<seed> npm test`. A manual browser check is in `tools/xss_fuzz_seed.js`.

## What is NOT defended

- **Local data is not encrypted.** Anyone with access to your browser profile, or any script running on the same origin, can read it.
- **One origin for every project of the account.** GitHub Pages serves all projects of `imsothe.github.io` from the same origin. A script-injection bug in a sibling app could read foodie's IndexedDB, `localStorage` and cache, and a bug in foodie could do the same to them. The `fd.` key prefix and `foodie-` cache prefix prevent accidents, not attacks. A custom domain for foodie would remove this exposure.
- **No integrity check of the backup file** you export: importing is not built, and nothing signs the file.
- **Look-alike text.** Names are cleaned of control and bidi characters but not of look-alike letters or invisible filler characters outside that list.
- **Nutrition and goal figures are estimates** (a standard formula and rounded food tables), not medical advice. They are not verified by this project's tests, which check only internal consistency.
- **Browser and extensions** are outside this app's control, and the checks above were run in a recent Chromium and Node, not on every browser.

## Local storage (IndexedDB): what is defended and what is not

Data used to live in `localStorage` (about 5 MB per origin, enough for months but not for a year with photo thumbnails). It now lives in an IndexedDB database `foodie` (one object store, one record per `fd.*` key). The store keeps the same synchronous API: everything is loaded into memory at start (`await store.ready` in `app/main.js`) and changes are written behind, after 400 ms, when the page is hidden or closed, in one transaction.

| Risk | Defence | Test |
|---|---|---|
| Losing data when moving from `localStorage` | One-time migration through the same cleaners, in one transaction with a marker; the result is read back and compared with what was meant to be written. If anything differs, the transaction is rolled back and `localStorage` stays the source. A migration interrupted after the commit is recognised by the marker and finished; `localStorage` is never deleted before the read-back succeeds | `idb-storage.test.js` (success, failed verification, interrupted, unreadable keys) |
| IndexedDB missing, blocked, slow or full (private modes, quota, another tab holding an old version) | Falls back to `localStorage` if it works, otherwise to memory, and the app says "no se puede guardar" instead of pretending; opening has a 2.5 s timeout; a failed write is reported and retried, never silently dropped | `idb-storage.test.js` (open fails, blocked, timeout, write errors, quota) |
| Every existing hostile-data defence still holding on the new backend | The store, fuzzing, cloud-sync and cache tests run a second time, unchanged, against the real IndexedDB layer on a hand-made fake database | `idb-backend.test.js` |
| Two tabs overwriting each other | A `BroadcastChannel` tells the other tab which keys changed; it reloads those through the cleaners and ignores messages that are not well-formed. Unchanged text is never written, so there are no echo loops; keys with unsaved local edits are not overwritten | `idb-storage.test.js` (two tabs, no echo) |
| A photo thumbnail making a cloud day document too big | Thumbnails are at most 12 KB; at most 20 per day and 20 among favourites (a meal past the cap is saved without its thumbnail), so a Firestore day stays far below its 1 MiB limit | `thumbs.test.js` |

Not defended, and worth knowing:

- **A script on the same origin can read the database**, as it could read `localStorage`. `BroadcastChannel` messages are also readable by same-origin scripts; they carry only the names of changed keys, never data.
- **Eviction.** Browsers may delete site data under storage pressure or after a long time without use (Safari does this for sites that are not installed). The app asks nothing of the browser (it does not request persistent storage), so on-device data without a cloud copy can disappear. The export button and the optional cloud copy are the backups.
- **The write-behind window.** A crash or a killed tab in the 400 ms before a write can lose the last edit. The page flushes when it is hidden or closed; there is no flush on a power cut.
- **Real-browser coverage is Chromium only.** The tests use a fake IndexedDB; Safari's behaviour (including on an installed iPhone app) has not been verified.

## Cloud copy (optional): what is defended and what is not

| Risk | Defence | Test |
|---|---|---|
| Someone reading another user's data | `firestore.rules`: deny by default; a signed-in user can read and write only `users/{their uid}`; every write validates field names, types, ranges and map sizes | `rules.test.js` (static, mutation-checked) |
| A different account on the same phone inheriting the first one's data | On sign-in, if the stored account id differs, the local data is cleared before anything is merged | `cloud.test.js` ("another account ...") |
| Hostile or corrupt cloud documents | Everything that comes back goes through the same cleaners as local data before it is merged or shown | `cloud.test.js`, `merge.test.js`, fuzzing in `security.test.js` |
| Two devices overwriting each other | Per-record merge: newest edit wins, deletions travel as tombstones, a clock far in the future is capped; merging is commutative, idempotent and associative | `merge.test.js` (2,000 generated state triples), `cloud.test.js` (two devices) |
| Loading code from the network | The Firebase SDK is vendored in `app/vendor/` (version, hash and licences in its README) and served from this origin; the CSP allows `apis.google.com` for scripts only (the helper Firebase Auth loads to open the Google popup) and one frame (this project's `firebaseapp.com` sign-in page) | `static.test.js` (CSP lists pinned, each host with a reason) |

The `apiKey` in `app/data/firebase-config.js` is not a secret: every Firebase web app ships it, and it only identifies the project. The data is protected by the rules above, and a test allows that key in that one file only.

Not defended, and worth knowing:

- **The rules are tested as text, not executed.** `rules.test.js` fails if a rule is opened up or a validation is dropped, but it does not run the rules against requests. Running them needs the Firestore emulator and is not set up yet.
- **Rules cannot look inside a meal.** They cap how many entries a map may hold and check each field's type and range; the content of meals (names, items, per-100 g values) is checked by the app's cleaners on every read and write. A user can only damage their own data.
- **Google sees your data.** It is stored in Google's Firestore (eur3, Europe) under your Google account id. foodie has no server of its own and cannot read it without you being signed in.
- **Sign-in was verified up to Google's account page, not past it.** Opening the popup and reaching Google's sign-in produced no CSP violation; a complete sign-in, and the sync against the real Firestore, still need to be exercised by a person with a Google account (including the installed iPhone PWA).

## Camera and barcode scanning: what is defended and what is not

| Risk | Defence | Test |
|---|---|---|
| A scanned code that opens something | Scanned text is never opened or navigated to: only a bare number or a GS1 Digital Link with a valid check digit becomes a product code, everything else is ignored | `off.test.js`, `scanner.test.js` (links, Wi-Fi codes, bad check digits) |
| A hostile product record (name with markup, a picture from another host, absurd numbers) | The record is cleaned like any other text and range-checked before it is cached or shown; the picture must be on `images.openfoodfacts.org`; rendering is by text nodes only | `off.test.js`, `off-client.test.js`, `dom.test.js` |
| A hostile or corrupt product cache in local storage (`fd.products`) | Validated on load like every key, capped at 200 products, never exported or synced | `off-client.test.js` |
| The camera staying on | Every track is stopped when the view closes, the route changes or the page is hidden (verified in Chromium with a simulated camera) | `scanner.test.js`; browser check |
| Loading the barcode reader from a CDN | The reader and its WebAssembly are vendored in `app/vendor/lazy/` and served from this origin; the library's default CDN address is overridden | `static.test.js` (vendored files listed by exact path) |

Hosts and permissions added for this, each one pinned with its reason in `tests/static.test.js`:

- `connect-src https://world.openfoodfacts.org`: one GET per new product, asking only for the fields the app uses, with no cookies and no referrer. The barcode that is looked up is sent to Open Food Facts together with your IP address, as with any web request.
- `img-src https://images.openfoodfacts.org`: the product picture. It is the only external host an `<img src>` may name (`app/ui/dom.js`).
- `script-src 'wasm-unsafe-eval'`: the barcode reader is ZXing compiled to WebAssembly, and Chromium refuses to instantiate it without this keyword (without it the console reports `script-src | wasm-eval` and the reader never starts). It allows WebAssembly only; `eval()` and string-to-code stay blocked. It is needed only on browsers without a native BarcodeDetector.

Not defended, and worth knowing: Open Food Facts is a crowd-sourced database; values can be wrong or missing, and the app shows what is missing but cannot tell if a stated value is accurate. The camera permission is granted to the whole origin by the browser, so any other app on `imsothe.github.io` shares it.

## Photo analysis (AI): what is defended and what is not

What leaves the device: one shrunk copy of the photo (at most about 400 KB, inline) and, if you typed one, a line of context, sent to Google (Gemini, through Firebase AI Logic). foodie does not store the photo; only a 160 px JPEG thumbnail (at most 12 KB) is saved with the meal, and only when you add the meal.

| Risk | Defence | Test |
|---|---|---|
| Hostile or broken model output (markup in names, absurd grams, wrong types, hostile keys) | Every field is range-checked and cleaned by `core/vision.js`; items without calories are dropped; grams are capped; calories that do not match the macros are flagged; the result is rendered as text | `vision.test.js` (fixtures and 3,000 fuzzed answers) |
| A photo or an answer stored by accident | The screen only hands a meal (with at most a small thumbnail) to the store; the thumbnail must be a JPEG data URL under 12 KB or it is dropped | `static.test.js`, `vision.test.js` (thumbnails), `image.test.js` |
| Runaway calls | One analysis at a time, a 3 s cooldown, a 45 s timeout, one retry for a transient failure | `vision-data.test.js` |
| The App Check debug token reaching production | It is switched on only when the host name is exactly `localhost` or `127.0.0.1`, and the string appears once in the code | `static.test.js`, `vision-data.test.js` |

Who can call the AI, said plainly:

- **The AI endpoint rejects requests that lack a valid App Check token.** This was checked by calling it with only the public web configuration: it answered 401 "Firebase App Check token is invalid". Firestore without sign-in answers 403.
- **App Check does not require a signed-in user.** "Only signed-in people can analyse photos" is a rule of this app (`data/vision.js` checks `cloud.user` before it touches Firebase), not something Google enforces on our behalf. A script running inside this app's own page could still obtain App Check tokens; reCAPTCHA's scoring limits that, it does not eliminate it.
- **The free quota is shared by every user of the project.** If it runs out, the photo flow says so ("se agotó el límite gratuito de hoy"). Nothing here claims the quota is protected.
- **App Check uses reCAPTCHA Enterprise (Fraud Defense).** `APP_CHECK_SITE_KEY` in `app/data/firebase-config.js` is public by design. The key is allowed for `imsothe.github.io` and `localhost` only; any other host (a fork, a preview deployment) gets no App Check token until its own debug token is registered in the Firebase console. If the key were empty the photo flow would show "La IA no está configurada todavía" and send nothing. On localhost the app turns on Firebase's debug token mechanism, and only there.
- **Google sees the photos you send.** Under Google's terms for the Gemini Developer API, not foodie's. Do not photograph anything you would not send to Google.

The model is `gemini-3.5-flash-lite` (a constant in `app/data/vision.js`): the larger `gemini-3.8-flash` answered HTTP 500 "high demand" or did not answer on the day this was tried, the lite model answered in 1 to 4 seconds. Both need no billing plan.

Hosts added for this, each pinned with its reason in `tests/static.test.js` (found by running the real App Check and AI calls from localhost with the site key and reading the requests and the browser's CSP violations; each reCAPTCHA host was then removed in turn to confirm it is needed):

- `connect-src https://firebasevertexai.googleapis.com`: the Firebase AI Logic endpoint the SDK calls with the photo.
- `connect-src https://content-firebaseappcheck.googleapis.com`: exchange of the reCAPTCHA result for an App Check token.
- `script-src https://www.google.com https://www.gstatic.com`, `frame-src https://www.google.com`, `connect-src https://www.google.com`: reCAPTCHA Enterprise (the Fraud Defense provider registered for App Check), which attests that the request comes from this app. The reCAPTCHA scripts run in the page; they are Google's, loaded from Google, and nothing else is allowed.

## Planned, not built

Rules tests that execute the rules against the Firestore emulator in CI. Server-side enforcement of "signed in" for the AI endpoint (it is an app rule today). Registering the App Check site key, and a real run of the photo analysis. None of this exists yet.
