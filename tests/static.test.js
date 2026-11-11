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
    /\bsrcdoc\b/, /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/, /createContextualFragment/, /DOMParser/];
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
    assert.ok(!/(^|\/)(\.env.*|.*\.pem|.*\.key|CLAUDE\.md|\.claude\/.*)$/i.test(f), `sensitive file tracked: ${f}`);
    if (/\.(png|woff2)$/.test(f) || f === 'tests/static.test.js') continue;
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const re of secret) assert.ok(!re.test(text), `possible secret or personal data in ${f}: ${re}`);
  }
});
