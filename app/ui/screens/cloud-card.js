/* foodie · "Copia en la nube" card in Settings: one button to sign in with Google, then a calm line about the sync state. */
import { h, toast } from '../dom.js';
import { icon } from '../icons.js';

const STATE_LINE = {
  syncing: 'Sincronizando…',
  synced: 'Todo guardado en tu cuenta.',
  offline: 'Sin conexión: lo que añadas se enviará cuando vuelva.',
  error: 'No se pudo sincronizar. Se reintentará solo; si sigue igual, usa "Sincronizar ahora".',
};

export function cloudCard(cloud) {
  const signedIn = !!cloud.user;
  if (!signedIn) {
    cloud.prepare().catch(() => { /* the button reports it if the sign-in module cannot load */ });   // ready before the tap, so the popup opens from it
    const button = h('button', { type: 'button', class: 'btn btn-primary' }, icon('cloud', 20), 'Continuar con Google');
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await cloud.signIn();
      button.disabled = false;
      if (!result.ok && !result.cancelled) toast(result.code === 'auth/popup-blocked'
        ? 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes para foodie e inténtalo otra vez.'
        : 'No se pudo iniciar sesión. Revisa tu conexión e inténtalo otra vez.');
    });
    return h('section', { class: 'card cloud-card' },
      h('h2', { class: 'section-title' }, 'Copia en la nube'),
      h('p', { class: 'muted' }, 'Guarda tus datos y úsalos en otro móvil. Entras con tu cuenta de Google y no hay nada más que configurar. La app sigue funcionando igual sin cuenta.'),
      button);
  }
  const sync = h('button', { type: 'button', class: 'btn btn-secondary', disabled: cloud.status === 'syncing', onClick: () => cloud.syncNow() }, 'Sincronizar ahora');
  const out = h('button', { type: 'button', class: 'btn btn-quiet', onClick: async () => { await cloud.signOut(); toast('Sesión cerrada. Tus datos siguen en este móvil.'); } }, 'Cerrar sesión');
  return h('section', { class: 'card cloud-card' },
    h('h2', { class: 'section-title' }, 'Copia en la nube'),
    h('p', null, cloud.user.name ? `Conectado como ${cloud.user.name}` : 'Conectado con Google'),
    h('p', { class: `small ${cloud.status === 'synced' ? 'muted' : ''}`, role: 'status' }, STATE_LINE[cloud.status] || ''),
    h('div', { class: 'cloud-actions' }, sync, out));
}
