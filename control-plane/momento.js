'use strict';
/* ============================================================================
 *  PBX-NG · La hora, para el que atiende.
 *
 *  POR QUÉ ESTO EXISTE: un modelo de lenguaje NO tiene reloj. Si el saludo dice «buenos
 *  días» es porque estaba en el texto, no porque sea de mañana; y una portería que da los
 *  buenos días a las once de la noche se nota enseguida. Tampoco alcanza con la hora del
 *  servidor: la central puede correr en UTC y el edificio está en Montevideo.
 *
 *  Así que la franja horaria se calcula acá, con la zona del cliente, y se le INYECTA al
 *  modelo al abrir la sesión. El modelo no decide qué hora es: se la damos.
 *
 *  Los cortes son los de uso rioplatense, no los del reloj astronómico:
 *    · 05:00–11:59  «buenos días»
 *    · 12:00–19:59  «buenas tardes»
 *    · 20:00–04:59  «buenas noches»
 *  La tarde arranca a las 12 —no a las 13— porque acá «buen día» después del mediodía ya
 *  suena raro, y la noche a las 20 por la misma razón.
 * ==========================================================================*/

const ZONA_DEF = 'America/Montevideo';

/** Hora local (0–23) en una zona, sin depender del TZ del proceso. */
function horaEn(fecha, zona) {
  try {
    const h = new Intl.DateTimeFormat('es-UY', { timeZone: zona || ZONA_DEF, hour: '2-digit', hour12: false }).format(fecha);
    const n = parseInt(h, 10);
    return Number.isFinite(n) ? (n % 24) : fecha.getHours();
  } catch (_) {
    /* Zona inválida: mejor la hora del servidor que romper la llamada. */
    return fecha.getHours();
  }
}

/** 'dias' | 'tardes' | 'noches' — sin tilde, es una clave, no un texto. */
function franja(fecha, zona) {
  const h = horaEn(fecha || new Date(), zona);
  if (h >= 5 && h < 12) return 'dias';
  if (h >= 12 && h < 20) return 'tardes';
  return 'noches';
}

/** «buenos días» / «buenas tardes» / «buenas noches», listo para meter en una frase. */
function saludoHora(fecha, zona) {
  const f = franja(fecha, zona);
  return f === 'dias' ? 'buenos días' : f === 'tardes' ? 'buenas tardes' : 'buenas noches';
}

/** Fecha y hora escritas, para que el modelo pueda contestar «¿qué hora es?». */
function textoFechaHora(fecha, zona) {
  const d = fecha || new Date();
  try {
    return new Intl.DateTimeFormat('es-UY', {
      timeZone: zona || ZONA_DEF, weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch (_) { return d.toISOString(); }
}

/**
 * El bloque que se le antepone a las instrucciones del agente.
 *
 * Va SEPARADO de lo que escribió el usuario en el panel y dice explícitamente que esto
 * manda sobre el saludo: si no, el modelo repite el «buenos días» que quedó escrito en el
 * texto del saludo y la hora que le pasamos no sirve de nada.
 */
function bloqueHora(fecha, zona) {
  const d = fecha || new Date();
  return 'CONTEXTO DE LA LLAMADA (dato del sistema, no lo leas en voz alta):\n'
    + '- Ahora es ' + textoFechaHora(d, zona) + ' en ' + (zona || ZONA_DEF) + '.\n'
    + '- Al saludar y al despedirte decí «' + saludoHora(d, zona) + '». Esto manda sobre '
    + 'cualquier saludo que aparezca escrito en otra parte de tus instrucciones.';
}

/** Reemplaza {saludo} en una frase configurada por el usuario. */
function conSaludo(texto, fecha, zona) {
  return String(texto || '').replace(/\{saludo\}/gi, saludoHora(fecha, zona));
}

module.exports = { ZONA_DEF, horaEn, franja, saludoHora, textoFechaHora, bloqueHora, conSaludo };
