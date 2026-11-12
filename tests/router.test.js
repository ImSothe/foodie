import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, MAX_HASH_LENGTH } from '../app/core/router.js';

const NAMES = ['/', '/progreso', '/guardadas', '/ajustes', '/perfil', '/kit'];

test('router: real routes resolve to themselves, with or without the leading #', () => {
  for (const name of NAMES) {
    assert.equal(resolveRoute(`#${name}`, NAMES), name);
    assert.equal(resolveRoute(name, NAMES), name);
  }
});

test('router: empty, missing or unknown addresses go home', () => {
  for (const h of ['', '#', '#/', '#/nope', '#/progreso/', '#progreso', '#/PROGRESO', '# /kit', '#/kit ', '#//kit', '#/kit?x=1', '#/kit#x', '#/ajustes/../kit']) {
    assert.equal(resolveRoute(h, NAMES), h === '#/' ? '/' : '/', JSON.stringify(h));
  }
  assert.equal(resolveRoute('#/nope', NAMES, '/ajustes'), '/ajustes');
});

test('router: names that every object inherits are not routes (a crafted link used to blank the app)', () => {
  const ROUTES = { '/': 1 };
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__defineGetter__', 'prototype']) {
    if (name in Object.prototype) assert.ok(ROUTES[name], `the old lookup would have accepted ${name}`);   // what the bug was
    for (const h of [`#${name}`, `#/${name}`, name]) assert.equal(resolveRoute(h, NAMES), '/', h);
    assert.equal(resolveRoute(`#${name}`, [...NAMES, '/x']), '/');
  }
});

test('router: absurd input is tolerated: very long, malformed, percent-encoded, odd types', () => {
  assert.equal(resolveRoute('#' + 'a'.repeat(1e6), NAMES), '/');
  assert.equal(resolveRoute('#/' + 'progreso'.repeat(100000), NAMES), '/');
  assert.equal(resolveRoute('#' + '/progreso'.padEnd(MAX_HASH_LENGTH + 1, 'x'), NAMES), '/');
  for (const h of ['#%', '#%E0%A4%A', '#%00', '#/%2e%2e/progreso', '#%2Fprogreso', '#/pro%67reso', '#\u0000', '#/progreso\n', '#/\ud800', '#<script>alert(1)</script>', '#javascript:alert(1)', '#//evil.example/', '#\\\\evil']) {
    assert.doesNotThrow(() => resolveRoute(h, NAMES), h);
    assert.equal(resolveRoute(h, NAMES), '/', JSON.stringify(h));
  }
  for (const h of [undefined, null, 5, {}, [], () => '/kit', Symbol('x'), { toString() { throw new Error('boom'); } }]) assert.equal(resolveRoute(h, NAMES), '/');
  for (const names of [undefined, null, 'abc', {}, 5]) assert.equal(resolveRoute('#/kit', names), '/');
  assert.equal(resolveRoute('#/kit', []), '/');
});

test('router: only names that were given can come back, and the result is always one of them or the fallback', () => {
  const fallback = '/';
  for (const h of ['#/kit', '#/zzz', '#constructor', '', '#/progreso', '#' + 'x'.repeat(200)]) {
    const r = resolveRoute(h, NAMES, fallback);
    assert.ok(NAMES.includes(r) || r === fallback);
  }
  // the list is compared by value: a name present only on the prototype of the list is not found either
  const names = Object.create(['/']);
  assert.equal(resolveRoute('#/progreso', Object.assign([], names)), '/');
});

test('router: main.js uses it (no raw lookup with the address)', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /resolveRoute\(location\.hash, ROUTE_NAMES\)/);
  assert.doesNotMatch(main, /ROUTES\[p\]/);
});
