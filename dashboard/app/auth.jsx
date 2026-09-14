'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from './notify';
const Ctx = createContext(null);
const PUBLIC = ['/login'];
const isPhone = (p) => p && p.startsWith('/phone');
let patched = false;

/* Pantallas del shell que un supervisor SÍ puede abrir (espejo de las reglas SUP de
 * `control-plane/rbac.js`, docs/CONTRATOS.md §2).
 *
 * Vive acá, y no en `shell.jsx`, porque la misma lista tiene que contestar dos preguntas
 * que hasta ahora se contestaban por separado: qué ítems se le dibujan en el menú y a
 * dónde lo deja quedarse el redirect de abajo. Con las dos listas separadas pasó lo que
 * tenía que pasar: el menú le ofrecía «Fax» y «Salas de reunión» y el redirect lo
 * rebotaba a /supervisor sin excepciones, así que todo el esconder-por-rol de adentro de
 * esas pantallas era código que con rol supervisor no se ejecutaba nunca.
 *
 * Para agregar una entrada acá la pantalla tiene que cumplir una de dos: o todos sus
 * pedidos son de familias SUP, o esconde sola lo que es de admin (la solapa
 * «Configuración» de /fax, el alta / editar / borrar / invitar / «Ver PIN» de /salas, los
 * «Envíos programados» de /reportes, la solapa «Almacenamiento» de /cdr). Una pantalla
 * que igual va a comer un 403 NO se agrega: un ítem de menú que sólo sabe decir «no
 * tenés permiso» es peor que no tenerlo. Por eso quedaron afuera `/mapa` (su único dato
 * es `GET /api/geo`, que es admin) y `/telefonos` (`GET|POST /api/settings` y el alta,
 * edición y baja de teléfonos son admin: la pantalla entera es configuración). */
export const SUP_OK = ['/cdr', '/reportes', '/wallboard', '/monitor', '/fax', '/salas'];

/* ¿El supervisor se puede quedar en esta ruta, o lo devolvemos a su pantalla?
 * /supervisor sigue siendo su inicio —es a donde lo manda el login y a donde vuelve
 * desde cualquier pantalla que no le corresponde—, pero navegar desde el menú a una de
 * SUP_OK ya no lo rebota. También se lo deja en /phone y /call, que son el softphone y
 * el click-to-call y no dependen del rol. */
const supervisorPuede = (path) => !!path && (
  path.startsWith('/supervisor') || path.startsWith('/phone') || path.startsWith('/call') ||
  SUP_OK.some((r) => path === r || path.startsWith(r + '/'))
);
/* Una pantalla suele disparar varios fetch a la vez (polling, listas, módulos): sin
 * dedupe un agente que abre una ruta de admin recibiría una lluvia de toasts iguales. */
const DEDUPE_403_MS = 3000;
let ultimo403 = 0;
function avisar403(r) {
  const ahora = Date.now();
  if (ahora - ultimo403 < DEDUPE_403_MS) return;
  ultimo403 = ahora;
  const mostrar = (msg) => toast(msg || 'No tenés permiso para esta acción', 'bad');
  // El body original queda intacto para la página; el clon es sólo para leer el `error`.
  let clon = null; try { clon = r.clone(); } catch (_) {}
  if (!clon) return mostrar();
  clon.json().then(d => mostrar(d && typeof d.error === 'string' ? d.error : '')).catch(() => mostrar());
}
function patchFetch() {
  if (patched || typeof window === 'undefined') return; patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    try {
      const u = typeof url === 'string' ? url : (url && url.url);
      if (u && u.indexOf('/backend') === 0) {
        // La sesión de panel manda; si no hay, se usa el token del softphone (que sólo
        // habilita lo de SU extensión). Así el administrador que abre /phone no pierde
        // sus permisos, y el que sólo tiene credenciales SIP igual ve su buzón.
        const t = localStorage.getItem('pbxng_jwt') || localStorage.getItem('pbxng_phone_jwt');
        opts = { ...opts, headers: { ...(opts.headers || {}), ...(t ? { Authorization: 'Bearer ' + t } : {}) } };
      }
    } catch (_) {}
    return orig(url, opts).then(r => {
      if (r.status === 401 && !location.pathname.startsWith('/login') && !location.pathname.startsWith('/phone') && !location.pathname.startsWith('/enroll') && !location.pathname.startsWith('/call')) {
        localStorage.removeItem('pbxng_jwt'); location.href = '/login';
      }
      /* 403 = sesión válida pero sin permiso (RBAC desde 1.4.0). No se redirige: el
       * usuario sigue logueado, sólo hay que decírselo. Se avisa acá y no en cada
       * página porque hay ~245 fetch sueltos y la mayoría ignora el status. Se clona
       * la respuesta para que la página pueda seguir leyendo el body como siempre. */
      if (r.status === 403) avisar403(r);
      return r;
    });
  };
}
if (typeof window !== 'undefined') patchFetch();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);
  const path = usePathname(); const router = useRouter();
  useEffect(() => { patchFetch(); }, []);
  useEffect(() => {
    if (isPhone(path) || path === '/login' || (path && path.startsWith('/enroll')) || (path && path.startsWith('/call'))) { setUser(null); return; }
    const t = typeof window !== 'undefined' ? localStorage.getItem('pbxng_jwt') : null;
    if (!t) { setUser(null); router.replace('/login'); return; }
    fetch('/backend/api/auth/me').then(r => r.ok ? r.json() : Promise.reject()).then(d => { setUser(d.user); const rl = d.user && d.user.role;
        if (rl === 'agente' && !path.startsWith('/agente') && !path.startsWith('/phone') && !path.startsWith('/call')) router.replace('/agente');
        else if (rl === 'supervisor' && !supervisorPuede(path)) router.replace('/supervisor');
        else if (rl === 'admin' && (path.startsWith('/agente') || path.startsWith('/supervisor'))) router.replace('/'); })
      .catch(() => { localStorage.removeItem('pbxng_jwt'); setUser(null); router.replace('/login'); });
  }, [path]);
  return <Ctx.Provider value={{ user, setUser }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx) || {};
/* ¿El que está mirando es administrador? Una sola respuesta para todo el panel.
 *
 * El porqué del helper: `user` arranca en `undefined` —«todavía no sé quién entró»—, y
 * recién cuando vuelve `GET auth/me` pasa a la sesión o a `null`. Ese limbo dura un par de
 * cientos de milisegundos y cada pantalla lo venía resolviendo a su gusto: `!user || …`
 * lo daba por admin (a un supervisor le parpadeaban los botones de administración y podía
 * llegar a apretar uno que sólo sabe dar 403) y `!!user && …` lo daba por no-admin. Gana
 * el lado prudente: mientras no se sabe, NO es admin. Esconder un botón durante un
 * parpadeo es barato; mostrar de más y que la API lo rechace, no. Ojo: esto es cosmética,
 * el permiso de verdad lo decide `control-plane/rbac.js`. */
export const esAdmin = (user) => !!user && user.role === 'admin';
export function useEsAdmin() { const { user } = useAuth(); return esAdmin(user); }
export function logout() { if (typeof window !== 'undefined') { localStorage.removeItem('pbxng_jwt'); location.href = '/login'; } }
