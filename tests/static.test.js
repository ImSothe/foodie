/* Static guards: things that must stay true in every commit (security policy, offline shell, no secrets). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR, listAppFiles, computeStamp, stampBlock, readStampedBlock } from '../tools/stamp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const html = read('app/index.html');
const appJs = listAppFiles().filter((f) => f.endsWith('.js')).concat('sw.js');

test('CSP: nothing allowed by default, no inline code, no eval, no wildcard hosts', () => {
  const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(m, 'the page has no CSP');
  const csp = Object.fromEntries(m[1].split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...v]) => [name, v]));
  assert.deepEqual(csp['default-src'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'none'"]);
  assert.deepEqual(csp['form-action'], ["'none'"]);
  for (const dir of ['script-src', 'style-src']) {
    assert.ok(csp[dir], `${dir} missing`);
    assert.ok(!csp[dir].includes("'unsafe-inline'") && !csp[dir].includes("'unsafe-eval'"), `${dir} is too open`);
  }
  for (const [dir, values] of Object.entries(csp)) {
    for (const v of values) assert.ok(v !== '*' && v !== 'https:' && v !== 'http:' && !/^https?:\/\/\*$/.test(v), `${dir} has a wildcard: ${v}`);
  }
  assert.ok(!('frame-ancestors' in csp), 'frame-ancestors does nothing in a meta tag: boot.js is the defence');
});

test('HTML: no inline scripts, styles or event handlers, and zoom is not blocked', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/<style[\s>]/i.test(html), 'inline <style>');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler');
  assert.ok(!/javascript:/i.test(html));
  assert.ok(!/user-scalable\s*=\s*no|maximum-scale/i.test(html), 'blocking zoom hurts accessibility');
  assert.ok(/name="referrer" content="no-referrer"/.test(html));
});

test('boot.js loads first, hides the app inside foreign frames and sets the theme before paint', () => {
  const boot = read('app/boot.js');
  assert.ok(html.indexOf('src="boot.js"') > 0 && html.indexOf('src="boot.js"') < html.indexOf('rel="stylesheet"'));
  assert.ok(/window\.top\s*!==\s*window\.self/.test(boot));
  assert.ok(/dataset\.theme/.test(boot));
});

test('app code never builds HTML from strings or evaluates text as code', () => {
  const banned = [/\beval\s*\(/, /new\s+Function\s*\(/, /document\.write/, /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/,
    /\.srcdoc\b/, /setAttribute\(\s*['"`]srcdoc/i, /\bsrcdoc\s*[:=]/, /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/, /createContextualFragment/, /DOMParser/];
  for (const f of appJs) {
    const code = readFileSync(join(APP_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const re of banned) assert.ok(!re.test(code), `${f} uses ${re}`);
  }
});

test('every file referenced by index.html and the manifest exists', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^[a-z]+:/i.test(u));
  const manifest = JSON.parse(read('app/manifest.webmanifest'));
  for (const rel of [...refs, ...manifest.icons.map((i) => i.src)]) assert.ok(existsSync(join(APP_DIR, rel)), `missing: ${rel}`);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
});

test('every import in the app points to a file that exists', () => {
  for (const f of appJs) {
    const code = readFileSync(join(APP_DIR, f), 'utf8');
    for (const m of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      assert.ok(existsSync(join(APP_DIR, dirname(f), m[1])), `${f} imports ${m[1]}, which does not exist`);
    }
  }
});

test('service worker: the cached file list and version match the app (run `npm run stamp` after changing app/)', () => {
  assert.equal(readStampedBlock(), stampBlock(computeStamp()), 'app/sw.js is out of date: run `npm run stamp`');
  const { shell } = computeStamp();
  for (const needed of ['./index.html', './main.js', './boot.js', './css/tokens.css', './manifest.webmanifest']) assert.ok(shell.includes(needed), needed);
});

test('service worker: only deletes its own caches (the origin is shared with other GitHub Pages apps)', () => {
  const sw = read('app/sw.js');
  const deletions = [...sw.matchAll(/caches\.delete\(/g)].length;
  assert.equal(deletions, 1);
  assert.ok(/filter\(\(k\) => k\.startsWith\('foodie-'\) && k !== CACHE\)/.test(sw), 'cache cleanup must be limited to the foodie- prefix');
  assert.ok(/origin !== self\.location\.origin\) return/.test(sw), 'requests to other origins must not be intercepted');
});

test('workflows: least privilege and every action pinned to a full commit hash', () => {
  const dir = join(ROOT, '.github', 'workflows');
  for (const f of readdirSync(dir)) {
    const y = readFileSync(join(dir, f), 'utf8');
    assert.ok(/^permissions:/m.test(y), `${f} declares no permissions`);
    assert.ok(!/permissions:\s*write-all/.test(y));
    for (const m of y.matchAll(/uses:\s*(\S+)/g)) assert.ok(/@[0-9a-f]{40}$/.test(m[1]), `${f}: ${m[1]} is not pinned by hash`);
  }
});

test('repository: no runtime dependencies, no secrets and no personal data tracked', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  let files;
  try { files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) { return; }
  const secret = [/AIza[0-9A-Za-z_-]{35}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /gh[pousr]_[A-Za-z0-9]{30,}/, /sk-[A-Za-z0-9]{32,}/,
    /[A-Za-z0-9._%+-]+@(gmail|hotmail|outlook|yahoo|icloud)\.[a-z.]+/i, /[A-Z]:\\Users\\/];
  for (const f of files) {
    assert.ok(!/(^|\/)(\.env.*|.*\.pem|.*\.key|CLAUDE\.md|\.claude\/.*|\.secrets\/.*|llave.*\.txt)$/i.test(f), `sensitive file tracked: ${f}`);
    if (/\.(png|woff2)$/.test(f) || f === 'tests/static.test.js') continue;
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const re of secret) {
      // The one allowed exception: the Firebase web config. Its apiKey only identifies the project to Google and is public in every
      // Firebase web app; the data is protected by firestore.rules, not by hiding this value. Any other file holding one still fails.
      if (re.source.startsWith('AIza') && f === 'app/data/firebase-config.js') continue;
      assert.ok(!re.test(text), `possible secret or personal data in ${f}: ${re}`);
    }
  }
  const config = readFileSync(join(ROOT, 'app/data/firebase-config.js'), 'utf8');
  assert.equal((config.match(/AIza[0-9A-Za-z_-]{35}/g) || []).length, 1, 'firebase-config.js should hold exactly the web apiKey');
  assert.ok(!/privateKey|client_secret|serviceAccount/i.test(config), 'only public web config belongs in firebase-config.js');
});

// ---------------------------------------------------------------------------------------------
// Security guards (see SECURITY.md)
// ---------------------------------------------------------------------------------------------

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const appSource = (f) => stripComments(readFileSync(join(APP_DIR, f), 'utf8'));
const jsFiles = listAppFiles().filter((f) => f.endsWith('.js'));
// Third-party code, vendored by exact path (tools/vendor_*.mjs, see app/vendor/README.txt). It is minified SDK code that legitimately uses
// postMessage, IndexedDB, web storage, cookies for its own iframe protocol, absolute Google URLs and console warnings, so it is exempt from
// the guards about those APIs ONLY. The guards against HTML-from-strings and eval (above) still apply to it, and it passes them.
const VENDORED = new Map([['vendor/lazy/barcode-detector.js', 'ZXing ponyfill: a console warning and the default jsDelivr URL of its WebAssembly, which app/data/scanner.js overrides with a local file'], ['vendor/firebase.js','Firebase web SDK: uses postMessage/IndexedDB/web storage/cookies/console and Google URLs']]);
const ownJs = jsFiles.filter((f) => !VENDORED.has(f));

test('srcdoc is only ever named in the deny list of the DOM helper', () => {
  for (const f of jsFiles) {
    const hits = [...readFileSync(join(APP_DIR, f), 'utf8').matchAll(/srcdoc/gi)].length;
    if (f !== 'ui/dom.js') assert.equal(hits, 0, `${f} mentions srcdoc`);
  }
  const dom = readFileSync(join(APP_DIR, 'ui/dom.js'), 'utf8');
  assert.ok(/DROPPED_ATTRIBUTES = new Set\(\[[^\]]*'srcdoc'/.test(dom), 'dom.js must list srcdoc as a dropped attribute');
});

test('every storage key written in app/ starts with "fd." (the origin is shared with other apps)', () => {
  const literal = /(?:getItem|setItem|removeItem)\(\s*['"`]([^'"`]+)['"`]/g;
  let seen = 0;
  for (const f of [...ownJs, 'sw.js', 'boot.js']) {
    const code = appSource(f);
    for (const m of code.matchAll(literal)) {
      seen += 1;
      assert.ok(m[1].startsWith('fd.'), `${f}: storage key "${m[1]}" does not start with fd.`);
    }
    for (const m of code.matchAll(/['"`](fd\.[A-Za-z0-9._-]*)['"`]/g)) assert.match(m[1], /^fd\.[a-z]+$/, `${f}: odd key ${m[1]}`);
  }
  assert.ok(seen >= 1, 'the scan found no storage calls: the test is broken');
});

test('the store only touches the keys listed in STORAGE_KEYS, all under "fd."', async () => {
  const { STORAGE_KEYS } = await import('../app/data/store.js');
  for (const k of Object.values(STORAGE_KEYS)) assert.match(k, /^fd\.[a-z]+$/);
  const store = readFileSync(join(APP_DIR, 'data/store.js'), 'utf8');
  assert.ok(!/(?:getItem|setItem|removeItem)\(\s*['"`]/.test(store.replace(/__fd_probe__/g, '')), 'the store must use STORAGE_KEYS, not literals');
});

test('external links never leave the opener behind: target="_blank" needs rel="noopener"', () => {
  const sources = [['index.html', html], ...ownJs.map((f) => [f, readFileSync(join(APP_DIR, f), 'utf8')])];
  for (const [name, text] of sources) {
    if (/_blank/.test(text)) assert.ok(/noopener/.test(text), `${name} opens a new window without rel="noopener"`);
  }
});

test('no console.log or console.debug left in app/', () => {
  for (const f of [...ownJs, 'sw.js', 'boot.js']) assert.ok(!/console\.(log|debug|trace|dir)\b/.test(appSource(f)), `${f} has a console call`);
});

test('connect-src is exactly the allowed list: adding a host must be a deliberate change to this test', () => {
  // Every host below is needed by Google sign-in or Firestore sync (found by running the sign-in flow and reading the CSP violations):
  //   identitytoolkit.googleapis.com  sign-in requests          securetoken.googleapis.com  refreshing the sign-in token
  //   firestore.googleapis.com        reading and writing the user's own documents
  //   world.openfoodfacts.org         looking a scanned barcode up in Open Food Facts (one GET, only the fields the app uses)
  //   firebasevertexai.googleapis.com the Firebase AI Logic endpoint the SDK calls for the photo analysis (seen in the requests of a real call)
  //   content-firebaseappcheck.googleapis.com  App Check: exchange of the reCAPTCHA Enterprise result for a token (seen in a real run with the site key)
  //   www.google.com                  reCAPTCHA Enterprise (App Check) posts to /recaptcha/enterprise/clr (seen in a real run)
  // Adding a host must be a deliberate change to this test, with a line saying why.
  const ALLOWED_CONNECT_SRC = ["'self'", 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://firestore.googleapis.com', 'https://world.openfoodfacts.org', 'https://content-firebaseappcheck.googleapis.com', 'https://firebasevertexai.googleapis.com', 'https://www.google.com'];
  const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  const csp = Object.fromEntries(m[1].split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...v]) => [name, v]));
  assert.deepEqual(csp['connect-src'], ALLOWED_CONNECT_SRC);
  for (const dir of ['style-src', 'font-src', 'worker-src', 'manifest-src']) assert.deepEqual(csp[dir], ["'self'"], dir);
  // apis.google.com: the helper script that Firebase Auth loads to open the Google sign-in popup. Nothing else may run.
  // 'wasm-unsafe-eval': the barcode reader (ZXing compiled to WebAssembly, vendored in app/vendor/lazy/) cannot be instantiated without it; verified in
  // Chromium: with it removed the browser reports "script-src | wasm-eval" and the reader never starts. It allows WebAssembly only, not eval().
  // www.google.com (recaptcha/enterprise.js) and www.gstatic.com (the reCAPTCHA scripts it loads): App Check proves that a request to the AI endpoint comes from
  // this app. Each was removed in turn in Chromium and produced a script-src-elem violation, so each is needed; nothing else is allowed.
  assert.deepEqual(csp['script-src'], ["'self'", "'wasm-unsafe-eval'", 'https://apis.google.com', 'https://www.google.com', 'https://www.gstatic.com']);
  // The sign-in page of this Firebase project, embedded by the Auth SDK to receive the result of the popup.
  // www.google.com: the reCAPTCHA Enterprise iframe (/recaptcha/enterprise/anchor) (removing it produced a frame-src violation).
  assert.deepEqual(csp['frame-src'], ['https://foodie-6b6da.firebaseapp.com', 'https://www.google.com']);
  // images.openfoodfacts.org: the product picture on the scanned-product screen (and the only external host an <img src> may name, see ui/dom.js).
  assert.deepEqual(csp['img-src'], ["'self'", 'data:', 'blob:', 'https://images.openfoodfacts.org']);
  assert.deepEqual(csp['default-src'], ["'none'"]);
});

test('app code never contacts another origin: no absolute URLs and no network API besides fetch of own files', () => {
  for (const f of [...ownJs, 'sw.js']) {
    const code = appSource(f);
    // The only absolute URLs in app code: the SVG namespace, and Open Food Facts in off.js (the API host and the host its product images
    // must come from; both are also pinned in the CSP test above). Anything else, anywhere else, fails.
    let withoutAllowed = code.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '');
    if (['core/off.js', 'ui/dom.js'].includes(f)) withoutAllowed = withoutAllowed.replace(/https:\/\/(world|images)\.openfoodfacts\.org/g, '');
    assert.ok(!/https?:\/\//.test(withoutAllowed), `${f} has an absolute URL`);
    assert.ok(!/\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/.test(code), `${f} uses a network API that is not allowed yet`);
    // fetch of own files only (the table of foods, the service worker's own requests); off-client.js forwards `fetchFn(offUrl(code))`, whose origin
    // is pinned in core/off.js and in the CSP, and its default is the plain global fetch (checked by tests/off-client.test.js).
    for (const m of code.matchAll(/\bfetch\(\s*([^)]*)\)/g)) assert.ok(/^(FOODS_URL|req\b)/.test(m[1].trim()) || (f === 'data/off-client.js' && m[1].trim() === '...a'), `${f}: fetch(${m[1]})`);
  }
});

test('service worker: never caches a response from another origin', () => {
  const sw = read('app/sw.js');
  const fetchHandler = sw.slice(sw.indexOf("addEventListener('fetch'"));
  const guard = fetchHandler.indexOf('origin !== self.location.origin');
  assert.ok(guard > 0 && guard < fetchHandler.indexOf('respondWith'), 'the cross-origin guard must come before the worker answers anything');
  assert.equal([...sw.matchAll(/cache\.put\(/g)].length, 1, 'one place stores responses');
  assert.ok(/res\.ok && inShell\(req\.url\)/.test(sw), 'only successful responses for files of the app are stored');
  assert.equal([...sw.matchAll(/addAll\(/g)].length, 1);
  assert.ok(/addAll\(SHELL\./.test(sw), 'addAll only takes the SHELL list');
  for (const url of computeStamp().shell) assert.ok(url === './' || /^\.\/[A-Za-z0-9_./-]+$/.test(url), `${url} is not a relative path of the app`);
});

test('forbidden APIs: postMessage, document.cookie, window.name, IndexedDB, BroadcastChannel and web storage stay out of the UI', () => {
  // Who may use what (changed deliberately when the data moved from localStorage to IndexedDB):
  //   data/idb-storage.js  owns IndexedDB (the database), BroadcastChannel and its postMessage (telling other tabs which keys changed, and nothing else),
  //                        and still reads localStorage once for the migration and as the fallback when IndexedDB cannot be used;
  //   boot.js              owns localStorage for the theme only (fd.theme), because it must run before the first paint;
  //   data/store.js        touches no storage API at all any more: it gets a storage object from idb-storage.js.
  //   data/keyring.js      owns indexedDB for ONE more database, "foodie-keys": the non-extractable encryption key of the cloud copy (never the passphrase).
  const OWNERS = { indexedDB: ['data/idb-storage.js', 'data/keyring.js'], BroadcastChannel: ['data/idb-storage.js'], postMessage: ['data/idb-storage.js'], localStorage: ['data/idb-storage.js', 'boot.js'] };
  const banned = [[/\bpostMessage\b/, 'postMessage'], [/document\.cookie/, 'document.cookie'], [/\bwindow\.name\b/, 'window.name'], [/\bindexedDB\b/, 'indexedDB'],
    [/\bBroadcastChannel\b/, 'BroadcastChannel'], [/\bsessionStorage\b/, 'sessionStorage'], [/\blocalStorage\b/, 'localStorage'], [/\bcaches\b/, 'caches']];
  for (const f of [...ownJs, 'sw.js', 'boot.js']) {
    const code = appSource(f);
    for (const [re, name] of banned) {
      if ((OWNERS[name] || []).includes(f)) continue;
      if (name === 'caches' && f === 'sw.js') continue;                                       // cache storage belongs to the service worker
      assert.ok(!re.test(code), `${f} uses ${name}`);
    }
  }
  const boot = appSource('boot.js');
  assert.ok([...boot.matchAll(/(?:getItem|setItem)\(\s*['"]([^'"]+)/g)].every((m) => m[1] === 'fd.theme'), 'boot.js may only touch fd.theme');
  assert.ok(!/localStorage|indexedDB/.test(appSource('data/store.js')), 'the store must not touch a storage API itself');
  // the one place that writes to IndexedDB uses one database and one object store of ours, and only keys that start with fd.
  const idb = appSource('data/idb-storage.js');
  assert.ok(/DB_NAME = 'foodie'/.test(idb) && /STORE_NAME = 'kv'/.test(idb) && /MARKER_KEY = 'fd\.migrated'/.test(idb));
  assert.ok(!/indexedDB\.(deleteDatabase|databases)/.test(idb), 'it never deletes or lists databases of the origin (other apps have theirs)');
  const keyring = appSource('data/keyring.js');
  assert.ok(/KEYS_DB = 'foodie-keys'/.test(keyring) && /KEYS_STORE = 'keys'/.test(keyring), 'the keyring has its own database');
  assert.ok(!/indexedDB\.(deleteDatabase|databases)/.test(keyring) && !/localStorage|sessionStorage|document\.cookie|console\./.test(keyring), 'the keyring only keeps keys, and tells nobody');
});

test('main.js resolves routes through resolveRoute and never indexes ROUTES with the address', () => {
  const main = appSource('main.js');
  assert.ok(/resolveRoute\(/.test(main));
  assert.ok(!/ROUTES\[\s*p\s*\]/.test(main));
  assert.ok(!/ROUTES\[[^\]]*hash/.test(main));
});

test('secrets stay local: .secrets/ and key files are git-ignored, and no secret-looking key is anywhere in the tracked files', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const entry of ['.secrets/', 'Llave*.txt', 'llave*.txt', '*.key', '*.pem', '.env*']) assert.ok(ignore.includes(entry), `.gitignore must list ${entry}`);
  let files;
  try { files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) { return; }
  // reCAPTCHA keys are 40 characters starting with 6L. The public site key may be shipped one day; the secret key never.
  for (const f of files) {
    if (/\.(png|woff2)$/.test(f) || f === 'tests/static.test.js') continue;
    if (f === 'app/data/firebase-config.js') continue;       // the only place the PUBLIC site key lives (checked below)
    assert.ok(!/\b6L[0-9A-Za-z_-]{38}\b/.test(readFileSync(join(ROOT, f), 'utf8')), `a reCAPTCHA-style key is in ${f}`);
  }
  const config = readFileSync(join(ROOT, 'app/data/firebase-config.js'), 'utf8');
  const keys = config.match(/\b6L[0-9A-Za-z_-]{38}\b/g) || [];
  assert.ok(keys.length <= 1, 'firebase-config.js should hold at most the one public site key');
  assert.ok(keys.length === 0 || /APP_CHECK_SITE_KEY\s*=\s*'6L/.test(config), 'the reCAPTCHA key in the config must be the APP_CHECK_SITE_KEY (the public one), nothing else');
});

test('App Check debug token: named only in data/vision.js, and only switched on for localhost', () => {
  for (const f of [...ownJs, 'sw.js', 'boot.js']) {
    const code = appSource(f);
    if (f === 'data/vision.js') {
      assert.ok(/if \(isLocalhost\(win\)\) globalThis\.FIREBASE_APPCHECK_DEBUG_TOKEN = true/.test(code), 'the debug token is set behind the localhost check');
      assert.equal([...code.matchAll(/FIREBASE_APPCHECK_DEBUG_TOKEN/g)].length, 1, 'and nowhere else in the file');
      assert.ok(/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$/.test(code), 'isLocalhost matches the whole host name, not a suffix');
    } else assert.ok(!/APPCHECK_DEBUG/.test(code), `${f} touches the App Check debug token`);
  }
});

test('photos are never stored: the photo screen and the vision module only hand a meal (with at most a small thumbnail) to the store', () => {
  const photo = appSource('ui/screens/photo.js');
  const vision = appSource('data/vision.js');
  for (const code of [photo, vision]) {
    assert.ok(!/localStorage|sessionStorage|indexedDB|caches\b/.test(code));
    assert.ok(!/\.setItem\(/.test(code));
  }
  assert.deepEqual([...new Set([...photo.matchAll(/store\.(\w+)\(/g)].map((m) => m[1]))].sort(), ['addMeal', 'deleteMeal']);
  assert.ok(/thumbnailDataUrl/.test(vision) && /thumb/.test(photo), 'only the thumbnail path leaves the screen');
});

test('the AI call path requires a signed-in person in the module that makes it', () => {
  const vision = appSource('data/vision.js');
  const signedOut = vision.indexOf("reason: 'signed-out'");
  const firstFirebase = vision.indexOf('await ensureModel()');
  assert.ok(signedOut > 0 && firstFirebase > 0 && vision.indexOf('if (!cloud.user)') < firstFirebase, 'the sign-in check comes before Firebase is touched');
});
