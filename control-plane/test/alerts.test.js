/* ============================================================================
 *  Motor de alertas por correo (alerts.js), contra una base efímera y un SMTP falso.
 *
 *  Lo que importa del motor es que NO inunde: una alerta por transición, no una por
 *  vuelta; throttle por evento y clave; y la primera vuelta de cada chequeo sólo aprende.
 *  Las pruebas llaman a `tick()` a mano y cambian lo que ven los chequeos entre vuelta y
 *  vuelta (troncales, nodos, rutas, servicios) para mirar exactamente qué correo sale.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { baseEfimera, motivoSinDb } = require('./helpers/db');
const { smtpFalso } = require('./helpers/smtp-falso');

const asuntos = (x) => (x.mensajes || x).map((m) => {
  const l = m.data.split('\n'); const i = l.findIndex((x) => /^Subject:/.test(x));
  let s = l[i]; for (let j = i + 1; j < l.length && /^\s/.test(l[j]); j++) s += l[j];
  /* Los asuntos con acentos viajan como =?UTF-8?Q?…?=: se decodifican para poder leerlos. */
  return s.replace(/^Subject:\s*/, '').replace(/=\?UTF-8\?Q\?(.*?)\?=\s*/gi, (_m, q) =>
    Buffer.from(q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
});

test('alertas: throttle, transiciones, fraude, colas y resumen diario', async (t) => {
  const db = await baseEfimera();
  if (!db) { t.skip('prueba de integración salteada: ' + motivoSinDb()); return; }
  const smtp = await smtpFalso();
  t.after(async () => { await smtp.cerrar(); await db.cerrar(); });

  const alerts = require('../alerts');
  /* init() deja relojes de 30 s y 60 s: se arman con relojes de mentira y se tiran, así el
   * proceso de prueba no queda vivo por ellos y los chequeos corren sólo cuando se piden. */
  const vivo = { trunks: {}, nodos: [], rutas: [], colas: [], state: { ari: true, ami: true }, geo: {} };
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  alerts.init(db.pool, {
    trunkHealth: async () => { if (vivo.trunks === 'roto') throw new Error('x'); return vivo.trunks; },
    saludNodos: async () => vivo.nodos,
    rutasFailover: async () => vivo.rutas,
    getQueues: async () => vivo.colas,
    geoLookup: async (ips) => Object.fromEntries(ips.map((ip) => [ip, vivo.geo[ip]])),
    state: vivo.state,
  });
  t.mock.timers.reset();

  const regla = (event, campos) => db.query(
    'UPDATE pbxng_alert_rules SET enabled=$2, recipients=$3, params=$4, throttle_min=$5 WHERE event=$1',
    [event, campos.enabled !== false, campos.to || null, JSON.stringify(campos.params || {}), campos.throttle == null ? 0 : campos.throttle]);
  const apagarTodo = () => db.query('UPDATE pbxng_alert_rules SET enabled=false');
  const enviadas = async (event) => (await db.query('SELECT * FROM pbxng_alerts WHERE event=$1 ORDER BY id', [event])).rows;

  await t.test('raise: sin regla, apagada, sin destinatario o sin SMTP no manda nada', async () => {
    assert.equal(await alerts.raise('no.existe', { title: 'x' }), false);
    await apagarTodo();
    assert.equal(await alerts.raise('trunk.down', { title: 'x' }), false, 'regla apagada');
    await regla('trunk.down', {});
    assert.equal(await alerts.raise('trunk.down', { title: 'x' }), false, 'sin destinatario');
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('alert_to','guardia@ejemplo.uy') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    assert.equal(await alerts.raise('trunk.down', { title: 'x' }), false, 'sin SMTP');
    await db.query('INSERT INTO pbxng_email_config (tenant_id,host,port,secure,from_addr,enabled) VALUES (1,$1,$2,false,$3,true) ON CONFLICT (tenant_id) DO UPDATE SET host=$1, port=$2, from_addr=$3, enabled=true', [smtp.host, smtp.port, 'central@ejemplo.uy']);
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('domain','pbx.ejemplo.uy'),('brand_name','Portería Sur') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
  });

  await t.test('raise: manda, respeta el throttle por clave, y el destinatario de la regla gana al global', async () => {
    smtp.olvidar();
    await regla('trunk.down', { throttle: 30, to: 'noc@ejemplo.uy' });
    assert.equal(await alerts.raise('trunk.down', { severity: 'crit', title: 'Troncal caída: antel', lines: [['Troncal', 'antel']], key: 'antel' }), true);
    assert.equal(await alerts.raise('trunk.down', { title: 'Otra vez', key: 'antel' }), false, 'dentro de la ventana no se repite');
    assert.equal(await alerts.raise('trunk.down', { title: 'Otra troncal', key: 'movistar' }), true, 'otra clave sí');
    assert.equal(await alerts.raise('trunk.down', { title: 'Forzada', key: 'antel', force: true }), true, 'la prueba manual ignora el throttle');
    assert.equal(await alerts.raise('trunk.down', { title: 'A otro', to: 'jefe@ejemplo.uy', force: true }), true);
    await smtp.esperar(4);
    assert.deepEqual(smtp.mensajes.map((m) => m.to[0]), ['noc@ejemplo.uy', 'noc@ejemplo.uy', 'noc@ejemplo.uy', 'jefe@ejemplo.uy']);
    assert.match(asuntos(smtp)[0], /\[Portería Sur\] 🔴 Troncal caída: antel/);
    assert.match(smtp.mensajes[0].data, /pbx\.ejemplo\.uy\/monitor/);
    const h = await enviadas('trunk.down');
    assert.equal(h.length, 4);
    assert.ok(h.every((x) => x.sent));
  });

  await t.test('raise: si el SMTP rechaza, queda en el historial con el error', async () => {
    await regla('service.down', {});
    smtp.olvidar();
    await db.query("UPDATE pbxng_email_config SET username='u', password='p'");
    smtp.rechazar();
    assert.equal(await alerts.raise('service.down', { title: 'falla' }), false);
    const h = await enviadas('service.down');
    assert.equal(h.at(-1).sent, false);
    assert.match(h.at(-1).err, /535|Username and Password/);
    await db.query('UPDATE pbxng_email_config SET username=NULL, password=NULL');
  });

  await t.test('login: avisa la IP nueva una sola vez; los fallidos sólo al llegar al umbral', async () => {
    await apagarTodo();
    await alerts.onLogin({ ok: true, username: 'ana', ip: '200.1.1.1' });   // regla apagada: ni aprende
    await regla('auth.login', { params: { only_new_ip: true } });
    vivo.geo['200.1.1.1'] = { city: 'Montevideo', country: 'UY', isp: 'Antel' };
    smtp.olvidar();
    await alerts.onLogin({ ok: true, username: 'ana', ip: '200.1.1.1', role: 'agente', ua: 'Firefox' });
    await alerts.onLogin({ ok: true, username: 'ana', ip: '200.1.1.1' });
    await alerts.onLogin({ ok: true, username: 'ana', ip: '10.0.0.5' });
    await smtp.esperar(2);
    const a = asuntos(smtp);
    assert.equal(a.length, 2, 'la IP de siempre no vuelve a avisar');
    assert.match(a[0], /IP nueva: ana/);
    assert.match(smtp.mensajes[0].data, /Montevideo/);
    assert.match(smtp.mensajes[1].data, /red interna/, 'una IP privada no se geolocaliza');
    await regla('auth.login', { params: { only_new_ip: false } });
    smtp.olvidar();
    await alerts.onLogin({ ok: true, username: 'ana', ip: '200.1.1.1' });
    assert.match(asuntos(await smtp.esperar(1))[0], /Inicio de sesión: ana/);

    await regla('auth.login_failed', { params: { attempts: 3, window_min: 10 } });
    smtp.olvidar();
    for (let i = 0; i < 2; i++) await alerts.onLogin({ ok: false, username: 'root', ip: '45.1.1.1' });
    assert.equal(smtp.mensajes.length, 0);
    await alerts.onLogin({ ok: false, username: 'root', ip: '45.1.1.1' });
    assert.match(asuntos(await smtp.esperar(1))[0], /3 intentos fallidos/);
  });

  await t.test('tick: troncales y servicios avisan sólo en la transición, y la primera vuelta aprende', async () => {
    await apagarTodo();
    await regla('trunk.down', {}); await regla('service.down', {});
    await db.query("DELETE FROM pbxng_alert_state WHERE key IN ('trunks','svc','nodos')");
    vivo.trunks = { antel: { status: 'online' } };
    vivo.nodos = [{ id: 'turn', nombre: 'TURN', host: '10.0.0.3', puerto: 3478, estado: 'ok' }, { id: 'sbc', nombre: 'SBC-NG', rol: 'borde-externo', host: '1.2.3.4', puerto: 5060, estado: 'ok', papel: 'borde' }];
    smtp.olvidar();
    await alerts.tick();
    assert.equal(smtp.mensajes.length, 0, 'la primera vuelta sólo aprende');

    vivo.trunks = { antel: { status: 'offline', detail: 'timeout' } };
    vivo.state.ami = false;
    vivo.nodos[0].estado = 'caido'; vivo.nodos[0].motivo = 'no responde'; vivo.nodos[1].estado = 'caido';
    await alerts.tick();
    await alerts.tick();   // nada cambió: no se repite
    await smtp.esperar(4);
    let a = asuntos(smtp);
    assert.equal(a.length, 4, a.join(' | '));
    assert.ok(a.some((s) => /Troncal caída: antel/.test(s)));
    assert.ok(a.some((s) => /Servicio caído: Asterisk \(AMI\)/.test(s)));
    assert.ok(a.some((s) => /Componente caido: TURN/.test(s)));
    assert.ok(smtp.mensajes.some((m) => /otro producto/.test(m.data)), 'el borde externo se aclara que es otro producto');

    smtp.olvidar();
    vivo.trunks = { antel: { status: 'online' } };
    vivo.state.ami = true;
    vivo.nodos.forEach((n) => { n.estado = 'ok'; });
    await alerts.tick();
    await smtp.esperar(4);
    a = asuntos(smtp);
    assert.ok(a.some((s) => /Troncal recuperada: antel/.test(s)));
    assert.ok(a.some((s) => /Servicio recuperado/.test(s)));
    assert.equal(a.filter((s) => /Componente recuperado/.test(s)).length, 2);

    vivo.trunks = 'roto';
    await alerts.tick();   // si el estado de las troncales no se puede leer, no rompe
    vivo.trunks = {};
  });

  await t.test('tick: failover por transición — respaldo, sin salida, vuelta a la principal y salida del SBC', async () => {
    await apagarTodo();
    await regla('trunk.failover', {});
    const ruta = (en_uso, sin_salida) => [{ id: 1, name: 'Celulares', pattern: '09XXXXXXX', principal: 'to-sbc', backups: ['antel', 'movistar'], en_uso, sin_salida },
      { id: 2, name: 'Sin respaldo', pattern: 'X.', principal: 'antel', backups: [], en_uso: 'antel' }];
    vivo.rutas = ruta('to-sbc');
    smtp.olvidar();
    await alerts.tick();
    vivo.rutas = ruta('antel'); await alerts.tick();
    vivo.rutas = ruta('antel'); await alerts.tick();
    vivo.rutas = ruta('', true); await alerts.tick();
    vivo.rutas = ruta('to-sbc'); await alerts.tick();
    await smtp.esperar(3);
    const a = asuntos(smtp);
    assert.equal(a.length, 3, a.join(' | '));
    assert.match(a[0], /saliendo por el respaldo antel/);
    assert.match(smtp.mensajes[0].data, /YA NO pasan por el SBC-NG/);
    assert.match(a[1], /Sin salida: la ruta Celulares/);
    assert.match(a[2], /volvió a la troncal principal/);
    assert.match(smtp.mensajes[2].data, /ninguna/, 'venía sin salida');
    vivo.rutas = [];
  });

  await t.test('tick: ataque agregado por ventana', async () => {
    await apagarTodo();
    await regla('security.attack', { params: { window_min: 1, failed: 5 } });
    await db.query("INSERT INTO pbxng_alert_state (key,value) VALUES ('sec', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify({ failed_at: Math.floor(Date.now() / 60000) - 5 })]);
    await db.query("INSERT INTO pbxng_sec_events (kind, severity, detail) VALUES ('fallo','warn','{\"n\":4,\"ip\":\"45.1.1.1\"}'),('fallo','warn','{\"n\":3,\"ip\":\"45.1.1.2\"}')");
    smtp.olvidar();
    await alerts.tick();
    assert.match(asuntos(await smtp.esperar(1))[0], /Ataque en curso: 7 intentos/);
    smtp.olvidar();
    await alerts.tick();   // la ventana recién empezó: no se vuelve a contar
    assert.equal(smtp.mensajes.length, 0);
  });

  await t.test('tick: fraude — llamada larga, ráfaga fuera de hora e internacional no permitida', async () => {
    await apagarTodo();
    const h = new Date().getHours();
    await regla('fraud.long_call', { params: { minutes: 30 } });
    await regla('fraud.after_hours', { params: { from_hour: h, to_hour: (h + 1) % 24, window_min: 30, calls: 2 } });
    await regla('fraud.international', { params: { prefixes: '00', allow: '0054' } });
    const cdr = (src, dst, billsec, ctx) => db.query("INSERT INTO cdr (start, src, dst, billsec, duration, dcontext, disposition, uniqueid, linkedid) VALUES (now() - interval '1 minute', $1, $2, $3, $3, $4, 'ANSWERED', md5(random()::text), 'x')", [src, dst, billsec, ctx]);
    await cdr('2001', '0034911222333', 40 * 60, 'internal');
    await cdr('2002', '0054111222333', 10, 'internal');
    await cdr('099', '2001', 50 * 60, 'from-trunk');
    smtp.olvidar();
    await alerts.tick();
    await smtp.esperar(3);
    const a = asuntos(smtp);
    assert.ok(a.some((s) => /Llamada saliente de 40 minutos/.test(s)), a.join(' | '));
    assert.ok(a.some((s) => /2 llamadas salientes fuera de horario/.test(s)));
    assert.ok(a.some((s) => /Llamada internacional: 0034911222333/.test(s)));
    assert.equal(a.some((s) => /0054/.test(s)), false, 'un prefijo permitido no avisa');
    assert.equal(a.some((s) => /50 minutos/.test(s)), false, 'una entrante larga no es fraude');
    await db.query('DELETE FROM cdr');
  });

  await t.test('tick: cola sin agentes en horario laboral, y nada el fin de semana', async () => {
    await apagarTodo();
    await regla('queue.no_agents', { params: { from_hour: 0, to_hour: 24 } });
    vivo.colas = [{ name: 'ventas', label: 'Ventas', agents_online: 0, agents_total: 3 }, { name: 'soporte', agents_online: 2 }];
    const miercoles = new Date(2026, 9, 7, 11, 0, 0), domingo = new Date(2026, 9, 11, 11, 0, 0);
    smtp.olvidar();
    t.mock.timers.enable({ apis: ['Date'], now: domingo });
    try { await alerts.tick(); } finally { t.mock.timers.reset(); }
    assert.equal(smtp.mensajes.length, 0, 'el domingo no se avisa');
    t.mock.timers.enable({ apis: ['Date'], now: miercoles });
    try { await alerts.tick(); } finally { t.mock.timers.reset(); }
    const a = asuntos(await smtp.esperar(1));
    assert.equal(a.length, 1);
    assert.match(a[0], /Cola sin agentes: Ventas/);
    vivo.colas = [];
  });

  await t.test('tick: el resumen diario sale una vez por día, con TODAS las tarjetas', async () => {
    await apagarTodo();
    await regla('digest.daily', { params: { hour: new Date().getHours() } });
    await db.query("DELETE FROM pbxng_alert_state WHERE key='digest'");
    await db.query("INSERT INTO cdr (start, src, dst, billsec, duration, dcontext, disposition, uniqueid, linkedid) VALUES (current_date - interval '12 hours', '2001', '099', 30, 30, 'internal', 'ANSWERED', 'd1', 'd1')");
    smtp.olvidar();
    await alerts.tick();
    await alerts.tick();
    const m = await smtp.esperar(1);
    assert.equal(m.length, 1, 'una sola vez por día');
    assert.match(asuntos(smtp)[0], /Resumen de ayer · 1 llamadas/);
    for (const kpi of ['Llamadas totales', 'Mensajes de voz enviados', 'IPs bloqueadas', 'Intentos fallidos']) {
      assert.match(m[0].data.replace(/=\r?\n/g, ''), new RegExp(kpi), kpi + ': el correo no puede cortar tarjetas');
    }
    assert.match(m[0].data, /Top interno 1/);
  });
});
