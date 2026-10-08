// PBX-NG Softphone · leer y escribir .xlsx sin dependencias
//
// POR QUE A MANO. Un .xlsx es un ZIP con un puñado de XML adentro, y lo que esta app
// necesita es UNA hoja con filas de texto. Las librerias que hacen esto bien pesan entre
// cientos de KB y un mega, traen su propia cadena de dependencias, y la mas conocida dejo
// de publicarse en npm. Para una tabla de clientes con cuatro columnas eso es pagar mucho
// por muy poco. Acá se usa `zlib`, que viene con Node.
//
// LO QUE SI HACE: una hoja, encabezado y filas, todo texto. Al leer entiende los dos
// formatos de celda de texto que importan —`inlineStr` (lo que escribimos nosotros) y `s`
// (la tabla de strings compartidos, que es lo que escribe Excel)— y los numeros.
//
// LO QUE NO HACE, dicho de frente: formulas, fechas con formato, varias hojas, estilos.
// Si alguna vez hace falta algo de eso, entra una libreria; hoy seria cargarla para nada.
'use strict';

const zlib = require('zlib');

/* ── ZIP ──────────────────────────────────────────────────────────────────── */

const crcTabla = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTabla[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* Se escribe SIN comprimir (metodo 0). Un .xlsx de unos miles de filas son unos cientos de
 * KB; comprimirlo ahorraria poco y agrega una cosa mas que puede salir mal. Excel abre los
 * dos igual. */
function zipEscribir(entradas) {
  const locales = [], central = [];
  let off = 0;
  for (const e of entradas) {
    const nombre = Buffer.from(e.nombre, 'utf8');
    const datos = Buffer.from(e.datos, 'utf8');
    const crc = crc32(datos);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(datos.length, 18); lh.writeUInt32LE(datos.length, 22);
    lh.writeUInt16LE(nombre.length, 26); lh.writeUInt16LE(0, 28);
    locales.push(lh, nombre, datos);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(datos.length, 20); ch.writeUInt32LE(datos.length, 24);
    ch.writeUInt16LE(nombre.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, nombre);
    off += 30 + nombre.length + datos.length;
  }
  const cen = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(0, 4); fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(entradas.length, 8); fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(cen.length, 12); fin.writeUInt32LE(off, 16); fin.writeUInt16LE(0, 20);
  return Buffer.concat([...locales, cen, fin]);
}

/* Al LEER hay que aceptar comprimido: Excel guarda con deflate. Se recorre el directorio
 * central (y no los encabezados locales) porque es el unico lugar donde los tamanios son
 * confiables: con descriptor de datos, el encabezado local los trae en cero. */
function zipLeer(buf) {
  let fin = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) throw new Error('el archivo no es un .xlsx válido');
  const n = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const salida = {};
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const comp = buf.readUInt32LE(p + 20);
    const lnom = buf.readUInt16LE(p + 28), lext = buf.readUInt16LE(p + 30), lcom = buf.readUInt16LE(p + 32);
    const desp = buf.readUInt32LE(p + 42);
    const nombre = buf.slice(p + 46, p + 46 + lnom).toString('utf8');
    const lnomL = buf.readUInt16LE(desp + 26), lextL = buf.readUInt16LE(desp + 28);
    const ini = desp + 30 + lnomL + lextL;
    const crudo = buf.slice(ini, ini + comp);
    try { salida[nombre] = metodo === 0 ? crudo : zlib.inflateRawSync(crudo); } catch (_) {}
    p += 46 + lnom + lext + lcom;
  }
  return salida;
}

/* ── XML ──────────────────────────────────────────────────────────────────── */

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  /* Los caracteres de control rompen el XML y Excel se niega a abrir el archivo entero por
   * uno solo. Se sacan: vienen de pegar texto raro en un campo, no de nadie escribiendolo. */
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const desesc = (v) => String(v || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

/* A1, B1 … Z1, AA1 … */
function celda(col, fila) {
  let s = '', n = col + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s + (fila + 1);
}

/**
 * Escribe una hoja. `filas` es un array de arrays de texto; la primera es el encabezado.
 * @returns {Buffer}
 */
function escribir(filas, nombreHoja) {
  const hoja = (filas || []).map((f, i) =>
    '<row r="' + (i + 1) + '">' + (f || []).map((v, j) =>
      '<c r="' + celda(j, i) + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>').join('') + '</row>').join('');

  return zipEscribir([
    { nombre: '[Content_Types].xml', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>' },
    { nombre: '_rels/.rels', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>' },
    { nombre: 'xl/workbook.xml', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="' + esc(nombreHoja || 'Clientes') + '" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { nombre: 'xl/_rels/workbook.xml.rels', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>' },
    { nombre: 'xl/worksheets/sheet1.xml', datos: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + hoja + '</sheetData></worksheet>' },
  ]);
}

/**
 * Lee la primera hoja. Devuelve un array de arrays de texto.
 * @param {Buffer} buf
 */
function leer(buf) {
  const partes = zipLeer(buf);
  const nombreHoja = Object.keys(partes).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));
  if (!nombreHoja) throw new Error('el archivo no tiene ninguna hoja');
  const xml = partes[nombreHoja].toString('utf8');

  /* La tabla de strings compartidos: es lo que usa Excel cuando guarda. Sin leerla, un
   * archivo guardado desde Excel se lee como una grilla de numeros. */
  let compartidos = [];
  const sst = partes['xl/sharedStrings.xml'];
  if (sst) {
    compartidos = (sst.toString('utf8').match(/<si>[\s\S]*?<\/si>/g) || []).map((si) =>
      (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => desesc(t.replace(/<[^>]+>/g, ''))).join(''));
  }

  const filas = [];
  for (const fr of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
    const fila = [];
    for (const cm of fr.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || []) {
      const ref = (/r="([A-Z]+)\d+"/.exec(cm) || [])[1] || '';
      /* La columna sale de la REFERENCIA y no del orden: una fila con celdas vacias las
       * omite, y leerlas por orden correría todo a la izquierda. */
      let col = 0; for (let i = 0; i < ref.length; i++) col = col * 26 + (ref.charCodeAt(i) - 64);
      col = Math.max(0, col - 1);
      const tipo = (/t="([^"]+)"/.exec(cm) || [])[1] || 'n';
      let v = '';
      if (tipo === 'inlineStr') {
        v = (cm.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => desesc(t.replace(/<[^>]+>/g, ''))).join('');
      } else {
        const m = /<v>([\s\S]*?)<\/v>/.exec(cm);
        const bruto = m ? desesc(m[1]) : '';
        v = tipo === 's' ? (compartidos[parseInt(bruto, 10)] || '') : bruto;
      }
      fila[col] = v;
    }
    for (let i = 0; i < fila.length; i++) if (fila[i] === undefined) fila[i] = '';
    filas.push(fila);
  }
  return filas;
}

module.exports = { escribir, leer };
