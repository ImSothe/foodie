/* foodie · food search (pure logic). Accent- and case-insensitive, matches the name and the aliases,
   and ranks matches that start a word before matches in the middle of one. */

/** "Jamón Serrano " -> "jamon serrano": lower case, no accents, single spaces. */
export const normalize = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Prepare a list of foods once; searches then only compare strings. */
export function buildIndex(foods) {
  return (foods || []).map((food, order) => {
    const name = normalize(food.name);
    const aliases = (food.aliases || []).map(normalize).filter(Boolean);
    return { food, order, name, aliases, nameWords: name.split(' '), aliasWords: aliases.map((a) => a.split(' ')) };
  });
}

// Lower is better.
const RANK = { exact: 0, nameStart: 1, aliasStart: 2, nameWord: 3, aliasWord: 4, nameInside: 5, aliasInside: 6 };

function rankOf(entry, query, tokens) {
  const { name, aliases, nameWords, aliasWords } = entry;
  if (name === query || aliases.includes(query)) return RANK.exact;
  if (name.startsWith(query)) return RANK.nameStart;
  if (aliases.some((a) => a.startsWith(query))) return RANK.aliasStart;
  const wordHit = (words) => tokens.every((t) => words.some((w) => w.startsWith(t)));
  if (wordHit(nameWords)) return RANK.nameWord;
  if (aliasWords.some(wordHit)) return RANK.aliasWord;
  if (tokens.every((t) => name.includes(t))) return RANK.nameInside;
  if (aliases.some((a) => tokens.every((t) => a.includes(t)))) return RANK.aliasInside;
  return null;
}

/**
 * Foods matching `query`, best first (ties keep the order of the table, which lists common foods first). An empty query returns everything alphabetically.
 * @param {ReturnType<typeof buildIndex>} index
 */
export function searchFoods(index, query, limit = 40) {
  const q = normalize(query);
  if (!q) return index.map((e) => e.food).sort((a, b) => a.name.localeCompare(b.name, 'es')).slice(0, limit);
  const tokens = q.split(' ');
  const hits = [];
  for (const entry of index) {
    const rank = rankOf(entry, q, tokens);
    if (rank !== null) hits.push({ rank, entry });
  }
  hits.sort((a, b) => a.rank - b.rank || a.entry.order - b.entry.order);
  return hits.slice(0, limit).map((h) => h.entry.food);
}
