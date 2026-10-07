/* ============================================================================
 *  Integración · con la base caída, la API contesta y no se cae.
 *
 *  Cada ruta tiene su `catch` para cuando Postgres no responde, y casi ninguno se había
 *  ejecutado nunca: un error de tipeo ahí adentro (un `res` mal escrito, un `.json` de
 *  algo que no existe) no se ve hasta el día que la base se cae, que es exactamente el
 *  día en que el panel tiene que decir algo útil. Esta prueba saca la lista de rutas del
 *  CÓDIGO (así una ruta nueva entra sola), corta la base a la API y las recorre todas:
 *  cada una tiene que contestar (no colgarse) y el proceso tiene que seguir vivo. Al
 *  final la base vuelve y /health vuelve a decir ok.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { entorno } = require('./helpers/db');

const RAIZ = path.resolve(__dirname, '..');
/* Las rutas del código: app.METODO('/ruta' y router.METODO('/ruta' (v1 va bajo /api/v1). */
function rutasDelCodigo() {
  const out = new Map();
  for (const f of fs.readdirSync(RAIZ).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(RAIZ, f), 'utf8');
    const re = /\b(app|router)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src))) {
      let ruta = m[3];
      if (m[1] === 'router') ruta = (f === 'v1.js' ? '/api/v1' : '') + ruta;
      if (!ruta.startsWith('/api') && !ruta.startsWith('/prov') && !ruta.startsWith('/health')) continue;
      const concreta = ruta.replace(/:[A-Za-z_]+/g, (p) => (/nombre/.test(p) ? 'x.tar.gz' : '1'));
      out.set(m[2].toUpperCase() + ' ' + concreta, { metodo: m[2].toUpperCase(), ruta: concreta, archivo: f });
    }
  }
  return [...out.values()];
}
/* Rutas que con la base caída igual podrían esperar algo de afuera hasta su tope (un
 * proveedor, el agente de Asterisk): se saltean para que la prueba no tarde minutos.
 * No es que no tengan catch: es que no dependen de la base. */
const LENTAS = /\/(voz|npm|asterisk\/(core|net|route|diag|iface)|turn|ai-agents\/(probar|modelos|salud)|acme\/(issue|renew)|softphone\/ota\/revisar|clients\/1\/geocode|intercom\/sync|security\/enforcement|integrations\/[^/]+\/test|email\/test|sysprompts\/generate|ivr\/gen-audio|queues\/preview-announce|calls\/spy)/;

test('con la base caída cada ruta contesta y la API sigue viva', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login, base } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  const rutas = rutasDelCodigo().filter((r) => !LENTAS.test(r.ruta));
  assert.ok(rutas.length > 250, 'se esperaban todas las rutas de la API, hay ' + rutas.length);

  /* Cortar la base: nadie más se conecta y se echa a los que estaban. */
  const adm = new Client({ host: ctx.db.env.DB_HOST, port: +ctx.db.env.DB_PORT, user: ctx.db.env.DB_USER, password: ctx.db.env.DB_PASS, database: 'postgres' });
  adm.on('error', () => {});   // al apagar el clúster de prueba esta conexión se corta
  await adm.connect();
  const nombre = ctx.db.env.DB_NAME;
  ctx.db.pool.on('error', () => {});   // el corte también echa a las conexiones de la prueba
  await adm.query('ALTER DATABASE "' + nombre + '" WITH ALLOW_CONNECTIONS false');
  await adm.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()', [nombre]);
  t.after(async () => { try { await adm.query('ALTER DATABASE "' + nombre + '" WITH ALLOW_CONNECTIONS true'); } catch (_) {} await adm.end().catch(() => {}); });

  const h = await api('GET', '/health');
  assert.equal(h.status, 503, 'sin base, /health tiene que decir degradado');
  assert.equal(h.json.db, false);

  const colgadas = [];
  const contestan = { ok: 0, error: 0 };
  for (const r of rutas) {
    for (const cuerpo of [undefined, {}]) {
      if (cuerpo !== undefined && r.metodo === 'GET') continue;
      try {
        const res = await fetch(base + r.ruta, {
          method: r.metodo,
          headers: Object.assign({ Authorization: 'Bearer ' + admin }, cuerpo ? { 'Content-Type': 'application/json' } : {}),
          body: cuerpo ? JSON.stringify(cuerpo) : undefined,
          signal: AbortSignal.timeout(+(process.env.BC_TOPE || 12000)),
        });
        await res.arrayBuffer();
        if (res.status >= 400) contestan.error++; else contestan.ok++;
        if (process.env.BC_DBG) console.log('BC', res.status, r.metodo, r.ruta);
      } catch (e) {
        colgadas.push(r.metodo + ' ' + r.ruta + ' (' + r.archivo + '): ' + e.name);
        if (process.env.BC_DBG) console.log('BC COLGADA', r.metodo, r.ruta);
      }
    }
  }
  assert.deepEqual(colgadas, [], 'rutas que no contestaron con la base caída');
  assert.ok(contestan.error > 100, 'casi todas tienen que contestar con error: ' + JSON.stringify(contestan));
  assert.equal((await api('GET', '/health')).status, 503, 'la API sigue viva después del barrido');

  /* La base vuelve: el pool se recupera solo. */
  await adm.query('ALTER DATABASE "' + nombre + '" WITH ALLOW_CONNECTIONS true');
  let vuelve = false;
  for (let i = 0; i < 50 && !vuelve; i++) { vuelve = (await api('GET', '/health')).status === 200; if (!vuelve) await new Promise((r) => setTimeout(r, 200)); }
  assert.ok(vuelve, 'cuando la base vuelve, la API vuelve sin reiniciar');
  assert.equal((await api('GET', '/api/users', { token: admin })).status, 200);
  await adm.end().catch(() => {});
});
