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
    /* Sin sesión de panel no hay socket. El servidor exige JWT en el handshake
     * (CONTRATOS §4), así que conectar desde /login sólo lograba que engine.io
     * cerrara la sesión y que el poll en vuelo volviera 400 en la consola. Después
     * de entrar hay recarga completa (login hace location.href), así que este
     * módulo se re-evalúa con el token ya guardado. */
    if (!token) return null;
    // Siempre mismo origen: server.js proxya /socket.io a la API tanto en `npm run dev`
    // como en producción, y :3000 sólo escucha en loopback (CONTRATOS §2/§4), así que
    // saltar directo a la API rompería el tiempo real para quien entra por :3001.
    // Polling-only: el upgrade a WebSocket no prospera detrás del proxy (h2) y el
    // realtime ya llega por snapshots; evitamos el error de consola sin perder función.
    socket = io({ path: '/socket.io', transports: ['polling'], upgrade: false, auth: { token } });
  }
  return socket;
}
/* EL ÚLTIMO ESTADO QUE VIMOS, guardado en el módulo.
 *
 *  Sin esto, entrar a Internos desde otra pantalla del panel mostraba el spinner **hasta
 *  quince segundos**. El motivo: el servidor manda un snapshot al CONECTAR y después sólo
 *  cuando pasa algo (un canal, un registro) o cada 15 s por el reloj de reconciliación.
 *  Pero el socket es uno solo para todo el panel y ya estaba conectado hace rato: la
 *  pantalla nueva se suscribía tarde, se perdía el snapshot inicial, y se quedaba
 *  esperando el siguiente. Con la central tranquila, eso son quince segundos de reloj
 *  girando sobre datos que el navegador YA TENÍA.
 *
 *  Ahora se guarda el último y la pantalla nueva pinta al instante con él —como mucho está
 *  15 s viejo, y es exactamente lo que estaba mostrando la pantalla anterior— y en paralelo
 *  se le pide al servidor uno fresco, que llega en decenas de milisegundos. */
let ultimoSnap = null;
function recordarSnap(d) { ultimoSnap = d; }

export function useLive() {
  const [snap, setSnap] = useState(ultimoSnap);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const s = getSocket(); if (!s) return;
    const onSnap = (d) => { recordarSnap(d); setSnap(d); }, onC = () => setConnected(true), onD = () => setConnected(false);
    s.on('snapshot', onSnap); s.on('connect', onC); s.on('disconnect', onD);
    setConnected(s.connected);
    /* Y uno fresco ya: lo del cache sirve para pintar, no para quedarse. */
    if (s.connected) s.emit('snapshot:pedir');
    else s.once('connect', () => s.emit('snapshot:pedir'));
    return () => { s.off('snapshot', onSnap); s.off('connect', onC); s.off('disconnect', onD); };
  }, []);
  return { snap, connected };
}
