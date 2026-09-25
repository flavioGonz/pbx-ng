/* ============================================================================
 *  La escalera de inactividad y la hora del saludo.
 *
 *  Estas dos piezas se prueban con un reloj FALSO y sin red: son lógica pura, y es
 *  exactamente donde se esconden los errores que sólo aparecen en una llamada real y a la
 *  hora equivocada. Lo que cuidan las pruebas es lo que le pasa a una persona parada en la
 *  puerta de un edificio:
 *    · que no le pregunten «¿sigue ahí?» encima de la frase anterior;
 *    · que no le corten la llamada cuando acaba de hablar;
 *    · y que la llamada NO quede abierta facturando si el modelo se queda mudo.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearVigilante, TOPE_ARRANQUE_MS, TOPE_DESPEDIDA_MS, CORTE_TRAS_DESPEDIDA_MS } = require('../inactividad');
const momento = require('../momento');

/* Reloj falso: los tiempos reales son de 5 a 8 segundos y una prueba no puede tardar eso. */
function reloj() {
  let ahora = 0; let id = 0;
  const pend = new Map();
  return {
    poner: (fn, ms) => { const k = ++id; pend.set(k, { fn, en: ahora + ms }); return k; },
    sacar: (k) => pend.delete(k),
    avanzar(ms) {
      const hasta = ahora + ms;
      for (;;) {
        let prox = null;
        for (const [k, v] of pend) if (v.en <= hasta && (!prox || v.en < prox[1].en)) prox = [k, v];
        if (!prox) break;
        pend.delete(prox[0]); ahora = prox[1].en; prox[1].fn();
      }
      ahora = hasta;
    },
  };
}
function armar(opts = {}) {
  const r = reloj();
  const dicho = []; const cortes = [];
  const v = crearVigilante(Object.assign({
    esperas: { consulta1: 5, consulta2: 3, cierre: 8 },
    frases: { consulta1: 'C1', consulta2: 'C2', despedida: 'CHAU' },
    decir: (t) => dicho.push(t),
    cortar: () => cortes.push(true),
    temporizador: r.poner, cancelar: r.sacar,
  }, opts));
  return { v, r, dicho, cortes };
}
/* El ciclo de una frase del agente: empieza a sonar, suena, termina. */
const decirYTerminar = (v, r, ms = 500) => { v.hablando(); r.avanzar(ms); v.callado(); };

test('la cuenta arranca cuando el agente TERMINA de hablar, no cuando empieza', () => {
  const { v, r, dicho } = armar();
  v.hablando();
  r.avanzar(30000);          // media vida hablando: no puede dispararse nada
  assert.deepEqual(dicho, [], 'preguntó «¿sigue ahí?» encima de su propia frase');
  v.callado();
  r.avanzar(4900);
  assert.deepEqual(dicho, [], 'se adelantó a la espera configurada');
  r.avanzar(200);
  assert.deepEqual(dicho, ['C1']);
});

test('la escalera completa: consulta, segunda consulta, despedida y corte', () => {
  const { v, r, dicho, cortes } = armar();
  v.callado();
  r.avanzar(5000); assert.deepEqual(dicho, ['C1']);

  decirYTerminar(v, r);                       // suena la primera consulta
  r.avanzar(2900); assert.equal(dicho.length, 1, 'la segunda consulta se adelantó');
  r.avanzar(200); assert.deepEqual(dicho, ['C1', 'C2']);

  decirYTerminar(v, r);
  r.avanzar(7900); assert.equal(dicho.length, 2, 'la despedida se adelantó');
  r.avanzar(200); assert.deepEqual(dicho, ['C1', 'C2', 'CHAU']);

  /* El corte va DESPUÉS de que termina la despedida, no encima de la última sílaba. */
  v.hablando(); r.avanzar(1200); v.callado();
  assert.deepEqual(cortes, [], 'cortó antes de terminar de despedirse');
  r.avanzar(CORTE_TRAS_DESPEDIDA_MS + 10);
  assert.equal(cortes.length, 1, 'no cortó al terminar la despedida');
});

test('si el visitante habla, se cancela todo — incluso el corte ya agendado', () => {
  const { v, r, dicho, cortes } = armar();
  v.callado();
  r.avanzar(5000); decirYTerminar(v, r);      // C1
  r.avanzar(3000); decirYTerminar(v, r);      // C2
  r.avanzar(8000);                            // despedida mandada
  assert.deepEqual(dicho, ['C1', 'C2', 'CHAU']);

  v.hablando(); r.avanzar(400);               // está diciendo la despedida y…
  v.visitanteHabla();                         // …el visitante aparece
  r.avanzar(60000);
  assert.deepEqual(cortes, [], 'cortó a alguien que volvió a hablar mientras se despedía');

  /* Y la escalera vuelve a empezar de cero, no desde donde estaba. */
  v.callado();
  r.avanzar(4900); assert.equal(dicho.length, 3);
  r.avanzar(200); assert.deepEqual(dicho, ['C1', 'C2', 'CHAU', 'C1'], 'no volvió al primer escalón');
});

test('si el audio de una consulta nunca arranca, la escalera sigue igual', () => {
  /* El modelo puede aceptar el texto y no emitir nada. Sin este tope, la llamada queda
   * abierta para siempre — y facturando. */
  const { v, r, dicho } = armar();
  v.callado();
  r.avanzar(5000); assert.deepEqual(dicho, ['C1']);
  r.avanzar(TOPE_ARRANQUE_MS + 10);           // nunca llega `hablando()`
  r.avanzar(3000);
  assert.deepEqual(dicho, ['C1', 'C2'], 'la escalera se trabó esperando un audio que no llegó');
});

test('la despedida corta igual aunque no se escuche', () => {
  const { v, r, dicho, cortes } = armar();
  v.callado();
  r.avanzar(5000); r.avanzar(TOPE_ARRANQUE_MS + 10);
  r.avanzar(3000); r.avanzar(TOPE_ARRANQUE_MS + 10);
  assert.deepEqual(dicho, ['C1', 'C2']);
  r.avanzar(8000); assert.equal(dicho[2], 'CHAU');
  r.avanzar(TOPE_DESPEDIDA_MS + 10);
  assert.equal(cortes.length, 1, 'la llamada quedó abierta porque la despedida no sonó');
});

test('con la espera en 0 no hay escalera: nadie corta una llamada sin que se lo pidan', () => {
  const { v, r, dicho, cortes } = armar({ esperas: { consulta1: 0, consulta2: 3, cierre: 8 } });
  assert.equal(v.activo, false);
  v.callado();
  r.avanzar(120000);
  assert.deepEqual(dicho, []);
  assert.deepEqual(cortes, []);
});

test('cerrar() no deja temporizadores sueltos que corten una llamada ya terminada', () => {
  const { v, r, cortes } = armar();
  v.callado(); r.avanzar(5000); decirYTerminar(v, r);
  v.cerrar();
  r.avanzar(120000);
  assert.deepEqual(cortes, [], 'cortó una llamada que ya había terminado por otro motivo');
});

/* ── La hora ───────────────────────────────────────────────────────────────── */
test('la franja horaria es la de uso rioplatense, y en la zona del cliente', () => {
  const uy = 'America/Montevideo';
  /* 12:00 UTC = 09:00 en Montevideo (UTC-3). */
  assert.equal(momento.saludoHora(new Date('2026-03-10T12:00:00Z'), uy), 'buenos días');
  /* 18:00 UTC = 15:00 → tarde. */
  assert.equal(momento.saludoHora(new Date('2026-03-10T18:00:00Z'), uy), 'buenas tardes');
  /* 02:00 UTC = 23:00 del día anterior → noche. */
  assert.equal(momento.saludoHora(new Date('2026-03-10T02:00:00Z'), uy), 'buenas noches');
  /* El corte de la tarde es a las 12, no a las 13: «buen día» a las 12:30 suena raro. */
  assert.equal(momento.saludoHora(new Date('2026-03-10T15:30:00Z'), uy), 'buenas tardes');

  /* Y la zona importa de verdad: la misma marca de tiempo, otro huso, otro saludo. */
  assert.notEqual(momento.saludoHora(new Date('2026-03-10T12:00:00Z'), 'Asia/Tokyo'),
    momento.saludoHora(new Date('2026-03-10T12:00:00Z'), uy));
});

test('una zona inválida no rompe la llamada', () => {
  assert.match(momento.saludoHora(new Date(), 'No/Existe'), /buen[oa]s/);
});

test('el bloque de contexto le dice al modelo que la hora del sistema manda', () => {
  const b = momento.bloqueHora(new Date('2026-03-10T12:00:00Z'), 'America/Montevideo');
  assert.match(b, /buenos días/);
  assert.match(b, /manda sobre/, 'sin esto el modelo repite el saludo escrito en el texto y la hora no sirve de nada');
  assert.match(b, /no lo leas en voz alta/, 'el modelo puede leer el contexto al aire si no se le aclara');
});

test('{saludo} se reemplaza en la frase que escribió el usuario', () => {
  const t = momento.conSaludo('Gracias por comunicarse. ¡Que tenga {saludo}!', new Date('2026-03-10T18:00:00Z'), 'America/Montevideo');
  assert.equal(t, 'Gracias por comunicarse. ¡Que tenga buenas tardes!');
});

/* ── El cierre de la llamada: el orden que evita canales zombis ───────────────
 * Esto se prueba acá y no en una de integración porque lo que hay que fijar es el ORDEN,
 * y el orden no se ve en un test de punta a punta: se ve leyendo qué se soltó primero.
 *
 * El canal AudioSocket de Asterisk está bloqueado LEYENDO nuestro socket. Colgar el canal
 * antes de soltar el socket deja el canal «Up» para siempre — ni el CLI lo mata—, y con dos
 * de esos la llamada siguiente al agente no se atiende. Pasó en producción. */
test('al cerrar, el socket se suelta ANTES de colgar el canal de medios, y con destroy()', () => {
  const orden = [];
  const pipeline = require('../ai-pipeline');
  const ses = {
    uuid: 'x', closed: false,
    socket: { destroy: () => orden.push('socket.destroy'), end: () => orden.push('socket.end') },
    em: { id: 'em1' },
    bridge: { destroy: () => { orden.push('bridge.destroy'); return Promise.resolve(); } },
    log: () => {},
  };
  /* `cleanupMedia` no se exporta: se ejerce por el camino real, `close()`, que lo llama
   * para cada sesión viva. Se registra la sesión a mano en el mapa interno. */
  const mapa = pipeline._sesiones();
  mapa.set('x', ses);
  pipeline.close();
  mapa.delete('x');

  assert.ok(orden.includes('socket.destroy'), 'no soltó el socket: el canal queda trabado leyéndolo');
  assert.ok(!orden.includes('socket.end'), 'usó end(): manda un FIN y espera a un lector que nunca responde');
  const iSock = orden.indexOf('socket.destroy');
  const iBr = orden.indexOf('bridge.destroy');
  assert.ok(iBr === -1 || iSock < iBr, 'soltó el socket DESPUÉS de tocar el canal: ese es el orden que dejaba canales zombis');
});
