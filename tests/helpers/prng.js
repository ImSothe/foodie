/* Seeded, dependency-free pseudo random numbers (mulberry32), so every fuzz failure can be replayed from its seed. */

export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

/** Seed from FOODIE_FUZZ_SEED when set (to replay a failure), a fixed default otherwise (so CI is deterministic). */
export const FUZZ_SEED = Number.isFinite(Number(process.env.FOODIE_FUZZ_SEED)) && process.env.FOODIE_FUZZ_SEED !== undefined && process.env.FOODIE_FUZZ_SEED !== ''
  ? Number(process.env.FOODIE_FUZZ_SEED) : 20261112;
