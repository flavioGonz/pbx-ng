/* ============================================================================
 *  PBX-NG · Un AMI de Asterisk de mentira, para las pruebas de integración.
 *
 *  apiEfimera() apunta el AMI a un puerto cerrado: la API arranca igual, pero todo lo
 *  que depende de Asterisk se queda en el camino de «AMI no conectado». Con esto la API
 *  tiene un AMI de verdad del otro lado del socket —el mismo protocolo de texto que
 *  habla Asterisk— y cada prueba decide qué contesta y qué eventos le llegan.
 *
 *  Uso:
 *    const ami = await amiFalso();
 *    ctx = await entorno(t, ami.env);          // AMI_HOST/AMI_PORT apuntando acá
 *    ami.comando(/^core show version/, 'Asterisk 22.1.0 built by …');
 *    ami.accion('QueuePause', { Response: 'Success' });
 *    ami.lista('ConfbridgeList', [{ Event: 'ConfbridgeList', … }], 'ConfbridgeListComplete');
 *    await ami.conectado();                    // espera el Login de la API
 *    ami.emitir({ Event: 'DialBegin', DestChannel: 'PJSIP/2001-0001', … });
 *    ami.pedidos('QueuePause')                 // lo que la API mandó
 * ==========================================================================*/
'use strict';
const net = require('net');

async function amiFalso() {
  const conexiones = new Set();
  const recibidos = [];
  const comandos = [];       // [{ re, salida }]
  const acciones = new Map(); // nombre (minúsculas) → respuesta (objeto o función)
  const listas = new Map();   // nombre → { filas, fin }
  let esperandoLogin = [];

  const linea = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n';
  const mandar = (sock, o) => { try { sock.write(linea(o)); } catch (_) {} };

  function responder(sock, msg) {
    const accion = String(msg.action || '').toLowerCase();
    const id = msg.actionid;
    recibidos.push(msg);
    if (accion === 'login') {
      sock.autenticado = true;
      mandar(sock, { Response: 'Success', ActionID: id, Message: 'Authentication accepted' });
      const w = esperandoLogin; esperandoLogin = [];
      for (const f of w) f();
      return;
    }
    if (accion === 'command') {
      const cmd = String(msg.command || '');
      const regla = comandos.find((c) => c.re.test(cmd));
      const salida = regla ? (typeof regla.salida === 'function' ? regla.salida(cmd) : regla.salida) : '';
      /* Asterisk 22 contesta el Command con una línea `Output:` por renglón. */
      const lineas = String(salida).split('\n');
      const r = ['Response: Success', 'ActionID: ' + id, 'Message: Command output follows'];
      for (const l of lineas) r.push('Output: ' + l);
      try { sock.write(r.join('\r\n') + '\r\n\r\n'); } catch (_) {}
      return;
    }
    if (listas.has(accion)) {
      const { filas, fin } = listas.get(accion);
      mandar(sock, { Response: 'Success', ActionID: id, EventList: 'start', Message: 'lista' });
      for (const f of filas) mandar(sock, Object.assign({}, f, { ActionID: id }));
      mandar(sock, { Event: fin, ActionID: id, EventList: 'Complete', ListItems: filas.length });
      return;
    }
    let r = acciones.get(accion);
    if (typeof r === 'function') r = r(msg);
    r = r || { Response: 'Success', Message: 'ok' };
    mandar(sock, Object.assign({}, r, { ActionID: id }));
  }

  const server = net.createServer((sock) => {
    conexiones.add(sock);
    sock.setEncoding('utf8');
    sock.on('close', () => conexiones.delete(sock));
    sock.on('error', () => {});
    try { sock.write('Asterisk Call Manager/9.0.0\r\n'); } catch (_) {}
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
        const bloque = buf.slice(0, i); buf = buf.slice(i + 4);
        const msg = {};
        for (const l of bloque.split('\r\n')) {
          const j = l.indexOf(':'); if (j < 0) continue;
          msg[l.slice(0, j).trim().toLowerCase()] = l.slice(j + 1).trim();
        }
        if (msg.action) responder(sock, msg);
      }
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;

  return {
    port,
    env: { AMI_HOST: '127.0.0.1', AMI_PORT: String(port) },
    /* Respuesta a un `Command` cuyo texto coincide. La última regla agregada gana. */
    comando(re, salida) { comandos.unshift({ re, salida }); },
    accion(nombre, respuesta) { acciones.set(String(nombre).toLowerCase(), respuesta); },
    lista(nombre, filas, fin) { listas.set(String(nombre).toLowerCase(), { filas, fin }); },
    emitir(evento) { for (const s of conexiones) if (s.autenticado) mandar(s, evento); },
    pedidos(nombre) { return nombre ? recibidos.filter((m) => String(m.action).toLowerCase() === String(nombre).toLowerCase()) : recibidos.slice(); },
    olvidar() { recibidos.length = 0; },
    /* Espera a que la API haga Login (o devuelve enseguida si ya lo hizo). */
    conectado(ms = 15000) {
      if ([...conexiones].some((s) => s.autenticado)) return Promise.resolve();
      return new Promise((ok, mal) => {
        const t = setTimeout(() => mal(new Error('la API no se conectó al AMI falso en ' + ms + ' ms')), ms);
        esperandoLogin.push(() => { clearTimeout(t); ok(); });
      });
    },
    /* Corta las conexiones (simula a Asterisk que se reinicia). */
    cortar() { for (const s of conexiones) s.destroy(); },
    cerrar() { for (const s of conexiones) s.destroy(); return new Promise((ok) => server.close(ok)); },
  };
}

module.exports = { amiFalso };
