/* ============================================================================
 *  Integración · ninguna ruta revienta con un pedido vacío.
 *
 *  Un cuerpo vacío o ausente es lo primero que manda un cliente roto, un script a medio
 *  escribir o alguien probando la API. La respuesta correcta es un 4xx que diga qué
 *  falta; un 500 quiere decir que la validación no está y el error salió de más adentro
 *  (así aparecieron «Cannot read properties of undefined» al editar una cola que no
 *  existía y «name es obligatorio» con status 500). Las rutas salen del código, así que
 *  una nueva entra sola. Sólo se acepta 503 donde falta Asterisk (ARI apagado).
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entorno } = require('./helpers/db');

const RAIZ = path.resolve(__dirname, '..');
/* Las que salen a la red (proveedor, agente de Asterisk) o crean algo pesado (un
 * respaldo, aplicar el modo de red): no dependen del cuerpo para fallar bien. */
const FUERA = /\/(voz|npm|asterisk\/(core|net|route|diag|iface)|turn|ai-agents\/(probar|modelos|salud)|acme\/(issue|renew)|softphone\/ota\/revisar|clients\/1\/geocode|intercom\/sync|security\/enforcement|integrations\/[^/]+\/test|email\/test|sysprompts\/generate|ivr\/gen-audio|queues\/preview-announce|calls\/spy|backup$|net\/mode\/apply)/;

function rutas() {
  const out = new Map();
  for (const f of fs.readdirSync(RAIZ).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(RAIZ, f), 'utf8');
    const re = /\b(app|router)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src))) {
      let r = m[3];
      if (m[1] === 'router') r = (f === 'v1.js' ? '/api/v1' : '') + r;
      if (!r.startsWith('/api')) continue;
      r = r.replace(/:[A-Za-z_]+/g, '1');
      out.set(m[2].toUpperCase() + ' ' + r, { metodo: m[2].toUpperCase(), ruta: r, archivo: f });
    }
  }
  /* El usuario 1 es el admin con el que se prueba: borrarlo cortaría la sesión. */
  return [...out.values()].filter((x) => !FUERA.test(x.ruta) && !/\/users\/1(\/|$)/.test(x.ruta));
}

test('ninguna ruta contesta 500 a un pedido vacío o sin cuerpo', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const admin = (await ctx.api.login('admin', 'admin')).token;
  const lista = rutas();
  assert.ok(lista.length > 250);
  const malas = [];
  for (const r of lista) {
    for (const cuerpo of [undefined, '{}']) {
      if (cuerpo && r.metodo === 'GET') continue;
      const res = await fetch(ctx.api.base + r.ruta, {
        method: r.metodo,
        headers: Object.assign({ Authorization: 'Bearer ' + admin }, cuerpo ? { 'Content-Type': 'application/json' } : {}),
        body: cuerpo, signal: AbortSignal.timeout(10000),
      });
      const txt = await res.text();
      if (res.status >= 500 && !(res.status === 503 && /ARI no disponible/.test(txt))) malas.push(res.status + ' ' + r.metodo + ' ' + r.ruta + ' (' + r.archivo + ', ' + (cuerpo ? 'json' : 'sin cuerpo') + '): ' + txt.slice(0, 120));
    }
  }
  assert.deepEqual(malas, []);
});
