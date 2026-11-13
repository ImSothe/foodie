/* The passphrase rules: a minimum length and an honest hint, with no silly composition rules. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPassphrase, MIN_PASSPHRASE } from '../app/core/passphrase.js';

test('shorter than 8 characters is refused; 8 and more is accepted', () => {
  assert.equal(MIN_PASSPHRASE, 8);
  for (const p of ['', 'a', '1234567', 'abcdefg', '       ', null, undefined, 5, {}]) assert.equal(checkPassphrase(p).ok, false, String(p));
  assert.equal(checkPassphrase('1234567').hint, 'Usa al menos 8 caracteres.');
  for (const p of ['unafrase', 'mi gato Tomás', 'correct horse battery staple']) assert.equal(checkPassphrase(p).ok, true, p);
});

test('there are no composition rules: a long phrase of lowercase words is fine, and so is a short mix', () => {
  assert.ok(checkPassphrase('el perro de mi vecina ladra').level >= 2);
  assert.equal(checkPassphrase('xK9#mQ2$').ok, true);
});

test('the length counts characters the way a person does (accents, emoji), and NFKC makes look-alikes equal', () => {
  assert.equal(checkPassphrase('ñññññññ').ok, false);
  assert.equal(checkPassphrase('🍎🍐🍊🍋🍌🍉🍇🍓').ok, true);
  assert.equal(checkPassphrase('ｐａｓｓｗｏｒｄ').level, 0, 'full-width letters are the same common password');
});

test('very common passwords, repeated characters and runs are flagged (level 0) but not forbidden', () => {
  for (const p of ['password', 'PASSWORD', '12345678', 'qwertyuiop', '11111111', 'abababab', 'abcdefgh', '87654321', 'Contraseña']) {
    const r = checkPassphrase(p);
    assert.equal(r.ok, true, p);
    assert.equal(r.level, 0, p);
    assert.match(r.hint, /primeras que probaría|más larga/);
  }
});

test('levels grow with length and variety, and every answer is a calm Spanish sentence', () => {
  const levels = ['k7Qm2xPa', 'k7Qm2xPa9z', 'una frase con varias palabras', 'una frase muy larga con varias palabras en español'].map((p) => checkPassphrase(p).level);
  assert.deepEqual([...levels].sort(), levels, 'never decreases as it gets longer');
  assert.ok(levels[0] <= 1 && levels[3] === 3);
  for (const p of ['corto', 'k7Qm2xPa', 'una frase con varias palabras']) assert.match(checkPassphrase(p).hint, /^[A-ZÁÉÍÓÚ].*[.]$/);
});
