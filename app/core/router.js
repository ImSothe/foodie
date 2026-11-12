/* foodie · route resolution (pure). The address after "#" is attacker-controlled (anyone can send a link), so it is only
   ever compared with an explicit list of route names, never used as a key of an object: "#constructor", "#__proto__"
   or "#toString" must not resolve to something that merely exists on every object. */

export const MAX_HASH_LENGTH = 64;

/**
 * @param {*} hash   location.hash, e.g. "#/progreso" ("" and "#" mean the home route)
 * @param {readonly string[]} names  route names, e.g. ['/', '/progreso']
 * @param {string} [fallback]
 * @returns {string} one of `names`, or `fallback`
 */
export function resolveRoute(hash, names, fallback = '/') {
  if (typeof hash !== 'string' || !Array.isArray(names)) return fallback;
  if (hash.length > MAX_HASH_LENGTH) return fallback;           // no real route is this long: do not even look at it
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (path === '') return fallback;
  for (const name of names) if (name === path) return name;      // own, explicit comparison: no property lookup
  return fallback;
}
