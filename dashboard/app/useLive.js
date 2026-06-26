'use client';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
let socket;
function getSocket() {
  if (!socket && typeof window !== 'undefined') {
    const url = location.port === '3001' ? `${location.protocol}//${location.hostname}:3000` : undefined;
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('pbxng_jwt') : null;
    // Polling-only: el upgrade a WebSocket no prospera detrás del proxy (h2) y el
    // realtime ya llega por snapshots; evitamos el error de consola sin perder función.
    socket = io(url, { path: '/socket.io', transports: ['polling'], upgrade: false, auth: { token } });
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
