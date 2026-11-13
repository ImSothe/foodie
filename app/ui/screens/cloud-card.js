/* foodie · "Copia en la nube" card in Settings: one button to sign in with Google, then a calm line about the sync state. */
import { h, toast } from '../dom.js';
import { icon } from '../icons.js';
import { openPassphraseSheet, hasLocalData } from './passphrase.js';

const STATE_LINE = {
  syncing: 'Sincronizando…',
  synced: 'Todo guardado en tu cuenta.',
  offline: 'Sin conexión: lo que añadas se enviará cuando vuelva.',
  error: 'No se pudo sincronizar. Se reintentará solo; si sigue igual, usa "Sincronizar ahora".',
  setup: 'Falta elegir una contraseña para cifrar tu copia. Hasta entonces tus datos solo están en este móvil.',
  locked: 'Escribe tu contraseña para abrir tus datos de la nube.',
};

/** Said instead of the generic error line when the cause is known. */
const ERROR_LINE = {
  'migration-incomplete': 'No se pudo cifrar todo. Tus datos en la nube siguen como estaban y se reintentará.',
};

/**
 * The one sign-in button of the app: "Continuar con Google". Settings and the photo flow use the same one.
 * The SDK is prepared before the tap, so the popup opens straight from it (browsers block popups that follow a wait).
 */
export function googleSignInButton(cloud) {
  cloud.prepare().catch(() => { /* the button reports it if the sign-in module cannot load */ });
  const button = h('button', { type: 'button', class: 'btn btn-primary' }, icon('cloud', 20), 'Continuar con Google');
  button.addEventListener('click', async () => {
    button.disabled = true;
    const result = await cloud.signIn();
    button.disabled = false;
    if (!result.ok && !result.cancelled) toast(result.code === 'auth/popup-blocked'
      ? 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes para foodie e inténtalo otra vez.'
      : 'No se pudo iniciar sesión. Revisa tu conexión e inténtalo otra vez.');
  });
  return button;
}

export function cloudCard(cloud, store) {
  const signedIn = !!cloud.user;
  const need = cloud.needsPassphrase;
  if (!signedIn) {
    return h('section', { class: 'card cloud-card' },
      h('h2', { class: 'section-title' }, 'Copia en la nube'),
      h('p', { class: 'muted' }, 'Guarda tus datos y úsalos en otro móvil. Entras con tu cuenta de Google y no hay nada más que configurar. La app sigue funcionando igual sin cuenta.'),
      h('p', { class: 'small muted' }, 'Tus datos se guardan en la base de datos de este proyecto, ligados a tu cuenta de Google. Se cifran en tu móvil con una contraseña que eliges tú antes de subirse: ni el autor ni quien administra el proyecto pueden leer tus comidas, pesos, objetivos o perfil. Sí ven que existes, qué días usas la app y cuánto apuntas; y si olvidas la contraseña, la copia no se puede recuperar.'),
      googleSignInButton(cloud));
  }
  const sync = h('button', { type: 'button', class: 'btn btn-secondary', disabled: cloud.status === 'syncing', onClick: () => cloud.syncNow() }, 'Sincronizar ahora');
  const out = h('button', { type: 'button', class: 'btn btn-quiet', onClick: async () => { await cloud.signOut(); toast('Sesión cerrada. Tus datos siguen en este móvil.'); } }, 'Cerrar sesión');
  return h('section', { class: 'card cloud-card' },
    h('h2', { class: 'section-title' }, 'Copia en la nube'),
    h('p', null, cloud.user.name ? `Conectado como ${cloud.user.name}` : 'Conectado con Google'),
    cloud.encrypted ? h('p', { class: 'small cloud-encrypted' }, icon('lock', 16), ' Cifrado activado: solo tú puedes leer tu copia.') : null,
    h('p', { class: `small ${cloud.status === 'synced' ? 'muted' : ''}`, role: 'status' }, (cloud.status === 'error' && ERROR_LINE[cloud.error]) || STATE_LINE[cloud.status] || ''),
    cloud.failedRecords > 0 ? h('p', { class: 'small muted' }, cloud.failedRecords === 1 ? '1 registro de la nube no se pudo abrir y se ha ignorado.' : `${cloud.failedRecords} registros de la nube no se pudieron abrir y se han ignorado.`) : null,
    h('div', { class: 'cloud-actions' }, need ? h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openPassphraseSheet({ cloud, store, mode: need }) }, need === 'setup' ? 'Elegir contraseña' : 'Escribir contraseña') : sync, out),
    (cloud.encrypted || need === 'locked') && hasLocalData(store) ? h('button', { type: 'button', class: 'btn btn-quiet', onClick: () => openPassphraseSheet({ cloud, store, mode: 'reset' }) }, 'Olvidé mi contraseña') : null);
}
