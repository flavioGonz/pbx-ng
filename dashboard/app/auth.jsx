'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from './notify';
const Ctx = createContext(null);
const PUBLIC = ['/login'];
const isPhone = (p) => p && p.startsWith('/phone');
let patched = false;
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
        else if (rl === 'supervisor' && !path.startsWith('/supervisor') && !path.startsWith('/phone') && !path.startsWith('/call')) router.replace('/supervisor');
        else if (rl === 'admin' && (path.startsWith('/agente') || path.startsWith('/supervisor'))) router.replace('/'); })
      .catch(() => { localStorage.removeItem('pbxng_jwt'); setUser(null); router.replace('/login'); });
  }, [path]);
  return <Ctx.Provider value={{ user, setUser }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx) || {};
export function logout() { if (typeof window !== 'undefined') { localStorage.removeItem('pbxng_jwt'); location.href = '/login'; } }
