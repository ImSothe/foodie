/* Vendors the barcode reader used when the browser has no native BarcodeDetector (Firefox, Safari, older Chrome):
   the `barcode-detector` ponyfill (a BarcodeDetector built on ZXing-C++ compiled to WebAssembly by `zxing-wasm`).
   Output, in app/vendor/lazy/ (cached by the service worker on first use, never precached):
     barcode-detector.js   one ES module, minified
     zxing_reader.wasm     the reader-only WebAssembly build, served from our own origin (no CDN)
   plus notices and licences in app/vendor/.
   Run it by hand when the pinned versions change; nothing here runs in the app, in CI or in the tests.
   There is no build step and no dependency in package.json.

   Usage:  node tools/vendor_barcode.mjs      (Node 22+, npm and network access) */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BARCODE_DETECTOR = '3.2.3';
const ZXING_WASM = '3.1.6';           // the version barcode-detector 3.2.3 depends on; checked below
const ESBUILD = '0.28.2';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'app', 'vendor');
const LAZY = join(VENDOR, 'lazy');
const win = process.platform === 'win32';
const npm = win ? 'npm.cmd' : 'npm';
const npx = win ? 'npx.cmd' : 'npx';

const ENTRY = `export { BarcodeDetector, setZXingModuleOverrides, ZXING_WASM_VERSION } from 'barcode-detector/ponyfill';\n`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const work = mkdtempSync(join(tmpdir(), 'foodie-vendor-bc-'));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: 'inherit', shell: win });
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'vendor-work', private: true }));
  run(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', `barcode-detector@${BARCODE_DETECTOR}`]);
  const installed = JSON.parse(readFileSync(join(work, 'node_modules', 'zxing-wasm', 'package.json'), 'utf8')).version;
  if (installed !== ZXING_WASM) throw new Error(`zxing-wasm ${installed} was installed, expected ${ZXING_WASM}: update the constants and the notice`);
  writeFileSync(join(work, 'entry.js'), ENTRY);
  run(npx, ['--yes', `esbuild@${ESBUILD}`, 'entry.js', '--bundle', '--format=esm', '--minify', '--target=es2022', '--legal-comments=none', '--outfile=out.js']);

  mkdirSync(LAZY, { recursive: true });
  const js = readFileSync(join(work, 'out.js'));
  writeFileSync(join(LAZY, 'barcode-detector.js'), js);
  copyFileSync(join(work, 'node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm'), join(LAZY, 'zxing_reader.wasm'));
  const wasm = readFileSync(join(LAZY, 'zxing_reader.wasm'));
  copyFileSync(join(work, 'node_modules', 'barcode-detector', 'LICENSE'), join(VENDOR, 'LICENSE-barcode-detector.txt'));
  copyFileSync(join(work, 'node_modules', 'zxing-wasm', 'LICENSE'), join(VENDOR, 'LICENSE-zxing-wasm.txt'));

  const notice = `foodie · vendored barcode reader (used only when the browser has no native BarcodeDetector)

Files (app/vendor/lazy/, fetched on first use and cached by the service worker; never part of the first load or the precache):
  barcode-detector.js   ${js.length} bytes, ${gzipSync(js).length} gzipped   SHA-256 ${sha256(js)}
  zxing_reader.wasm     ${wasm.length} bytes, ${gzipSync(wasm).length} gzipped   SHA-256 ${sha256(wasm)}
Packages:  barcode-detector ${BARCODE_DETECTOR} (MIT, see LICENSE-barcode-detector.txt)
           zxing-wasm ${ZXING_WASM} (MIT, see LICENSE-zxing-wasm.txt), a build of ZXing-C++ (Apache License 2.0,
           https://github.com/zxing-cpp/zxing-cpp), compiled with Emscripten
Bundler:   esbuild ${ESBUILD}
Command:   node tools/vendor_barcode.mjs
           (npm install barcode-detector@${BARCODE_DETECTOR} in a temporary folder, then
            npx --yes esbuild@${ESBUILD} entry.js --bundle --format=esm --minify --target=es2022 --legal-comments=none,
            entry.js re-exporting BarcodeDetector and setZXingModuleOverrides from 'barcode-detector/ponyfill')
Note:      the ponyfill downloads its WebAssembly from a CDN by default; foodie overrides that with setZXingModuleOverrides so the
           file above is served from the app's own origin (app/data/scanner.js).
           Instantiating WebAssembly needs 'wasm-unsafe-eval' in the Content Security Policy (see SECURITY.md).
`;
  writeFileSync(join(VENDOR, 'README-barcode.txt'), notice);
  console.log(notice);
} finally {
  rmSync(work, { recursive: true, force: true });
}
