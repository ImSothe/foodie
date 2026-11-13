/* foodie · what a passphrase for the cloud copy must be, said gently (pure logic).
   The only hard rule is a minimum length. There are no composition rules (symbols, capitals, digits): a long phrase of ordinary words is stronger
   than a short tangle, and rules like that push people to write passwords on a note. The strength hint is an honest rough guide, not a guarantee:
   whoever has access to the stored verifier can guess offline, so a longer phrase is the real protection. */

export const MIN_PASSPHRASE = 8;

const COMMON = new Set([
  'password', 'passw0rd', 'contrasena', 'contraseña', '12345678', '123456789', '1234567890', '11111111', '00000000', 'qwertyui', 'qwertyuiop', 'abcdefgh',
  'iloveyou', 'tequiero', 'football', 'barcelona', 'realmadrid', 'foodie123', 'foodie1234', 'abc12345', 'password1', 'password123', '87654321',
]);

/**
 * @param {string} text
 * @returns {{ ok: boolean, level: 0|1|2|3, hint: string }}  level 0 = refused or very common, 1 = short but accepted, 2 = good, 3 = strong
 */
export function checkPassphrase(text) {
  const p = typeof text === 'string' ? text : '';
  const chars = [...p.normalize('NFKC')];
  if (chars.length < MIN_PASSPHRASE) return { ok: false, level: 0, hint: `Usa al menos ${MIN_PASSPHRASE} caracteres.` };
  const lower = p.normalize('NFKC').toLowerCase();
  const distinct = new Set(chars).size;
  const ordered = chars.every((c, i) => i === 0 || Math.abs(c.codePointAt(0) - chars[i - 1].codePointAt(0)) === 1);
  if (COMMON.has(lower) || distinct <= 2 || ordered) return { ok: true, level: 0, hint: 'Es de las primeras que probaría cualquiera. Mejor una frase tuya, más larga.' };
  const digitsOnly = chars.every((c) => c >= '0' && c <= '9');
  if (chars.length >= 16 || (chars.length >= 12 && !digitsOnly && distinct >= 8)) return { ok: true, level: 3, hint: 'Larga y difícil de adivinar.' };
  if (chars.length >= 12 || (!digitsOnly && chars.length >= 10)) return { ok: true, level: 2, hint: 'Una frase más larga es todavía mejor.' };
  return { ok: true, level: 1, hint: 'Una frase de varias palabras es más segura y más fácil de recordar.' };
}
