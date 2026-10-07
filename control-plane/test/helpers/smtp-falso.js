/* ============================================================================
 *  PBX-NG · Un servidor de correo de mentira para las pruebas.
 *
 *  Las alertas, la prueba de SMTP del panel, las invitaciones a una sala y el informe
 *  programado mandan correo con nodemailer. Esto habla el SMTP justo que nodemailer
 *  necesita (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT) y guarda cada mensaje,
 *  así la prueba puede mirar a quién fue y qué decía. `rechazar` hace que el próximo
 *  AUTH falle con el 535 de Gmail, para el camino de «contraseña de aplicación».
 * ==========================================================================*/
'use strict';
const net = require('net');

async function smtpFalso() {
  const mensajes = [];
  let rechazarAuth = false;
  const server = net.createServer((s) => {
    s.setEncoding('utf8');
    s.on('error', () => {});
    let buf = '', enData = false, actual = null, esperandoLogin = 0;
    const w = (l) => { try { s.write(l + '\r\n'); } catch (_) {} };
    w('220 smtp-falso listo');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (enData) {
          if (l === '.') { enData = false; mensajes.push(actual); actual = null; w('250 ok: encolado'); }
          else actual.data += (l.startsWith('..') ? l.slice(1) : l) + '\n';
          continue;
        }
        if (esperandoLogin) {
          esperandoLogin--;
          if (esperandoLogin) { w('334 UGFzc3dvcmQ6'); continue; }
          if (rechazarAuth) { rechazarAuth = false; w('535 5.7.8 Username and Password not accepted'); } else w('235 ok');
          continue;
        }
        const cmd = l.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') { w('250-smtp-falso'); w('250-AUTH PLAIN LOGIN'); w('250 8BITMIME'); }
        else if (cmd === 'AUTH') {
          if (/LOGIN/i.test(l)) { esperandoLogin = 2; w('334 VXNlcm5hbWU6'); }
          else if (rechazarAuth) { rechazarAuth = false; w('535 5.7.8 Username and Password not accepted'); }
          else w('235 ok');
        }
        else if (cmd === 'MAIL') { actual = { from: (/<([^>]*)>/.exec(l) || [])[1] || '', to: [], data: '' }; w('250 ok'); }
        else if (cmd === 'RCPT') { actual.to.push((/<([^>]*)>/.exec(l) || [])[1] || ''); w('250 ok'); }
        else if (cmd === 'DATA') { enData = true; w('354 seguí'); }
        else if (cmd === 'QUIT') { w('221 chau'); s.end(); }
        else if (cmd === 'RSET' || cmd === 'NOOP') w('250 ok');
        else w('502 no implementado');
      }
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  return {
    host: '127.0.0.1', port, mensajes,
    rechazar() { rechazarAuth = true; },
    olvidar() { mensajes.length = 0; },
    async esperar(n = 1, ms = 5000) {
      const fin = Date.now() + ms;
      while (mensajes.length < n && Date.now() < fin) await new Promise((r) => setTimeout(r, 50));
      return mensajes;
    },
    cerrar() { return new Promise((ok) => server.close(ok)); },
  };
}

module.exports = { smtpFalso };
