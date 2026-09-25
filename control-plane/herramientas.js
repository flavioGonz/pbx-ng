'use strict';
/* ============================================================================
 *  PBX-NG · Las herramientas que un agente de IA puede PEDIR.
 *
 *  EL PRINCIPIO, Y NO ES NEGOCIABLE: el modelo nunca ejecuta nada. Pide. Este archivo
 *  decide si corresponde, lo hace, y le devuelve el resultado. Esa inversión es lo único
 *  que separa «un asistente con herramientas» de «un relé conectado a un micrófono».
 *
 *  POR QUÉ EL CATÁLOGO ES CERRADO Y NO UNA LISTA EDITABLE EN EL PANEL: cada herramienta
 *  necesita código atrás igual. Una lista libre no agrega capacidades: agrega formas de
 *  que el agente PROMETA cosas que no existen, y de que alguien declare `abrir_porton` sin
 *  los candados. Si falta una herramienta, se agrega acá, con su prueba.
 *
 *  DOS CLASES, Y SE TRATAN DISTINTO
 *  --------------------------------
 *  · LEEN    (`verificar_unidad`, `consultar_datos`): si se equivocan, el agente dice algo
 *            incorrecto. Molesto, no grave. Llevan tope de tiempo y nada más.
 *  · ACTÚAN  (`transferir_a_agente`, `tomar_mensaje`, `terminar_llamada`, `abrir_porton`):
 *            tienen consecuencia. Todas se auditan. Y una de ellas abre la puerta de un
 *            edificio, así que tiene candados propios.
 *
 *  SOBRE `abrir_porton`
 *  --------------------
 *  Un agente de voz escucha un nombre y un número de unidad; no puede confirmar que sean
 *  ciertos. Por eso, de fábrica, abrir exige que ANTES haya salido bien una verificación
 *  contra el CRM en la misma llamada (`exigir_verificacion`). Con eso apagado, el portón
 *  se abre con lo que alguien dijo por teléfono — es una decisión del dueño del edificio,
 *  no un default nuestro.
 *  Los otros candados —ventana horaria, tope por hora, auditoría de todo— existen porque
 *  el modo en que esto sale mal no es «se abre una vez de más»: es una ráfaga a las tres
 *  de la mañana que nadie mira hasta el lunes.
 * ==========================================================================*/

const TOPE_LECTURA_MS = 2500;      // una consulta lenta no puede trabar la conversación
const VENTANA_DEF = '00:00-23:59';
const MAX_HORA_DEF = 3;

/* ── Catálogo ──────────────────────────────────────────────────────────────────
 * `declarar()` arma lo que se le manda al modelo. Cada entrada dice para qué sirve EN
 * CRISTIANO, porque esa descripción es lo único que el modelo usa para decidir cuándo
 * pedirla: una descripción vaga es una herramienta que se dispara cuando no corresponde. */
const CATALOGO = {
  verificar_autorizado: {
    riesgo: 'lee',
    titulo: 'Verificar a un autorizado',
    ayuda: 'Confirma contra el CRM de la central si la persona que está en la puerta figura entre los autorizados de esa dirección.',
    declarar: () => ({
      type: 'function', name: 'verificar_autorizado',
      description: 'Confirmar si quien está en la puerta figura entre las personas autorizadas de esta dirección. '
        + 'Pedile nombre y apellido completos; si hay más de una persona con ese nombre te voy a pedir el documento. '
        + 'NO inventes el resultado ni digas nombres de residentes que el visitante no haya dicho antes.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre y apellido, tal como lo dijo el visitante' },
          documento: { type: 'string', description: 'Número de documento, si lo dio' },
        },
        required: ['nombre'],
      },
    }),
  },
  verificar_unidad: {
    riesgo: 'lee',
    titulo: 'Verificar unidad',
    ayuda: 'Confirma contra el CRM que una unidad existe y quién es su titular.',
    declarar: () => ({
      type: 'function', name: 'verificar_unidad',
      description: 'Confirmar que una unidad (apartamento/oficina) existe y quién figura como titular. '
        + 'Usala cuando el visitante dice a quién viene a ver o en qué unidad. No inventes el resultado: si esto falla, decilo.',
      parameters: {
        type: 'object',
        properties: {
          unidad: { type: 'string', description: 'Número de unidad, tal como lo dijo el visitante' },
          nombre: { type: 'string', description: 'Nombre de la persona a la que viene a ver, si lo dijo' },
        },
        required: ['unidad'],
      },
    }),
  },
  consultar_datos: {
    riesgo: 'lee',
    titulo: 'Consultar datos',
    ayuda: 'Pregunta libre al CRM del cliente (horarios, autorizaciones, visitas agendadas).',
    declarar: () => ({
      type: 'function', name: 'consultar_datos',
      description: 'Consultar información del edificio o del cliente (horarios, visitas agendadas, autorizaciones). '
        + 'Devuelve texto. Si no hay respuesta, decí que no lo podés confirmar; NO inventes.',
      parameters: {
        type: 'object',
        properties: { consulta: { type: 'string', description: 'La pregunta, en una frase' } },
        required: ['consulta'],
      },
    }),
  },
  transferir_a_agente: {
    riesgo: 'actua',
    titulo: 'Transferir a una persona',
    ayuda: 'Pasa la llamada a un interno o a una cola. Es la salida cuando el agente no puede resolver.',
    declarar: () => ({
      type: 'function', name: 'transferir_a_agente',
      description: 'Pasar la llamada a una persona. Usala cuando el visitante lo pide, cuando no podés resolver, '
        + 'o cuando dudás de algo que importa. Después de llamarla no digas nada más: la llamada ya no es tuya.',
      parameters: {
        type: 'object',
        properties: { motivo: { type: 'string', description: 'Por qué se deriva, en pocas palabras' } },
      },
    }),
  },
  tomar_mensaje: {
    riesgo: 'actua',
    titulo: 'Tomar un mensaje',
    ayuda: 'Guarda lo que el visitante quiere dejar dicho, para que un operario lo vea después.',
    declarar: () => ({
      type: 'function', name: 'tomar_mensaje',
      description: 'Guardar un mensaje para el titular o para el personal. Usala cuando no hay nadie que atienda '
        + 'o el visitante quiere dejar dicho algo. Confirmale que quedó anotado.',
      parameters: {
        type: 'object',
        properties: {
          mensaje: { type: 'string', description: 'Lo que hay que dejar anotado' },
          unidad: { type: 'string', description: 'Unidad a la que corresponde, si aplica' },
          de_parte_de: { type: 'string', description: 'Quién lo deja' },
        },
        required: ['mensaje'],
      },
    }),
  },
  terminar_llamada: {
    riesgo: 'actua',
    titulo: 'Terminar la llamada',
    ayuda: 'Corta cuando el visitante pide cortar. La despedida la dice la central.',
    declarar: () => ({
      type: 'function', name: 'terminar_llamada',
      description: 'Terminar la llamada cuando el visitante pide cortar («cortá», «podés colgar», «listo, gracias»). '
        + 'Respondé sólo «Perfecto.» y llamá a esta función: de la despedida se encarga el sistema. '
        + '«No me cortes» o «se cortó la luz» NO son pedidos de cortar.',
      parameters: { type: 'object', properties: { motivo: { type: 'string' } } },
    }),
  },
  abrir_porton: {
    riesgo: 'abre',
    titulo: 'Abrir el portón',
    ayuda: 'Abre la puerta. Con candados: verificación previa, ventana horaria, tope por hora y auditoría.',
    declarar: () => ({
      type: 'function', name: 'abrir_porton',
      description: 'Abrir la puerta o el portón al visitante. Usala SÓLO después de identificarlo y de que '
        + 'corresponda dejarlo pasar. Si la función devuelve que no se puede, decí el motivo y ofrecé pasar con una persona; '
        + 'no vuelvas a intentarlo.',
      parameters: {
        type: 'object',
        properties: { motivo: { type: 'string', description: 'A quién se le abre y por qué' } },
        required: ['motivo'],
      },
    }),
  },
};

/** Las declaraciones de las herramientas ENCENDIDAS para un agente. */
function declarar(cfg) {
  const on = cfg || {};
  return Object.keys(CATALOGO)
    .filter((k) => on[k] && on[k].on)
    .map((k) => CATALOGO[k].declarar());
}

/* ── Candados de `abrir_porton` ───────────────────────────────────────────────── */

/** '07:00-22:00' → ¿la hora local del cliente cae adentro? Soporta ventanas que cruzan
 *  la medianoche ('22:00-06:00'), que es el caso de un edificio con portería nocturna. */
function enVentana(ventana, hhmm) {
  const v = String(ventana || VENTANA_DEF).trim();
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return true;                        // ventana mal escrita: no es motivo para no abrir
  const min = (h, mi) => (Number(h) % 24) * 60 + Number(mi);
  const desde = min(m[1], m[2]), hasta = min(m[3], m[4]);
  const p = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm)) || [];
  const ahora = min(p[1] || 0, p[2] || 0);
  return desde <= hasta ? (ahora >= desde && ahora <= hasta) : (ahora >= desde || ahora <= hasta);
}

/* Tope por hora, por agente. En memoria a propósito: si la central se reinicia, el tope se
 * reinicia — y eso es preferible a que un reinicio deje el portón bloqueado. */
const aperturas = new Map();   // agenteId -> [marcas de tiempo]
function contarAperturas(agenteId, ahora) {
  const lista = (aperturas.get(agenteId) || []).filter((t) => ahora - t < 3600000);
  aperturas.set(agenteId, lista);
  return lista.length;
}
function anotarApertura(agenteId, ahora) {
  const lista = aperturas.get(agenteId) || [];
  lista.push(ahora); aperturas.set(agenteId, lista);
}
function _resetTopes() { aperturas.clear(); }   // sólo para las pruebas

/**
 * Ejecuta una herramienta pedida por el modelo.
 *
 * @param {string} nombre
 * @param {object} args     lo que pidió el modelo (dato no confiable: se valida acá)
 * @param {object} ctx
 *   cfg          configuración de herramientas del agente
 *   agenteId     para el tope por hora
 *   ahora        Date (inyectable en las pruebas)
 *   hhmm         hora local del cliente 'HH:MM' (la calcula momento.js)
 *   sesion       { verificada: bool }  — estado de la llamada
 *   leerCrm      (tipo, args) => Promise<{ok, texto, datos}>
 *   transferir   (motivo) => Promise
 *   mensaje      (datos) => Promise
 *   terminar     (motivo) => Promise
 *   abrir        (motivo) => Promise<{ok, detalle}>
 *   auditar      (registro) => void     SIEMPRE se llama en las que actúan
 *   log          (texto) => void
 * @returns {Promise<object>} lo que se le devuelve al modelo. Siempre un objeto con `ok`.
 */
async function ejecutar(nombre, args, ctx) {
  const c = ctx || {};
  const cfg = (c.cfg || {})[nombre] || {};
  const log = c.log || (() => {});
  const ahora = c.ahora ? c.ahora.getTime() : Date.now();
  const a = args && typeof args === 'object' ? args : {};

  if (!CATALOGO[nombre]) return { ok: false, motivo: 'esa herramienta no existe' };
  if (!cfg.on) {
    /* El modelo puede pedir una herramienta apagada: la lista se arma con las encendidas,
     * pero una sesión vieja o un modelo creativo igual la nombran. No es un error: se le
     * contesta que no está disponible y sigue hablando. */
    log('herramienta pedida pero apagada: ' + nombre);
    return { ok: false, motivo: 'esa función no está disponible en esta portería' };
  }

  const auditar = (extra) => {
    if (typeof c.auditar === 'function') {
      try { c.auditar(Object.assign({ herramienta: nombre, args: a, ts: new Date(ahora).toISOString() }, extra)); }
      catch (_) {}
    }
  };

  try {
    switch (nombre) {
      case 'verificar_autorizado': {
        /* La verificación de verdad: contra el CRM de la central, el MISMO que ve el
         * operario. Si validara contra otra tabla, dar de baja a alguien en el CRM no lo
         * sacaría de la puerta. */
        if (typeof c.verificarPersona !== 'function') return { ok: false, motivo: 'la verificación no está disponible' };
        const r = await conTope(c.verificarPersona({ nombre: String(a.nombre || ''), documento: String(a.documento || '') }), TOPE_LECTURA_MS);
        /* La bandera la escribe la central, nunca el modelo: es lo que habilita abrir. */
        if (r && r.ok && c.sesion) { c.sesion.verificada = true; c.sesion.persona = (r.persona && r.persona.name) || ''; }
        auditar({ resultado: r && r.ok ? 'verificado' : 'no verificado', razon: (r && r.razon) || '', motivo: String(a.nombre || '') });
        return r && r.ok
          ? { ok: true, autorizado: true, detalle: r.alModelo }
          : { ok: false, autorizado: false, motivo: (r && r.alModelo) || 'no se pudo verificar' };
      }
      case 'verificar_unidad': {
        const unidad = String(a.unidad || '').trim();
        if (!unidad) return { ok: false, motivo: 'falta el número de unidad' };
        const r = await conTope(c.leerCrm('verificar_unidad', { unidad, nombre: String(a.nombre || '').trim() }), TOPE_LECTURA_MS);
        /* El estado de la sesión lo escribe ACÁ, no el modelo: `abrir_porton` mira esta
         * bandera, así que si la pusiera el modelo el candado no valdría nada. */
        if (r && r.ok && c.sesion) c.sesion.verificada = true;
        return r && r.ok
          ? { ok: true, encontrado: true, detalle: r.texto || '', datos: r.datos || null }
          : { ok: false, encontrado: false, motivo: (r && r.motivo) || 'no se pudo verificar' };
      }
      case 'consultar_datos': {
        const consulta = String(a.consulta || '').trim();
        if (!consulta) return { ok: false, motivo: 'falta la consulta' };
        const r = await conTope(c.leerCrm('consultar_datos', { consulta }), TOPE_LECTURA_MS);
        return r && r.ok ? { ok: true, respuesta: r.texto || '' } : { ok: false, motivo: (r && r.motivo) || 'sin respuesta' };
      }
      case 'transferir_a_agente': {
        const motivo = String(a.motivo || '').slice(0, 200);
        auditar({ resultado: 'transferida', motivo });
        await c.transferir(motivo);
        return { ok: true, detalle: 'la llamada se está transfiriendo' };
      }
      case 'tomar_mensaje': {
        const mensaje = String(a.mensaje || '').trim();
        if (!mensaje) return { ok: false, motivo: 'falta el mensaje' };
        const datos = { mensaje: mensaje.slice(0, 2000), unidad: String(a.unidad || '').slice(0, 40), de_parte_de: String(a.de_parte_de || '').slice(0, 120) };
        await c.mensaje(datos);
        auditar({ resultado: 'mensaje guardado', motivo: datos.unidad });
        return { ok: true, detalle: 'mensaje guardado' };
      }
      case 'terminar_llamada': {
        const motivo = String(a.motivo || '').slice(0, 200);
        auditar({ resultado: 'terminada por pedido', motivo });
        await c.terminar(motivo);
        return { ok: true, detalle: 'la llamada se va a cortar' };
      }
      case 'abrir_porton': {
        const motivo = String(a.motivo || '').slice(0, 300);
        const rechazo = (razon, alModelo) => {
          auditar({ resultado: 'rechazada', razon, motivo });
          log('apertura RECHAZADA: ' + razon);
          return { ok: false, motivo: alModelo };
        };
        /* Los candados, en el orden en que importan. */
        if (cfg.exigir_verificacion !== false && !(c.sesion && c.sesion.verificada)) {
          return rechazo('sin verificación previa en esta llamada',
            'no puedo abrir sin confirmar antes la unidad; pedile los datos o pasá con una persona');
        }
        if (!enVentana(cfg.ventana, c.hhmm)) {
          return rechazo('fuera de la ventana horaria (' + (cfg.ventana || VENTANA_DEF) + ')',
            'a esta hora no puedo abrir; pasá con una persona');
        }
        const tope = Number(cfg.max_por_hora || MAX_HORA_DEF);
        if (contarAperturas(c.agenteId, ahora) >= tope) {
          return rechazo('tope de ' + tope + ' aperturas por hora alcanzado',
            'no puedo abrir en este momento; pasá con una persona');
        }
        const r = await conTope(c.abrir(motivo), 6000);
        if (!r || !r.ok) return rechazo('falló el comando de apertura: ' + ((r && r.detalle) || 'sin detalle'), 'no pude abrir; pasá con una persona');
        anotarApertura(c.agenteId, ahora);
        auditar({ resultado: 'ABIERTO', motivo, detalle: r.detalle || '' });
        log('APERTURA: ' + motivo);
        return { ok: true, detalle: 'la puerta se abrió' };
      }
      default:
        return { ok: false, motivo: 'esa herramienta no existe' };
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    log('herramienta ' + nombre + ' falló: ' + msg);
    auditar({ resultado: 'error', razon: msg });
    /* Al modelo se le dice que falló, NUNCA el detalle técnico: lo lee en voz alta. */
    return { ok: false, motivo: 'no se pudo completar esa acción' };
  }
}

/* Un tope para cualquier promesa: una herramienta lenta no puede dejar la conversación
 * colgada. El visitante está parado en la puerta. */
function conTope(promesa, ms) {
  let t = null;
  const corte = new Promise((_, fail) => { t = setTimeout(() => fail(new Error('tardó más de ' + ms + ' ms')), ms); });
  /* El temporizador se LIMPIA cuando la carrera termina. Sin esto queda un timer vivo por
   * cada consulta —y en un proceso que atiende llamadas todo el día, eso se nota. */
  return Promise.race([Promise.resolve(promesa), corte]).finally(() => { if (t) clearTimeout(t); });
}

module.exports = { CATALOGO, declarar, ejecutar, enVentana, conTope, TOPE_LECTURA_MS, VENTANA_DEF, MAX_HORA_DEF, _resetTopes };
