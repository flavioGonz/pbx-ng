/* ============================================================================
 *  PBX-NG · Estado real de los nodos.
 *
 *  Por qué existe: hasta ahora /api/topology devolvía las IPs del archivo de
 *  configuración y nada más. Topología y Resumen las dibujaban siempre en verde.
 *  El 2026-07-21 el borde estuvo caído medio día y las dos pantallas lo mostraron
 *  sano todo el tiempo; el único que se dio cuenta fue Asterisk, porque cualifica
 *  la troncal por su cuenta. Un panel que no puede decir "esto está caído" no
 *  sirve para operar.
 *
 *  Cómo mide: abre el puerto que de verdad importa en cada nodo (no un ping, que
 *  contesta el kernel aunque el servicio esté muerto) y mide cuánto tarda. Si el
 *  puerto abre, el servicio está escuchando.
 *
 *  Un aviso sobre los pings: verificando esta misma caída, un ping desde afuera
 *  respondía OK mientras el contenedor estaba apagado — contestaba otro equipo del
 *  camino. Por eso acá se prueba el PUERTO del servicio y nunca ICMP.
 * ==========================================================================*/
'use strict';

const net = require('net');

/* Cache corto: las pantallas consultan cada pocos segundos y no queremos abrir
 * sockets sin parar. 8s es suficiente para que un corte se note enseguida sin
 * castigar a los nodos. */
const TTL = 8000;
const cache = new Map();   // clave -> { hasta, valor }

/* Prueba de vida real: ¿hay algo escuchando en ese puerto? */
function probarPuerto(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    if (!host) return resolve({ vivo: false, motivo: 'sin dirección configurada' });
    const t0 = Date.now();
    const s = new net.Socket();
    let listo = false;
    const cerrar = (vivo, motivo) => {
      if (listo) return;
      listo = true;
      try { s.destroy(); } catch (_) {}
      resolve({ vivo, ms: Date.now() - t0, motivo: motivo || null });
    };
    s.setTimeout(timeout);
    s.once('connect', () => cerrar(true));
    s.once('timeout', () => cerrar(false, 'no respondió a tiempo'));
    s.once('error', (e) => cerrar(false, e.code === 'ECONNREFUSED' ? 'puerto cerrado' : (e.code || 'sin alcance')));
    s.connect(port, host);
  });
}

async function conCache(clave, fn) {
  const ahora = Date.now();
  const c = cache.get(clave);
  if (c && c.hasta > ahora) return c.valor;
  const valor = await fn();
  cache.set(clave, { hasta: ahora + TTL, valor });
  return valor;
}

/* Cada nodo del appliance, con el puerto que de verdad dice si está vivo. */
function definirNodos(NODES) {
  const n = [];
  n.push({ id: 'asterisk', nombre: 'Núcleo (Asterisk)', rol: 'nucleo', host: NODES.asterisk, puerto: 8088,
           papel: 'Procesa las llamadas: dialplan, colas, IVR, buzón y grabación.' });
  n.push({ id: 'db', nombre: 'Base de datos', rol: 'datos', host: NODES.db, puerto: 5432,
           papel: 'Guarda la configuración, el historial y el CRM.' });
  if (NODES.sbc) {
    n.push({ id: 'borde', nombre: 'Borde propio', rol: 'borde-propio', host: NODES.sbc, puerto: 5060,
             papel: 'El borde que viene con la central: recibe el SIP de afuera y ancla el audio.' });
  }
  if (NODES.turn && NODES.turn !== NODES.sbc) {
    n.push({ id: 'turn', nombre: 'TURN', rol: 'nat', host: NODES.turn, puerto: 3478,
             papel: 'Da camino al audio de los softphones detrás de NAT.' });
  }
  if (NODES.voz) {
    n.push({ id: 'voz', nombre: 'IA de voz', rol: 'voz', host: NODES.voz, puerto: 8080,
             papel: 'Genera y transcribe audio (TTS y STT).' });
  }
  if (NODES.npm) {
    n.push({ id: 'proxy', nombre: 'Proxy / TLS', rol: 'proxy', host: NODES.npm, puerto: 443,
             papel: 'Publica el panel y el WebSocket con certificado.' });
  }
  return n;
}

/* Estado de todos los nodos propios, medido en paralelo. */
async function nodos(NODES) {
  const defs = definirNodos(NODES);
  const res = await Promise.all(defs.map(async (d) => {
    const p = await conCache(`${d.host}:${d.puerto}`, () => probarPuerto(d.host, d.puerto));
    return { ...d, estado: p.vivo ? 'ok' : 'caido', ms: p.ms ?? null, motivo: p.motivo };
  }));
  return res;
}

/* Bordes EXTERNOS: son otro producto (SBC-NG u otro), conectados como troncal.
 * Se distinguen del borde propio a propósito: uno es parte de este appliance y el
 * otro es un equipo aparte, con su propio panel y su propio ciclo de vida.
 * Confundirlos es lo que hacía que la topología mostrara "SBC-NG" en verde
 * mientras el SBC-NG de verdad estaba apagado. */
async function bordesExternos(filas) {
  const ext = (filas || []).filter((t) => t.kind === 'sbc');
  return Promise.all(ext.map(async (t) => {
    const p = await conCache(`${t.provider_host}:${t.provider_port || 5060}`,
      () => probarPuerto(t.provider_host, t.provider_port || 5060));
    return {
      id: t.name, nombre: t.name, rol: 'borde-externo',
      host: t.provider_host, puerto: t.provider_port || 5060,
      estado: p.vivo ? 'ok' : 'caido', ms: p.ms ?? null, motivo: p.motivo,
      papel: 'Borde de otro producto, conectado por troncal. Se administra en su propio panel.',
    };
  }));
}

/* Resumen de una línea, que es lo que la pantalla de inicio necesita. */
function resumir(lista) {
  const caidos = lista.filter((x) => x.estado === 'caido');
  return {
    total: lista.length,
    ok: lista.length - caidos.length,
    caidos: caidos.length,
    sano: caidos.length === 0,
    detalle: caidos.map((c) => `${c.nombre} (${c.host}): ${c.motivo || 'no responde'}`),
  };
}

module.exports = { nodos, bordesExternos, resumir, probarPuerto };
