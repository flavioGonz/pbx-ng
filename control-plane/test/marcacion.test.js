/* Integración · marcación (marcacion.js): DISA, callback, dial-by-name y marcación
 * abreviada, contra la API real y un PostgreSQL efímero. Sin Postgres se saltea.
 *
 * Asterisk NO está: los DBPut/DBDel y el Originate del callback fallan y se ignoran a
 * propósito (la fuente de verdad es Postgres y syncAbreviados() la vuelve a volcar al
 * reconectar). Lo que se verifica es lo que SÍ tiene que quedar: las filas en la base, el
 * dialplan realtime en `extensions` y —sobre todo— que ni el PIN ni un destino sin validar
 * puedan terminar adentro del dialplan. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const fs = require('node:fs');
const path = require('node:path');

/* Las dos rutas que llama el dialplan contestan TEXTO PLANO ('ok' / 'no' / 'bloqueado'),
 * no JSON: el que las lee es un `${CURL(...)}` comparado con `$["${DRES}"="ok"]`. El
 * ayudante de pruebas intenta parsear y, cuando no puede, deja el cuerpo en `_raw`. */
const txt = (r) => String((r.json && r.json._raw != null ? r.json._raw : r.json) || '').trim();

const filas = (ctx, exten) => ctx.db.query("SELECT priority, app, appdata FROM extensions WHERE context='internal' AND exten=$1 ORDER BY priority", [exten]).then((r) => r.rows);

test('marcación: DISA, callback, dial-by-name y abreviados', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  const tok = fs.readFileSync(path.join(ctx.api.confDir, 'agent.token'), 'utf8').trim();

  // Una ruta saliente de verdad: es contra sus patrones que se decide qué puede marcar la DISA.
  let rutaId = 0;
  await t.test('preparar una ruta saliente para restringir la DISA', async () => {
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'op1', provider_host: 'sip.ejemplo.test', mode: 'ip' } })).status, 201);
    const r = await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'Celulares', pattern: '09XXXXXXX', trunk: 'op1', strip: 0 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    rutaId = r.json.id;
  });

  let disaId = 0;
  await t.test('DISA: alta, PIN que no puede ser un interno y dialplan sin el PIN adentro', async () => {
    // El PIN nunca puede ser el número de un interno: es el que pone todo el mundo.
    await ctx.db.query("INSERT INTO ps_endpoints (id) VALUES ('1001') ON CONFLICT DO NOTHING");
    assert.equal((await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA', exten: '*30', pin: '1001', rutas: [rutaId] } })).status, 400);
    assert.equal((await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA', exten: '*30', pin: '1111', rutas: [rutaId] } })).status, 400, 'todos los dígitos iguales');
    assert.equal((await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA', exten: '*30', pin: '1234', rutas: [rutaId] } })).status, 400, 'secuencia');
    assert.equal((await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA', exten: '*30', pin: '12' } })).status, 400, 'PIN corto');
    // Una extensión de entrada con patrón se comería medio plan de marcado.
    assert.equal((await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA', exten: '_X.', pin: '748291', rutas: [rutaId] } })).status, 400);
    // Activarla sin ninguna ruta ni internos es abrir una puerta que no sirve para nada.
    assert.equal((await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA', exten: '*30', pin: '748291', enabled: true, rutas: [] } })).status, 400);
    assert.equal((await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA', exten: '*30', pin: '748291', rutas: [9999] } })).status, 400, 'ruta inexistente');

    const r = await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA oficina', exten: '*30', pin: '748291', rutas: [rutaId], dur_seg: 240, callerid: '24875000' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    disaId = r.json.id;
    // Nace APAGADA: una actualización no puede encender sola algo que gasta plata.
    assert.equal(r.json.enabled, false);
    assert.equal(r.json.pin_hash, undefined, 'el hash del PIN no sale por la API');
    assert.equal((await filas(ctx, '*30')).length, 0, 'apagada no publica dialplan');

    const up = await api('PUT', '/api/disa/' + disaId, { token: admin, body: { enabled: true } });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    const dp = await filas(ctx, '*30');
    assert.ok(dp.length > 5, JSON.stringify(dp));
    const todo = dp.map((x) => x.app + '|' + x.appdata).join('\n');
    // EL punto de todo el diseño: el PIN no está en el dialplan, se pregunta por CURL.
    assert.ok(!/748291/.test(todo), 'el PIN NO puede estar en el dialplan: ' + todo);
    assert.ok(/CURL\(.*\/api\/internal\/disa/.test(todo), 'tiene que preguntar el PIN a la API');
    // El número marcado se filtra a dígitos antes de salir de acá.
    assert.ok(/FNUM=\$\{FILTER\(0-9,\$\{DNUM\}\)\}/.test(todo), todo);
    // Duración acotada: una DISA sin tope es una llamada internacional abierta.
    assert.ok(dp.some((x) => x.app === 'Set' && x.appdata === 'TIMEOUT(absolute)=240'), todo);
    // Y sólo marca DESPUÉS de que la API dijo ok.
    const iDial = dp.findIndex((x) => x.app === 'Dial');
    const iCheck = dp.findIndex((x) => x.app === 'GotoIf' && /\$\{DRES\}"!="ok"/.test(x.appdata));
    assert.ok(iCheck >= 0 && iCheck < iDial, 'el Dial tiene que ir después de la validación: ' + todo);
    // Todos los saltos apuntan a una prioridad que existe (el armador de etiquetas).
    const maxP = dp[dp.length - 1].priority;
    for (const f of dp) {
      for (const m of String(f.appdata).matchAll(/\?(\d+)\b/g)) {
        assert.ok(+m[1] >= 1 && +m[1] <= maxP, 'salto a una prioridad inexistente (' + m[1] + '): ' + f.appdata);
      }
      assert.ok(!/<<[a-z_]+>>/.test(f.appdata), 'quedó una etiqueta sin resolver: ' + f.appdata);
    }
  });

  await t.test('DISA: la API valida el PIN, bloquea por intentos y restringe el destino', async () => {
    const pedir = (body) => api('POST', '/api/internal/disa', { body: Object.assign({ tok, id: disaId }, body) });
    // Sólo desde la central: con cabecera de proxy o sin token, no.
    assert.equal((await api('POST', '/api/internal/disa', { headers: { 'X-Forwarded-For': '1.2.3.4' }, body: { tok, id: disaId, accion: 'pin', pin: '748291' } })).status, 403);
    assert.equal((await api('POST', '/api/internal/disa', { body: { id: disaId, accion: 'pin', pin: '748291' } })).status, 403);

    assert.equal(txt(await pedir({ accion: 'pin', pin: '748291', cid: '099111222' })), 'ok');
    assert.equal(txt(await pedir({ accion: 'pin', pin: '000000', cid: '099111222' })), 'no');

    // Destino permitido (entra en 09XXXXXXX) vs. destino de otra ruta que esta DISA no tiene.
    assert.equal(txt(await pedir({ accion: 'marcar', num: '099123456', cid: '099111222' })), 'ok');
    assert.equal(txt(await pedir({ accion: 'marcar', num: '0059899123456', cid: '099111222' })), 'no');
    assert.equal(txt(await pedir({ accion: 'marcar', num: '1001', cid: '099111222' })), 'no', 'internos apagados por defecto');
    await api('PUT', '/api/disa/' + disaId, { token: admin, body: { internos: true } });
    assert.equal(txt(await pedir({ accion: 'marcar', num: '1001', cid: '099111222' })), 'ok');
    assert.equal(txt(await pedir({ accion: 'marcar', num: '1099', cid: '099111222' })), 'no', 'un interno que no existe tampoco');

    // Bloqueo por intentos: max_intentos fallos desde el MISMO origen y se cierra.
    const cid = '099999888';
    for (let i = 0; i < 3; i++) await pedir({ accion: 'pin', pin: '000000', cid });
    assert.equal(txt(await pedir({ accion: 'pin', pin: '748291', cid })), 'bloqueado', 'ni con el PIN bueno mientras esté bloqueado');
    // Y el bloqueo es por origen: no se puede dejar la DISA muerta para todos los demás.
    assert.equal(txt(await pedir({ accion: 'pin', pin: '748291', cid: '099111222' })), 'ok');

    // Todo quedó registrado con el CallerID de origen: sin esto no te enterás hasta la factura.
    const reg = await api('GET', '/api/disa/registro', { token: admin });
    assert.equal(reg.status, 200);
    assert.ok(reg.json.some((r) => r.evento === 'bloqueado' && r.cid === cid), JSON.stringify(reg.json.slice(0, 5)));
    assert.ok(reg.json.some((r) => r.evento === 'llamada' && r.destino === '099123456'), 'la llamada permitida también se registra');
    assert.ok(reg.json.some((r) => r.evento === 'rechazo' && r.destino === '0059899123456'), 'y el rechazo por ruta no habilitada');
  });

  /* La regresión que hace de la DISA una puerta de fraude internacional: habilitar sólo la
   * ruta nacional no alcanzaba, porque después se marca `Local/<num>@internal` y ahí
   * Asterisk vuelve a elegir entre TODAS las rutas. Con `_0X.` habilitada (la que siembra
   * el panel por defecto) y `_00.` NO habilitada, marcar 00 + internacional matcheaba
   * `_0X.`, la API decía «ok» y la llamada salía por `_00.`. */
  await t.test('DISA: manda la ruta que GANA el best-match, no cualquiera que matchee', async () => {
    const nac = await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'Salida por 0', pattern: '0X.', trunk: 'op1', strip: 1 } });
    assert.equal(nac.status, 201, JSON.stringify(nac.json));
    const inter = await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'Internacional', pattern: '00.', trunk: 'op1', strip: 1 } });
    assert.equal(inter.status, 201, JSON.stringify(inter.json));
    // Sólo la nacional habilitada, que es lo que el administrador ve en la pantalla.
    assert.equal((await api('PUT', '/api/disa/' + disaId, { token: admin, body: { rutas: [nac.json.id], internos: false } })).status, 200);

    const pedir = (num) => api('POST', '/api/internal/disa', { body: { tok, id: disaId, accion: 'marcar', num, cid: '099111222' } });
    assert.equal(txt(await pedir('0221234567')), 'ok', 'un nacional gana por _0X., que sí está habilitada');
    assert.equal(txt(await pedir('00598991234567')), 'no', 'el internacional lo cursaría _00., que NO está habilitada');
    // Y al revés: habilitando la internacional, ese mismo número sale.
    assert.equal((await api('PUT', '/api/disa/' + disaId, { token: admin, body: { rutas: [nac.json.id, inter.json.id] } })).status, 200);
    assert.equal(txt(await pedir('00598991234567')), 'ok');

    const reg = await api('GET', '/api/disa/registro', { token: admin });
    assert.ok(reg.json.some((r) => r.evento === 'rechazo' && r.destino === '00598991234567' && /00\./.test(r.motivo || '')),
      'el registro dice POR QUÉ ruta se habría cursado: ' + JSON.stringify(reg.json.slice(0, 3)));

    // Y se deja la DISA como estaba para el resto de las pruebas.
    assert.equal((await api('PUT', '/api/disa/' + disaId, { token: admin, body: { rutas: [rutaId], internos: true } })).status, 200);
    await api('DELETE', '/api/routes/outbound/' + inter.json.id, { token: admin });
    await api('DELETE', '/api/routes/outbound/' + nac.json.id, { token: admin });
  });

  await t.test('DISA: apagarla y cambiarle la entrada no deja dialplan huérfano', async () => {
    await api('PUT', '/api/disa/' + disaId, { token: admin, body: { exten: '*31' } });
    assert.equal((await filas(ctx, '*30')).length, 0, 'la extensión vieja tiene que desaparecer');
    assert.ok((await filas(ctx, '*31')).length > 0);
    await api('PUT', '/api/disa/' + disaId, { token: admin, body: { enabled: false } });
    assert.equal((await filas(ctx, '*31')).length, 0);
    await api('PUT', '/api/disa/' + disaId, { token: admin, body: { enabled: true } });
  });

  let cbId = 0;
  await t.test('callback: lista blanca obligatoria, cooldown y registro', async () => {
    assert.equal((await api('POST', '/api/callback', { token: admin, body: { nombre: 'CB', exten: '*32', enabled: true, numeros: [], dest_value: '*31' } })).status, 400, 'en modo lista hace falta la lista');
    assert.equal((await api('POST', '/api/callback', { token: admin, body: { nombre: 'CB', exten: '*32', numeros: ['099*'], dest_value: '*31' } })).status, 400, 'los números son sólo dígitos');
    assert.equal((await api('POST', '/api/callback', { token: admin, body: { nombre: 'CB', exten: '*32', modo: 'pin', dest_value: '*31' } })).status, 400, 'modo con PIN sin PIN');

    const r = await api('POST', '/api/callback', { token: admin, body: { nombre: 'CB', exten: '*32', enabled: true, numeros: ['099111222'], dest_type: 'disa', dest_value: '*31', cooldown_seg: 600 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    cbId = r.json.id;
    const dp = await filas(ctx, '*32');
    const todo = dp.map((x) => x.app + '|' + x.appdata).join('\n');
    // En modo lista NO se atiende: atender es tarifar, y la gracia del callback es no cobrarle.
    assert.ok(!dp.some((x) => x.app === 'Answer'), todo);
    assert.ok(/CURL\(.*\/api\/internal\/callback/.test(todo), todo);

    const pedir = (cid, extra) => api('POST', '/api/internal/callback', { body: Object.assign({ tok, id: cbId, cid }, extra || {}) });
    assert.equal(txt(await pedir('099333444')), 'no', 'un número fuera de la lista no dispara nada');
    assert.equal(txt(await pedir('')), 'no', 'sin CallerID no hay a quién devolverle la llamada');
    assert.equal(txt(await pedir('099111222')), 'ok');
    assert.equal(txt(await pedir('099111222')), 'no', 'dos seguidos: lo frena el cooldown');

    const reg = await api('GET', '/api/callback/registro', { token: admin });
    assert.ok(reg.json.some((x) => x.evento === 'llamada' && x.cid === '099111222'), JSON.stringify(reg.json.slice(0, 5)));
    assert.ok(reg.json.some((x) => x.evento === 'rechazo' && x.cid === '099333444'), JSON.stringify(reg.json.slice(0, 5)));
  });

  /* El callback devuelve la llamada al CallerID entrante, y el CallerID se falsea. En modo
   * `pin` no hay lista blanca: sin restricción de rutas, quien tenga el PIN se hace llamar a
   * un premium internacional y el único freno es el tope diario. */
  await t.test('callback en modo PIN: sin rutas no se enciende, y con rutas el destino se valida', async () => {
    const sinRutas = await api('POST', '/api/callback', { token: admin, body: { nombre: 'CB PIN', exten: '*34', enabled: true, modo: 'pin', pin: '748291', dest_value: '*31' } });
    assert.equal(sinRutas.status, 400, 'modo PIN encendido sin ninguna ruta habilitada: ' + JSON.stringify(sinRutas.json));

    const r = await api('POST', '/api/callback', { token: admin, body: { nombre: 'CB PIN', exten: '*34', enabled: true, modo: 'pin', pin: '748291', rutas: [rutaId], dest_value: '*31', cooldown_seg: 600 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.deepEqual(r.json.rutas, [rutaId], 'las rutas habilitadas salen por la API');
    const pin = (cid, extra) => api('POST', '/api/internal/callback', { body: Object.assign({ tok, id: r.json.id, cid, pin: '748291' }, extra || {}) });

    // El destino tiene que entrar en una ruta habilitada (09XXXXXXX), venga el CallerID que venga.
    assert.equal(txt(await pin('0059899123456')), 'no', 'un internacional falseando el CallerID no se devuelve');
    assert.equal(txt(await pin('1001')), 'no', 'ni un número que no sale por ninguna ruta');
    assert.equal(txt(await pin('099123456')), 'ok');

    // El PIN malo bloquea POR CALLBACK: rotar el CallerID no da un balde nuevo por intento.
    for (let i = 0; i < 3; i++) assert.equal(txt(await pin('09912345' + i, { pin: '000000' })), 'no');
    assert.equal(txt(await pin('099123999')), 'no', 'bloqueado aunque el CallerID sea otro y el PIN sea el bueno');
    assert.equal((await api('DELETE', '/api/callback/' + r.json.id, { token: admin })).status, 200);
  });

  await t.test('dial-by-name: opciones validadas y contexto de marcado fijo', async () => {
    assert.equal((await api('PUT', '/api/dialbyname', { token: admin, body: { exten: '*33', opciones: 'internal)&Hangup' } })).status, 400);
    assert.equal((await api('PUT', '/api/dialbyname', { token: admin, body: { exten: '*33', vm_context: 'default,internal,x' } })).status, 400);
    const r = await api('PUT', '/api/dialbyname', { token: admin, body: { exten: '*33', enabled: true, opciones: 'ef' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const dp = await filas(ctx, '*33');
    const dir = dp.find((x) => x.app === 'Directory');
    assert.ok(dir, JSON.stringify(dp));
    assert.equal(dir.appdata, 'default,internal,ef', 'el contexto donde marca es siempre internal');
    const get = await api('GET', '/api/dialbyname', { token: admin });
    assert.ok(Array.isArray(get.json.directorio), 'dice quién aparecería en el directorio');
  });

  /* La regresión seria: `internal` es un contexto COMPARTIDO y el alta publicaba borrando
   * todo lo que hubiera en esa extensión. Una DISA en `*97` se llevaba puesto el buzón de
   * voz —y pasaba igual creándola APAGADA, porque el borrado va antes que el `enabled`—. */
  await t.test('la extensión de entrada no puede pisar a otra aplicación', async () => {
    // Los códigos de función de verdad (telefonia.js), publicados en internal: *97 es el buzón.
    assert.equal((await api('POST', '/api/featurecodes/install', { token: admin })).status, 200);
    const antes = await filas(ctx, '*97');
    assert.ok(antes.length > 0, 'el código de función tiene que estar publicado');

    // Apagada o encendida da lo mismo: el borrado iba antes que el `enabled`.
    const apagada = await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA pirata', exten: '*97', pin: '748291', rutas: [rutaId] } });
    assert.equal(apagada.status, 409, JSON.stringify(apagada.json));
    assert.match(String(apagada.json.error), /código de función/, JSON.stringify(apagada.json));
    assert.deepEqual(await filas(ctx, '*97'), antes, 'el dialplan del buzón sigue intacto');
    assert.equal((await api('GET', '/api/disa', { token: admin })).json.length, 1, 'y la DISA pirata no se creó');

    // Tampoco moviendo una DISA que ya existe a esa extensión.
    const mover = await api('PUT', '/api/disa/' + disaId, { token: admin, body: { exten: '*97' } });
    assert.equal(mover.status, 409, JSON.stringify(mover.json));
    assert.deepEqual(await filas(ctx, '*97'), antes, 'el dialplan del buzón sigue intacto');
    assert.ok((await filas(ctx, '*31')).length > 0, 'y la DISA se queda donde estaba');

    // Lo mismo entre aplicaciones de este módulo: en *33 está el directorio por nombre.
    const cbPisa = await api('POST', '/api/callback', { token: admin, body: { nombre: 'CB pirata', exten: '*33', numeros: ['099111222'], dest_value: '*31' } });
    assert.equal(cbPisa.status, 409, JSON.stringify(cbPisa.json));
    assert.match(String(cbPisa.json.error), /directorio/, JSON.stringify(cbPisa.json));
    // Y contra un interno: una DISA en 1001 deja al interno sin timbre.
    assert.equal((await api('POST', '/api/disa', { token: admin, body: { nombre: 'DISA pirata', exten: '1001', pin: '748291', rutas: [rutaId] } })).status, 409);

    // Editar la DISA sin moverla NO puede dar 409 contra su propio dialplan.
    assert.equal((await api('PUT', '/api/disa/' + disaId, { token: admin, body: { nombre: 'DISA oficina' } })).status, 200);
    assert.ok((await filas(ctx, '*31')).length > 0);

    // Se sacan los códigos de función para no dejarle el plan de marcado ocupado al resto.
    assert.equal((await api('POST', '/api/featurecodes/uninstall', { token: admin })).status, 200);
  });

  await t.test('abreviados globales: no pueden pisar un código de función ni otra aplicación', async () => {
    assert.equal((await api('POST', '/api/abreviados', { token: admin, body: { code: '*78', destino: '1001' } })).status, 409, '*78 es el no molestar');
    assert.equal((await api('POST', '/api/abreviados', { token: admin, body: { code: '*33', destino: '1001' } })).status, 409, 'ahí está el directorio');
    assert.equal((await api('POST', '/api/abreviados', { token: admin, body: { code: '80', destino: '1002*78' } })).status, 400, 'el destino va crudo a un Goto: sólo dígitos');
    const r = await api('POST', '/api/abreviados', { token: admin, body: { code: '80', destino: '099123456', nombre: 'Guardia' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const dp = await filas(ctx, '80');
    assert.ok(dp.some((x) => x.app === 'Goto' && x.appdata === 'internal,099123456,1'), JSON.stringify(dp));
    assert.equal((await api('PUT', '/api/abreviados/' + r.json.id, { token: admin, body: { destino: '24875000' } })).status, 200);
    assert.ok((await filas(ctx, '80')).some((x) => x.appdata === 'internal,24875000,1'));
    assert.equal((await api('DELETE', '/api/abreviados/' + r.json.id, { token: admin })).status, 200);
    assert.equal((await filas(ctx, '80')).length, 0);
  });

  await t.test('abreviados personales: patrón sólo si hay alguno, y el agente toca el suyo', async () => {
    const lista = await api('GET', '/api/abreviados', { token: admin });
    const pref = lista.json.prefijo;
    assert.equal(pref, '*75');
    assert.equal((await filas(ctx, '_' + pref + 'XX')).length, 0, 'sin abreviados personales no se ocupa el plan de marcado');

    assert.equal((await api('PUT', '/api/extensions/1001/abreviados', { token: admin, body: { entradas: [{ code: '1', destino: '1002' }] } })).status, 400, 'el código es de dos dígitos');
    assert.equal((await api('PUT', '/api/extensions/1001/abreviados', { token: admin, body: { entradas: [{ code: '01', destino: '*78' }] } })).status, 400, 'el destino va a un Goto: sólo dígitos');
    const put = await api('PUT', '/api/extensions/1001/abreviados', { token: admin, body: { entradas: [{ code: '01', destino: '099123456', nombre: 'Casa' }] } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const dp = await filas(ctx, '_' + pref + 'XX');
    const todo = dp.map((x) => x.app + '|' + x.appdata).join('\n');
    // La identidad sale del endpoint que autenticó, no del CallerID que manda el teléfono.
    assert.ok(/MIEXT=.*CHANNEL\(endpoint\)/.test(todo), todo);
    // Y lo que sale de la AstDB se vuelve a filtrar antes de entrar al Goto.
    assert.ok(/ADEST=\$\{FILTER\(0-9,\$\{DB\(abrev\/\$\{MIEXT\}-/.test(todo), todo);

    // Un agente toca su libreta y no la del vecino.
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'agem', password: 'Clave-agem-123', role: 'agente', ext: '1001' } })).status, 201);
    const age = (await login('agem', 'Clave-agem-123')).token;
    assert.equal((await api('GET', '/api/extensions/1001/abreviados', { token: age })).status, 200);
    assert.equal((await api('PUT', '/api/extensions/1001/abreviados', { token: age, body: { entradas: [{ code: '02', destino: '1002' }] } })).status, 200);
    assert.equal((await api('GET', '/api/extensions/1002/abreviados', { token: age })).status, 403);
    // Y nada de la configuración de la central.
    assert.equal((await api('GET', '/api/disa', { token: age })).status, 403);
    assert.equal((await api('GET', '/api/abreviados', { token: age })).status, 403);

    // Vaciar la lista saca el patrón: no puede quedar dialplan que no lleva a ningún lado.
    assert.equal((await api('PUT', '/api/extensions/1001/abreviados', { token: age, body: { entradas: [] } })).status, 200);
    assert.equal((await filas(ctx, '_' + pref + 'XX')).length, 0);
  });

  /* El candado de `internal` tiene que cerrar por los DOS lados. Con la comprobación
   * viviendo sólo acá, la DISA ya no podía pisar un código de función, pero publicar el
   * código de función seguía borrando la DISA: `setDialplan()` es DELETE + INSERT, así que
   * era exactamente el mismo error en espejo. Por eso la pregunta «¿quién ocupa esta
   * extensión de internal?» es una sola (`dueno-internal.js`) y la hacen los dos módulos. */
  await t.test('el candado de `internal` es simétrico: el código de función tampoco pisa a la DISA', async () => {
    const disa = await filas(ctx, '*31');
    assert.ok(disa.length > 0, 'la DISA tiene que estar publicada en *31');

    /* Antes que nada, el chequeo de la fila PROPIA: reconocer «ésta es mía, la voy a
     * reescribir» no puede saltearse los que vienen después. Con un `return` en vez de un
     * `continue`, cambiarle el nombre a la DISA republicaba su dialplan sin mirar si
     * mientras tanto le habían puesto un código de función —o un interno— en ese número. */
    await ctx.db.query("UPDATE pbxng_featurecodes SET code='*31' WHERE accion='dnd_off'");
    const editar = await api('PUT', '/api/disa/' + disaId, { token: admin, body: { nombre: 'DISA oficina' } });
    assert.equal(editar.status, 409, JSON.stringify(editar.json));
    assert.match(String(editar.json.error), /código de función/, JSON.stringify(editar.json));
    await ctx.db.query("UPDATE pbxng_featurecodes SET code='*79' WHERE accion='dnd_off'");
    // Y sin ese choque la misma edición pasa: nunca 409 contra el dialplan propio.
    assert.equal((await api('PUT', '/api/disa/' + disaId, { token: admin, body: { nombre: 'DISA oficina' } })).status, 200);

    // Ida: mover el código encima de la DISA se rechaza aunque el código NO esté instalado.
    // El catálogo es la fuente: dejarlo pasar era postergar el destrozo al próximo install.
    const mover = await api('PUT', '/api/featurecodes', { token: admin, body: { codes: [{ accion: 'dnd_on', code: '*31' }] } });
    assert.equal(mover.status, 409, JSON.stringify(mover.json));
    assert.match(String(mover.json.error), /DISA/, JSON.stringify(mover.json));
    const cat = await api('GET', '/api/featurecodes', { token: admin });
    assert.equal(cat.json.find((f) => f.accion === 'dnd_on').code, '*78', 'la transacción vuelve atrás entera');

    // Y si el choque ya viene de una central vieja (el catálogo se movió cuando todavía no
    // había candado), instalar tampoco publica encima: antes se llevaba la DISA en silencio.
    await ctx.db.query("UPDATE pbxng_featurecodes SET code='*31' WHERE accion='dnd_on'");
    const inst = await api('POST', '/api/featurecodes/install', { token: admin });
    assert.equal(inst.status, 409, JSON.stringify(inst.json));
    assert.deepEqual(await filas(ctx, '*31'), disa, 'el dialplan de la DISA sigue intacto');
    /* Sigue siendo todo o nada, pero el mensaje tiene que servir para arreglarlo: nombra el
     * código culpable. Antes decía «ese número ya lo usa una DISA» y el que apretaba
     * «Reinstalar todos» se quedaba sin catálogo y sin saber cuál de los quince era. */
    assert.match(String(inst.json.error), /\*31/, JSON.stringify(inst.json));
    assert.equal((await filas(ctx, '*97')).length, 0, 'si uno choca no se instala NINGUNO');
    /* Y con DOS choques los nombra a los dos: de a uno por vuelta, el administrador necesita
     * tantos intentos como aplicaciones pisadas para enterarse de todas. */
    await ctx.db.query("UPDATE pbxng_featurecodes SET code='*32' WHERE accion='dnd_off'");
    await ctx.db.query("INSERT INTO pbxng_disa (nombre,exten,pin_hash) VALUES ('Otra','*32','x')");
    const dos = await api('POST', '/api/featurecodes/install', { token: admin });
    assert.equal(dos.status, 409, JSON.stringify(dos.json));
    for (const c of ['*31', '*32']) assert.match(String(dos.json.error), new RegExp('\\' + c), JSON.stringify(dos.json));
    await ctx.db.query("DELETE FROM pbxng_disa WHERE exten='*32'");
    await ctx.db.query("UPDATE pbxng_featurecodes SET code='*79' WHERE accion='dnd_off'");
    await ctx.db.query("UPDATE pbxng_featurecodes SET code='*78' WHERE accion='dnd_on'");

    // Vuelta: con los códigos instalados, la DISA sigue sin poder pisar el buzón de voz.
    assert.equal((await api('POST', '/api/featurecodes/install', { token: admin })).status, 200);
    const buzon = await filas(ctx, '*97');
    assert.ok(buzon.length > 0, 'el buzón tiene que estar publicado en *97');
    const pisa = await api('PUT', '/api/disa/' + disaId, { token: admin, body: { exten: '*97' } });
    assert.equal(pisa.status, 409, JSON.stringify(pisa.json));
    assert.deepEqual(await filas(ctx, '*97'), buzon, 'el dialplan del buzón sigue intacto');

    /* El `_` es del dialplan y no del código (pbx_realtime sólo trata como patrón a las
     * filas que empiezan con guión bajo): un código de función guardado SIN guión bajo
     * ocupa igual la extensión `_*75XX` con la que se publica el patrón de los abreviados
     * personales. Preguntándolo al revés —`code = '_' || $1`— esto no daba 409 y el patrón
     * de abreviados se publicaba encima del código de función. */
    assert.equal((await api('PUT', '/api/featurecodes', { token: admin, body: { codes: [{ accion: 'dnd_on', code: '*75XX' }] } })).status, 200);
    const fc = await filas(ctx, '_*75XX');
    assert.ok(fc.length > 0, 'el código de función quedó publicado como patrón');
    const choque = await api('PUT', '/api/extensions/1001/abreviados', { token: admin, body: { entradas: [{ code: '01', destino: '099123456' }] } });
    assert.equal(choque.status, 409, JSON.stringify(choque.json));
    assert.match(String(choque.json.error), /código de función/, JSON.stringify(choque.json));
    assert.deepEqual(await filas(ctx, '_*75XX'), fc, 'y el código de función sigue entero');

    // Se deja el plan de marcado como estaba para el resto de las pruebas.
    assert.equal((await api('PUT', '/api/featurecodes', { token: admin, body: { codes: [{ accion: 'dnd_on', code: '*78' }] } })).status, 200);
    assert.equal((await api('POST', '/api/featurecodes/uninstall', { token: admin })).status, 200);
  });

  await t.test('roles: el registro de uso lo ve el supervisor, la configuración no', async () => {
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'supm', password: 'Clave-supm-123', role: 'supervisor' } })).status, 201);
    const sup = (await login('supm', 'Clave-supm-123')).token;
    assert.equal((await api('GET', '/api/disa/registro', { token: sup })).status, 200);
    assert.equal((await api('GET', '/api/callback/registro', { token: sup })).status, 200);
    assert.equal((await api('GET', '/api/disa', { token: sup })).status, 403);
    assert.equal((await api('PUT', '/api/dialbyname', { token: sup, body: { enabled: false } })).status, 403);
    assert.equal((await api('POST', '/api/abreviados', { token: sup, body: { code: '81', destino: '1001' } })).status, 403);
  });
});
