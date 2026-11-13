/* Test helpers for a simulated phone with the encrypted cloud copy: a cheap key derivation (the real default is 600,000 iterations), and the
   step every phone has to take after signing in: choose the passphrase (first phone of an account) or type it (the next ones). */
export const PASS = 'contraseña de prueba larga';
export const FAST_CRYPTO = { kdfIterations: 1000, minIterations: 1000 };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** After signing in: sets the passphrase when the account has none, unlocks when it has one. Returns the final status. */
export async function enter(cloud, pass = PASS) {
  for (let i = 0; i < 200 && cloud.status === 'syncing'; i += 1) await tick();
  if (cloud.status === 'setup') await cloud.setupPassphrase(pass);
  else if (cloud.status === 'locked') await cloud.unlock(pass);
  for (let i = 0; i < 200 && cloud.status === 'syncing'; i += 1) await tick();
  return cloud.status;
}
