'use strict';
/* ============================================================================
 *  PBX-NG · Qué hacer cuando el visitante deja de hablar.
 *
 *  POR QUÉ NO SE LE PIDE AL MODELO: un modelo de voz no tiene reloj, no sabe cuánto
 *  silencio pasó y no puede colgar una llamada. Pedirle «si no contesta en 5 segundos,
 *  preguntá si sigue ahí» funciona a veces, y «a veces» en una portería es una llamada
 *  abierta toda la noche o cortada en la cara de un visitante. Esto es una máquina de
 *  estados del lado nuestro; el modelo sólo pone la voz.
 *
 *  LA ESCALERA (los tres tiempos son ajustes del agente):
 *    hablando ─┐
 *              └─ calla ── espera1 ──► «¿Sigue ahí?» ── calla ── espera2 ──► «¿Hola?»
 *                                                                  │
 *                                                calla ── espera3 ─┴─► despedida ──► cortar
 *
 *  DOS DETALLES QUE PARECEN MENORES Y NO LO SON:
 *
 *  1. **La cuenta arranca cuando el agente TERMINA de hablar, no cuando se le manda el
 *     texto.** Si arrancara al mandarlo, una respuesta larga se comería la espera entera y
 *     el agente preguntaría «¿sigue ahí?» encima de su propia frase.
 *
 *  2. **Si el audio no llega a sonar, igual se sigue.** El modelo puede aceptar el texto y
 *     no emitir nada —pasa—, y si la escalera esperara ese audio para siempre, la llamada
 *     quedaría abierta y facturando. Por eso cada paso tiene un tope: si el audio no
 *     arrancó en `TOPE_ARRANQUE_MS`, se cuenta como dicho; y la despedida corta igual a
 *     los `TOPE_DESPEDIDA_MS` de mandarse, haya sonado o no. El que decide cortar es este
 *     archivo, nunca el proveedor.
 *
 *  El visitante hablando CANCELA todo, incluido un corte ya agendado: quien vuelve a
 *  hablar mientras el agente se despide no se queda sin llamada.
 * ==========================================================================*/

const TOPE_ARRANQUE_MS = 3000;     // si la consulta no empieza a sonar, se cuenta como dicha
const TOPE_DESPEDIDA_MS = 8000;    // tope duro: pasado esto se corta aunque no haya sonado
const CORTE_TRAS_DESPEDIDA_MS = 1000;   // un respiro para que no se corte sobre la última sílaba

const FRASES = {
  consulta1: '¿Sigue ahí? ¿Hay algo en lo que lo pueda ayudar?',
  consulta2: '¿Hola? ¿Me escucha? Si necesita algo dígame.',
  despedida: 'Gracias por comunicarse. ¡Que tenga {saludo}!',
};

/**
 * @param {object} o
 *   esperas   {consulta1, consulta2, cierre} en SEGUNDOS. Si `consulta1` es 0, no hay
 *             escalera: el agente se queda esperando para siempre, como antes.
 *   frases    {consulta1, consulta2, despedida} — texto ya resuelto (sin {saludo}).
 *   decir     (texto) => void   le pide al agente que diga algo
 *   cortar    () => void        termina la llamada
 *   log       (texto) => void
 *   temporizador/cancelar  inyectables para las pruebas (por defecto setTimeout/clearTimeout)
 */
function crearVigilante(o) {
  const esperas = o.esperas || {};
  const frases = Object.assign({}, FRASES, o.frases || {});
  const decir = o.decir || (() => {});
  const cortar = o.cortar || (() => {});
  const log = o.log || (() => {});
  const poner = o.temporizador || ((fn, ms) => setTimeout(fn, ms));
  const sacar = o.cancelar || ((t) => clearTimeout(t));
  const seg = (x) => Math.max(0, Math.round(Number(x) || 0)) * 1000;

  const ms = {
    consulta1: seg(esperas.consulta1),
    consulta2: seg(esperas.consulta2),
    cierre: seg(esperas.cierre),
  };

  /* paso: 0 conversando · 1 dicha la primera consulta · 2 dicha la segunda · 3 despidiéndose */
  let paso = 0;
  let timer = null;          // la espera de silencio en curso
  let arranque = null;       // el tope por si el audio no empieza
  let hablando = false;
  let esperandoAudio = false;    // se mandó algo y todavía no empezó a sonar
  let vivo = ms.consulta1 > 0;
  let cerrado = false;

  const limpiar = () => {
    if (timer) { sacar(timer); timer = null; }
    if (arranque) { sacar(arranque); arranque = null; }
  };

  function agendar() {
    limpiar();
    if (!vivo || cerrado || hablando || esperandoAudio) return;
    const espera = paso === 0 ? ms.consulta1 : paso === 1 ? ms.consulta2 : paso === 2 ? ms.cierre : 0;
    if (espera <= 0) return;
    timer = poner(() => { timer = null; avanzar(); }, espera);
  }

  function mandar(texto, tope) {
    esperandoAudio = true;
    limpiar();
    decir(texto);
    /* El tope: si el audio no arranca, se sigue igual. Sin esto, un modelo que acepta el
     * texto y no emite nada deja la llamada abierta para siempre. */
    arranque = poner(() => {
      arranque = null;
      if (cerrado || !esperandoAudio) return;
      log('la consulta no llegó a sonar: se sigue igual');
      esperandoAudio = false; hablando = false;
      if (paso === 3) return;          // la despedida tiene su propio tope, más abajo
      agendar();
    }, tope);
  }

  function avanzar() {
    if (cerrado || !vivo) return;
    if (paso === 0) {
      paso = 1; log('inactividad: primera consulta');
      mandar(frases.consulta1, TOPE_ARRANQUE_MS);
    } else if (paso === 1) {
      paso = 2; log('inactividad: segunda consulta');
      mandar(frases.consulta2, TOPE_ARRANQUE_MS);
    } else if (paso === 2) {
      paso = 3; log('inactividad: despedida, la llamada se va a cortar');
      mandar(frases.despedida, TOPE_DESPEDIDA_MS);
      /* Tope duro de la despedida: pase lo que pase con el audio, a los 8 s se corta.
       * Es la garantía de que ninguna llamada queda abierta facturando. */
      const duro = poner(() => { if (!cerrado) { log('tope de despedida: se corta igual'); terminar(); } }, TOPE_DESPEDIDA_MS);
      arranque = duro;
    }
  }

  function terminar() {
    if (cerrado) return;
    cerrado = true; limpiar();
    cortar();
  }

  return {
    /** El agente empezó a emitir audio. */
    hablando() {
      if (cerrado) return;
      hablando = true; esperandoAudio = false;
      limpiar();
    },
    /** El agente terminó de hablar: acá arranca la cuenta, y no antes. */
    callado() {
      if (cerrado) return;
      hablando = false; esperandoAudio = false;
      if (paso === 3) {
        /* Terminó la despedida: se corta un segundo después, no encima de la última sílaba. */
        limpiar();
        timer = poner(() => { timer = null; terminar(); }, CORTE_TRAS_DESPEDIDA_MS);
        return;
      }
      agendar();
    },
    /** Habló el visitante: se cancela todo, incluso un corte ya agendado. */
    visitanteHabla() {
      if (cerrado) return;
      if (paso > 0) log('el visitante volvió a hablar: se cancela el cierre');
      paso = 0; hablando = false; esperandoAudio = false;
      limpiar();
    },
    /** Para cuando la llamada termina por otro motivo. */
    cerrar() { cerrado = true; limpiar(); },
    /** Para las pruebas y para el tablero. */
    estado() { return { paso, vivo, hablando, esperandoAudio, cerrado }; },
    activo: vivo,
  };
}

module.exports = { crearVigilante, FRASES, TOPE_ARRANQUE_MS, TOPE_DESPEDIDA_MS, CORTE_TRAS_DESPEDIDA_MS };
