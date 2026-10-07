/* ============================================================================
 *  Motor de alertas (alerts.js) en unidad: base, SMTP y reloj de mentira.
 *
 *  test/alerts.test.js recorre el motor contra Postgres y un SMTP falso. Acá se fijan
 *  los bordes que allá no aparecen y que hacen a que el correo salga y diga algo útil
 *  aun con datos incompletos:
 *   - sin marca, sin dominio, sin puerto o sin remitente se usan los valores por defecto
 *     (y con usuario SMTP se autentica);
 *   - una regla con `params` vacío usa sus umbrales por defecto en cada chequeo;
 *   - las fuentes que fallan (salud de troncales, rutas, nodos, colas, geolocalización,
 *     la base misma) no tiran el tick: el chequeo se saltea o informa «—»;
 *   - el failover distingue «volvió a la principal», «sin salida» y «dejó el SBC»,
 *     y nombra «ninguna» cuando venía de quedarse sin salida;
 *   - fuera de horario y colas sin agentes dependen de la hora local, que acá se fija;
 *   - el resumen diario sale una vez por día, a la hora pedida, aun con la base vacía.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const alerts = require('../alerts');

/* Base en memoria que entiende las consultas del motor. `romper` hace fallar las que
 * matcheen la expresión, para ver qué hace el motor cuando la base no contesta. */
function baseFalsa(o = {}) {
  const db = {
    rules: {}, state: {}, settings: {}, email: { host: 'smtp.local', enabled: true },
    alertas: [], cdrLargas: [], cdrFuera: [{ n: 0 }], cdrRecientes: [], sec: [{ fallos: 0, ips: 0 }], bloqueadas: [{ n: 0 }],
    digest: { tot: [], top: [], bans: [], vm: [] }, romper: null, ...o,
  };
  db.query = async (sql, args = []) => {
    if (db.romper && db.romper.test(sql)) throw new Error('base caída');
    if (/FROM pbxng_alert_rules/.test(sql)) return { rows: db.rules[args[0]] ? [db.rules[args[0]]] : [] };
    if (/FROM pbxng_alert_state/.test(sql)) return { rows: args[0] in db.state ? [{ value: db.state[args[0]] }] : [] };
    if (/INTO pbxng_alert_state/.test(sql)) { db.state[args[0]] = JSON.parse(args[1]); return { rowCount: 1 }; }
    if (/FROM pbxng_settings WHERE key='(\w+)'/.test(sql)) { const k = /key='(\w+)'/.exec(sql)[1]; return { rows: db.settings[k] ? [{ value: db.settings[k] }] : [] }; }
    if (/FROM pbxng_email_config/.test(sql)) return { rows: db.email ? [db.email] : [] };
    if (/INSERT INTO pbxng_alerts/.test(sql)) { db.alertas.push(args); return { rowCount: 1 }; }
    if (/FROM pbxng_sec_events WHERE kind='fallo' AND created_at > now/.test(sql)) return { rows: db.sec };
    if (/^SELECT count\(\*\)::int AS n FROM pbxng_blocked/.test(sql)) return { rows: db.bloqueadas };
    if (/^SELECT 1$/.test(sql)) return { rows: [{}] };
    if (/billsec > \$1/.test(sql)) return { rows: db.cdrLargas };
    if (/count\(\*\)::int n FROM cdr WHERE start > now/.test(sql)) return { rows: db.cdrFuera };
    if (/interval '5 minutes'/.test(sql)) return { rows: db.cdrRecientes };
    if (/avg_talk/.test(sql)) return { rows: db.digest.tot };
    if (/GROUP BY src/.test(sql)) return { rows: db.digest.top };
    if (/pbxng_blocked\) b/.test(sql)) return { rows: db.digest.bans };
    if (/pbxng_vm_sent/.test(sql)) return { rows: db.digest.vm };
    throw new Error('consulta inesperada: ' + sql.slice(0, 80));
  };
  db.regla = (event, campos = {}) => { db.rules[event] = { event, enabled: true, recipients: 'guardia@ejemplo.uy', params: null, throttle_min: 0, ...campos }; };
  return db;
}

function armar(t, db, deps = {}, ahora = new Date(2026, 9, 6, 3, 0, 0)) {   // martes 6/10, 03:00 local
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: ahora.getTime() });
  const enviados = [];
  t.mock.method(nodemailer, 'createTransport', (opts) => ({ sendMail: async (m) => { enviados.push({ opts, m }); } }));
  alerts.init(db, deps);
  return enviados;
}
/* Mueve el reloj SIN disparar los relojes del motor: si no, cada minuto adelantado corre
 * un tick() en paralelo con el que la prueba llama a mano. */
const adelantar = (t, ms) => t.mock.timers.setTime(Date.now() + ms);
const asuntos = (env) => env.map((e) => e.m.subject);
const linea = (env, i, k) => { const m = new RegExp('^' + k + ': (.*)$', 'm').exec(env[i].m.text); return m && m[1]; };

test('raise: valores por defecto de marca, dominio, puerto y remitente; con usuario SMTP autentica', async (t) => {
  const db = baseFalsa({ email: { host: 'smtp.local', enabled: true, username: 'central@ejemplo.uy', password: 'k' } });
  db.regla('trunk.down');
  const antes = process.env.DOMAIN;
  delete process.env.DOMAIN;
  t.after(() => { if (antes === undefined) delete process.env.DOMAIN; else process.env.DOMAIN = antes; });
  const env = armar(t, db);
  assert.equal(await alerts.raise('trunk.down', { severity: 'info', title: 'hola' }), true);
  assert.equal(env[0].opts.port, 587);
  assert.deepEqual(env[0].opts.auth, { user: 'central@ejemplo.uy', pass: 'k' });
  assert.equal(env[0].m.from, 'central@ejemplo.uy', 'sin remitente propio sale con el usuario SMTP');
  assert.equal(env[0].m.subject, '[PBX-NG] hola', 'sin marca: PBX-NG, y info no lleva emoji');
  assert.ok(!/https:\/\//.test(env[0].m.html), 'sin dominio no hay enlace al panel');
  process.env.DOMAIN = 'pbx.env.ejemplo';
  await alerts.raise('trunk.down', { title: 'otra' });
  assert.match(env[1].m.html, /https:\/\/pbx\.env\.ejemplo\/monitor/, 'el dominio del .env sirve de respaldo');
});

test('raise: si el envío falla queda registrado como no enviado (aunque registrar también falle)', async (t) => {
  const db = baseFalsa();
  db.regla('trunk.down');
  armar(t, db);
  t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async () => { throw new Error('550 rechazado'); } }));
  assert.equal(await alerts.raise('trunk.down', { title: 'x' }), false);
  assert.equal(db.alertas.at(-1)[4], '550 rechazado');
  db.romper = /pbxng_alert_rules|INSERT INTO pbxng_alerts/;
  assert.equal(await alerts.raise('trunk.down'), false, 'sin título y con la base caída tampoco revienta');
});

test('login: con only_new_ip=false avisa también la IP de siempre; geolocalización y errores', async (t) => {
  const db = baseFalsa();
  db.regla('auth.login', { params: { only_new_ip: false } });
  db.regla('auth.login_failed');
  const geo = { '200.1.1.1': { city: 'Montevideo', country: 'UY' }, '200.2.2.2': null };
  const env = armar(t, db, { geoLookup: async (ips) => { if (ips[0] === '200.9.9.9') throw new Error('geo caído'); return geo; } });
  await alerts.onLogin({ ok: true, username: 'ana', ip: '200.1.1.1' });
  await alerts.onLogin({ ok: true, username: 'ana', ip: '200.1.1.1', role: 'admin', ua: 'Firefox' });
  assert.equal(env.length, 2);
  assert.match(env[0].m.subject, /IP nueva: ana/);
  assert.match(env[1].m.subject, /Inicio de sesión: ana$/);
  assert.equal(linea(env, 0, 'Origen'), 'Montevideo · UY');
  assert.equal(linea(env, 0, 'Navegador'), '—');
  assert.equal(linea(env, 1, 'Usuario'), 'ana (admin)');
  await alerts.onLogin({ ok: true, username: 'ana', ip: '200.2.2.2' });
  assert.equal(linea(env, 2, 'Origen'), '—', 'la geo no conoce la IP');
  await alerts.onLogin({ ok: true, username: 'ana', ip: '200.9.9.9' });
  assert.equal(linea(env, 3, 'Origen'), '—', 'la geo falla: guion, no excepción');

  // Fallidos sin params: 3 en 10 min por defecto; sin usuario se agrupa como «?».
  for (let i = 0; i < 3; i++) await alerts.onLogin({ ok: false, ip: '10.0.0.7' });
  assert.match(env.at(-1).m.subject, /3 intentos fallidos/);
  assert.equal(linea(env, env.length - 1, 'Usuario probado'), '—');
  assert.equal(linea(env, env.length - 1, 'Origen'), 'red interna');
  assert.ok('?|10.0.0.7' in db.state.login_fails);

  const n = env.length;
  db.romper = /pbxng_alert_rules/;
  await alerts.onLogin({ ok: true, username: 'ana', ip: '1.1.1.1' });             // no tira
  assert.equal(env.length, n);
});

test('seguridad: defaults de ventana y umbral, y una base que no trae filas cuenta cero', async (t) => {
  const db = baseFalsa();
  db.regla('security.attack');
  db.state.sec = {};                                    // estado viejo, sin marca de tiempo
  const env = armar(t, db);
  db.sec = [];
  await alerts.tick();                                  // primera vuelta: aprende la marca
  assert.ok(db.state.sec.failed_at);
  adelantar(t, 11 * 60000);
  db.sec = [{ fallos: 25 }];
  db.bloqueadas = [];
  await alerts.tick();
  assert.equal(env.length, 1);
  assert.equal(linea(env, 0, 'IPs distintas'), '0');
  assert.equal(linea(env, 0, 'IPs bloqueadas'), '0');
  assert.equal(linea(env, 0, 'Ventana'), '10 min');
  adelantar(t, 11 * 60000);
  db.sec = [];
  await alerts.tick();
  assert.equal(env.length, 1, 'sin filas: cero fallos, nada que avisar');
});

test('troncales: fuente caída o vacía no avisa; una troncal sin detalle dice «—»', async (t) => {
  const db = baseFalsa();
  db.regla('trunk.down');
  let salud = null;
  const env = armar(t, db, { trunkHealth: async () => { if (salud === 'roto') throw new Error('x'); return salud; } });
  await alerts.tick();                                  // null: nada que mirar
  salud = 'roto';
  await alerts.tick();
  salud = { op1: { status: 'online' }, op2: null };
  await alerts.tick();
  salud = { op1: null, op2: { status: 'online' } };
  await alerts.tick();
  assert.deepEqual(asuntos(env).sort(), ['[PBX-NG] 🔴 Troncal caída: op1', '[PBX-NG] Troncal recuperada: op2'].sort());
  assert.equal(linea(env, env.findIndex((e) => /caída/.test(e.m.subject)), 'Detalle'), '—');
});

test('failover: sin salida, vuelta a la principal desde «ninguna», salida del SBC y fuentes rotas', async (t) => {
  const db = baseFalsa();
  db.regla('trunk.failover');
  let rutas = null;
  const env = armar(t, db, { rutasFailover: async () => { if (rutas === 'roto') throw new Error('x'); return rutas; } });
  const ruta = (extra) => ({ id: 1, pattern: '0X.', principal: 'to-sbc', backups: ['op1'], ...extra });
  await alerts.tick();                                  // null: lista vacía
  rutas = 'roto';
  await alerts.tick();
  rutas = [null, { id: 9, backups: [] }, ruta({ en_uso: 'to-sbc' }), ruta({ id: 2, name: 'Celulares', en_uso: '' })];
  await alerts.tick();                                  // aprende
  rutas = [ruta({ en_uso: 'op1' })];
  await alerts.tick();
  assert.match(env.at(-1).m.subject, /Ruta _0X\.: saliendo por el respaldo op1/, 'sin nombre se nombra por el patrón');
  assert.match(env.at(-1).m.text, /YA NO pasan por el SBC-NG/);
  rutas = [ruta({ sin_salida: true })];
  await alerts.tick();
  assert.match(env.at(-1).m.subject, /Sin salida: la ruta _0X\. agotó/);
  rutas = [ruta({ en_uso: 'to-sbc' })];
  await alerts.tick();
  assert.match(env.at(-1).m.subject, /volvió a la troncal principal/);
  assert.equal(linea(env, env.length - 1, 'Venía saliendo por'), 'ninguna');
  rutas = [ruta({ sin_salida: true })];
  await alerts.tick();
  rutas = [ruta({ en_uso: 'op1', backups: [''] })];
  await alerts.tick();
  assert.equal(linea(env, env.length - 1, 'Venía saliendo por'), 'ninguna');
  assert.equal(linea(env, env.length - 1, 'Respaldos'), '—');
  rutas = [ruta({ en_uso: 'op2', principal: 'op0', backups: ['op1', 'op2'] })];
  await alerts.tick();
  assert.match(env.at(-1).m.text, /La troncal principal no está cursando llamadas/, 'entre respaldos comunes no se habla del SBC');
});

test('servicios y nodos: la base caída se avisa; sin saludNodos o con la fuente rota se saltea', async (t) => {
  const db = baseFalsa();
  db.regla('service.down');
  const state = { ari: true, ami: true };
  let nodos = 'roto';
  const env = armar(t, db, { state, saludNodos: async () => { if (nodos === 'roto') throw new Error('x'); return nodos; } });
  await alerts.tick();                                   // aprende db/ari/ami; nodos rotos
  db.romper = /^SELECT 1$/;
  await alerts.tick();
  assert.match(env.at(-1).m.subject, /Servicio caído: Base de datos/);
  db.romper = null;
  nodos = [{ id: 'turn', estado: 'ok', nombre: 'TURN', host: 'h', puerto: 1 }];
  await alerts.tick();
  nodos = [{ id: 'turn', estado: 'caido', nombre: 'TURN', host: 'h', puerto: 1, rol: 'turn' }];
  await alerts.tick();
  assert.match(env.at(-1).m.subject, /Componente caido: TURN/);
  assert.equal(linea(env, env.length - 1, 'Motivo'), 'no responde');
  // Sin saludNodos: sólo los servicios del núcleo.
  const db2 = baseFalsa();
  db2.regla('service.down');
  alerts.init(db2, {});
  await alerts.tick();
  assert.deepEqual(Object.keys(db2.state), ['svc']);
  assert.deepEqual(db2.state.svc, { db: true, ari: false, ami: false });
});

test('fraude: umbrales por defecto, ventana que no cruza medianoche y destinos permitidos', async (t) => {
  const db = baseFalsa();
  db.regla('fraud.long_call');
  db.regla('fraud.after_hours');
  db.regla('fraud.international', { params: { allow: '0054, +598' } });
  const env = armar(t, db);
  db.cdrLargas = [{ src: '2001', dst: '099', billsec: 3600, start: new Date().toISOString() }];
  db.cdrFuera = [];                                      // fuera de hora (03:00 cae entre 22 y 6) pero sin filas: 0
  db.cdrRecientes = [
    { src: '2001', dst: '0034911', billsec: null, start: new Date().toISOString() },
    { src: '2001', dst: '005411', billsec: 4, start: new Date().toISOString() },
    { src: '2001', dst: '+59899', billsec: 4, start: new Date().toISOString() },
    { src: '2001', dst: null, billsec: 4, start: new Date().toISOString() },
  ];
  await alerts.tick();
  assert.deepEqual(asuntos(env), ['[PBX-NG] 🟠 Llamada saliente de 60 minutos', '[PBX-NG] 🟠 Llamada internacional: 0034911']);
  assert.equal(linea(env, 1, 'Duración'), '0 s');
  // Ventana diurna (9 a 18): a las 03:00 está DENTRO del horario, no se cuenta nada.
  db.regla('fraud.after_hours', { params: { from_hour: 9, to_hour: 18, calls: 1 } });
  db.cdrFuera = [{ n: 50 }];
  db.cdrLargas = [];
  db.cdrRecientes = [];
  await alerts.tick();
  assert.equal(env.length, 2);
  // Ventana 1 a 5: las 03:00 están fuera y con 50 llamadas avisa.
  db.regla('fraud.after_hours', { params: { from_hour: 1, to_hour: 5, calls: 10, window_min: 15 } });
  await alerts.tick();
  assert.match(env.at(-1).m.subject, /50 llamadas salientes fuera de horario/);
  assert.equal(linea(env, env.length - 1, 'Ventana'), '15 min');
});

test('colas sin agentes: sólo en horario laboral de un día hábil, y con la fuente rota se saltea', async (t) => {
  const db = baseFalsa();
  db.regla('queue.no_agents');
  let colas = [{ name: 'ventas', agents_online: 0 }, { name: 'soporte', label: 'Soporte', agents_online: 2 }];
  const env = armar(t, db, { getQueues: async () => { if (colas === 'roto') throw new Error('x'); return colas; } }, new Date(2026, 9, 6, 10, 0, 0));
  await alerts.tick();
  assert.deepEqual(asuntos(env), ['[PBX-NG] 🟠 Cola sin agentes: ventas']);
  assert.equal(linea(env, 0, 'Agentes totales'), '0');
  colas = 'roto';
  await alerts.tick();
  assert.equal(env.length, 1);
  // Fuera del horario configurado (10 a 11, ya son las 11).
  db.regla('queue.no_agents', { params: { from_hour: 10, to_hour: 11 } });
  colas = [{ name: 'x' }];
  adelantar(t, 3600000);
  await alerts.tick();
  assert.equal(env.length, 1);
});

test('resumen diario: a la hora por defecto (8), una vez por día, aun con la base vacía', async (t) => {
  const db = baseFalsa();
  db.regla('digest.daily');
  const env = armar(t, db, {}, new Date(2026, 9, 6, 7, 0, 0));
  await alerts.tick();
  assert.equal(env.length, 0, 'a las 7 todavía no');
  adelantar(t, 3600000);
  db.digest = { tot: [], top: [{ src: null, n: 3 }, { src: '2001', n: 2 }], bans: [], vm: [] };
  await alerts.tick();
  assert.equal(env.length, 1);
  assert.equal(env[0].m.subject, '[PBX-NG] Resumen de ayer · 0 llamadas');
  for (const k of ['Llamadas totales', 'Atendidas', 'Perdidas', 'Entrantes', 'Mensajes de voz enviados', 'IPs bloqueadas \\(vigentes\\)', 'Intentos fallidos \\(ayer\\)']) assert.equal(linea(env, 0, k), '0', k);
  assert.equal(linea(env, 0, 'Duración media'), '0 s');
  assert.equal(linea(env, 0, 'Top interno 1'), '— · 3 llamadas');
  await alerts.tick();
  assert.equal(env.length, 1, 'el mismo día no se repite');
});

test('init: los relojes del motor corren el tick y un tick que falla sólo se registra', async (t) => {
  const db = baseFalsa({ romper: /pbxng_alert_rules/ });
  armar(t, db);
  let consultas = 0;
  const q = db.query;
  db.query = async (...a) => { consultas++; return q(...a); };
  t.mock.timers.tick(30000);                             // el primer tick a los 30 s (falla: base caída)
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(30000);                             // y el de cada minuto
  await new Promise((r) => setImmediate(r));
  assert.ok(consultas >= 2, 'los dos relojes llegaron a consultar la base');
});
