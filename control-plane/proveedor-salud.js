'use strict';
/* ============================================================================
 *  PBX-NG · ¿La cuenta del proveedor puede atender una llamada AHORA?
 *
 *  POR QUÉ NO ES «LEER EL SALDO»: OpenAI no publica una API para consultar el crédito
 *  restante. Y aunque la publicara, el saldo no es la pregunta: la pregunta es si una
 *  llamada que entra en este momento va a poder atenderse. Una cuenta con saldo pero con
 *  la clave rotada, o con el modelo retirado, tampoco atiende.
 *
 *  Así que en vez de preguntar cuánto queda, se PRUEBA: una petición mínima, de un token,
 *  cada tanto. Cuesta una fracción de centavo —y cuando no hay crédito no cuesta nada,
 *  porque falla antes de generar— y contesta la pregunta de verdad.
 *
 *  El orden de los dos chequeos importa:
 *    1. listar modelos → dice si la CLAVE sirve (no gasta);
 *    2. una generación de 1 token → dice si hay CRÉDITO (la lista de modelos responde
 *       igual con la cuenta vacía, así que sin este paso el panel mostraría «todo bien»
 *       hasta que alguien llame).
 *
 *  Esto nació de una llamada real: la cuenta se quedó sin créditos y la única forma de
 *  enterarse fue marcar el interno y escuchar «no puedo atenderte».
 * ==========================================================================*/

const TOPE_MS = 8000;

/* La traducción de un error del proveedor a algo accionable. El orden importa: «insufficient
 * quota» también trae un 429, y lo que hay que decir es «sin saldo», no «probá más tarde». */
const CLASES = [
  { estado: 'sin_saldo', re: /no credits|insufficient[_ ]quota|exceeded your current quota|billing/i,
    que: 'La cuenta del proveedor no tiene crédito.',
    arreglo: 'Cargá saldo en platform.openai.com. Mientras tanto ninguna llamada con IA se puede atender.' },
  { estado: 'clave', re: /invalid[_ ]api[_ ]key|incorrect api key|unauthorized|\b401\b|\b403\b/i,
    que: 'El proveedor rechazó la clave.',
    arreglo: 'Revisá la clave en IA & Voz → Nube. Si la rotaste, hay que volver a cargarla.' },
  { estado: 'modelo', re: /does not exist|do not have access|\b404\b/i,
    que: 'El modelo configurado no existe para esta cuenta.',
    arreglo: 'Elegí uno de la lista en el agente, pestaña Cerebro.' },
  { estado: 'limite', re: /rate limit|\b429\b/i,
    que: 'El proveedor está limitando las llamadas.',
    arreglo: 'Suele ser temporal. Si se repite, mirá el plan de la cuenta.' },
];

function clasificar(texto) {
  const t = String(texto || '');
  const c = CLASES.find((x) => x.re.test(t));
  return c
    ? { estado: c.estado, que: c.que, arreglo: c.arreglo, detalle: t.slice(0, 300) }
    : { estado: 'error', que: 'No se pudo consultar al proveedor.', arreglo: 'Puede ser la red de la central o un problema del proveedor.', detalle: t.slice(0, 300) };
}

/* El modelo más barato que la cuenta tenga, para gastar lo mínimo en el chequeo. */
function modeloBarato(ids) {
  const lista = (ids || []).filter((x) => /^gpt-/.test(x) && !/realtime|live|audio|tts|transcribe|image|embed/.test(x));
  return lista.find((x) => /nano/.test(x)) || lista.find((x) => /mini/.test(x)) || lista[0] || null;
}

/**
 * Prueba la cuenta. Devuelve siempre un objeto con `estado`:
 *   'ok' | 'sin_clave' | 'sin_saldo' | 'clave' | 'modelo' | 'limite' | 'error'
 *
 * @param {object} o  { key, fetch?, modelo? }
 */
async function revisar(o) {
  const cfg = o || {};
  const traer = cfg.fetch || fetch;
  if (!cfg.key) {
    return { estado: 'sin_clave', que: 'No hay clave del proveedor cargada.',
      arreglo: 'Cargala en IA & Voz → Nube. Sin clave los agentes atienden en modo demo.', ts: new Date().toISOString() };
  }
  const cabeceras = { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' };
  const sello = () => new Date().toISOString();

  /* 1. ¿Sirve la clave? Listar modelos no gasta nada. */
  let ids = [];
  try {
    const r = await traer('https://api.openai.com/v1/models', { headers: cabeceras, signal: AbortSignal.timeout(TOPE_MS) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return Object.assign(clasificar((j && j.error && j.error.message) || ('HTTP ' + r.status)), { ts: sello() });
    ids = (j.data || []).map((x) => String(x.id));
  } catch (e) {
    return Object.assign(clasificar((e && e.message) || e), { ts: sello() });
  }

  /* 2. ¿Hay crédito? La lista de modelos responde IGUAL con la cuenta vacía: sin este
   * segundo paso el panel diría «todo bien» hasta que alguien llame. */
  const modelo = cfg.modelo || modeloBarato(ids);
  if (!modelo) {
    return { estado: 'modelo', que: 'La cuenta no lista ningún modelo utilizable.',
      arreglo: 'Revisá el acceso a modelos en el panel de OpenAI.', ts: sello(), modelos: ids.length };
  }
  try {
    const r = await traer('https://api.openai.com/v1/responses', {
      method: 'POST', headers: cabeceras,
      body: JSON.stringify({ model: modelo, input: 'ok', max_output_tokens: 16 }),
      signal: AbortSignal.timeout(TOPE_MS),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return Object.assign(clasificar((j && j.error && j.error.message) || ('HTTP ' + r.status)), { ts: sello(), modelos: ids.length });
  } catch (e) {
    return Object.assign(clasificar((e && e.message) || e), { ts: sello(), modelos: ids.length });
  }

  return { estado: 'ok', que: 'La cuenta puede atender llamadas.', arreglo: '', ts: sello(), modelos: ids.length, probado_con: modelo };
}

module.exports = { revisar, clasificar, modeloBarato, CLASES, TOPE_MS };
