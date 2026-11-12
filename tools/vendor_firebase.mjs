/* Vendors the parts of the Firebase web SDK that foodie uses into one ES module: app/vendor/firebase.js.
   Run it by hand when the pinned versions change; nothing here runs in the app, in CI or in the tests.
   There is no build step and no dependency in package.json: the SDK is installed in a throw-away folder, bundled
   with esbuild (fetched with `npx --yes esbuild@<exact version>`), and only the bundle is committed.

   Usage:  node tools/vendor_firebase.mjs                       (writes app/vendor/firebase.js and the notice files)
   Needs:  Node 22+, npm and network access.

   What is bundled: app, auth (Google popup, IndexedDB/localStorage persistence) and the LITE build of Firestore
   (plain REST, no realtime listeners and no offline cache: foodie keeps its own queue). */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIREBASE = '13.3.0';
const ESBUILD = '0.28.2';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'app', 'vendor');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const ENTRY = `export { initializeApp } from 'firebase/app';
export { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
export { getFirestore, doc, getDoc, setDoc, deleteField, collection, getDocs, query, where, writeBatch } from 'firebase/firestore/lite';
`;

const work = mkdtempSync(join(tmpdir(), 'foodie-vendor-'));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: 'inherit', shell: process.platform === 'win32' });
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'vendor-work', private: true }));
  run(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', `firebase@${FIREBASE}`]);
  writeFileSync(join(work, 'entry.js'), ENTRY);
  const args = ['--yes', `esbuild@${ESBUILD}`, 'entry.js', '--bundle', '--format=esm', '--minify', '--target=es2022', '--legal-comments=none',
    '--outfile=out.js', '--metafile=meta.json'];
  run(npx, args);

  mkdirSync(OUT_DIR, { recursive: true });
  const bundle = readFileSync(join(work, 'out.js'));
  writeFileSync(join(OUT_DIR, 'firebase.js'), bundle);
  const sha = createHash('sha256').update(bundle).digest('hex');

  // The packages that ended up in the bundle, with their licences.
  const meta = JSON.parse(readFileSync(join(work, 'meta.json'), 'utf8'));
  const packages = new Map();
  for (const input of Object.keys(meta.inputs)) {
    const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (!m || packages.has(m[1])) continue;
    const pkg = JSON.parse(readFileSync(join(work, 'node_modules', m[1], 'package.json'), 'utf8'));
    packages.set(m[1], `${pkg.version} ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}`);
  }

  const licence = execFileSync('curl', ['-fsSL', 'https://www.apache.org/licenses/LICENSE-2.0.txt'], { encoding: 'utf8' });
  writeFileSync(join(OUT_DIR, 'LICENSE-firebase.txt'), licence);

  const notice = `foodie · vendored Firebase web SDK

File:      firebase.js  (one ES module, minified)
Contents:  firebase/app, firebase/auth (Google popup) and firebase/firestore/lite, bundled with their dependencies
Versions:  firebase ${FIREBASE}, esbuild ${ESBUILD}
Command:   node tools/vendor_firebase.mjs
           (npm install firebase@${FIREBASE} in a temporary folder, then
            npx --yes esbuild@${ESBUILD} entry.js --bundle --format=esm --minify --target=es2022 --legal-comments=none)
SHA-256:   ${sha}
Size:      ${bundle.length} bytes, ${(execFileSync('gzip', ['-c'], { input: bundle, maxBuffer: 1 << 26 }).length)} bytes gzipped
Licence:   Apache License 2.0, see LICENSE-firebase.txt (copyright Google LLC and the Firebase authors)

Packages bundled (name, version, licence):
${[...packages].sort().map(([name, info]) => `  ${name} ${info}`).join('\n')}

The app loads this file with a dynamic import() only when the user chooses to sign in (or was signed in before),
so it costs nothing for everyone else. Update it by changing the versions at the top of tools/vendor_firebase.mjs,
running the command above and committing the new files together with a note in this file.
`;
  writeFileSync(join(OUT_DIR, 'README.txt'), notice);
  console.log(`app/vendor/firebase.js ${bundle.length} bytes, sha256 ${sha}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
