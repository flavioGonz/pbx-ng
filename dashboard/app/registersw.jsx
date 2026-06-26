'use client';
import { useEffect } from 'react';

// Registra el service worker y mantiene la PWA al día.
// La UX de actualización (aviso + aplicar) la maneja UpdateBanner; acá sólo
// gestionamos el ciclo de vida del SW y recargamos cuando el nuevo toma control.
export default function RegisterSW() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    let reloaded = false;
    const safeReload = () => {
      if (reloaded) return;
      if (typeof window !== 'undefined' && window.__pbxInCall) { window.__pbxReloadPending = true; return; }
      reloaded = true;
      try { location.reload(); } catch (_) {}
    };

    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), 60000);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            try { nw.postMessage({ type: 'skipWaiting' }); } catch (_) {}
          }
        });
      });
    }).catch(() => {});

    navigator.serviceWorker.addEventListener('controllerchange', safeReload);
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'sw-activated') safeReload(); });

    // Re-chequea al volver al foreground (refresca el SW por si hay versión nueva)
    const onVis = () => { if (!document.hidden) navigator.serviceWorker.getRegistration().then((r) => r && r.update().catch(() => {})).catch(() => {}); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  return null;
}
