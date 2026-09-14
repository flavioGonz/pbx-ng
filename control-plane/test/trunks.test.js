/* Integración · troncales y rutas (trunks.js, docs/CONTRATOS.md §3) contra la API real
 * y un PostgreSQL efímero. Sin Postgres disponible se saltea. Asterisk no está: el
 * estado de las troncales sale 'offline' y eso es lo esperado acá. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

test('trunks/routes: crear troncal SIP, listar, ruta saliente, borrar', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  await t.test('validaciones: sin host 400; registro sin usuario/clave 400', async () => {
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'sinhost' } })).status, 400);
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'reg', provider_host: 'sip.ejemplo.test', mode: 'register' } })).status, 400);
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'kam', kind: 'kamailio', provider_host: 'x' } })).status, 400);
  });

  await t.test('crear troncal SIP con registro y listarla (con sus filas pjsip)', async () => {
    const r = await api('POST', '/api/trunks', { token: admin, body: { name: 'operador', provider_host: 'sip.ejemplo.test', provider_port: 5060, mode: 'register', username: 'usr', password: 'clave', codecs: ['alaw', 'ulaw'], outbound_prefix: '9' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.mode, 'register');
    const lista = await api('GET', '/api/trunks', { token: admin });
    assert.equal(lista.status, 200);
    const tk = lista.json.find((x) => x.name === 'operador');
    assert.ok(tk, 'la troncal tiene que aparecer en GET /api/trunks');
    assert.equal(tk.kind, 'asterisk');
    assert.equal(tk.mode, 'register');
    assert.equal(tk.status, 'offline');   // sin Asterisk no hay registro
    for (const tabla of ['ps_endpoints', 'ps_aors', 'ps_auths', 'ps_registrations', 'ps_endpoint_id_ips']) {
      const { rows } = await ctx.db.query('SELECT 1 FROM ' + tabla + " WHERE id='operador'");
      assert.equal(rows.length, 1, tabla + ' debería tener la fila de la troncal');
    }
    // El prefijo de salida '9' dejó la extensión _9. en el dialplan realtime.
    const { rows: dp } = await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten='_9.' ORDER BY priority");
    assert.ok(dp.some((x) => x.app === 'Dial' && /@operador/.test(x.appdata)), JSON.stringify(dp));
    const det = await api('GET', '/api/trunks/operador/detail', { token: admin });
    assert.equal(det.status, 200);
    assert.equal(det.json.has_password, true);
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'operador', provider_host: 'otro', mode: 'ip' } })).status, 409);   // 23505 → 409 (errores.js)
  });

  await t.test('ruta saliente: sin patrón 400; crear (troncal por defecto), listar, borrar', async () => {
    assert.equal((await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'x' } })).status, 400);
    const r = await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'Celulares', pattern: '09XXXXXXX', strip: 0 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.trunk, 'operador');   // sin SBC, sale por la primera troncal de operador
    const lista = await api('GET', '/api/routes/outbound', { token: admin });
    assert.equal(lista.status, 200);
    const ruta = lista.json.find((x) => x.pattern === '09XXXXXXX');
    assert.ok(ruta);
    const { rows: dp } = await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten='_09XXXXXXX' ORDER BY priority");
    assert.ok(dp.some((x) => x.app === 'Dial' && /@operador,60/.test(x.appdata)), JSON.stringify(dp));
    const d = await api('DELETE', '/api/routes/outbound/' + ruta.id, { token: admin });
    assert.equal(d.status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='_09XXXXXXX'")).rows.length, 0);
    assert.equal((await api('GET', '/api/routes/outbound', { token: admin })).json.length, 0);
  });

  await t.test('ruta entrante: crear, listar, borrar', async () => {
    assert.equal((await api('POST', '/api/routes/inbound', { token: admin, body: { did: '24000000' } })).status, 400);
    const r = await api('POST', '/api/routes/inbound', { token: admin, body: { did: '24000000', dest_type: 'interno', dest_value: '1001' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const lista = (await api('GET', '/api/routes/inbound', { token: admin })).json;
    const ruta = lista.find((x) => x.did === '24000000');
    assert.ok(ruta);
    assert.equal((await api('DELETE', '/api/routes/inbound/' + ruta.id, { token: admin })).status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='from-trunk' AND exten='24000000'")).rows.length, 0);
  });

  /* Failover de troncal (ítem 10 de docs/BRECHA-UCM-XORCOM.md). Lo que se prueba acá es
   * lo que NO se puede ver a ojo en el dialplan generado: que la escalera salte siempre
   * hacia adelante (nada de bucles), que estén las dos troncales y que un respaldo que no
   * existe no llegue nunca a escribirse. */
  await t.test('failover: cadena ordenada, escalera sin bucles y validaciones', async () => {
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'respaldo', provider_host: 'sip2.ejemplo.test', mode: 'ip' } })).status, 201);
    // Respaldo inexistente o repetido: ni se crea la ruta ni se toca el dialplan.
    assert.equal((await api('POST', '/api/routes/outbound', { token: admin, body: { pattern: '070X.', trunk: 'operador', backups: ['no-existe'] } })).status, 400);
    assert.equal((await api('POST', '/api/routes/outbound', { token: admin, body: { pattern: '070X.', trunk: 'operador', backups: ['operador'] } })).status, 400);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='_070X.'")).rows.length, 0);
    // Un prefijo con caracteres que romperían el Dial tampoco pasa.
    assert.equal((await api('POST', '/api/routes/outbound', { token: admin, body: { pattern: '070X.', trunk: 'operador', prepend: '9@otra,60&PJSIP/x' } })).status, 400);

    const r = await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'Nacional', pattern: '070X.', trunk: 'operador', backups: ['respaldo'], intento_seg: 20, total_seg: 45 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.id;
    const filas = async () => (await ctx.db.query("SELECT priority, app, appdata FROM extensions WHERE context='internal' AND exten='_070X.' ORDER BY priority")).rows;
    let dp = await filas();
    const dials = dp.filter((x) => x.app === 'Dial').map((x) => x.appdata);
    assert.equal(dials.length, 2, JSON.stringify(dp));
    assert.match(dials[0], /@operador,20$/);
    assert.match(dials[1], /@respaldo,20$/);
    assert.ok(dp.some((x) => x.app === 'Set' && x.appdata === 'DB(rutasal/' + id + ')=respaldo'), 'la troncal que cursa tiene que quedar marcada en la AstDB');
    /* La marca tiene que ir ANTES del Dial: cuando cuelga el que llama, Asterisk destruye el
     * canal y las prioridades que siguen al Dial no se ejecutan nunca. Con la marca después,
     * `rutasal` se quedaba en la troncal vieja y el aviso de failover no salía jamás. */
    for (const t of ['operador', 'respaldo']) {
      const marca = dp.find((x) => x.app === 'Set' && x.appdata === 'DB(rutasal/' + id + ')=' + t);
      const dial = dp.find((x) => x.app === 'Dial' && x.appdata.includes('@' + t + ','));
      assert.ok(marca && dial && marca.priority < dial.priority, 'la marca de ' + t + ' tiene que escribirse antes del Dial');
    }
    /* Las dos caras de la causa 21. `ast_sip_hangup_sip2cause()` la usa tanto para el
     * 401/403/407 DEL PROVEEDOR («la troncal nos rechaza» → hay que saltar al respaldo)
     * como para el 603 Decline DEL DESTINO («el que llamamos cortó» → saltar es facturarle
     * al cliente un intento por troncal y mandar el correo de failover en falso). Como
     * `handle_cause()` de app_dial no tiene case para la 21 y cae en el default (nochan →
     * DIALSTATUS=CHANUNAVAIL), las dos prenden FALLA: lo único que las separa es el código
     * SIP crudo, así que eso es lo que se comprueba acá. */
    const cond = dp.filter((x) => x.app === 'ExecIf' && /Set\(FALLA=0\)/.test(x.appdata));
    assert.ok(cond.length, JSON.stringify(dp));
    // Ninguna condición puede cancelar el failover mirando SÓLO la causa 21.
    for (const c of cond) {
      if (/"\$\{CAUSA\}"="21"/.test(c.appdata)) assert.match(c.appdata, /"\$\{SIPCODE\}"="603"/, 'la causa 21 sola no alcanza para cancelar el failover: ' + c.appdata);
    }
    assert.ok(cond.some((c) => /"\$\{CAUSA\}"="17"/.test(c.appdata)), 'el ocupado (486 → 17) del destino tiene que cancelar el failover');
    assert.ok(cond.some((c) => /"\$\{CAUSA\}"="21" & \("\$\{SIPCODE\}"="603"\)/.test(c.appdata)), 'el 603 Decline del destino tiene que cancelar el failover');
    /* El código SIP se lee por intento: sin limpiar las causas del intento anterior el
     * segundo Dial leería el código del primero. Y el motivo crudo («SIP 603 Decline») no
     * puede entrar nunca en un ExecIf: un ')' del otro extremo rompería la llamada. */
    assert.equal(dp.filter((x) => x.app === 'HangupCauseClear').length, 2, JSON.stringify(dp));
    for (const t of ['operador', 'respaldo']) {
      const limpia = dp.find((x) => x.app === 'HangupCauseClear' && x.priority < dp.find((y) => y.app === 'Dial' && y.appdata.includes('@' + t + ',')).priority);
      assert.ok(limpia, 'falta HangupCauseClear antes del Dial por ' + t);
    }
    for (const x of dp) assert.ok(!(x.app === 'ExecIf' && /HANGUPCAUSE\(/.test(x.appdata)), 'el motivo SIP crudo no puede ir adentro de un ExecIf: ' + x.appdata);
    // Ningún salto hacia atrás: es la garantía de que la escalera no puede hacer bucle.
    for (const f of dp) {
      for (const m of String(f.appdata).matchAll(/\?(?:Goto\()?(\d+)\)?$/g)) {
        assert.ok(+m[1] > f.priority, 'salto hacia atrás en la prioridad ' + f.priority + ': ' + f.appdata);
      }
    }

    // Reordenar por PUT: el respaldo pasa a principal y el dialplan lo refleja.
    const p = await api('PUT', '/api/routes/outbound/' + id, { token: admin, body: { trunk: 'respaldo', backups: ['operador'] } });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    dp = await filas();
    assert.match(dp.filter((x) => x.app === 'Dial')[0].appdata, /@respaldo,20$/);

    // El estado del failover es admin: la única pantalla que lo pide (/rutas) es de admin.
    const fo = await api('GET', '/api/routes/outbound/failover', { token: admin });
    assert.equal(fo.status, 200);
    const ruta = fo.json.find((x) => x.id === id);
    assert.deepEqual(ruta.cadena.map((x) => x.trunk), ['respaldo', 'operador']);

    // Borrar una troncal la saca de los respaldos: si no, el dialplan seguiría marcándola.
    assert.equal((await api('PUT', '/api/routes/outbound/' + id, { token: admin, body: { trunk: 'operador', backups: ['respaldo'] } })).status, 200);
    assert.equal((await api('DELETE', '/api/trunks/respaldo', { token: admin })).status, 200);
    const sola = (await api('GET', '/api/routes/outbound', { token: admin })).json.find((x) => x.id === id);
    assert.equal(sola.trunk, 'operador');
    assert.deepEqual(sola.backups, []);
    // Y el dialplan vuelve a ser el simple de una sola troncal (sin escalera).
    assert.equal((await filas()).filter((x) => x.app === 'Dial').length, 1);
    assert.equal((await api('DELETE', '/api/routes/outbound/' + id, { token: admin })).status, 200);
  });

  /* `internal` es un contexto COMPARTIDO y `setDialplan()` es DELETE + INSERT: hasta 1.10.0
   * este módulo escribía y borraba ahí a ciegas, así que el candado de `dueno-internal.js`
   * NO era simétrico. Se borraba una ruta saliente `_*21*.`, el administrador publicaba en
   * ese número un código de función (el número figuraba libre, no había dialplan) y al
   * recrear la ruta el código desaparecía sin que nadie se enterara. */
  await t.test('el candado de `internal` también lo cierran las rutas salientes y la salida de la troncal', async () => {
    // Un código de función publicado a mano hace de «lo que ya está» (telefonia.js).
    await ctx.db.query("UPDATE pbxng_featurecodes SET code='_*21*.' WHERE accion='cfu_set'");
    assert.equal((await api('POST', '/api/featurecodes/install', { token: admin })).status, 200);
    const antes = (await ctx.db.query("SELECT priority, app, appdata FROM extensions WHERE context='internal' AND exten='_*21*.' ORDER BY priority")).rows;
    assert.ok(antes.length > 0, 'el código de función tiene que estar publicado');

    // La ruta saliente con ese mismo patrón se rechaza diciendo quién lo ocupa.
    const choque = await api('POST', '/api/routes/outbound', { token: admin, body: { pattern: '*21*.', trunk: 'operador' } });
    assert.equal(choque.status, 409, JSON.stringify(choque.json));
    assert.match(String(choque.json.error), /código de función/, JSON.stringify(choque.json));
    assert.deepEqual((await ctx.db.query("SELECT priority, app, appdata FROM extensions WHERE context='internal' AND exten='_*21*.' ORDER BY priority")).rows, antes,
      'el dialplan del código de función tiene que seguir entero');
    assert.equal((await ctx.db.query("SELECT 1 FROM pbxng_outbound_routes WHERE pattern='*21*.'")).rows.length, 0, 'y la ruta no se creó');

    // Y la salida directa de una troncal nueva tampoco puede pisarlo.
    const tron = await api('POST', '/api/trunks', { token: admin, body: { name: 'pisa', provider_host: 'sip3.ejemplo.test', mode: 'ip', outbound_prefix: '*21*' } });
    assert.equal(tron.status, 409, JSON.stringify(tron.json));
    assert.equal((await ctx.db.query("SELECT 1 FROM pbxng_trunks WHERE name='pisa'")).rows.length, 0, 'la transacción vuelve atrás entera');
    assert.equal((await api('POST', '/api/featurecodes/uninstall', { token: admin })).status, 200);
    await ctx.db.query("UPDATE pbxng_featurecodes SET code='_*21*.' WHERE accion='cfu_set'");

    /* Dos troncales con el mismo prefijo de salida: antes la segunda le borraba la extensión
     * a la primera y el administrador creía que las dos salían por lo suyo. El prefijo y el
     * interruptor están en el mismo formulario, así que el 409 es accionable. */
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'otra9', provider_host: 'sip4.ejemplo.test', mode: 'ip', outbound_prefix: '9' } })).status, 409);
    // Con otro prefijo entra sin problema, y borrarla se lleva su salida directa.
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'otra8', provider_host: 'sip4.ejemplo.test', mode: 'ip', outbound_prefix: '8' } })).status, 201);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='_8.'")).rows.length > 0, true);
    assert.equal((await api('DELETE', '/api/trunks/otra8', { token: admin })).status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='_8.'")).rows.length, 0,
      'la salida directa se va con la troncal: si no, seguía marcando contra un endpoint que ya no existe');

    /* Editar lo PROPIO tiene que seguir funcionando. El alta inserta la fila de la troncal
     * antes de publicar el dialplan, así que al preguntar «¿de quién es `_9.`?» siempre hay
     * una fila propia reclamándolo: si el candado la mira a ella, un cambio de clave o de
     * host en la troncal que ya usa ese prefijo devolvería 409 para siempre —justo lo que
     * uno necesita hacer rápido cuando el operador rota la contraseña—. */
    const edit = await api('PUT', '/api/trunks/operador', { token: admin, body: { provider_host: 'sip9.ejemplo.test', mode: 'register', username: 'usr', password: 'otra', outbound_prefix: '9' } });
    assert.equal(edit.status, 200, JSON.stringify(edit.json));
    assert.ok((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='_9.'")).rows.length > 0,
      'la salida directa de la troncal editada sigue publicada');

    /* Y el dueño FANTASMA: el enlace a SBC-NG y las troncales WebRTC no publican salida
     * directa, pero se guardan sin `outbound_prefix`. Con el `COALESCE(..., 'X')` y sin
     * filtrar por `kind` reclamaban `_X.`, y en una central con SBC —o sea la de
     * producción— eso dejaba sin poder crear una ruta con patrón `X.`. */
    await ctx.db.query("INSERT INTO pbxng_trunks (name,provider_host,kind,adv_config) VALUES ('to-sbc','10.0.0.1','sbc','{\"mode\":\"ip\"}') ON CONFLICT (name) DO NOTHING");
    const libre = await api('POST', '/api/routes/outbound', { token: admin, body: { pattern: 'X.', trunk: 'operador' } });
    assert.equal(libre.status, 201, JSON.stringify(libre.json));
    await api('DELETE', '/api/routes/outbound/' + libre.json.id, { token: admin });
    await ctx.db.query("DELETE FROM pbxng_trunks WHERE name='to-sbc'");
  });

  await t.test('borrar la troncal limpia pbxng_trunks y las tablas pjsip', async () => {
    const d = await api('DELETE', '/api/trunks/operador', { token: admin });
    assert.equal(d.status, 200);
    for (const tabla of ['pbxng_trunks', 'ps_endpoints', 'ps_aors', 'ps_auths', 'ps_registrations', 'ps_endpoint_id_ips']) {
      const col = tabla === 'pbxng_trunks' ? 'name' : 'id';
      assert.equal((await ctx.db.query('SELECT 1 FROM ' + tabla + ' WHERE ' + col + "='operador'")).rows.length, 0, tabla);
    }
    // Sin troncal ni SBC, una ruta saliente nueva no tiene por dónde salir.
    const r = await api('POST', '/api/routes/outbound', { token: admin, body: { pattern: '0X.' } });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /troncal/);
  });
});
