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

/** Porcentaje en es-UY (`82,5 %`). `null`/`undefined` es «no se pudo calcular» y
 *  devuelve el guion, que no es lo mismo que 0 %: los informes de call center
 *  distinguen «nadie llamó» de «no hay con qué medirlo». */
export function fmtPct(v, { decimales = 1 } = {}) {
  if (v == null || v === '' || isNaN(+v)) return VACIO;
  return (+v).toLocaleString(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: decimales }) + ' %';
}

/** Uptime en segundos como `3d 4h 12m`. */
export function fmtUptime(segundos) {
  const s = Math.max(0, parseInt(segundos, 10) || 0);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}

/** Fecha y hora para un `<input type="datetime-local">` (`2026-09-22T10:30`).
 *  No es lo mismo que mostrar una fecha: el input EXIGE ese formato y en hora LOCAL
 *  (un ISO con `Z` lo deja vacío sin decir por qué). Devuelve '' cuando no hay fecha,
 *  que es lo que el input entiende como «sin valor». */
export function fmtInputFechaHora(v) {
  const d = aFecha(v);
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
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

/* ---------------------------------------------------------------- infraestructura
 * Un módulo de infraestructura tiene DOS estados y no son el mismo: `deseado` es el
 * interruptor que alguien dejó en ON (`pbxng_settings.mod_<id>`) y `corriendo` es lo
 * que contestó el servicio cuando se lo fue a buscar. El release 1.11.0 salió
 * justamente porque el panel dibujaba el primero y lo llamaba «activo»: switch en
 * verde, contenedor inexistente y siete softphones sin audio. Acá se traduce el par a
 * lo que hay que mostrar, en un solo lugar, para que el interruptor de
 * `ModulesPanel` y la pantalla de WebRTC/TURN no se contradigan entre sí.
 *
 * `est` es lo que devuelve una sonda con forma `{deseado, corriendo, motivo, local}`
 * (hoy `GET /api/turn/estado`). `est` nulo NO es «apagado»: es «no lo sé», y se dice
 * así — inventar un verde sin haber medido es el bug original.
 * Devuelve `{color, texto, detalle, medido}`.
 */
export function estadoInfra(est, { deseado } = {}) {
  const on = est ? !!est.deseado : !!deseado;
  /* `sondeado:false` = no salió un solo paquete (módulo apagado, origen sin host, enlace
   * al SBC caído). Sin medición no se afirma NADA: pintar «NO responde» sobre algo que
   * nadie preguntó es la misma clase de mentira que este release vino a matar, movida
   * del backend al panel. Va antes que todo lo demás, incluido `local === false`. */
  if (est && est.sondeado === false) {
    return {
      color: 'gray', medido: false,
      texto: on ? 'no se pudo comprobar' : 'apagado',
      detalle: est.motivo || (on ? 'el interruptor está en ON pero no se pudo medir el servicio.' : ''),
    };
  }
  if (!est) {
    return {
      color: 'gray', medido: false,
      texto: on ? 'encendido · no se puede comprobar' : 'apagado',
      detalle: on ? 'este módulo todavía no tiene sonda: el panel sabe que el interruptor está en ON, pero no puede afirmar que el servicio esté respondiendo.' : '',
    };
  }
  /* El servicio lo provee otro (el TURN del SBC-NG o uno externo): el contenedor local
   * está apagado A PROPÓSITO, así que un interruptor en OFF no es una falla. */
  if (est.local === false) {
    return est.corriendo
      ? { color: 'teal', medido: true, texto: 'lo provee otro servidor · responde', detalle: est.motivo || '' }
      : { color: 'red', medido: true, texto: 'lo provee otro servidor · NO responde', detalle: est.motivo || '' };
  }
  if (on && !est.corriendo) {
    return { color: 'red', medido: true, texto: 'encendido, pero el servicio no responde', detalle: est.motivo || '' };
  }
  if (!on && est.corriendo) {
    return { color: 'yellow', medido: true, texto: 'apagado, pero todavía responde', detalle: est.motivo || 'el interruptor está en OFF y el servicio sigue contestando: quedó corriendo de antes.' };
  }
  if (on) return { color: 'teal', medido: true, texto: 'encendido y respondiendo', detalle: est.motivo || '' };
  return { color: 'gray', medido: true, texto: 'apagado', detalle: '' };
}

/* ------------------------------------------------------------------- nodos
 * Misma idea que `estadoInfra()`, pero para un nodo del inventario
 * (`GET /api/system/overview` → `nodes[]`). El bug era idéntico y de la misma
 * familia: la tarjeta pintaba un «EN LÍNEA» de adorno y un juego de barras para
 * CADA nodo, hubiera contestado su agente o no. Un nodo cuyo agente no contestó no
 * se sabe cómo está: no se afirma, se dice que no se pudo medir.
 *
 * `n` es un elemento de `nodes[]`. Devuelve la MISMA forma que `estadoInfra()`
 * —`{color, texto, detalle, medido}`— para que las dos pantallas que muestran
 * infraestructura hablen el mismo idioma; `medido:false` significa siempre lo
 * mismo en las dos: acá no hay número que mostrar.
 */
export function estadoNodo(n) {
  if (!n) {
    return { color: 'gray', medido: false, texto: 'no se pudo medir', detalle: 'el panel no recibió nada de este nodo.' };
  }
  /* `ok:false` = se le preguntó al agente y no contestó. Eso NO mide el nodo: mide
   * que no se lo puede alcanzar. Sus recursos siguen siendo desconocidos, así que va
   * gris (no medido) igual que el `sondeado:false` de `estadoInfra()`. Que algo esté
   * caído lo grita el cartel de arriba de la pantalla, no un verde a medias. */
  if (n.ok === false) {
    return {
      color: 'gray', medido: false, texto: 'no se pudo medir',
      detalle: n.motivo || 'el agente de este nodo no contestó: no hay medición de CPU, memoria ni disco.',
    };
  }
  /* Contestó, pero sin una sola métrica adentro. Pasa cuando el agente responde el
   * health y el cuerpo viene vacío o con otra forma: tampoco hay nada que afirmar. */
  const hayAlgo = [n.cpu_pct, n.mem_pct, n.mem_total_mb, n.uptime_s, n.ncpu].some((v) => v != null) || !!n.disk;
  if (!hayAlgo) {
    return {
      color: 'gray', medido: false, texto: 'respondió, pero sin datos',
      detalle: 'el agente contestó y no mandó ninguna métrica: no se puede decir cómo está este nodo.',
    };
  }
  return { color: 'teal', medido: true, texto: 'en línea', detalle: '' };
}

/* Campos que, dentro de un contenedor, salen del kernel de la máquina de abajo:
 * `/proc/meminfo`, `os.cpu_count()` y `/proc/uptime` no están namespaceados, así que
 * un agente que los lee directo reporta el hipervisor y no su CT. El disco NO está en
 * la lista a propósito: se mide sobre el sistema de archivos propio y sí es del nodo. */
const FIRMA_HOST = ['mem_total_mb', 'ncpu', 'uptime_s'];

/* Dos nodos DISTINTOS no pueden tener la misma memoria total, los mismos vCPU y el
 * mismo uptime al segundo: el uptime es el que delata, porque dos máquinas que
 * arrancaron por separado no coinciden al segundo. Cuando coinciden, lo que se está
 * mirando es una sola máquina física reportada con varios nombres —el caso real: tres
 * agentes devolviendo los 35 GB, los 12 vCPU y los 36 días del hipervisor— y el panel
 * no tiene que dibujar cuatro tarjetas iguales como si nada.
 *
 * Devuelve `{ grupos, ids }`: `grupos` son los conjuntos de nodos que comparten firma
 * (para el cartel) e `ids` es un Set con los nodos afectados (para tachar sus números).
 * Es detección, no diagnóstico: el panel no puede arreglar el agente, pero sí puede
 * negarse a presentar como propio un número que evidentemente es de otra máquina. */
export function metricasClonadas(nodes = []) {
  const porFirma = new Map();
  for (const n of nodes) {
    if (!n || n.ok === false) continue;
    if (FIRMA_HOST.some((k) => n[k] == null)) continue;   // sin los tres, no hay firma que comparar
    const firma = FIRMA_HOST.map((k) => n[k]).join('|');
    if (!porFirma.has(firma)) porFirma.set(firma, []);
    porFirma.get(firma).push({ id: n.id, name: n.name });
  }
  const grupos = [];
  const ids = new Set();
  for (const [firma, nodos] of porFirma) {
    if (nodos.length < 2) continue;
    grupos.push({ firma, nodos });
    for (const x of nodos) ids.add(x.id);
  }
  return { grupos, ids };
}
