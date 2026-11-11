/* Writes the list of app files and a content hash into app/sw.js, so the service worker caches exactly
   what is published and every change produces a new cache version.
   Usage: node tools/stamp.mjs          (rewrite app/sw.js)
   The same functions are used by the tests to check that the stamp is up to date. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const TEXT = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt']);
const SKIP = new Set(['sw.js']);          // the worker never caches itself
const SKIP_EXT = new Set(['.txt']);       // licence notices are published but not needed offline

export function listAppFiles(dir = APP_DIR, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listAppFiles(join(dir, entry.name), rel));
    else if (!SKIP.has(rel) && !SKIP_EXT.has(extname(entry.name))) out.push(rel);
  }
  return out.sort();
}

export function computeStamp() {
  const files = listAppFiles();
  const hash = createHash('sha256');
  for (const rel of files) {
    let data = readFileSync(join(APP_DIR, rel));
    // Same hash on Windows and Linux checkouts, whatever the line endings.
    if (TEXT.has(extname(rel))) data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    hash.update(rel).update('\0').update(data).update('\0');
  }
  return { version: hash.digest('hex').slice(0, 12), shell: ['./', ...files.map((f) => `./${f}`)] };
}

export function stampBlock({ version, shell }) {
  return `/* stamp:start */\nconst VERSION = '${version}';\nconst SHELL = ${JSON.stringify(shell, null, 2)};\n/* stamp:end */`;
}

const BLOCK = /\/\* stamp:start \*\/[\s\S]*?\/\* stamp:end \*\//;

export function readStampedBlock() {
  const m = readFileSync(join(APP_DIR, 'sw.js'), 'utf8').replace(/\r\n/g, '\n').match(BLOCK);
  return m ? m[0] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = join(APP_DIR, 'sw.js');
  const stamp = computeStamp();
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(BLOCK, stampBlock(stamp)));
  console.log(`sw.js stamped: version ${stamp.version}, ${stamp.shell.length} files`);
}
