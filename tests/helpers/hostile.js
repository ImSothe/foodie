/* Generators of hostile input. Source text avoids backslash escapes on purpose: every odd character is built from a code point. */

const cp = (...codes) => String.fromCodePoint(...codes);
const span = (a, b) => { let s = ''; for (let c = a; c <= b; c += 1) s += String.fromCharCode(c); return s; };

export const HOSTILE_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'];

/** Characters that must never survive in a stored name: controls, zero-width, bidi. */
export const FORBIDDEN_CHARS = new RegExp('[' + [
  span(0x00, 0x1F), span(0x7F, 0x9F), cp(0x2028, 0x2029, 0x00AD, 0x061C, 0x180E), span(0x200B, 0x200F), span(0x202A, 0x202E),
  span(0x2060, 0x206F), cp(0xFEFF), span(0xFFF9, 0xFFFB),
].join('') + ']');

export const XSS_CORPUS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '"><svg/onload=alert(1)>',
  "';alert(1);//",
  '"><script>alert(document.domain)</script>',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '<a href="javascript:alert(1)">click</a>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<style>@import "//evil.example/x.css"</style>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;',
  '{{constructor.constructor("alert(1)")()}}',
  '${alert(1)}',
  '`${alert(1)}`',
  '<%= alert(1) %>',
  '__proto__',
  'constructor',
  '%3Cscript%3Ealert(1)%3C/script%3E',
  "' OR 1=1 --",
  '../../etc/passwd',
  'null' + cp(0) + 'byte' + cp(0),
  'evil' + cp(0x202E) + 'gnp.exe',
  cp(0x2066) + 'isolate' + cp(0x2069),
  cp(0xFEFF) + 'bom' + cp(0x200B) + 'zero' + cp(0x200D) + 'width',
  'line1' + cp(10) + 'line2' + cp(13) + 'line3' + cp(9) + 'tab',
  'ctrl' + cp(1, 2, 3, 0x7F, 0x85, 0x9F) + 'chars',
  cp(0xD83D) + 'lone high surrogate',
  cp(0xDE00) + 'lone low surrogate',
  'emoji ' + cp(0x1F600).repeat(100),
  'A'.repeat(100000),
  cp(0x1F600).repeat(50000),
  ' '.repeat(5000) + 'padded' + ' '.repeat(5000),
];

/** A number that is hard to get right. */
export function hostileNumber(rng) {
  return rng.pick([
    NaN, Infinity, -Infinity, -0, 0, 1, -1, 0.1, 1e308, -1e308, 5e-324, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 53 + 2,
    rng.int(-1000, 100000), rng.next() * 1000, -rng.next() * 1000, 365.0000001, 29.9999999, 300.00000001,
  ]);
}

export function hostileString(rng) {
  const r = rng.next();
  if (r < 0.3) return rng.pick(XSS_CORPUS);
  if (r < 0.45) return rng.pick(['1', '-1', '0', '-0', '1e5', '1,5', '72,5', ' 42 ', '0x10', 'NaN', 'Infinity', '1e999', '9'.repeat(400), '2026-11-12', '2026-02-30', '12:30', '25:61', '08:15']);
  if (r < 0.55) return rng.pick(HOSTILE_KEYS);
  if (r < 0.65) return 'x'.repeat(rng.int(60, 3000));
  let s = '';
  const n = rng.int(0, 40);
  for (let i = 0; i < n; i += 1) s += String.fromCharCode(rng.chance(0.2) ? rng.int(0, 0x2FF) : rng.chance(0.2) ? rng.int(0xD800, 0xDFFF) : rng.int(0x20, 0x7E));
  return s;
}

/** A value with a getter that throws, or a proxy that throws on every read. */
export function boobyTrap(rng) {
  if (rng.chance(0.5)) {
    const o = {};
    for (const k of ['id', 'name', 'items', 'grams', 'per100', 'kcal', 'meals', 'sex', 'from', 'goals', 'slot', 'time', 'waterMl', 'length']) {
      if (rng.chance(0.3)) Object.defineProperty(o, k, { enumerable: true, get() { throw new Error('boom ' + k); } });
    }
    return o;
  }
  return new Proxy(rng.chance(0.5) ? [] : {}, {
    get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); }, has() { throw new Error('boom'); }, getOwnPropertyDescriptor() { throw new Error('boom'); },
  });
}

/** An own property called "__proto__" (JSON.parse makes these; an object literal would set the prototype instead). */
export function withOwnKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}

/** Any value at all: wrong types, odd numbers, nesting, hostile keys, traps. */
export function anyValue(rng, depth = 0) {
  const r = rng.next();
  if (r < 0.12) return hostileNumber(rng);
  if (r < 0.30) return hostileString(rng);
  if (r < 0.36) return rng.pick([null, undefined, true, false]);
  if (r < 0.40) return rng.pick([() => 1, Symbol('s'), 10n, new Date(NaN), /x/, new Map(), new Set([1])]);
  if (r < 0.44) return boobyTrap(rng);
  if (depth >= 4) return hostileNumber(rng);
  if (r < 0.65) return Array.from({ length: rng.int(0, 5) }, () => anyValue(rng, depth + 1));
  const o = {};
  const keys = rng.int(0, 5);
  for (let i = 0; i < keys; i += 1) {
    const k = rng.chance(0.3) ? rng.pick(HOSTILE_KEYS) : rng.pick(['id', 'name', 'items', 'grams', 'per100', 'kcal', 'meals', 'sex', 'from', 'goals', 'slot', 'time', 'waterMl', 'steps', 'age', 'x']);
    withOwnKey(o, k, anyValue(rng, depth + 1));
  }
  return o;
}

/** Very deep nesting, built in a loop (no recursion, so the generator itself is safe). */
export function deepNest(levels, wrap) {
  let v = 'leaf';
  for (let i = 0; i < levels; i += 1) v = wrap(v);
  return v;
}

/** Mutates a copy of a valid plain value: swaps random fields for anyValue(), deletes some, adds hostile keys. */
export function mutate(rng, base) {
  const root = Array.isArray(base) ? [...base] : { ...base };
  const edits = rng.int(1, 4);
  for (let e = 0; e < edits; e += 1) {
    try { editOnce(rng, root); } catch (err) { /* an earlier edit planted a trap where this one wanted to look: skip */ }
  }
  return root;
}

function editOnce(rng, root) {
  {
    let node = root;
    for (let d = 0; d < 3; d += 1) {
      const keys = Object.keys(node);
      if (!keys.length || rng.chance(0.4)) break;
      const k = rng.pick(keys);
      let child;
      try { child = node[k]; } catch (e) { break; }   // an earlier edit may have planted a trap here
      if (child === null || typeof child !== 'object') break;
      node[k] = Array.isArray(child) ? [...child] : { ...child };
      node = node[k];
    }
    let keys;
    try { keys = Object.keys(node); } catch (e) { return; }
    const roll = rng.next();
    if (roll < 0.55 && keys.length) node[rng.pick(keys)] = anyValue(rng);
    else if (roll < 0.7 && keys.length) delete node[rng.pick(keys)];
    else if (roll < 0.9 && !Array.isArray(node)) withOwnKey(node, rng.pick(HOSTILE_KEYS), anyValue(rng, 2));
    else if (Array.isArray(node)) node.push(anyValue(rng));
    else withOwnKey(node, 'extra', anyValue(rng));
  }
}
