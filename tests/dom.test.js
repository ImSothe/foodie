/* The DOM helper under attack, with a tiny hand-written document (tests/helpers/fake-dom.js): no dependency, no browser. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as domModule from '../app/ui/dom.js';
import { installFakeDom, FakeElement, FakeText, htmlWrites, allText, walk } from './helpers/fake-dom.js';
import { XSS_CORPUS } from './helpers/hostile.js';

const { h, s, mount } = domModule;
const isSafeUrl = domModule.isSafeUrl || (() => 'missing');
let dom;
before(() => { dom = installFakeDom(); });
after(() => dom.restore());

const attrs = (el) => Object.fromEntries(el.attributes);

test('dom: strings and numbers become text nodes, whatever they contain', () => {
  for (const p of XSS_CORPUS) {
    const el = h('p', null, p, 42, [p, ['nested', p]], null, false, undefined);
    assert.equal(el.children.every((c) => c instanceof FakeText), true);
    assert.equal(allText(el), p + '42' + p + 'nested' + p);
    assert.equal(el.attributes.size, 0);
  }
  const svg = s('svg', { viewBox: '0 0 1 1' }, s('text', null, '<script>alert(1)</script>'));
  assert.equal(allText(svg), '<script>alert(1)</script>');
  assert.equal(walk(svg).filter((n) => n.nodeType === 1).length, 2);
});

test('dom: nothing ever assigns innerHTML, outerHTML or insertAdjacentHTML', () => {
  const before = htmlWrites.length;
  h('div', { innerHTML: '<img src=x onerror=alert(1)>', outerHTML: '<b>', textContent: '<i>' }, '<b>x</b>');
  mount(h('main'), h('a', null, '<script>'), '<img src=x onerror=alert(1)>');
  s('g', { innerHTML: '<script>' });
  assert.equal(htmlWrites.length, before);
  for (const f of ['../app/ui/dom.js', '../app/main.js', '../app/ui/screens/add-food.js', '../app/ui/screens/home.js']) {
    const code = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /\.(inner|outer)HTML\s*=|insertAdjacentHTML\s*\(|document\.write/);
  }
});

test('dom: a non-function under on* is never set as an inline handler (the bug: it fell through to setAttribute)', () => {
  const el = h('button', { onclick: 'alert(1)', onClick: 'alert(2)', onerror: 'alert(3)', onload: '1', onmouseover: true, ONFOCUS: 'x', onToggle: {}, 'on-x': 'y' });
  assert.deepEqual(attrs(el), {});
  assert.deepEqual(el.listeners, []);
  const fn = () => {};
  const ok = h('button', { onClick: fn, onToggle: fn });
  assert.deepEqual(ok.listeners.map(([t]) => t), ['click', 'toggle']);
  assert.deepEqual(attrs(ok), {});
});

test('dom: srcdoc, srcset and HTML-writing attribute names are dropped', () => {
  const el = h('iframe-like', { srcdoc: '<script>alert(1)</script>', srcDoc: '<b>', srcset: 'x 1x', is: 'evil', innerHTML: '<b>', class: 'ok' });
  assert.deepEqual(attrs(el), { class: 'ok' });
});

test('dom: dangerous elements cannot be created at all', () => {
  for (const tag of ['script', 'SCRIPT', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base', 'frame', 'applet']) {
    assert.throws(() => h(tag), /refusing/, tag);
    assert.throws(() => s(tag), /refusing/, tag);
  }
  for (const tag of ['', 'a b', '<script>', 'img src=x', 5, null, undefined, 'a/b', '1a']) assert.throws(() => h(tag), /refusing/, String(tag));
  assert.doesNotThrow(() => h('x-widget'));
});

test('dom: URL attributes accept only relative URLs, fragments, blob: and raster data:image', () => {
  const GOOD = ['#top', '#/ajustes', 'page.html', './a/b.png', '../x', '/icons/a.png', 'a:b', 'blob:https://example.test/1234', 'data:image/png;base64,AAAA', 'DATA:IMAGE/JPEG;base64,AAAA', '', '?q=1', 'path/with:colon'];
  const BAD = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'java\tscript:alert(1)', 'java\u0000script:alert(1)', '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'data:image/svg+xml,<svg onload=alert(1)>', 'data:application/javascript,alert(1)', 'vbscript:x', 'file:///etc/passwd',
    'https://evil.example/', 'http://evil.example', '//evil.example/x', '\\\\evil.example\\x', 'ftp://x', 'mailto:a@b.c', 'tel:123', 'about:blank', 'chrome://settings', 'view-source:x', 'filesystem:https://x/y', 'x-unknown:1'];
  for (const attr of ['href', 'src', 'action', 'formaction', 'xlink:href', 'HREF', 'poster']) {
    for (const u of GOOD) { if (u === 'a:b') continue; assert.equal(attrs(h('a', { [attr]: u }))[attr] ?? null, u === '' ? '' : u, `${attr}=${u}`); }
    for (const u of BAD) assert.equal(attrs(h('a', { [attr]: u }))[attr], undefined, `${attr}=${JSON.stringify(u)} must be dropped`);
  }
  assert.equal(isSafeUrl('a:b'), false);          // "a:" would be read as a scheme
  assert.equal(isSafeUrl(5), false);
  assert.equal(isSafeUrl(null), false);
  assert.equal(attrs(s('use', { 'xlink:href': 'javascript:alert(1)' }))['xlink:href'], undefined);
  assert.equal(attrs(s('use', { 'xlink:href': '#icon' }))['xlink:href'], '#icon');
  assert.equal(attrs(h('a', { href: { toString: () => 'javascript:alert(1)' } })).href, undefined);
  assert.equal(attrs(h('a', { href: ['javascript:alert(1)'] })).href, undefined);
});

test('dom: attribute names that are not names are dropped instead of throwing', () => {
  const el = h('div', { 'a b': '1', '<x': '2', '"': '3', '': '4', '1a': '5', 'ok-name': '6', 'aria-label': '7', 'data-x': '8' });
  assert.deepEqual(attrs(el), { 'ok-name': '6', 'aria-label': '7', 'data-x': '8' });
});

test('dom: style, dataset and props that are not what they should be do not throw and do not leak', () => {
  assert.doesNotThrow(() => h('div', { style: 'color:red;background:url(javascript:alert(1))', dataset: 'x' }));
  const el = h('div', { style: 'x', dataset: 5 });
  assert.deepEqual(el.styleProps, {});
  assert.deepEqual(el.dataset, {});
  const styled = h('div', { style: { width: '10%', '--x': 'y' } });
  assert.deepEqual(styled.styleProps, { width: '10%', '--x': 'y' });
  for (const props of ['string', 5, true, [], () => {}, Symbol('x')]) assert.doesNotThrow(() => h('div', props));
});

test('dom: class, ids and aria values are attributes holding text, nothing more', () => {
  for (const p of XSS_CORPUS) {
    const el = h('div', { class: p, id: p, title: p, 'aria-label': p });
    assert.deepEqual(Object.keys(attrs(el)).sort(), ['aria-label', 'class', 'id', 'title']);
    assert.deepEqual(el.listeners, []);
  }
});

test('dom: mount replaces the children and keeps text as text', () => {
  const root = new FakeElement('main', 'html');
  root.append(new FakeText('old'));
  mount(root, h('p', null, '<b>new</b>'));
  assert.equal(root.children.length, 1);
  assert.equal(allText(root), '<b>new</b>');
});

test('dom: the only elements created while this file ran are the ones the tests asked for', () => {
  assert.ok(dom.doc.created.every((el) => !['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base'].includes(String(el.tagName).toLowerCase())));
});
