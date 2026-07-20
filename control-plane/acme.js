'use strict';
/* ============================================================================
 *  SBC-NG · ACME / Let's Encrypt
 *
 *  Un appliance de borde tiene que poder tener su propio certificado TLS válido
 *  SIN depender de un proxy inverso adelante: para el panel por HTTPS, para el SIP
 *  sobre TLS y para el WSS de WebRTC. Acá vive la integración con acme.sh (un solo
 *  script, ya instalado en la imagen) para EMITIR y RENOVAR contra Let's Encrypt.
 *
 *  Dos formas de que Let's Encrypt confirme que el dominio es tuyo, elegibles desde
 *  el panel:
 *    · HTTP-01  → LE pega a http://dominio/.well-known/acme-challenge/…  El SBC
 *                 responde el desafío en el puerto 80 (modo standalone de acme.sh).
 *                 Es el caso "sin proxy": el 80 tiene que llegar al control-plane.
 *    · DNS-01   → el SBC crea un registro TXT vía la API de tu DNS. No necesita el
 *                 puerto 80 (sirve detrás de NAT), pero pide las credenciales del DNS.
 *
 *  Todo el estado (cuenta ACME, certificados, config) vive en el volumen persistente
 *  (CONF_DIR), así que sobrevive a un reinicio del contenedor.
 * ==========================================================================*/
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONF = process.env.CONF_DIR || '/etc/pbxng';
const ACME_HOME = path.join(CONF, 'acme');        // estado de acme.sh (cuenta, historial)
const CERT_DIR = path.join(CONF, 'certs');        // el cert instalado (fullchain.pem + key.pem)
const CFG_FILE = path.join(ACME_HOME, 'config.json');
const ACME_BIN = '/usr/local/bin/acme.sh';
const CA = 'letsencrypt';

function asegurarDirs() {
  for (const d of [ACME_HOME, CERT_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
}

// Credenciales de DNS por proveedor: qué variables de entorno espera acme.sh.
// (Las más usadas; se cargan desde el panel y se exportan sólo durante la emisión.)
const DNS_PROVIDERS = {
  cloudflare: { dns: 'dns_cf', vars: ['CF_Token', 'CF_Account_ID'], label: 'Cloudflare' },
  route53:    { dns: 'dns_aws', vars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], label: 'AWS Route 53' },
  digitalocean: { dns: 'dns_dgon', vars: ['DO_API_KEY'], label: 'DigitalOcean' },
  godaddy:    { dns: 'dns_gd', vars: ['GD_Key', 'GD_Secret'], label: 'GoDaddy' },
  namecheap:  { dns: 'dns_namecheap', vars: ['NAMECHEAP_USERNAME', 'NAMECHEAP_API_KEY'], label: 'Namecheap' },
};

function leerCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (_) { return {}; }
}
function guardarCfg(cfg) {
  asegurarDirs();
  const prev = leerCfg();
  const next = { ...prev, ...cfg };
  fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2));
  return next;
}

// Config para el panel: NO devolvemos las credenciales del DNS en claro.
function configPublica() {
  const c = leerCfg();
  return {
    domain: c.domain || '', email: c.email || '', method: c.method || 'http',
    dns_provider: c.dns_provider || '', tiene_dns_creds: !!(c.dns_creds && Object.keys(c.dns_creds).length),
    proveedores: Object.entries(DNS_PROVIDERS).map(([k, v]) => ({ id: k, label: v.label, vars: v.vars })),
  };
}

// Lee el vencimiento del cert instalado (con openssl, que ya está en la imagen).
function estadoCert() {
  return new Promise((resolve) => {
    const cf = path.join(CERT_DIR, 'fullchain.pem');
    if (!fs.existsSync(cf)) return resolve({ emitido: false });
    execFile('openssl', ['x509', '-enddate', '-subject', '-noout', '-in', cf], { timeout: 5000 }, (err, out) => {
      if (err) return resolve({ emitido: true, error: 'no se pudo leer el certificado' });
      const m = /notAfter=(.+)/.exec(out); const s = /subject=.*?CN\s*=\s*([^,\/\n]+)/.exec(out);
      const vence = m ? new Date(m[1].trim()) : null;
      const dias = vence ? Math.round((vence - Date.now()) / 86400000) : null;
      resolve({ emitido: true, cn: s ? s[1].trim() : null, vence: vence ? vence.toISOString() : null, dias_restantes: dias });
    });
  });
}

function correr(args, extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(extraEnv || {}) };
    execFile(ACME_BIN, ['--home', ACME_HOME, ...args], { timeout: 180000, env }, (err, out, errout) => {
      resolve({ ok: !err, salida: String(out || '') + String(errout || ''), code: err ? (err.code || 1) : 0 });
    });
  });
}

/* Emitir (o re-emitir) el certificado del dominio configurado. */
async function emitir() {
  asegurarDirs();
  const c = leerCfg();
  if (!c.domain) return { ok: false, error: 'falta el dominio' };
  if (!c.email) return { ok: false, error: 'falta el email de la cuenta ACME' };

  // Cuenta ACME (idempotente): registra el email contra Let's Encrypt una vez.
  await correr(['--register-account', '-m', c.email, '--server', CA]);

  let args, extraEnv = {};
  if (c.method === 'dns') {
    const prov = DNS_PROVIDERS[c.dns_provider];
    if (!prov) return { ok: false, error: 'proveedor de DNS no soportado' };
    if (!c.dns_creds) return { ok: false, error: 'faltan las credenciales del DNS' };
    for (const v of prov.vars) if (c.dns_creds[v]) extraEnv[v] = String(c.dns_creds[v]);
    args = ['--issue', '-d', c.domain, '--dns', prov.dns, '--server', CA, '--force'];
  } else {
    // HTTP-01 standalone: acme.sh levanta un server temporal en el 80 (necesita socat,
    // ya en la imagen), y el 80 tiene que llegar a este contenedor (deploy sin proxy).
    args = ['--issue', '-d', c.domain, '--standalone', '--httpport', '80', '--server', CA, '--force'];
  }

  const r = await correr(args, extraEnv);
  if (!r.ok) return { ok: false, error: 'Let\'s Encrypt rechazó la emisión', salida: r.salida.slice(-1500) };

  // Instalar el cert en un lugar estable + (opcional) recargar quien lo use.
  const inst = await correr(['--install-cert', '-d', c.domain,
    '--key-file', path.join(CERT_DIR, 'key.pem'),
    '--fullchain-file', path.join(CERT_DIR, 'fullchain.pem'),
    '--ca-file', path.join(CERT_DIR, 'ca.pem')]);
  const st = await estadoCert();
  return { ok: inst.ok, salida: (r.salida + '\n' + inst.salida).slice(-1500), ...st };
}

/* Renovar todo lo que esté por vencer. acme.sh no renueva si aún falta mucho. */
async function renovar() {
  const r = await correr(['--renew-all', '--server', CA]);
  const c = leerCfg();
  if (c.domain) {
    await correr(['--install-cert', '-d', c.domain,
      '--key-file', path.join(CERT_DIR, 'key.pem'),
      '--fullchain-file', path.join(CERT_DIR, 'fullchain.pem')]);
  }
  const st = await estadoCert();
  return { ok: r.ok, salida: r.salida.slice(-1200), ...st };
}

module.exports = { configPublica, guardarCfg, estadoCert, emitir, renovar, DNS_PROVIDERS, CERT_DIR };
