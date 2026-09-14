/* Integración · fax (fax.js): cajas, dialplan de recepción y envío, ruta entrante marcada
 * como fax, cola de salida y el aviso que manda el dialplan. Sin Postgres se saltea.
 *
 * Asterisk NO está (el Originate falla y se ignora) y ghostscript puede no estar instalado
 * en la máquina que corre las pruebas: lo que se verifica es lo que NO depende de ninguno
 * de los dos —las filas, el dialplan realtime, los permisos y, sobre todo, que nada de lo
 * que escribe un usuario termine crudo adentro del dialplan ni de un nombre de archivo—.
 * La única parte que necesita ghostscript (convertir el PDF) se comprueba sólo si está. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const filas = (ctx, contexto, exten) => ctx.db.query(
  'SELECT priority, app, appdata FROM extensions WHERE context=$1 AND exten=$2 ORDER BY priority', [contexto, exten]).then((r) => r.rows);
const texto = (fs2) => fs2.map((x) => x.app + '|' + x.appdata).join('\n');

/* Un PDF mínimo pero de verdad (una página vacía): sirve para las dos cosas que importan
 * acá, que la firma `%PDF-` y el `%%EOF` pasen la validación y que ghostscript lo pueda
 * convertir cuando está instalado. */
const PDF_OK = Buffer.from(
  '%PDF-1.4\n'
  + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

test('fax: cajas, dialplan, ruta entrante, cola de envío y permisos', async (t) => {
  const faxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-fax-'));
  const ctx = await entorno(t, { FAX_DIR: faxDir, FAX_DIR_AST: '/var/spool/asterisk/monitor/fax', FAX_TICK_MS: '600000' });
  if (!ctx) return;
  t.after(() => { ctx.cerrar(); try { fs.rmSync(faxDir, { recursive: true, force: true }); } catch (_) {} });
  const { api, login, base } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  const tok = fs.readFileSync(path.join(ctx.api.confDir, 'agent.token'), 'utf8').trim();

  /* Subida del PDF: el cuerpo va CRUDO (Content-Type: application/pdf), así que no se puede
   * usar el ayudante `api()` del entorno, que fuerza JSON. */
  async function subir(qs, body, tipo, token) {
    const r = await fetch(base + '/api/fax/out' + qs, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (token || admin), 'Content-Type': tipo || 'application/pdf' },
      body,
    });
    const txt = await r.text();
    let json;
    try { json = txt ? JSON.parse(txt) : null; } catch (_) { json = { _raw: txt }; }
    return { status: r.status, json };
  }

  await t.test('estado: dice qué falta en vez de fallar en medio de una llamada', async () => {
    const r = await api('GET', '/api/fax/estado', { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(typeof r.json.herramientas.ghostscript, 'boolean');
    assert.equal(r.json.spool.escribible, true);
    // El tope duro protege la memoria de la central aunque alguien edite la configuración.
    assert.ok(r.json.limites.max_mb <= r.json.limites.max_mb_duro);
  });

  /* El arranque de la API era lo ÚNICO que escribía dialplan sin que nadie lo pidiera, y lo
   * hacía siempre: en una central sin una sola caja de fax igual borraba `fax-rx-%`, `fax` y
   * `fax-tx` y los volvía a insertar en cada arranque, sobre la tabla realtime que Asterisk
   * consulta en CADA llamada. */
  await t.test('sin fax configurado no se escribe dialplan de fax', async () => {
    for (const [ctxt, ex] of [['internal', 'fax-tx'], ['from-trunk', 'fax']]) {
      assert.equal((await filas(ctx, ctxt, ex)).length, 0, ctxt + '/' + ex + ' no tiene por qué existir sin fax');
    }
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='from-trunk' AND exten LIKE 'fax-rx-%'")).rows.length, 0);
    /* Y guardar la configuración tampoco lo publica mientras no haya ni una caja ni un envío:
     * `fax-tx` vive en el contexto COMPARTIDO `internal`, así que en una central sin fax ese
     * número no es de nadie y tiene que quedar libre para quien lo quiera. */
    assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { station_id: '24875000' } })).status, 200);
    assert.equal((await filas(ctx, 'internal', 'fax-tx')).length, 0, 'sin cajas ni envíos, fax-tx no se publica');
  });

  let caja = 0;
  await t.test('caja de fax: alta, saneo de lo que va al dialplan y ReceiveFAX', async () => {
    assert.equal((await api('POST', '/api/fax/boxes', { token: admin, body: { nombre: '' } })).status, 400);
    assert.equal((await api('POST', '/api/fax/boxes', { token: admin, body: { nombre: 'X', email: 'esto-no-es-un-mail' } })).status, 400);

    const r = await api('POST', '/api/fax/boxes', {
      token: admin,
      // El CSID va crudo dentro de un Set(FAXOPT(localstationid)=…): una coma abre otro
      // argumento y un ${...} expande variables del canal. Tiene que salir limpio.
      body: { nombre: 'Contaduría', email: 'fax@ejemplo.test, otro@ejemplo.test', station_id: '24875000,${CALLERID(num)}' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    caja = r.json.id;
    assert.equal(r.json.station_id.includes(','), false, 'el CSID sale sin comas: ' + r.json.station_id);
    assert.equal(r.json.station_id.includes('$'), false);

    const dp = await filas(ctx, 'from-trunk', 'fax-rx-' + caja);
    const todo = texto(dp);
    assert.ok(/ReceiveFAX\|/.test(todo), todo);
    /* El nombre lleva la CAJA además del UNIQUEID: es lo único que le queda al barrido para
     * saber a quién era el fax cuando la llamada se cortó antes del aviso. */
    assert.ok(todo.includes('/in/' + caja + '-${UNIQUEID}.tif'), 'el TIFF se nombra con la caja y el UNIQUEID: ' + todo);
    // f = respaldo en audio, z = pedir T.38: el mismo dialplan sirve con y sin SBC adelante.
    assert.ok(/ReceiveFAX\|[^\n]*,fz$/m.test(todo), todo);
    assert.ok(/CURL\([^)]*\/api\/internal\/fax/.test(todo), 'tiene que avisar cómo salió: ' + todo);
    assert.ok(!/\$\{CALLERID\(num\)\}\}/.test(todo));
    // La extensión de envío vive en `internal` y no hace nada sin FAXJOB.
    const tx = texto(await filas(ctx, 'internal', 'fax-tx'));
    assert.ok(/SendFAX\|/.test(tx), tx);
    assert.ok(/GotoIf\|\$\["\$\{FAXJOB\}" = ""/.test(tx), 'sin trabajo no hace nada: ' + tx);
  });

  await t.test('ruta entrante marcada como fax', async () => {
    assert.equal((await api('POST', '/api/routes/inbound', { token: admin, body: { did: '24875001', dest_type: 'fax', dest_value: 'la-de-arriba' } })).status, 400);
    const r = await api('POST', '/api/routes/inbound', { token: admin, body: { did: '24875001', name: 'Fax', dest_type: 'fax', dest_value: String(caja) } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const dp = texto(await filas(ctx, 'from-trunk', '24875001'));
    assert.ok(dp.includes('Goto|from-trunk,fax-rx-' + caja + ',1'), dp);
    // Con una ruta apuntándole, borrar la caja dejaría el DID mandando llamadas a la nada.
    assert.equal((await api('DELETE', '/api/fax/boxes/' + caja, { token: admin })).status, 409);
  });

  await t.test('detección de tono: sólo con una caja elegida y de verdad existente', async () => {
    assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { detect: true, detect_box: 99999 } })).status, 400);
    let r = await api('PUT', '/api/fax/config', { token: admin, body: { detect: true, detect_box: caja, station_id: '24875000' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(texto(await filas(ctx, 'from-trunk', 'fax')).includes('fax-rx-' + caja), 'la extensión `fax` es a donde manda chan_pjsip al detectar el CNG');
    r = await api('PUT', '/api/fax/config', { token: admin, body: { detect: false } });
    assert.equal(r.status, 200);
    assert.equal((await filas(ctx, 'from-trunk', 'fax')).length, 0, 'apagada no deja dialplan colgado');
    assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { t38_ec: 'cualquiera' } })).status, 400);
  });

  await t.test('envío: el PDF se valida ANTES de tocar nada', async () => {
    // Un destino con `*` es el fraude de tarifación de siempre (ver telefonia.js).
    assert.equal((await subir('?numero=*21*099123456', PDF_OK)).status, 400);
    assert.equal((await subir('?numero=', PDF_OK)).status, 400);
    // Sin Content-Type de PDF no hay cuerpo que valga.
    assert.equal((await subir('?numero=099123456', 'hola', 'text/plain')).status, 415);
    // Firma y final del archivo: un .exe renombrado no llega ni a ghostscript.
    assert.equal((await subir('?numero=099123456', Buffer.from('MZ  esto no es un pdf'))).status, 415);
    assert.equal((await subir('?numero=099123456', Buffer.from('%PDF-1.4\nsin fin de archivo'))).status, 415);
  });

  let job = 0;
  await t.test('cola de envío: encolar, reintentar y cancelar', async () => {
    const r = await subir('?numero=099123456&nombre=Estudio&asunto=Factura', PDF_OK);
    if (r.status === 503) {
      // Sin ghostscript en esta máquina no se puede convertir: es exactamente lo que tiene
      // que contestar (y lo que el panel muestra en rojo). El resto se prueba a mano.
      assert.ok(/ghostscript/i.test(r.json.error), JSON.stringify(r.json));
      const { rows } = await ctx.db.query(
        "INSERT INTO pbxng_fax_out (numero,archivo,tiff,paginas,bytes,max_intentos) VALUES ('099123456','x.pdf','x.tif',1,10,2) RETURNING id");
      job = rows[0].id;
    } else {
      assert.equal(r.status, 201, JSON.stringify(r.json));
      job = r.json.id;
      assert.equal(r.json.estado, 'pendiente');
      assert.ok(r.json.paginas >= 1);
      // El nombre del archivo lo pone la API, nunca el usuario.
      assert.ok(/^out-[a-z0-9]+-[0-9a-f]{8}\.pdf$/.test(r.json.archivo), r.json.archivo);
    }
    const lista = await api('GET', '/api/fax/out', { token: admin });
    assert.equal(lista.status, 200);
    assert.ok(lista.json.some((x) => x.id === job));
    // Reintentar sólo tiene sentido sobre lo que ya falló.
    assert.equal((await api('POST', '/api/fax/out/' + job + '/retry', { token: admin })).status, 409);
  });

  await t.test('el aviso del dialplan: sólo desde la central y con token', async () => {
    await ctx.db.query("UPDATE pbxng_fax_out SET estado='enviando', enviando_desde=now(), intentos=1 WHERE id=$1", [job]);
    const cuerpo = (extra) => new URLSearchParams(Object.assign({ dir: 'out', job: String(job), status: 'SUCCESS', pag: '2', rem: '099999999' }, extra)).toString();
    const pegar = (body, headers) => fetch(base + '/api/internal/fax', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers || {}), body,
    });

    assert.equal((await pegar(cuerpo({ tok: 'inventado' }))).status, 403, 'sin el token del agente no se acepta');
    // Una cabecera de proxy significa que el pedido pasó por el panel: no viene de Asterisk.
    assert.equal((await pegar(cuerpo({ tok }), { 'X-Forwarded-For': '10.0.0.9' })).status, 403);

    assert.equal((await pegar(cuerpo({ tok }))).status, 200);
    // El aviso se contesta antes de convertir y mandar el correo: se espera al UPDATE.
    let fila = null;
    for (let i = 0; i < 40 && (!fila || fila.estado !== 'ok'); i++) {
      fila = (await ctx.db.query('SELECT estado,paginas,remoto FROM pbxng_fax_out WHERE id=$1', [job])).rows[0];
      if (fila.estado !== 'ok') await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(fila.estado, 'ok');
    assert.equal(fila.paginas, 2);
    assert.equal(fila.remoto, '099999999');
  });

  await t.test('un fallo vuelve a la cola hasta agotar los intentos', async () => {
    const { rows } = await ctx.db.query(
      "INSERT INTO pbxng_fax_out (numero,archivo,tiff,max_intentos,estado,enviando_desde,intentos) VALUES ('099000111','y.pdf','y.tif',2,'enviando',now(),1) RETURNING id");
    const id = rows[0].id;
    const fallo = (n) => fetch(base + '/api/internal/fax', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ dir: 'out', job: String(id), status: 'FAILED', str: 'no answer', tok, _n: String(n) }).toString(),
    });
    async function esperar(estado) {
      for (let i = 0; i < 40; i++) {
        const f = (await ctx.db.query('SELECT estado,intentos FROM pbxng_fax_out WHERE id=$1', [id])).rows[0];
        if (f.estado === estado) return f;
        await new Promise((r) => setTimeout(r, 100));
      }
      return (await ctx.db.query('SELECT estado,intentos FROM pbxng_fax_out WHERE id=$1', [id])).rows[0];
    }
    await fallo(1);
    assert.equal((await esperar('pendiente')).estado, 'pendiente', 'el primer fallo NO es definitivo: un fax que no entra a la primera es lo normal');
    await ctx.db.query("UPDATE pbxng_fax_out SET estado='enviando', enviando_desde=now(), intentos=2 WHERE id=$1", [id]);
    await fallo(2);
    const f = await esperar('error');
    assert.equal(f.estado, 'error', 'agotados los intentos queda en error, no girando para siempre');
    // Y desde ahí se puede reintentar a mano sin volver a subir el PDF.
    assert.equal((await api('POST', '/api/fax/out/' + id + '/retry', { token: admin })).status, 200);
    assert.equal((await api('DELETE', '/api/fax/out/' + id, { token: admin })).status, 200);
  });

  await t.test('el fax recibido entra una sola vez y con lo que dijo el dialplan', async () => {
    const uid = '1757800000.77';
    fs.writeFileSync(path.join(faxDir, 'in', caja + '-' + uid + '.tif'), Buffer.alloc(2048, 7));
    const avisar = () => fetch(base + '/api/internal/fax', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ dir: 'in', box: String(caja), uid, cid: '099123456', status: 'SUCCESS', pag: '3', tok }).toString(),
    });
    assert.equal((await avisar()).status, 200);
    let fila = null;
    for (let i = 0; i < 40 && !fila; i++) {
      fila = (await ctx.db.query('SELECT * FROM pbxng_fax_in WHERE uniqueid=$1', [uid])).rows[0];
      if (!fila) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fila, 'el fax recibido tiene que quedar registrado');
    assert.equal(fila.paginas, 3);
    assert.equal(fila.cid, '099123456');
    assert.equal(fila.tiff, caja + '-' + uid + '.tif');
    assert.equal(fila.box_id, caja);
    // El mismo aviso dos veces (o el aviso + el barrido del spool) no puede duplicarlo.
    assert.equal((await avisar()).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    const { rows: n } = await ctx.db.query('SELECT count(*)::int c FROM pbxng_fax_in WHERE uniqueid=$1', [uid]);
    assert.equal(n[0].c, 1);
    // Un uniqueid que no es un uniqueid no puede armar un nombre de archivo.
    const malo = await fetch(base + '/api/internal/fax', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ dir: 'in', box: String(caja), uid: '../../etc/passwd', status: 'SUCCESS', tok }).toString(),
    });
    assert.equal(malo.status, 200);   // al dialplan siempre se le contesta 'ok'
    await new Promise((r) => setTimeout(r, 200));
    const { rows: m } = await ctx.db.query("SELECT count(*)::int c FROM pbxng_fax_in WHERE uniqueid LIKE '%passwd%'");
    assert.equal(m[0].c, 0);
    /* Un fax que empezó con el dialplan de la versión anterior dejó el archivo con el nombre
     * viejo (`<uniqueid>.tif`) y el aviso llega después de actualizar: se tiene que importar
     * igual, con la caja que dice el aviso. */
    const viejo = '1757800000.78';
    fs.writeFileSync(path.join(faxDir, 'in', viejo + '.tif'), Buffer.alloc(2048, 9));
    await fetch(base + '/api/internal/fax', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ dir: 'in', box: String(caja), uid: viejo, status: 'SUCCESS', pag: '1', tok }).toString(),
    });
    let fv = null;
    for (let i = 0; i < 40 && !fv; i++) {
      fv = (await ctx.db.query('SELECT * FROM pbxng_fax_in WHERE uniqueid=$1', [viejo])).rows[0];
      if (!fv) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fv && fv.paginas === 1, 'el nombre viejo se sigue importando');
    assert.equal(fv.estado, 'ok', 'y no como «no llegó ninguna página»: ' + fv.detalle);

    // La descarga existe (y el TIFF está, aunque no haya tiff2pdf para el PDF).
    const d = await fetch(base + '/api/fax/in/' + fila.id + '/pdf?tiff=1', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('content-type'), 'image/tiff');
  });

  await t.test('«no reintentar» es 0 y no tres llamadas', async () => {
    /* La columna acepta 0 y el panel lo deja poner. Con `parseInt(...) || 3` el 0 se
     * convertía en 3 y el que pidió una sola llamada se llevaba tres, facturadas. */
    const cfg0 = await api('PUT', '/api/fax/config', { token: admin, body: { reintentos: 0 } });
    assert.equal(cfg0.status, 200, JSON.stringify(cfg0.json));
    assert.equal(cfg0.json.reintentos, 0, 'el 0 tiene que sobrevivir al guardado');

    const { rows } = await ctx.db.query(
      "INSERT INTO pbxng_fax_out (numero,archivo,tiff,max_intentos,estado,intentos) VALUES ('099555000','z.pdf','z.tif',3,'error',3) RETURNING id");
    const id = rows[0].id;
    const r = await api('POST', '/api/fax/out/' + id + '/retry', { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.max_intentos, 0, 'reintentos=0 es UNA llamada, no tres');

    // Y el resto de los valores sigue funcionando igual. (El retry anterior dejó el trabajo
    // en `pendiente`; se lo vuelve a poner en `error`, que es lo único reintentable.)
    await ctx.db.query('UPDATE pbxng_fax_config SET reintentos=3 WHERE id=1');
    await ctx.db.query("UPDATE pbxng_fax_out SET estado='error' WHERE id=$1", [id]);
    const r2 = await api('POST', '/api/fax/out/' + id + '/retry', { token: admin });
    assert.equal(r2.json.max_intentos, 3);
    await api('DELETE', '/api/fax/out/' + id, { token: admin });
  });

  await t.test('cancelar un fax en el aire no larga el siguiente por la misma troncal', async () => {
    const { rows } = await ctx.db.query(
      "INSERT INTO pbxng_fax_out (numero,archivo,tiff,max_intentos,estado,enviando_desde,intentos) VALUES ('099777000','c.pdf','c.tif',3,'enviando',now(),1) RETURNING id");
    const id = rows[0].id;
    const d = await api('DELETE', '/api/fax/out/' + id, { token: admin });
    assert.equal(d.status, 200);
    assert.equal(d.json.cancelled, id);
    const estado = async () => (await ctx.db.query('SELECT estado,max_intentos FROM pbxng_fax_out WHERE id=$1', [id])).rows[0];
    /* Queda `cancelando`, NO `cancelado`: el canal sigue vivo y el chequeo de "un fax a la
     * vez" de la cola lo tiene que seguir viendo como ocupado. */
    assert.equal((await estado()).estado, 'cancelando');
    const { rows: ocupado } = await ctx.db.query("SELECT 1 FROM pbxng_fax_out WHERE estado IN ('enviando','cancelando') AND id=$1", [id]);
    assert.equal(ocupado.length, 1, 'mientras se cancela la troncal sigue ocupada');
    // Y no se puede reintentar algo que todavía está colgando.
    assert.equal((await api('POST', '/api/fax/out/' + id + '/retry', { token: admin })).status, 409);

    // Cuando el canal termina de verdad, el aviso del dialplan lo cierra en `cancelado`.
    await fetch(base + '/api/internal/fax', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ dir: 'out', job: String(id), status: 'FAILED', str: 'cancelado a mano', tok }).toString(),
    });
    let f = null;
    for (let i = 0; i < 40 && (!f || f.estado === 'cancelando'); i++) {
      f = await estado();
      if (f.estado === 'cancelando') await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(f.estado, 'cancelado', 'y nunca vuelve a «pendiente»: se pidió cancelarlo');
    // Desde ahí sí se reintenta a mano, y recién ahí se borra.
    assert.equal((await api('POST', '/api/fax/out/' + id + '/retry', { token: admin })).status, 200);
    await ctx.db.query('DELETE FROM pbxng_fax_out WHERE id=$1', [id]);
  });

  await t.test('T.38: el fax sólo apaga lo que encendió', async () => {
    /* Una troncal con T.38 puesto A MANO en ps_endpoints, que el módulo de fax nunca tocó:
     * el reloj no la puede apagar. Antes el UPDATE era `NOT (id = ANY(lista))`, que con la
     * lista vacía —el default de la migración 0016, o sea toda central sin fax— era
     * verdadero para TODAS las filas. */
    await ctx.db.query("INSERT INTO ps_endpoints (id, pbxng_kind, t38_udptl) VALUES ('tr-manual','trunk','yes') ON CONFLICT (id) DO UPDATE SET pbxng_kind='trunk', t38_udptl='yes'");
    await ctx.db.query("INSERT INTO ps_endpoints (id, pbxng_kind) VALUES ('tr-fax','trunk') ON CONFLICT (id) DO UPDATE SET pbxng_kind='trunk'");
    // La lista de troncales del fax se valida contra las troncales que existen, así que
    // para el panel «tr-fax» tiene que ser una troncal de verdad, no sólo un endpoint.
    await ctx.db.query("INSERT INTO pbxng_trunks (name, provider_host) VALUES ('tr-fax','sip.fax.test') ON CONFLICT (name) DO NOTHING");
    // Un INTERNO, para comprobar que el fax no le puede encender T.38 ni detección.
    await ctx.db.query("INSERT INTO ps_endpoints (id, pbxng_kind) VALUES ('9911','extension') ON CONFLICT (id) DO UPDATE SET pbxng_kind='extension'");
    const t38 = async (id) => (await ctx.db.query('SELECT t38_udptl FROM ps_endpoints WHERE id=$1', [id])).rows[0].t38_udptl;

    // Guardar configuración sin tocar la lista de troncales no puede apagar nada.
    assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { station_id: '29001234' } })).status, 200);
    assert.equal(await t38('tr-manual'), 'yes', 'el fax no es dueño del T.38 que no puso él');

    // Con la troncal en la lista sí se le enciende, y sólo a ella.
    assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { t38: true, trunks: ['tr-fax'] } })).status, 200);
    assert.equal(await t38('tr-fax'), 'yes');
    assert.equal(await t38('tr-manual'), 'yes');

    // Y sacarla de la lista sí se lo apaga: eso es lo que el módulo sí encendió.
    assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { trunks: [] } })).status, 200);
    assert.equal(await t38('tr-fax'), 'no');
    assert.equal(await t38('tr-manual'), 'yes', 'la de al lado sigue intacta');

    /* Lo que no es una troncal no entra a la lista: antes el nombre malo se tiraba en
     * silencio (el panel guardaba «bien» y nadie entendía por qué no había T.38) y un
     * interno con nombre de formato válido llegaba derecho al UPDATE de ps_endpoints. */
    assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { trunks: ['no-existe'] } })).status, 400);
    assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { trunks: ['tr fax/../'] } })).status, 400);
    assert.equal((await api('PUT', '/api/fax/config', { token: admin, body: { t38: true, trunks: ['9911'] } })).status, 400);
    assert.equal(await t38('9911'), null, 'el fax no le puede encender T.38 a un interno');
    assert.deepEqual((await api('GET', '/api/fax/config', { token: admin })).json.trunks, [], 'una lista rechazada no se guarda');
  });

  await t.test('permisos: el agente no ve nada, el supervisor opera pero no configura', async () => {
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'sup', password: 'supersecreta', role: 'supervisor' } })).status, 201);
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'age', password: 'supersecreta', role: 'agente' } })).status, 201);
    const sup = (await login('sup', 'supersecreta')).token;
    const age = (await login('age', 'supersecreta')).token;

    assert.equal((await api('GET', '/api/fax/in', { token: age })).status, 403);
    assert.equal((await api('GET', '/api/fax/out', { token: age })).status, 403);
    assert.equal((await subir('?numero=099123456', PDF_OK, 'application/pdf', age)).status, 403);

    assert.equal((await api('GET', '/api/fax/in', { token: sup })).status, 200);
    assert.equal((await api('GET', '/api/fax/out', { token: sup })).status, 200);
    // Configurar cajas y T.38 de las troncales es configuración: sólo admin.
    assert.equal((await api('POST', '/api/fax/boxes', { token: sup, body: { nombre: 'otra' } })).status, 403);
    assert.equal((await api('PUT', '/api/fax/config', { token: sup, body: { t38: false } })).status, 403);
    // Borrar un fax recibido es borrar un documento: tampoco.
    assert.equal((await api('DELETE', '/api/fax/in/1', { token: sup })).status, 403);
  });
});
