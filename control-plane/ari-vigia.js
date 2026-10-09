/* Vigía de la conexión ARI.
 *
 * Por qué: el WebSocket de eventos del ARI puede quedar medio abierto (un corte de la
 * red de Docker, la máquina que se durmió) sin que ari-client emita WebSocketClose ni
 * WebSocketError. La API seguía creyendo que estaba conectada, pero Asterisk ya no
 * tenía la app registrada: cada llamada a un agente de IA entraba a Stasis y Asterisk
 * la cortaba con "Stasis app 'pbxng' doesn't exist", hasta reiniciar la API. Pasó en
 * desarrollo el 2026-10-04, con la conexión muerta desde el 02/10 y el log diciendo
 * "ok".
 *
 * Cada `cadaMs` se le pregunta a Asterisk por REST si la app sigue registrada
 * (GET /ari/applications/<app>). Un 404 es la prueba de que la conexión se perdió: se
 * avisa una sola vez (`alPerder`) y el vigía se apaga; reconectar es de quien lo creó.
 * Un error de red no dispara nada: si Asterisk se cayó de verdad, el WebSocket lo
 * avisa, y si vuelve sin la app, el próximo chequeo lo ve. */
'use strict';

/** Arranca el vigía. Devuelve `comprobar` (un chequeo, para las pruebas) y `parar`. */
function vigilarAri({ url, user, pass, app, cadaMs = 30000, alPerder, fetchImpl = fetch, log = () => {} }) {
  const destino = url.replace(/\/+$/, '') + '/ari/applications/' + encodeURIComponent(app);
  const headers = { Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') };
  let parado = false;
  // Un aviso por racha de errores de red, no uno cada `cadaMs` mientras dure.
  let avisado = false;

  async function comprobar() {
    if (parado) return 'parado';
    let status;
    try {
      status = (await fetchImpl(destino, { headers, signal: AbortSignal.timeout(3000) })).status;
    } catch (e) {
      if (!avisado) log('no se pudo comprobar la app ' + app + ' en la central (' + ((e && e.message) || e) + ')');
      avisado = true;
      return 'sin-respuesta';
    }
    avisado = false;
    if (parado) return 'parado';
    if (status !== 404) return 'ok';
    parar();
    alPerder();
    return 'perdida';
  }

  const timer = setInterval(() => { comprobar().catch(() => {}); }, cadaMs);
  // No mantiene vivo el proceso: el cierre ordenado de la API no lo espera.
  if (timer && timer.unref) timer.unref();
  function parar() { parado = true; clearInterval(timer); }
  return { comprobar, parar };
}

module.exports = { vigilarAri };
