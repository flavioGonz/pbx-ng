/* ============================================================================
 *  ACME / Let's Encrypt (acme.js) con un acme.sh de mentira.
 *
 *  El acme.sh falso anota con qué argumentos y qué variables lo llamaron, y al
 *  `--install-cert` deja un certificado autofirmado de verdad (openssl), así
 *  `estadoCert()` lee un vencimiento real. Lo que se prueba es qué se le pide a
 *  acme.sh en cada método, que las credenciales del DNS viajen sólo por el entorno
 *  y nunca salgan por `configPublica()`, y qué pasa cuando Let's Encrypt dice que no.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-test-'));
const LOG = path.join(RAIZ, 'llamadas.log');
const SH = path.join(RAIZ, 'acme.sh');
fs.writeFileSync(SH, `#!/bin/sh
echo "ARGS $* CF=$CF_Token" >> "${LOG}"
[ -n "$FALSO_ACME_FALLA" ] && case "$*" in *--issue*) echo "Verify error: Invalid response from http://x"; exit 1;; esac
case "$*" in *--install-cert*)
  while [ $# -gt 0 ]; do
    case "$1" in --key-file) shift; K="$1";; --fullchain-file) shift; F="$1";; esac; shift
  done
  openssl req -x509 -newkey rsa:2048 -nodes -days 60 -subj "/CN=pbx.ejemplo.uy" -keyout "$K" -out "$F" >/dev/null 2>&1
;; esac
echo ok
`, { mode: 0o755 });
process.env.CONF_DIR = RAIZ;
process.env.ACME_SH = SH;
const acme = require('../acme');
test.after(() => fs.rmSync(RAIZ, { recursive: true, force: true }));
const llamadas = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : []);
const tieneOpenssl = (() => { try { execFileSync('openssl', ['version']); return true; } catch (_) { return false; } })();

test('sin dominio o sin email no se llama a acme.sh', async () => {
  assert.deepEqual(await acme.estadoCert(), { emitido: false });
  assert.match((await acme.emitir()).error, /falta el dominio/);
  acme.guardarCfg({ domain: 'pbx.ejemplo.uy' });
  assert.match((await acme.emitir()).error, /falta el email/);
  assert.equal(llamadas().length, 0);
});

test('HTTP-01: registra la cuenta, emite en standalone por el 80 e instala el certificado', async (t) => {
  if (!tieneOpenssl) { t.skip('sin openssl'); return; }
  acme.guardarCfg({ email: 'admin@ejemplo.uy', method: 'http' });
  const r = await acme.emitir();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.emitido, true);
  assert.equal(r.cn, 'pbx.ejemplo.uy');
  assert.ok(r.dias_restantes >= 59 && r.dias_restantes <= 60);
  const l = llamadas();
  assert.match(l[0], /--register-account -m admin@ejemplo\.uy --server letsencrypt/);
  assert.match(l[1], /--issue -d pbx\.ejemplo\.uy --standalone --httpport 80/);
  assert.match(l[2], /--install-cert -d pbx\.ejemplo\.uy/);
  assert.ok(l.every((x) => x.includes('--home ' + path.join(RAIZ, 'acme'))), 'el estado de acme.sh vive en el volumen persistente');
});

test('DNS-01: las credenciales viajan por el entorno y no salen por la config pública', async () => {
  fs.rmSync(LOG, { force: true });
  acme.guardarCfg({ method: 'dns', dns_provider: 'cloudflare', dns_creds: { CF_Token: 'tok-secreto', CF_Account_ID: '' } });
  const pub = acme.configPublica();
  assert.equal(pub.tiene_dns_creds, true);
  assert.equal(JSON.stringify(pub).includes('tok-secreto'), false);
  assert.ok(pub.proveedores.some((p) => p.id === 'route53'));
  await acme.emitir();
  const issue = llamadas().find((x) => /--issue/.test(x));
  assert.match(issue, /--dns dns_cf/);
  assert.match(issue, /CF=tok-secreto$/, 'el token llega a acme.sh como variable de entorno');
  assert.doesNotMatch(issue, /tok-secreto.*--/, 'y no como argumento, que quedaría en la lista de procesos');

  acme.guardarCfg({ dns_provider: 'proveedor-raro' });
  assert.match((await acme.emitir()).error, /no soportado/);
  acme.guardarCfg({ dns_provider: 'cloudflare', dns_creds: null });
  assert.match((await acme.emitir()).error, /faltan las credenciales/);
});

test('si Let\'s Encrypt rechaza, se devuelve la salida para saber por qué', async () => {
  acme.guardarCfg({ method: 'http' });
  process.env.FALSO_ACME_FALLA = '1';
  try {
    const r = await acme.emitir();
    assert.equal(r.ok, false);
    assert.match(r.error, /rechazó la emisión/);
    assert.match(r.salida, /Verify error/);
  } finally { delete process.env.FALSO_ACME_FALLA; }
});

test('renovar: renueva todo y reinstala el del dominio; un certificado ilegible se informa', async (t) => {
  if (!tieneOpenssl) { t.skip('sin openssl'); return; }
  fs.rmSync(LOG, { force: true });
  const r = await acme.renovar();
  assert.equal(r.ok, true);
  assert.match(llamadas()[0], /--renew-all/);
  fs.writeFileSync(path.join(acme.CERT_DIR, 'fullchain.pem'), 'basura');
  assert.deepEqual(await acme.estadoCert(), { emitido: true, error: 'no se pudo leer el certificado' });
  fs.writeFileSync(path.join(RAIZ, 'acme', 'config.json'), '{roto');
  assert.equal(acme.configPublica().domain, '', 'una config ilegible se trata como vacía');
  assert.equal((await acme.renovar()).ok, true, 'sin dominio, renueva sin reinstalar');
});
