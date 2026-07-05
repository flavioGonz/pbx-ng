'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
const Ctx = createContext(null);
const PUBLIC = ['/login'];
const isPhone = (p) => p && p.startsWith('/phone');
let patched = false;
function patchFetch() {
  if (patched || typeof window === 'undefined') return; patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    try {
      const u = typeof url === 'string' ? url : (url && url.url);
      if (u && u.indexOf('/backend') === 0) {
        const t = localStorage.getItem('pbxng_jwt');
        opts = { ...opts, headers: { ...(opts.headers || {}), ...(t ? { Authorization: 'Bearer ' + t } : {}) } };
      }
    } catch (_) {}
    return orig(url, opts).then(r => {
      if (r.status === 401 && !location.pathname.startsWith('/login') && !location.pathname.startsWith('/phone') && !location.pathname.startsWith('/enroll') && !location.pathname.startsWith('/call')) {
        localStorage.removeItem('pbxng_jwt'); location.href = '/login';
      }
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
