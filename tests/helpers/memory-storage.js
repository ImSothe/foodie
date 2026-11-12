/* In-memory storage with the same three methods as localStorage, with optional failures. */

export function memoryStorage(initial = {}, { failGet = false, failSet = false, failRemove = false } = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    getItem: (k) => { if (failGet) throw new Error('getItem blocked'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (failSet) throw new Error('quota exceeded'); m.set(k, String(v)); },
    removeItem: (k) => { if (failRemove) throw new Error('removeItem blocked'); m.delete(k); },
  };
}
