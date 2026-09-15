/* Integración · telefonía clásica (telefonia.js + las rutas entrantes con horario de
 * trunks.js) contra la API real y un PostgreSQL efímero. Sin Postgres se saltea.
 *
 * Asterisk NO está: los DBPut/DBDel a la AstDB fallan y se ignoran a propósito (la
 * fuente de verdad es Postgres y syncFeatures() la vuelve a volcar al reconectar), así
 * que acá se verifica lo que SÍ tiene que quedar: las filas en la base y el dialplan
 * realtime en la tabla `extensions`. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const fs = require('node:fs');
const path = require('node:path');

/* 'MM-DD' de hoy, en la hora local del proceso: es la misma que usa estadoNightmode(). */
function mdHoy() {
  const d = new Date();
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
/* Un tramo que SÍ contiene este momento y otro que no, para probar el cálculo por hora. */
function tramoQueContieneAhora() {
  const d = new Date();
  const dia = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()];
  return { dias: dia, desde: '00:00', hasta: '23:59' };
}
function tramoQueNoContieneAhora() {
  const d = new Date();
  const otro = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][(d.getDay() + 3) % 7];
  return { dias: otro, desde: '03:00', hasta: '03:01' };
}

test('telefonía: features del interno, horarios, feriados, modo noche, códigos y DID con horario', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  /* El secreto que el CURL del dialplan manda en POST /api/internal/feature: la API lo
   * genera en su CONF_DIR al arrancar y Asterisk lo lee del mismo archivo montado ro. */
  const tok = fs.readFileSync(path.join(ctx.api.confDir, 'agent.token'), 'utf8').trim();

  await t.test('features: PUT/GET del interno, validación y alcance por rol', async () => {
    const put = await api('PUT', '/api/extensions/1001/features', { token: admin, body: { dnd: true, cfu: '1002', fm: '099123456', fm_seg: 20 } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.dnd, true);
    assert.equal(put.json.cfu, '1002');
    assert.equal(put.json.fm_seg, 20);
    const get = await api('GET', '/api/extensions/1001/features', { token: admin });
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, { dnd: true, cfu: '1002', cfb: '', cfnr: '', fm: '099123456', fm_seg: 20 });
    // La fuente de verdad es Postgres (la AstDB no existe en esta prueba).
    const { rows } = await ctx.db.query("SELECT dnd, cfu, fm, fm_seg FROM pbxng_ext_features WHERE ext='1001'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dnd, true);
    assert.equal(rows[0].fm_seg, 20);
    // Un destino con letras nunca puede terminar dentro de un Goto del dialplan.
    assert.equal((await api('PUT', '/api/extensions/1001/features', { token: admin, body: { cfb: 'rm -rf' } })).status, 400);
    // Ni con `*` o `#`: el destino se marca en el contexto `internal`, donde viven los
    // códigos de función, y esos toman la identidad del canal que LLAMA. Un desvío a
    // `*21*099…` le ponía el desvío al que te llamaba; `*78` lo dejaba en no molestar.
    for (const malo of ['*78', '*21*099123456', '#99', '099#', '+59899123456']) {
      assert.equal((await api('PUT', '/api/extensions/1001/features', { token: admin, body: { cfu: malo } })).status, 400, 'cfu=' + malo + ' tiene que dar 400');
    }
    assert.equal((await api('POST', '/api/internal/feature', { body: { tok, ext: '1001', accion: 'cfu', valor: '*78' } })).status, 400, 'tampoco por la ruta que llama el dialplan');
    // Un interno sin fila devuelve los valores por defecto, no un 404.
    assert.deepEqual((await api('GET', '/api/extensions/1099/features', { token: admin })).json, { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '', fm_seg: 15 });

    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'age', password: 'Clave-age-123', role: 'agente', ext: '1001' } })).status, 201);
    const age = (await login('age', 'Clave-age-123')).token;
    assert.equal((await api('GET', '/api/extensions/1001/features', { token: age })).status, 200);
    assert.equal((await api('PUT', '/api/extensions/1001/features', { token: age, body: { dnd: false } })).status, 200);
    assert.equal((await api('GET', '/api/extensions/1002/features', { token: age })).status, 403, 'un agente no puede ver el desvío de otro interno');
    assert.equal((await api('PUT', '/api/extensions/1002/features', { token: age, body: { cfu: '1003' } })).status, 403);
  });

  await t.test('sígueme/desvío: no se deja armar el ciclo, ni en dos pasos ni en tres', async () => {
    /* El canal Local del sígueme arrancaba de cero el contador SALTOS del dialplan, así que
     * A→B y B→A se pasaban la llamada para siempre. El tope se arregló en extensions.conf
     * (`__SALTOS`, heredable); acá se verifica la otra mitad: que el ciclo OBVIO no se pueda
     * ni guardar, que es donde se le puede explicar al usuario qué pasó. */
    for (const e of ['1101', '1102', '1103']) {
      assert.equal((await api('PUT', '/api/extensions/' + e + '/features', { token: admin, body: { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '' } })).status, 200);
    }
    // Uno solo: desviarse a sí mismo.
    assert.equal((await api('PUT', '/api/extensions/1101/features', { token: admin, body: { cfu: '1101' } })).status, 400);
    // Dos pasos: A→B y B→A.
    assert.equal((await api('PUT', '/api/extensions/1101/features', { token: admin, body: { fm: '1102' } })).status, 200);
    const dos = await api('PUT', '/api/extensions/1102/features', { token: admin, body: { fm: '1101' } });
    assert.equal(dos.status, 400, JSON.stringify(dos.json));
    assert.match(String(dos.json.error), /bucle/i);
    // Tres pasos, con banderas distintas (el sígueme y el desvío caen al mismo `internal`).
    assert.equal((await api('PUT', '/api/extensions/1102/features', { token: admin, body: { cfnr: '1103' } })).status, 200);
    assert.equal((await api('PUT', '/api/extensions/1103/features', { token: admin, body: { cfu: '1101' } })).status, 400, 'A→B→C→A también es un bucle');
    // Y no queda nada guardado del intento rechazado.
    assert.deepEqual((await api('GET', '/api/extensions/1103/features', { token: admin })).json,
      { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '', fm_seg: 15 });
    // Una cadena que NO vuelve al principio se sigue pudiendo armar.
    assert.equal((await api('PUT', '/api/extensions/1103/features', { token: admin, body: { fm: '099123456' } })).status, 200);
    for (const e of ['1101', '1102', '1103']) {
      assert.equal((await api('PUT', '/api/extensions/' + e + '/features', { token: admin, body: { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '' } })).status, 200);
    }
  });

  await t.test('ciclo YA guardado en la base: el interno igual puede apagar su DND y salir del ciclo', async () => {
    /* La comprobación de ciclos es de 1.11.0, pero hay centrales con desvíos guardados de
     * antes (o escritos desde el teléfono cuando la comprobación no existía). Si el ciclo
     * viejo bloqueara cualquier guardado, el usuario quedaba encerrado: `f` es el merge de
     * lo actual con el parcial, así que apagar el DND arrastraba los cfu/cfb viejos. Se
     * siembra el ciclo directo en Postgres, que es como llega en una central real. */
    for (const [e, cfu] of [['1111', '1112'], ['1112', '1111']]) {
      await ctx.db.query(
        `INSERT INTO pbxng_ext_features (ext,dnd,cfu,updated_at) VALUES ($1,true,$2,now())
         ON CONFLICT (ext) DO UPDATE SET dnd=true, cfu=$2`, [e, cfu]);
    }
    // Apagar el DND no toca ningún destino: no se valida un ciclo que el usuario no armó.
    const off = await api('PUT', '/api/extensions/1111/features', { token: admin, body: { dnd: false } });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(off.json.dnd, false);
    assert.equal(off.json.cfu, '1112', 'el desvío viejo queda como estaba: apagar el DND no lo borra');
    // Y la salida del ciclo (borrar el desvío) también tiene que pasar.
    assert.equal((await api('PUT', '/api/extensions/1111/features', { token: admin, body: { cfu: '' } })).status, 200);
    // Pero volver a armarlo, ahora que la otra punta sigue puesta, sigue siendo 400.
    const rearmar = await api('PUT', '/api/extensions/1111/features', { token: admin, body: { cfu: '1112' } });
    assert.equal(rearmar.status, 400, JSON.stringify(rearmar.json));
    assert.match(String(rearmar.json.error), /bucle/i);
    for (const e of ['1111', '1112']) {
      assert.equal((await api('PUT', '/api/extensions/' + e + '/features', { token: admin, body: { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '' } })).status, 200);
    }
  });

  let horarioId = 0;
  await t.test('horarios: validación y CRUD', async () => {
    assert.equal((await api('POST', '/api/horarios', { token: admin, body: { nombre: 'mal', tramos: [{ dias: 'lunes', desde: '09:00', hasta: '18:00' }] } })).status, 400);
    assert.equal((await api('POST', '/api/horarios', { token: admin, body: { nombre: 'mal', tramos: [{ dias: 'mon-fri', desde: '9', hasta: '18:00' }] } })).status, 400);
    const r = await api('POST', '/api/horarios', { token: admin, body: { nombre: 'Oficina', tramos: [{ dias: 'mon-fri', desde: '09:00', hasta: '18:00' }] } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    horarioId = r.json.id;
    const lista = await api('GET', '/api/horarios', { token: admin });
    assert.equal(lista.status, 200);
    assert.equal(lista.json.length, 1);
    assert.equal(lista.json[0].tramos[0].dias, 'mon-fri');
    const put = await api('PUT', '/api/horarios/' + horarioId, { token: admin, body: { nombre: 'Oficina UY', tramos: [{ dias: 'mon-fri', desde: '08:00', hasta: '17:00' }] } });
    assert.equal(put.status, 200);
    assert.equal(put.json.nombre, 'Oficina UY');
    assert.equal(put.json.tramos[0].desde, '08:00');
    assert.equal((await api('PUT', '/api/horarios/9999', { token: admin, body: { nombre: 'x' } })).status, 404);
  });

  await t.test('modo noche: forzado, por feriado y por tramo', async () => {
    // Forzado desde el panel: gana sobre cualquier horario.
    assert.equal((await api('PUT', '/api/nightmode', { token: admin, body: { modo: 'cerrado' } })).json.estado, 'cerrado');
    assert.equal((await api('PUT', '/api/nightmode', { token: admin, body: { modo: 'abierto' } })).json.estado, 'abierto');
    assert.equal((await api('PUT', '/api/nightmode', { token: admin, body: { modo: 'noche' } })).status, 400);

    // En automático manda el horario: un tramo que contiene este momento = abierto.
    await api('PUT', '/api/horarios/' + horarioId, { token: admin, body: { tramos: [tramoQueContieneAhora()] } });
    assert.equal((await api('PUT', '/api/nightmode', { token: admin, body: { modo: 'auto', horario_id: horarioId } })).json.estado, 'abierto');
    await api('PUT', '/api/horarios/' + horarioId, { token: admin, body: { tramos: [tramoQueNoContieneAhora()] } });
    assert.equal((await api('GET', '/api/nightmode', { token: admin })).json.estado, 'cerrado');

    // Un feriado de hoy cierra aunque el tramo diga que está abierto.
    await api('PUT', '/api/horarios/' + horarioId, { token: admin, body: { tramos: [tramoQueContieneAhora()] } });
    assert.equal((await api('GET', '/api/nightmode', { token: admin })).json.estado, 'abierto');
    const fer = await api('POST', '/api/feriados', { token: admin, body: { md: mdHoy(), nombre: 'Prueba' } });
    assert.equal(fer.status, 201, JSON.stringify(fer.json));
    const conFeriado = await api('GET', '/api/nightmode', { token: admin });
    assert.equal(conFeriado.json.estado, 'cerrado');
    assert.match(conFeriado.json.motivo, /feriado/);
    assert.equal((await api('DELETE', '/api/feriados/' + fer.json.id, { token: admin })).status, 200);
    assert.equal((await api('GET', '/api/nightmode', { token: admin })).json.estado, 'abierto');
    assert.equal((await api('POST', '/api/feriados', { token: admin, body: { md: '31-12' } })).status, 400);
  });

  await t.test('ruta entrante con horario: tres extensiones en from-trunk', async () => {
    const sin = await api('POST', '/api/routes/inbound', { token: admin, body: { did: '24875000', dest_type: 'interno', dest_value: '1001' } });
    assert.equal(sin.status, 201, JSON.stringify(sin.json));
    // Sin horario se genera como siempre: una sola extensión, sin ramas.
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='from-trunk' AND exten LIKE '%-24875000'")).rows.length, 0);

    const r = await api('POST', '/api/routes/inbound', {
      token: admin,
      body: { did: '24875001', dest_type: 'ivr', dest_value: '9000', horario_id: horarioId, dest_cerrado_type: 'interno', dest_cerrado_value: '1001' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const decide = (await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='from-trunk' AND exten='24875001' ORDER BY priority")).rows;
    assert.ok(decide.some((x) => x.app === 'ExecIf' && /nightmode\/modo/.test(x.appdata) && /cerrado-24875001/.test(x.appdata)), JSON.stringify(decide));
    assert.ok(decide.some((x) => x.app === 'GotoIf' && /DB_EXISTS\(hol\//.test(x.appdata)), JSON.stringify(decide));
    assert.ok(decide.some((x) => x.app === 'GotoIfTime' && /abierto-24875001/.test(x.appdata)), JSON.stringify(decide));
    assert.equal(decide[decide.length - 1].app, 'Goto');
    const abierto = (await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='from-trunk' AND exten='abierto-24875001' ORDER BY priority")).rows;
    assert.ok(abierto.some((x) => x.app === 'Goto' && x.appdata === 'ivr,9000,1'), JSON.stringify(abierto));
    const cerrado = (await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='from-trunk' AND exten='cerrado-24875001' ORDER BY priority")).rows;
    assert.ok(cerrado.some((x) => x.app === 'Voicemail' && /1001@default/.test(x.appdata)), JSON.stringify(cerrado));

    // Cambiar los tramos del horario regenera el dialplan de las rutas que lo usan.
    await api('PUT', '/api/horarios/' + horarioId, { token: admin, body: { tramos: [{ dias: 'mon-fri', desde: '07:30', hasta: '19:45' }] } });
    const tras = (await ctx.db.query("SELECT appdata FROM extensions WHERE context='from-trunk' AND exten='24875001' AND app='GotoIfTime'")).rows;
    assert.equal(tras.length, 1);
    assert.match(tras[0].appdata, /^07:30-19:45,mon-fri,\*,\*\?/);

    // Sacarle el horario a la ruta borra las ramas: no puede quedar dialplan marcable.
    const lista = await api('GET', '/api/routes/inbound', { token: admin });
    const ruta = lista.json.find((x) => x.did === '24875001');
    assert.equal(ruta.horario_id, horarioId);
    const upd = await api('PUT', '/api/routes/inbound/' + ruta.id, { token: admin, body: { horario_id: null } });
    assert.equal(upd.status, 200, JSON.stringify(upd.json));
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='from-trunk' AND exten IN ('abierto-24875001','cerrado-24875001')")).rows.length, 0);

    // Borrar un horario deja las rutas que lo usaban como de 24 h.
    await api('PUT', '/api/routes/inbound/' + ruta.id, { token: admin, body: { horario_id: horarioId } });
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='from-trunk' AND exten='abierto-24875001'")).rows.length, 1);
    assert.equal((await api('DELETE', '/api/horarios/' + horarioId, { token: admin })).status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='from-trunk' AND exten='abierto-24875001'")).rows.length, 0);
    const solo = (await ctx.db.query("SELECT app FROM extensions WHERE context='from-trunk' AND exten='24875001' ORDER BY priority")).rows;
    assert.equal(solo[0].app, 'Goto');   // vuelve a ser la ruta simple al IVR
  });

  await t.test('códigos de función: catálogo, instalación y código editable', async () => {
    const cat = await api('GET', '/api/featurecodes', { token: admin });
    assert.equal(cat.status, 200);
    assert.ok(cat.json.length >= 15, 'el catálogo tiene que traer los códigos del sprint 6');
    const dnd = cat.json.find((f) => f.accion === 'dnd_on');
    assert.equal(dnd.code, '*78');
    assert.equal(dnd.installed, false);

    assert.equal((await api('POST', '/api/featurecodes/install', { token: admin })).status, 200);
    const rows = (await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten='*78' ORDER BY priority")).rows;
    assert.ok(rows.some((x) => x.app === 'Set' && /DB\(dnd\/\$\{MIEXT\}\)=1/.test(x.appdata)), JSON.stringify(rows));
    assert.ok(rows.some((x) => x.app === 'Set' && /CURL\(.*\/api\/internal\/feature/.test(x.appdata)), 'el código tiene que avisarle a la API');
    // El patrón del desvío incondicional toma el destino de ${EXTEN:4}, pero pasado por
    // FILTER(0-9,...): el `.` del patrón también matchea `*` y `#`, y sin filtrar se podía
    // marcar `*21**78` y meter un código de función como destino del desvío.
    // El exten guardado tiene que conservar el `_`: pbx_realtime sólo trata como patrón a
    // las filas que empiezan con guión bajo, sin él `*21*1002#` no matchearía nada.
    /* *97 (buzón propio) publicado en realtime tiene que ser el MISMO dialplan que el *97
     * estático de extensions.conf. El realtime GANA en cuanto el administrador mueve el
     * código a otro número, y la versión vieja de acá era
     * `VoiceMailMain(${CALLERID(num)}@default)` a secas: pedía PIN, pero el buzón al que
     * entraba salía del CallerID, que es lo que el teléfono manda en el From. Un interno
     * registrado ponía el número de otro y escuchaba sus mensajes. */
    const vm = (await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten='*97' ORDER BY priority")).rows;
    assert.ok(vm.some((x) => x.app === 'VoiceMailMain' && /^\$\{CHANNEL\(endpoint\)\}@[^,]+,s$/.test(x.appdata)),
      'la identidad del buzón propio sale de CHANNEL(endpoint), no del CallerID: ' + JSON.stringify(vm));
    assert.ok(vm.some((x) => x.app === 'GotoIf' && /CHANNEL\(channeltype\).*PJSIP/.test(x.appdata)),
      'la opción s (saltear el PIN) sólo puede valer para un canal PJSIP: ' + JSON.stringify(vm));
    assert.ok(vm.every((x) => !(x.app === 'VoiceMailMain' && /CALLERID\(num\).*,s/.test(x.appdata))),
      'nunca se saltea el PIN identificando por CallerID');
    // *98 (buzón de otro) NUNCA lleva la 's': sería dejar todos los buzones abiertos.
    const vm98 = (await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten='*98' ORDER BY priority")).rows;
    assert.ok(vm98.some((x) => x.app === 'VoiceMailMain' && !/,s$/.test(x.appdata)), JSON.stringify(vm98));

    const cfuRows = (await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten='_*21*.' ORDER BY priority")).rows;
    const cfu = cfuRows.filter((x) => x.app === 'Set');
    assert.ok(cfu.some((x) => /FDEST=\$\{FILTER\(0-9,\$\{EXTEN:4\}\)\}/.test(x.appdata)), JSON.stringify(cfu));
    assert.ok(cfu.some((x) => /DB\(cfu\/\$\{MIEXT\}\)=\$\{FDEST\}/.test(x.appdata)), JSON.stringify(cfu));
    assert.ok(!cfuRows.some((x) => /DB\(cfu\/\$\{MIEXT\}\)=\$\{EXTEN:/.test(x.appdata)), 'el destino no puede ir sin filtrar a la AstDB');
    // Si no queda ningún dígito, se corta sin escribir la clave (vacía sería peor: DB_EXISTS la da por puesta).
    assert.ok(cfuRows.some((x) => x.app === 'ExecIf' && /"\$\{FDEST\}"=""\]\?Hangup\(\)/.test(x.appdata)), JSON.stringify(cfuRows));
    const pat = (await ctx.db.query("SELECT DISTINCT exten FROM extensions WHERE context='internal' AND exten LIKE '%*.'")).rows.map((x) => x.exten).sort();
    assert.deepEqual(pat, ['_*21*.', '_*22*.', '_*23*.', '_*24*.'], JSON.stringify(pat));

    // Editar el código borra el dialplan del viejo y publica el nuevo.
    const put = await api('PUT', '/api/featurecodes', { token: admin, body: { codes: [{ accion: 'dnd_on', code: '*38' }] } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='*78'")).rows.length, 0);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='*38'")).rows.length > 0, true);
    assert.equal((await api('PUT', '/api/featurecodes', { token: admin, body: { codes: [{ accion: 'dnd_on', code: 'hola' }] } })).status, 400);
    assert.equal((await api('PUT', '/api/featurecodes', { token: admin, body: { codes: [{ accion: 'no_existe', code: '*39' }] } })).status, 404);

    // Apagar una acción saca su dialplan sin borrarla del catálogo.
    assert.equal((await api('PUT', '/api/featurecodes', { token: admin, body: { codes: [{ accion: 'dnd_on', enabled: false }] } })).status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='*38'")).rows.length, 0);
    assert.equal((await api('POST', '/api/featurecodes/uninstall', { token: admin })).status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='_*21*.'")).rows.length, 0);
  });

  await t.test('POST /api/internal/feature: sólo desde la central (loopback, sin proxy, con token) y deja Postgres al día', async () => {
    // Es pública (la llama el dialplan por CURL) y llega desde loopback en la prueba.
    const r = await api('POST', '/api/internal/feature', { body: { tok, ext: '1005', accion: 'cfu', valor: '1006' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await ctx.db.query("SELECT cfu FROM pbxng_ext_features WHERE ext='1005'")).rows[0].cfu, '1006');
    assert.equal((await api('POST', '/api/internal/feature', { body: { tok, ext: '1005', accion: 'off', valor: 'cfu' } })).status, 200);
    assert.equal((await ctx.db.query("SELECT cfu FROM pbxng_ext_features WHERE ext='1005'")).rows[0].cfu, null);
    assert.equal((await api('POST', '/api/internal/feature', { body: { tok, ext: '1005', accion: 'inventada' } })).status, 400);
    // El modo noche marcado con *28 también queda en la base.
    assert.equal((await api('POST', '/api/internal/feature', { body: { tok, accion: 'night', valor: 'cerrado' } })).status, 200);
    assert.equal((await api('GET', '/api/nightmode', { token: admin })).json.modo, 'cerrado');

    /* Secuestro de desvíos desde la LAN: el panel proxya /backend/** y deja la IP real del
     * navegador en X-Forwarded-For, que con trust proxy = 1 pasa a ser req.ip — privada, o
     * sea que el viejo filtro de "red interna" la dejaba entrar sin sesión. La cabecera de
     * proxy es la marca de que el pedido no vino del CURL del dialplan: 403 y se acabó. */
    const porElPanel = await api('POST', '/api/internal/feature', { headers: { 'X-Forwarded-For': '1.2.3.4' }, body: { tok, ext: '1005', accion: 'cfu', valor: '1006' } });
    assert.equal(porElPanel.status, 403, JSON.stringify(porElPanel.json));
    assert.equal((await api('POST', '/api/internal/feature', { headers: { 'X-Real-IP': '192.168.1.50' }, body: { tok, ext: '1005', accion: 'dnd_on' } })).status, 403);
    // Sin el secreto compartido tampoco, aunque venga por loopback (defensa en profundidad).
    assert.equal((await api('POST', '/api/internal/feature', { body: { ext: '1005', accion: 'cfu', valor: '1006' } })).status, 403);
    assert.equal((await api('POST', '/api/internal/feature', { body: { tok: tok.slice(0, -1) + 'z', ext: '1005', accion: 'cfu', valor: '1006' } })).status, 403);
    // Y nada de eso llegó a la base.
    assert.equal((await ctx.db.query("SELECT cfu, dnd FROM pbxng_ext_features WHERE ext='1005'")).rows[0].cfu, null);
  });

  await t.test('roles: horarios y códigos son admin; el estado de modo noche lo ve el supervisor', async () => {
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'sup', password: 'Clave-sup-123', role: 'supervisor' } })).status, 201);
    const sup = (await login('sup', 'Clave-sup-123')).token;
    const age = (await login('age', 'Clave-age-123')).token;
    assert.equal((await api('GET', '/api/nightmode', { token: sup })).status, 200);
    assert.equal((await api('PUT', '/api/nightmode', { token: sup, body: { modo: 'auto' } })).status, 403);
    assert.equal((await api('GET', '/api/horarios', { token: sup })).status, 403);
    assert.equal((await api('GET', '/api/featurecodes', { token: age })).status, 403);
    assert.equal((await api('GET', '/api/nightmode', { token: age })).status, 403);
  });
});
