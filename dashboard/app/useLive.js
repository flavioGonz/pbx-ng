'use client';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
let socket;
/* Exportado para que otras pantallas (el registro de seguridad en vivo, p. ej.) usen
 * la MISMA conexión en vez de abrir otra: cada socket extra es otro long-polling
 * contra la API por el proxy, y el JWT ya viaja en este handshake. */
export function getSocket() {
  if (!socket && typeof window !== 'undefined') {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('pbxng_jwt') : null;
    // Siempre mismo origen: server.js proxya /socket.io a la API tanto en `npm run dev`
    // como en producción, y :3000 sólo escucha en loopback (CONTRATOS §2/§4), así que
    // saltar directo a la API rompería el tiempo real para quien entra por :3001.
    // Polling-only: el upgrade a WebSocket no prospera detrás del proxy (h2) y el
    // realtime ya llega por snapshots; evitamos el error de consola sin perder función.
    socket = io({ path: '/socket.io', transports: ['polling'], upgrade: false, auth: { token } });
  }
  return socket;
}
export function useLive() {
  const [snap, setSnap] = useState(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const s = getSocket(); if (!s) return;
    const onSnap = (d) => setSnap(d), onC = () => setConnected(true), onD = () => setConnected(false);
    s.on('snapshot', onSnap); s.on('connect', onC); s.on('disconnect', onD);
    setConnected(s.connected);
    return () => { s.off('snapshot', onSnap); s.off('connect', onC); s.off('disconnect', onD); };
  }, []);
  return { snap, connected };
}
