/* Formateo compartido del panel. Cada pantalla venía con su propia copia de estas
 * funciones (fmtB en Resumen y SystemOverview, tres fmtDur distintos, `es-UY` escrito
 * a mano en una docena de lugares): además de repetirse, cada copia redondeaba o
 * abreviaba distinto, así que la misma duración se veía de tres formas según la
 * pantalla. Acá está la versión única; lo que de verdad difiere queda documentado.
 *
 * Sin 'use client': son funciones puras, las puede usar cualquier componente. */

const LOCALE = 'es-UY';
const VACIO = '—';

const aFecha = (v) => {
  if (v == null || v === '') return null;
  // La API manda ISO (timestamptz) o epoch en ms; `sec:ev` manda epoch en ms también.
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
  return isNaN(d.getTime()) ? null : d;
};

/** Duración en segundos como texto corto: `1m 5s`, `45s`. Es la forma que usan
 *  historial, mapa y la ficha de cliente (la más común en tablas). */
export function fmtDur(segundos) {
  const s = Math.max(0, Math.floor(Number(segundos) || 0));
  const m = Math.floor(s / 60);
  return m ? m + 'm ' + (s % 60) + 's' : s + 's';
}

/** Duración como reloj: `MM:SS` y `H:MM:SS` desde la hora. Para reproductores y
 *  wallboard, donde los números se comparan de un vistazo en columna. */
export function fmtReloj(segundos) {
  if (segundos == null || segundos < 0) return VACIO;
  const s = Math.floor(Number(segundos) || 0);
  const p = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

/** Fecha corta es-UY (`08/09/2026`). Con `{ largo: true }`, `8 de setiembre de 2026`. */
export function fmtFecha(v, { largo = false } = {}) {
  const d = aFecha(v);
  if (!d) return VACIO;
  return d.toLocaleDateString(LOCALE, largo
    ? { day: '2-digit', month: 'long', year: 'numeric' }
    : undefined);
}

/** Hora es-UY en 24 h (`14:05`). Con `{ segundos: true }`, `14:05:32`. */
export function fmtHora(v, { segundos = false } = {}) {
  const d = aFecha(v);
  if (!d) return VACIO;
  return d.toLocaleTimeString(LOCALE, { hour12: false, hour: '2-digit', minute: '2-digit', ...(segundos ? { second: '2-digit' } : {}) });
}

/** Día y hora sin año (`08/09 14:05`): lo que muestran las tablas de eventos. */
export function fmtFechaHora(v) {
  const d = aFecha(v);
  if (!d) return VACIO;
  return d.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Bytes legibles (`1,5 GB`). Una sola decimal debajo de 10 y sólo a partir de KB. */
export function fmtBytes(n) {
  if (n == null || n === '' || isNaN(+n)) return VACIO;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Math.abs(+n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (+n < 0 ? '-' : '') + v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}

/** Uptime en segundos como `3d 4h 12m`. */
export function fmtUptime(segundos) {
  const s = Math.max(0, parseInt(segundos, 10) || 0);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}

/* Nombre comercial del códec: en la interfaz el usuario reconoce «G.711 µ-law»,
 * no `ulaw` (que es como lo nombra Asterisk en pjsip.conf). */
const CODECS = {
  ulaw: 'G.711 µ-law', alaw: 'G.711 A-law', g722: 'G.722 (HD)', g729: 'G.729',
  gsm: 'GSM', opus: 'Opus', speex: 'Speex', ilbc: 'iLBC',
  h264: 'H.264', vp8: 'VP8', vp9: 'VP9',
};
export function codecLabel(c) {
  const k = String(c || '').toLowerCase().trim();
  return CODECS[k] || (c ? String(c).toUpperCase() : VACIO);
}

/* Bandera del país como IMAGEN (flagcdn) y no emoji: Windows/Chrome no trae glifos
 * de banderas y el emoji se ve como el código de país. Devuelve la URL o '' si el
 * código no es un ISO-3166 de dos letras (la API deja `cc` vacío si ip-api no resolvió). */
export function banderaCC(cc, { formato = 'svg' } = {}) {
  const c = String(cc || '').toLowerCase().trim();
  if (!/^[a-z]{2}$/.test(c)) return '';
  return `https://flagcdn.com/${c}.${formato}`;
}

/* Color Mantine por estado. Vale para troncales (online/offline/sbc), componentes de
 * la topología (ok/down/pending) e internos (online/offline): son los tres vocabularios
 * que devuelve la API y se pintaban con el mismo ternario copiado en cada pantalla. */
const COLOR_ESTADO = {
  online: 'teal', ok: 'teal', up: 'teal', activo: 'teal', registrado: 'teal',
  offline: 'red', down: 'red', caido: 'red', error: 'red', bloqueado: 'red',
  sbc: 'grape',
  pending: 'yellow', pendiente: 'yellow', warn: 'yellow', degraded: 'yellow',
  llamada: 'orange', busy: 'orange',
};
export function estadoColor(estado, porDefecto = 'gray') {
  return COLOR_ESTADO[String(estado || '').toLowerCase().trim()] || porDefecto;
}
