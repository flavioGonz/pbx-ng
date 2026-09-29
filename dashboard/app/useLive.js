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
    /* Se INTENTA el WebSocket, con long-polling como piso.
     *
     * Antes estaba forzado a polling para no ver el error de consola del upgrade fallido.
     * El costo de eso no se veía hasta que el estado de los internos pasó a ser en vivo:
     * medido contra la central, un evento que el servidor emitía 158 ms después de que el
     * teléfono empezara a timbrar tardaba entre 100 ms y 1.3 s en llegar al navegador,
     * porque con polling el mensaje espera a que el cliente vuelva a abrir el GET. Con
     * WebSocket el mensaje sale por una conexión que ya está abierta.
     *
     * Si el proxy del cliente no deja pasar el upgrade, socket.io se queda en polling solo
     * (eso es lo que hace de fábrica): se pierde velocidad, no función. */
    socket = io({ path: '/socket.io', transports: ['polling', 'websocket'], upgrade: true, auth: { token } });
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

/* ── Carril rápido: el estado de los internos ──────────────────────────────────────
 *
 *  Va por un evento aparte del `snapshot` porque el snapshot es caro de armar del lado de
 *  la central (lee la base y le pide `pjsip show contacts` al AMI) y por eso llega con
 *  freno. Acá viajan SÓLO las diferencias —un objeto por interno que cambió—, así que
 *  entre que un teléfono empieza a timbrar y que la insignia cambia en pantalla hay
 *  décimas de segundo. Al conectar llega uno completo (`completo: true`) y a partir de ahí
 *  cada mensaje se funde sobre lo que ya había.
 *
 *  Mismo truco de memoria que el snapshot: la pantalla que se abre pinta con lo último
 *  que vimos y pide uno fresco en paralelo. */
let ultimoEstados = {};
export function useEstados() {
  const [estados, setEstados] = useState(ultimoEstados);
  useEffect(() => {
    const s = getSocket(); if (!s) return;
    const on = (d) => {
      if (!d || !d.internos) return;
      ultimoEstados = d.completo ? { ...d.internos } : { ...ultimoEstados, ...d.internos };
      setEstados(ultimoEstados);
    };
    const pedir = () => s.emit('estados:pedir');
    s.on('estados', on);
    /* Y en cada reconexión, uno completo: mientras el socket estuvo caído pudo cambiar
     * cualquier cosa y las diferencias que nos perdimos no vuelven solas. */
    s.on('connect', pedir);
    if (s.connected) pedir();
    return () => { s.off('estados', on); s.off('connect', pedir); };
  }, []);
  return estados;
}

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
