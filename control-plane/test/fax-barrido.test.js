/* Integración · fax, barrido del spool (fax.js). Va aparte de `fax.test.js` porque necesita
 * el reloj corriendo de verdad (`FAX_TICK_MS` corto) y ahí la cola de salida se pondría a
 * originar llamadas contra un Asterisk que no existe, tapando lo que esa prueba mira.
 *
 * Lo que se verifica es la fuga que encontró el revisor: un fax donde el emisor corta dos
 * segundos antes del CURL final entra por el barrido, y ANTES se le adjudicaba a la caja de
 * la detección de tono — o sea, el fax de la escribanía se le mandaba por correo, con el PDF
 * adjunto, a la contaduría. Ahora la caja sale del nombre del propio archivo y, si no se
 * puede deducir, el fax entra SIN caja y SIN correo. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* El barrido ignora lo que se escribió hace menos de un minuto (para no importar un TIFF que
 * Asterisk está escribiendo en este momento): se envejece el archivo a mano. */
function ponerTiff(dir, nombre) {
  const p = path.join(dir, 'in', nombre);
  fs.writeFileSync(p, Buffer.alloc(2048, 7));
  const antes = new Date(Date.now() - 5 * 60000);
  fs.utimesSync(p, antes, antes);
}

async function esperarFila(ctx, uid, seg = 30) {
  for (let i = 0; i < seg * 10; i++) {
    const { rows } = await ctx.db.query('SELECT * FROM pbxng_fax_in WHERE uniqueid=$1', [uid]);
    if (rows[0]) return rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

test('fax: el barrido del spool no le manda el documento a la caja equivocada', async (t) => {
  const faxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-faxb-'));
  const ctx = await entorno(t, { FAX_DIR: faxDir, FAX_DIR_AST: '/var/spool/asterisk/monitor/fax', FAX_TICK_MS: '5000' });
  if (!ctx) return;
  t.after(() => { ctx.cerrar(); try { fs.rmSync(faxDir, { recursive: true, force: true }); } catch (_) {} });
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  const contaduria = (await api('POST', '/api/fax/boxes', { token: admin, body: { nombre: 'Contaduría', email: 'contaduria@ejemplo.test' } })).json;
  const escribania = (await api('POST', '/api/fax/boxes', { token: admin, body: { nombre: 'Escribanía', email: 'escribania@ejemplo.test' } })).json;
  // El escenario del revisor: la detección de tono apunta a Contaduría.
  assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { detect: true, detect_box: contaduria.id } })).status, 200);

  await t.test('el huérfano va a la caja por la que entró, no a la de la detección', async () => {
    const uid = '1757900000.11';
    ponerTiff(faxDir, escribania.id + '-' + uid + '.tif');
    const fila = await esperarFila(ctx, uid);
    assert.ok(fila, 'el fax huérfano se tiene que importar igual');
    assert.equal(fila.box_id, escribania.id, 'es un fax de la Escribanía: no puede quedar en Contaduría');
    assert.equal(fila.email_to, 'escribania@ejemplo.test');
  });

  await t.test('si no se puede saber la caja: sin caja, sin correo y avisado en la bandeja', async () => {
    const uid = '1757900000.12';
    ponerTiff(faxDir, uid + '.tif');                     // nombre viejo, sin caja adelante
    const fila = await esperarFila(ctx, uid);
    assert.ok(fila, 'se importa igual: el documento no se pierde');
    assert.equal(fila.box_id, null);
    assert.equal(fila.email_to, null, 'adivinar el destinatario de un documento es la fuga que se está arreglando');
    assert.equal(fila.email_ok, false);
    assert.ok(/caja/i.test(fila.email_err || ''), 'la bandeja tiene que decir por qué no salió el correo: ' + fila.email_err);
  });

  await t.test('una caja borrada tampoco hace que el fax caiga en otra', async () => {
    const otra = (await api('POST', '/api/fax/boxes', { token: admin, body: { nombre: 'Temporal' } })).json;
    assert.equal((await api('DELETE', '/api/fax/boxes/' + otra.id, { token: admin })).status, 200);
    const uid = '1757900000.13';
    ponerTiff(faxDir, otra.id + '-' + uid + '.tif');
    const fila = await esperarFila(ctx, uid);
    assert.ok(fila);
    assert.equal(fila.box_id, null);
    assert.equal(fila.email_to, null);
  });
});
