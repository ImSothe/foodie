/* A tiny hand-written DOM, just enough to run app/ui/dom.js in Node and to look at what it builds.
   It records every attribute, listener and property write, and any attempt to write HTML from a string. */

export class FakeNode {}

export class FakeText extends FakeNode {
  constructor(data) { super(); this.nodeType = 3; this.data = data; }
}

export const htmlWrites = [];   // every innerHTML / outerHTML / insertAdjacentHTML write, ever

export class FakeElement extends FakeNode {
  constructor(tag, ns) {
    super();
    this.nodeType = 1;
    this.tagName = tag;
    this.namespaceURI = ns;
    this.attributes = new Map();
    this.children = [];
    this.listeners = [];
    this.dataset = {};
    this.styleProps = {};
    this.style = { setProperty: (p, v) => { this.styleProps[p] = v; } };
  }
  setAttribute(name, value) {
    // real browsers throw on names like "a b" or "<x"
    if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(name)) throw new Error(`InvalidCharacterError: ${name}`);
    this.attributes.set(name, String(value));
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, fn) { this.listeners.push([type, fn]); }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren() { this.children = []; }
  set innerHTML(v) { htmlWrites.push(['innerHTML', String(v)]); }
  set outerHTML(v) { htmlWrites.push(['outerHTML', String(v)]); }
  insertAdjacentHTML(where, v) { htmlWrites.push(['insertAdjacentHTML', String(v)]); }
}

/** Installs `document` and `Node` globals for dom.js; returns the document and a function that puts things back. */
export function installFakeDom() {
  const created = [];
  const doc = {
    created,
    createElement: (tag) => { const el = new FakeElement(tag, 'html'); created.push(el); return el; },
    createElementNS: (ns, tag) => { const el = new FakeElement(tag, ns); created.push(el); return el; },
    createTextNode: (data) => new FakeText(String(data)),
  };
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.document = doc;
  globalThis.Node = FakeNode;
  return {
    doc,
    restore() {
      if (before.document === undefined) delete globalThis.document; else globalThis.document = before.document;
      if (before.Node === undefined) delete globalThis.Node; else globalThis.Node = before.Node;
    },
  };
}

/** All descendants (depth first), the element included. */
export function walk(node, out = []) {
  out.push(node);
  if (node.children) for (const c of node.children) walk(c, out);
  return out;
}

export const textNodes = (node) => walk(node).filter((n) => n instanceof FakeText);
export const allText = (node) => textNodes(node).map((n) => n.data).join('');
