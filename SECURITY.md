# Security

foodie is a static web app (HTML, CSS and JavaScript served by GitHub Pages). Today it has no server, no account and no network calls of its own: everything you enter stays in your browser's `localStorage`. This page says what is defended, how that is checked, and what is not.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue for a security problem. This is a one-person project; expect a reply in days, not hours.

## What is defended

Every row names the test that fails if the defence is removed. Tests are in `tests/`; run them with `npm test`.

| Risk | Defence | Test |
|---|---|---|
| Script injection through text (meal names, food names, backups) | The UI is built only with `createElement` and text nodes; no `innerHTML`, no `eval`; strict CSP with no inline code | `static.test.js` (CSP, no HTML from strings), `dom.test.js` (text becomes text nodes) |
| An attribute or tag that executes code | `app/ui/dom.js` drops `on*` attributes that are not functions, `srcdoc`, invalid attribute names; refuses `script`, `iframe`, `object`, `embed`, `style`, `link`, `meta`, `base`; URL attributes accept only relative URLs, `#fragments`, `blob:` and raster `data:image/` | `dom.test.js` |
| Crafted link (`#constructor`, `#__proto__`, huge or malformed hashes) | Routes are resolved by comparing with an explicit list, never by object lookup | `router.test.js` |
| Hostile data in `localStorage` (a corrupted file, a script on the same origin) | Everything read back is validated: ids match `^[A-Za-z0-9_-]{1,64}$` and never `__proto__`, `constructor`, `toString`...; maps of days, meals and weights have no prototype; numbers are finite and in range; unknown fields are dropped | `security.test.js` (fuzzing of every cleaner with 33,000 seeded inputs: never throws, valid shape, idempotent, prototype untouched; store under attack) |
| Control, zero-width and bidi characters in names (spoofing, broken layout) | Names are single-line: those characters are removed, whitespace collapsed, text cut by code points | `security.test.js` (defect 3 tests, XSS corpus) |
| Runaway data (memory, slow start) | Caps: 100 meals per day, 4,000 days and weights, 300 favourites, 5 MB per stored value (larger values are not parsed and the problem is reported) | `security.test.js` (defect 5 tests) |
| Another app or the network reading data through this one | CSP `connect-src 'self'`, no `postMessage`, cookies, `window.name`, IndexedDB; `localStorage` only in `app/data/store.js` and `app/boot.js` for the theme; keys start with `fd.` | `static.test.js` (security guards) |
| Service worker serving or caching something it should not | Only same-origin GET requests are answered; only the app's own files are stored; only `foodie-*` caches are deleted | `static.test.js` |
| Dependency and CI supply chain | No runtime dependencies; GitHub Actions pinned by commit hash with least privilege | `static.test.js` |

Fuzzing is deterministic. If it ever fails, the message prints the seed; replay with `FOODIE_FUZZ_SEED=<seed> npm test`. A manual browser check is in `tools/xss_fuzz_seed.js`.

## What is NOT defended

- **Local data is not encrypted.** Anyone with access to your browser profile, or any script running on the same origin, can read it.
- **One origin for every project of the account.** GitHub Pages serves all projects of `imsothe.github.io` from the same origin. A script-injection bug in a sibling app could read foodie's `localStorage` and cache, and a bug in foodie could do the same to them. The `fd.` key prefix and `foodie-` cache prefix prevent accidents, not attacks. A custom domain for foodie would remove this exposure.
- **No integrity check of the backup file** you export: importing is not built, and nothing signs the file.
- **Look-alike text.** Names are cleaned of control and bidi characters but not of look-alike letters or invisible filler characters outside that list.
- **Nutrition and goal figures are estimates** (a standard formula and rounded food tables), not medical advice. They are not verified by this project's tests, which check only internal consistency.
- **Browser and extensions** are outside this app's control, and the checks above were run in a recent Chromium and Node, not on every browser.

## Planned, not built

Sign-in and cloud copy are not implemented. When they are, the plan is: per-user Firestore rules that deny everything by default and allow a user only their own documents, rules tests run in CI, a CSP `connect-src` extended with the exact hosts and nothing else (the test in `static.test.js` lists the allowed hosts so that adding one is a deliberate change), and the same cleaning of everything that comes back from the server. None of this exists yet.
