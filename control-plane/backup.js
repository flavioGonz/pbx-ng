/* ============================================================================
 *  PBX-NG · Respaldo y restauración
 *
 *  Qué se respalda y por qué:
 *
 *    base        pg_dump lógico de PostgreSQL. Va lógico y no una copia cruda del
 *                volumen porque una copia cruda sólo se puede restaurar en la MISMA
 *                versión de PostgreSQL y en la misma arquitectura. El dump entra en
 *                cualquier instalación nueva, que es justo lo que se necesita el día
 *                que se murió el disco.
 *    conf        /etc/asterisk/pbxng.d — lo que el panel le genera a Asterisk
 *                (aparcado, música en espera, features). Sin esto la central levanta
 *                sin esas funciones.
 *    certs       /etc/pbxng — certificados (ACME) y material de TLS.
 *    audios      sonidos propios: prompts del IVR, música en espera.
 *    buzones     mensajes de voz.
 *    grabaciones OPCIONAL y aparte: es lo único que crece sin techo. Un respaldo de
 *                configuración tiene que poder pesar poco y hacerse seguido; las
 *                grabaciones se archivan con otro criterio.
 *
 *  Qué NO se respalda, a propósito:
 *
 *    Las credenciales del entorno (DB_PASS, JWT_SECRET, claves de AMI/ARI). No hacen
 *    falta: el restore es lógico, así que la instalación destino usa las suyas. El
 *    manifiesto deja anotado qué variables tiene que tener configuradas el destino.
 *
 *  OJO, el archivo SÍ es material sensible:
 *
 *    La parte `certs` lleva los certificados TLS CON sus claves privadas. No hay forma
 *    de evitarlo sin que el respaldo deje de servir para levantar la central, así que
 *    la decisión es incluirlas y decirlo fuerte en la pantalla, en vez de dar una
 *    falsa sensación de que el archivo se puede mandar por correo.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DIR = process.env.BACKUP_DIR || '/respaldos';
const FORMATO = 2;                       // versión del formato del archivo de respaldo
const PRODUCTO = 'PBX-NG';

/* Cada parte es un directorio montado en este contenedor. Si un volumen no está
 * montado, la parte se marca "ausente" en el manifiesto en vez de romper el respaldo:
 * es mejor un respaldo parcial y honesto que ninguno. */
const PARTES = [
  { id: 'conf',        ruta: '/etc/asterisk/pbxng.d',            desc: 'Configuración generada para Asterisk' },
  { id: 'certs',       ruta: '/etc/pbxng',                       desc: 'Certificados y material TLS' },
  { id: 'audios',      ruta: '/var/lib/asterisk/sounds/custom',  desc: 'Audios propios (IVR, música en espera)' },
  { id: 'buzones',     ruta: '/voicemail',                       desc: 'Mensajes de voz' },
  { id: 'grabaciones', ruta: '/recordings',                      desc: 'Grabaciones de llamadas', opcional: true },
];

const ENV_REQUERIDAS = ['DB_PASS', 'JWT_SECRET', 'ARI_PASS', 'AMI_PASS'];

function correr(cmd, args, opts = {}) {
  return new Promise((ok, err) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64, ...opts }, (e, out, errOut) => {
      if (e) { e.message = `${cmd}: ${(errOut || e.message || '').toString().slice(0, 500)}`; return err(e); }
      ok(out);
    });
  });
}

const sha256 = (f) => new Promise((ok, err) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(f).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', err);
});

const existe = (p) => fsp.access(p).then(() => true).catch(() => false);
const pesar = async (f) => { try { return (await fsp.stat(f)).size; } catch (_) { return 0; } };

async function asegurarDir() { await fsp.mkdir(DIR, { recursive: true }); }

/* Nombre estable y ordenable: pbxng-20260720-1432.tar.gz */
function nombreNuevo() {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `pbxng-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.tar.gz`;
}

const dbEnv = () => ({
  ...process.env,
  PGHOST: process.env.DB_HOST || 'postgres',
  PGPORT: process.env.DB_PORT || '5432',
  PGDATABASE: process.env.DB_NAME || 'pbxng',
  PGUSER: process.env.DB_USER || 'pbxng',
  PGPASSWORD: process.env.DB_PASS || '',
});

async function versionPg() {
  try { return (await correr('psql', ['-tAc', 'SHOW server_version'], { env: dbEnv() })).trim(); }
  catch (_) { return null; }
}

/* ---------------------------------------------------------------- crear ---- */
async function crear({ grabaciones = false, nota = '' } = {}) {
  await asegurarDir();
  const trabajo = await fsp.mkdtemp('/tmp/pbxng-bk-');
  const nombre = nombreNuevo();
  const destino = path.join(DIR, nombre);

  try {
    const partes = [];

    // 1) Base de datos. --no-owner/--no-privileges para que entre en una instalación
    //    cuyo usuario de base se llame distinto.
    const sql = path.join(trabajo, 'base.sql');
    await correr('pg_dump', ['--no-owner', '--no-privileges', '--clean', '--if-exists', '-f', sql], { env: dbEnv() });
    await correr('gzip', ['-9', sql]);
    partes.push({ id: 'base', archivo: 'base.sql.gz', bytes: await pesar(sql + '.gz'), sha256: await sha256(sql + '.gz'), desc: 'Volcado lógico de PostgreSQL' });

    // 2) Directorios.
    for (const p of PARTES) {
      if (p.id === 'grabaciones' && !grabaciones) { partes.push({ id: p.id, omitida: 'no solicitada', desc: p.desc }); continue; }
      if (!(await existe(p.ruta))) { partes.push({ id: p.id, ausente: true, desc: p.desc }); continue; }
      const tgz = path.join(trabajo, p.id + '.tar.gz');
      // -C para guardar rutas relativas: el restore decide dónde va, no el respaldo.
      await correr('tar', ['-czf', tgz, '-C', p.ruta, '.']);
      partes.push({ id: p.id, archivo: p.id + '.tar.gz', bytes: await pesar(tgz), sha256: await sha256(tgz), desc: p.desc });
    }

    // 3) Manifiesto: es lo que hace que el restore pueda decir que NO.
    const manifiesto = {
      formato: FORMATO,
      producto: PRODUCTO,
      version: process.env.APP_VERSION || null,
      creado: new Date().toISOString(),
      host: process.env.DOMAIN || process.env.PUBLIC_IP || null,
      postgres: await versionPg(),
      nota: String(nota || '').slice(0, 300),
      incluye_grabaciones: !!grabaciones,
      partes,
      // El respaldo no lleva las credenciales del entorno: esto le dice al destino qué
      // tiene que tener configurado por su cuenta para que la restauración sirva.
      entorno_requerido: ENV_REQUERIDAS,
      aviso: 'No contiene las credenciales del entorno (base, sesiones, AMI/ARI): el destino usa las suyas. '
           + 'SÍ contiene los certificados TLS con sus claves privadas: tratá el archivo como material sensible.',
    };
    await fsp.writeFile(path.join(trabajo, 'manifiesto.json'), JSON.stringify(manifiesto, null, 2));

    await correr('tar', ['-czf', destino, '-C', trabajo, '.']);
    return { nombre, bytes: await pesar(destino), manifiesto };
  } finally {
    await fsp.rm(trabajo, { recursive: true, force: true }).catch(() => {});
  }
}

/* --------------------------------------------------------------- listar ---- */
async function listar() {
  await asegurarDir();
  const files = (await fsp.readdir(DIR)).filter((f) => f.endsWith('.tar.gz'));
  const out = [];
  for (const f of files) {
    const st = await fsp.stat(path.join(DIR, f)).catch(() => null);
    if (st) out.push({ nombre: f, bytes: st.size, creado: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.creado.localeCompare(a.creado));
}

async function borrar(nombre) {
  const f = seguro(nombre);
  await fsp.unlink(f);
  return true;
}

/* Nunca dejar que un nombre de archivo salga del directorio de respaldos. */
function seguro(nombre) {
  const base = path.basename(String(nombre || ''));
  if (!base || !base.endsWith('.tar.gz')) throw new Error('nombre de respaldo inválido');
  return path.join(DIR, base);
}

/* ------------------------------------------------------------ inspeccionar - */
/* Lee el manifiesto SIN restaurar nada. Es lo que permite mostrarle al operador qué
 * está por hacer antes de que apriete el botón. */
async function inspeccionar(nombre) {
  const f = seguro(nombre);
  const trabajo = await fsp.mkdtemp('/tmp/pbxng-insp-');
  try {
    await correr('tar', ['-xzf', f, '-C', trabajo, './manifiesto.json']);
    const m = JSON.parse(await fsp.readFile(path.join(trabajo, 'manifiesto.json'), 'utf8'));
    return { ...m, compatible: compatibilidad(m) };
  } catch (e) {
    throw new Error('el archivo no parece un respaldo de PBX-NG (no tiene manifiesto)');
  } finally {
    await fsp.rm(trabajo, { recursive: true, force: true }).catch(() => {});
  }
}

/* Un respaldo de otro producto o de un formato futuro NO se restaura. Es la
 * diferencia entre un restore que falla temprano y uno que deja la central a medias. */
function compatibilidad(m) {
  if (!m || m.producto !== PRODUCTO) return { ok: false, motivo: `el respaldo es de ${(m && m.producto) || 'otro producto'}, no de ${PRODUCTO}` };
  if (Number(m.formato) > FORMATO) return { ok: false, motivo: `fue hecho por una versión más nueva (formato ${m.formato}, acá se entiende hasta ${FORMATO})` };
  return { ok: true };
}

/* ------------------------------------------------------------- restaurar --- */
/* Restaura EN CALIENTE lo que se puede y avisa qué necesita reinicio. Antes de tocar
 * nada saca un respaldo de seguridad: si el archivo venía mal, se puede volver. */
async function restaurar(nombre, { partes = null, confirmar = false } = {}) {
  if (!confirmar) throw new Error('falta la confirmación explícita');
  const f = seguro(nombre);
  const m = await inspeccionar(nombre);
  const compat = compatibilidad(m);
  if (!compat.ok) throw new Error('respaldo incompatible: ' + compat.motivo);

  const previo = await crear({ grabaciones: false, nota: `automático antes de restaurar ${nombre}` });

  const trabajo = await fsp.mkdtemp('/tmp/pbxng-rst-');
  const hechas = [];
  const saltadas = [];
  try {
    await correr('tar', ['-xzf', f, '-C', trabajo]);

    const quiere = (id) => !partes || (Array.isArray(partes) && partes.includes(id));

    // 1) Base primero: es la que manda.
    if (quiere('base') && (await existe(path.join(trabajo, 'base.sql.gz')))) {
      await correr('gunzip', ['-f', path.join(trabajo, 'base.sql.gz')]);
      // ON_ERROR_STOP=0: el dump trae DROP ... IF EXISTS que pueden no aplicar en una
      // base recién creada; no queremos abortar por eso, pero sí ver el resultado.
      await correr('psql', ['-v', 'ON_ERROR_STOP=0', '-f', path.join(trabajo, 'base.sql')], { env: dbEnv() });
      hechas.push('base');
    } else if (quiere('base')) saltadas.push('base (no venía en el archivo)');

    // 2) Directorios: se vacía el destino y se desempaqueta encima.
    for (const p of PARTES) {
      if (!quiere(p.id)) continue;
      const tgz = path.join(trabajo, p.id + '.tar.gz');
      if (!(await existe(tgz))) { saltadas.push(`${p.id} (no venía en el archivo)`); continue; }
      if (!(await existe(p.ruta))) { saltadas.push(`${p.id} (el destino no está montado)`); continue; }
      await correr('tar', ['-xzf', tgz, '-C', p.ruta]);
      hechas.push(p.id);
    }

    return {
      ok: true,
      restauradas: hechas,
      saltadas,
      respaldo_previo: previo.nombre,
      reiniciar: hechas.some((h) => h === 'base' || h === 'conf' || h === 'certs'),
      aviso: 'Reiniciá los servicios para que Asterisk tome la configuración restaurada.',
    };
  } finally {
    await fsp.rm(trabajo, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { crear, listar, borrar, inspeccionar, restaurar, seguro, DIR, PARTES, FORMATO };
