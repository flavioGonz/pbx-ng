// PBX-NG Softphone · go2rtc propio, adentro de la app
//
// QUE PROBLEMA RESUELVE. Las camaras que el usuario carga a mano en el softphone quedan
// guardadas como una URL `rtsp://`, y Chromium no reproduce RTSP. Hasta ahora esas camaras
// se podian anotar y no mirar: la unica forma de verlas era subirlas a la central, que es
// la que tiene go2rtc. Un tecnico con el softphone en la obra y la URL del portero en la
// mano no tiene central a mano — y muchas veces no tiene ni red hacia ella.
//
// COMO. La app trae su propio go2rtc (un binario estatico, el MISMO motor que corre en la
// central) y lo levanta en 127.0.0.1 cuando hace falta. A partir de ahi el camino es
// IDENTICO al de una camara de la central: el proxy WebSocket del main (`go2rtc-open`),
// MSE en el renderer, el mismo visor. No hay un segundo reproductor que mantener.
//
// DECISIONES QUE NO SE VEN EN EL CODIGO FELIZ:
//
//  - Se levanta POR DEMANDA, no al arrancar. La inmensa mayoria de los usos del softphone
//    no tocan una camara local: arrancar un proceso hijo y dejarlo corriendo para nada
//    cuesta memoria y es un puerto abierto mas, aunque sea en loopback.
//  - PUERTO EFIMERO, pedido al sistema. Fijar el 1984 —el de go2rtc— choca con un go2rtc
//    que el usuario ya tenga corriendo en su maquina, o con una segunda instancia del
//    softphone. El sistema sabe cual esta libre; nosotros no.
//  - SOLO 127.0.0.1. Un go2rtc escuchando en 0.0.0.0 publica en la red de la oficina, sin
//    autenticacion, las camaras del cliente —con sus credenciales adentro de la URL—. Eso
//    no es un detalle de configuracion, es el punto en el que esto pasa de util a peligro.
//  - La configuracion se reescribe y el proceso se reinicia cuando CAMBIA la lista. go2rtc
//    no recarga el archivo solo, y mandarle `restart` por API es mas fragil que levantarlo
//    de nuevo: tarda menos de un segundo.
//  - Si el binario no esta, se dice. No se intenta bajarlo en caliente: una app de
//    escritorio que sale a buscar un ejecutable a internet y lo corre es exactamente la
//    forma de un troyano, y el usuario no tiene como distinguirlo.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

/* Donde vive el binario. Empaquetado va en resources/go2rtc/ (extraResources de
 * electron-builder); en desarrollo, en softphone-app/vendor/go2rtc/. */
function rutaBinario(app) {
  const exe = process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc';
  const candidatos = app.isPackaged
    ? [path.join(process.resourcesPath, 'go2rtc', exe)]
    : [path.join(__dirname, '..', 'vendor', 'go2rtc', exe), path.join(__dirname, '..', '..', 'vendor', 'go2rtc', exe)];
  for (const c of candidatos) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

/* Un puerto libre de verdad: se abre, se lee cual dio el sistema y se cierra. Hay una
 * ventana minima entre cerrar y que go2rtc lo tome; en loopback y en una maquina de
 * escritorio es despreciable, y la alternativa (adivinar) es peor. */
function puertoLibre() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

module.exports = function initGo2rtcLocal(deps) {
  const { app, log } = deps;
  const decir = log || (() => {});
  let proc = null, puerto = 0, firma = '', arrancando = null;

  const dir = () => path.join(app.getPath('userData'), 'go2rtc');
  const cfgPath = () => path.join(dir(), 'go2rtc.yaml');

  /* La firma es la lista de camaras: si no cambio, el proceso que ya corre sirve. */
  const firmaDe = (cams) => (cams || []).map((c) => c.id + '=' + c.rtsp).sort().join('|');

  /* YAML a mano y no una dependencia: son tres claves y un mapa de strings. Las URL van
   * entre comillas simples con las internas duplicadas — una contrasena con `:` o `#`
   * adentro rompe el YAML sin comillas, y una con apostrofo rompe el escape naive. */
  function escribirConfig(cams, p) {
    const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
    const lineas = [
      '# Generado por el softphone PBX-NG. No editar a mano: se reescribe.',
      'api:',
      "  listen: '127.0.0.1:" + p + "'",
      /* Sin origen permitido: al WebSocket lo abre el proceso main, que no manda Origin. */
      '  origin: ',
      'rtsp:',
      "  listen: ''",        // no se publica RTSP de salida: nadie lo consume
      'webrtc:',
      "  listen: ''",        // ni WebRTC: el visor usa MSE por el WebSocket
      'log:',
      "  level: 'warn'",
      'streams:',
    ];
    for (const c of cams || []) lineas.push('  ' + c.id + ': ' + q(c.rtsp));
    fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
    fs.writeFileSync(cfgPath(), lineas.join('\n') + '\n', { mode: 0o600 });
  }

  function matar() {
    if (!proc) return;
    const p = proc; proc = null; puerto = 0; firma = '';
    try { p.kill(); } catch (_) {}
    /* Si no se murio solo en 3 s, SIGKILL. Un go2rtc huerfano sigue tirandole RTSP a las
     * camaras del cliente despues de cerrar la app. */
    setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 3000).unref();
  }

  /* ¿Contesta? go2rtc tarda unas decimas en abrir el puerto. */
  function esperarApi(p, ms) {
    const hasta = Date.now() + (ms || 6000);
    return new Promise((res) => {
      const probar = () => {
        const s = net.connect({ host: '127.0.0.1', port: p }, () => { s.destroy(); res(true); });
        s.on('error', () => { s.destroy(); if (Date.now() > hasta) return res(false); setTimeout(probar, 150); });
      };
      probar();
    });
  }

  /**
   * Deja corriendo un go2rtc con estas camaras y devuelve dónde mirarlas.
   * @param {Array<{id:string,rtsp:string}>} cams
   * @returns {Promise<{ok:boolean, base?:string, motivo?:string}>}
   */
  async function asegurar(cams) {
    const lista = (cams || []).filter((c) => c && c.id && c.rtsp);
    if (!lista.length) return { ok: false, motivo: 'no hay cámaras locales que mostrar' };

    const bin = rutaBinario(app);
    if (!bin) {
      return { ok: false, motivo: 'esta versión del softphone no trae el motor de video (go2rtc). Subí la cámara a la central para verla.' };
    }
    const f = firmaDe(lista);
    if (proc && puerto && f === firma) return { ok: true, base: 'http://127.0.0.1:' + puerto };
    if (arrancando) { try { await arrancando; } catch (_) {} if (proc && puerto && firmaDe(lista) === firma) return { ok: true, base: 'http://127.0.0.1:' + puerto }; }

    arrancando = (async () => {
      matar();
      const p = await puertoLibre();
      escribirConfig(lista, p);
      /* `-c` con el archivo y `-d` nunca: el modo daemon de go2rtc se desprende del
       * proceso padre y entonces cerrar la app lo dejaria vivo. */
      const hijo = spawn(bin, ['-c', cfgPath()], {
        cwd: dir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      hijo.on('error', (e) => decir({ err: e && e.message }, 'go2rtc local: no se pudo ejecutar'));
      hijo.on('exit', (code, sig) => {
        if (proc === hijo) { proc = null; puerto = 0; firma = ''; }
        decir({ code, sig }, 'go2rtc local: termino');
      });
      /* El stderr de go2rtc sólo al log de la app, nunca a la pantalla: trae las URL de las
       * cámaras con sus credenciales adentro. */
      const sorber = (s) => { if (!s) return; s.on('data', (b) => decir({ linea: String(b).trim().slice(0, 300) }, 'go2rtc local')); };
      sorber(hijo.stderr); sorber(hijo.stdout);

      if (!(await esperarApi(p, 8000))) {
        try { hijo.kill(); } catch (_) {}
        throw new Error('go2rtc no abrió su puerto');
      }
      proc = hijo; puerto = p; firma = firmaDe(lista);
      decir({ puerto: p, camaras: lista.length }, 'go2rtc local arriba');
    })();

    try { await arrancando; return { ok: true, base: 'http://127.0.0.1:' + puerto }; }
    catch (e) { return { ok: false, motivo: (e && e.message) || 'no se pudo levantar el motor de video' }; }
    finally { arrancando = null; }
  }

  function estado() {
    return { disponible: !!rutaBinario(app), corriendo: !!proc, base: puerto ? 'http://127.0.0.1:' + puerto : null };
  }

  return { asegurar, estado, parar: matar };
};
