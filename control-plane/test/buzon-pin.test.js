/* Integración · el PIN del buzón de voz (vmpin.js + las rutas /api/mailboxes de apps.js)
 * contra la API real y un PostgreSQL efímero. Sin Postgres se saltea.
 *
 * Lo que se cuida acá es la regresión concreta que había: el buzón nacía con
 * `password = mailbox`, o sea sin PIN, y con `*98` cualquiera escuchaba los mensajes de
 * cualquiera. Asterisk NO está: el buzón vive en la tabla realtime `voicemail`, que es
 * Postgres, así que todo esto se verifica sin central. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

test('buzón de voz: el PIN nace al azar, no se muestra en el listado y se puede rotar', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  await t.test('crear un interno deja el buzón con PIN al azar, nunca con el número', async () => {
    const cre = await api('POST', '/api/endpoints', { token: admin, body: { id: '1001', password: 'Clave-sip-1001' } });
    assert.equal(cre.status, 201, JSON.stringify(cre.json));
    const { rows } = await ctx.db.query("SELECT password FROM voicemail WHERE mailbox='1001' AND context='default'");
    assert.equal(rows.length, 1, 'el alta del interno tiene que crear su buzón');
    assert.notEqual(rows[0].password, '1001', 'el PIN del buzón NO puede ser el número del interno');
    assert.match(String(rows[0].password), /^[0-9]{6}$/);
    /* Y el PIN VUELVE en la respuesta del alta. Si no, nadie lo ve nunca: el buzón recién
     * creado todavía no tiene correo configurado, así que no hay a quién avisarle. */
    assert.equal(cre.json.vm_mailbox, '1001');
    assert.equal(cre.json.vm_pin, rows[0].password, 'el alta tiene que devolver el PIN que quedó en la base');
  });

  await t.test('recrear el interno NO le rota el PIN ni lo devuelve', async () => {
    const { rows: antes } = await ctx.db.query("SELECT password FROM voicemail WHERE mailbox='1001' AND context='default'");
    await api('DELETE', '/api/endpoints/1001', { token: admin });
    const cre = await api('POST', '/api/endpoints', { token: admin, body: { id: '1001', password: 'Clave-sip-1001' } });
    assert.equal(cre.status, 201, JSON.stringify(cre.json));
    const { rows: desp } = await ctx.db.query("SELECT password FROM voicemail WHERE mailbox='1001' AND context='default'");
    assert.equal(desp[0].password, antes[0].password, 'reaprovisionar un teléfono no puede dejar al dueño afuera de su buzón');
    assert.equal(cre.json.vm_pin, null, 'el PIN de un buzón que ya existía no lo generamos nosotros: sale por el detalle, que es admin');
  });

  await t.test('POST /api/mailboxes sin PIN genera uno y lo devuelve UNA vez', async () => {
    const r = await api('POST', '/api/mailboxes', { token: admin, body: { mailbox: '2001', fullname: 'Portería' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.match(String(r.json.pin), /^[0-9]{6}$/);
    assert.notEqual(r.json.pin, '2001');
    // El PIN escrito a mano se acepta, pero no el número del buzón ni uno de tres dígitos.
    assert.equal((await api('POST', '/api/mailboxes', { token: admin, body: { mailbox: '2002', password: '2002' } })).status, 400);
    assert.equal((await api('POST', '/api/mailboxes', { token: admin, body: { mailbox: '2002', password: '123' } })).status, 400);
    assert.equal((await api('POST', '/api/mailboxes', { token: admin, body: { mailbox: '2002', password: '4488' } })).status, 201);
  });

  await t.test('el listado no trae el PIN; el detalle sí, y sólo admin', async () => {
    const lista = await api('GET', '/api/mailboxes', { token: admin });
    assert.equal(lista.status, 200);
    const b = lista.json.find((x) => x.mailbox === '2001');
    assert.ok(b, 'el buzón creado tiene que estar en el listado');
    assert.equal(b.pin, undefined, 'el PIN no viaja en un listado que se mira de a diez');
    assert.equal(b.pin_debil, false);
    const det = await api('GET', '/api/mailboxes/2001', { token: admin });
    assert.equal(det.status, 200);
    assert.match(String(det.json.pin), /^[0-9]{6}$/);
    assert.equal((await api('GET', '/api/mailboxes/9999', { token: admin })).status, 404);

    // Un supervisor puede con los buzones ajenos, pero NO con el PIN: con el PIN se
    // escuchan los mensajes de otro marcando *98, y eso no deja rastro en ningún lado.
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'sup', password: 'Clave-sup-123', role: 'supervisor' } })).status, 201);
    const sup = (await login('sup', 'Clave-sup-123')).token;
    assert.equal((await api('GET', '/api/mailboxes/2001', { token: sup })).status, 403);
    assert.equal((await api('POST', '/api/mailboxes/2001/pin', { token: sup, body: {} })).status, 403);
  });

  await t.test('un buzón viejo con PIN = número se marca débil y se rota a pedido', async () => {
    // Así quedaron los buzones de las centrales instaladas antes de este arreglo. NINGUNA
    // migración los toca: rotarlos a ciegas deja al dueño afuera de sus propios mensajes.
    await ctx.db.query("INSERT INTO voicemail (context, mailbox, password, fullname) VALUES ('default','3001','3001','Viejo')");
    const lista = await api('GET', '/api/mailboxes', { token: admin });
    assert.equal(lista.json.find((x) => x.mailbox === '3001').pin_debil, true);

    const rot = await api('POST', '/api/mailboxes/3001/pin', { token: admin, body: {} });
    assert.equal(rot.status, 200, JSON.stringify(rot.json));
    assert.match(String(rot.json.pin), /^[0-9]{6}$/);
    const { rows } = await ctx.db.query("SELECT password FROM voicemail WHERE mailbox='3001' AND context='default'");
    assert.equal(rows[0].password, rot.json.pin, 'lo que se le muestra al operador es lo que quedó en la base');
    const lista2 = await api('GET', '/api/mailboxes', { token: admin });
    assert.equal(lista2.json.find((x) => x.mailbox === '3001').pin_debil, false);
    assert.equal((await api('POST', '/api/mailboxes/9999/pin', { token: admin, body: {} })).status, 404);
  });

  /* La rotación EN LOTE es el camino para una central que ya venía andando con TODOS los
   * buzones en `password = mailbox`: el administrador decide cuándo, y lo hace de un saque. */
  await t.test('rotación en lote: sólo los débiles, con lista explícita, y nunca «todos» por omisión', async () => {
    for (const mb of ['4001', '4002', '4003']) {
      await ctx.db.query("INSERT INTO voicemail (context, mailbox, password, fullname) VALUES ('default',$1,$1,'Heredado')", [mb]);
    }
    // Sin decir qué rotar no se rota nada: un POST vacío que le cambie el PIN a la central
    // entera es justo el accidente que esto viene a evitar.
    assert.equal((await api('POST', '/api/mailboxes/rotar-pin', { token: admin, body: {} })).status, 400);

    const soloUno = await api('POST', '/api/mailboxes/rotar-pin', { token: admin, body: { mailboxes: ['4001', '9999'] } });
    assert.equal(soloUno.status, 200, JSON.stringify(soloUno.json));
    assert.equal(soloUno.json.rotados, 1, 'el buzón que no existe no rompe el lote, sale como fila con error');
    const f4001 = soloUno.json.resultados.find((r) => r.mailbox === '4001');
    assert.equal(f4001.ok, true);
    // Sin SMTP configurado no se puede avisar, así que el PIN vuelve para que el operador
    // lo dicte. A los que SÍ se les avisó no vuelve (ver el comentario de la ruta).
    assert.equal(f4001.avisado, false);
    assert.match(String(f4001.pin), /^[0-9]{6}$/);
    assert.equal(soloUno.json.resultados.find((r) => r.mailbox === '9999').ok, false);
    const { rows: q1 } = await ctx.db.query("SELECT password FROM voicemail WHERE mailbox='4001' AND context='default'");
    assert.equal(q1[0].password, f4001.pin);

    const debiles = await api('POST', '/api/mailboxes/rotar-pin', { token: admin, body: { solo_debiles: true } });
    assert.equal(debiles.status, 200, JSON.stringify(debiles.json));
    const tocados = debiles.json.resultados.filter((r) => r.ok).map((r) => r.mailbox);
    assert.ok(tocados.includes('4002') && tocados.includes('4003'), 'los heredados tienen que entrar');
    assert.ok(!tocados.includes('4001'), 'el que ya se rotó dejó de ser débil y no se vuelve a tocar');
    // Cada buzón lleva SU PIN: uno común sería no tener PIN.
    const pines = debiles.json.resultados.filter((r) => r.ok).map((r) => r.pin);
    assert.equal(new Set(pines).size, pines.length);
    const lista = await api('GET', '/api/mailboxes', { token: admin });
    assert.equal(lista.json.filter((x) => x.pin_debil).length, 0, 'después del lote no queda ningún buzón débil');

    // Es admin, como la rotación de a uno: de un saque le cambia el PIN a toda la central.
    const sup = (await login('sup', 'Clave-sup-123')).token;
    assert.equal((await api('POST', '/api/mailboxes/rotar-pin', { token: sup, body: { solo_debiles: true } })).status, 403);
  });
});
