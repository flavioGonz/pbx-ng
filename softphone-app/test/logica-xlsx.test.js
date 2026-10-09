/* Exportar/importar clientes del aparato en Excel (electron/xlsx.cjs, hecho a mano con
 * zlib). Se fija que lo que escribimos sea un .xlsx VÁLIDO —un ZIP con las partes que pide
 * OOXML, con CRC y tamaños correctos, que se puede leer con un lector independiente— y que
 * los datos (acentos, comillas, &, caracteres de control) vuelvan intactos. Y al leer, que
 * entienda lo que guarda Excel de verdad: deflate, sharedStrings, celdas vacías omitidas.
 * Una planilla que no abre, o que corre las columnas, es perder la libreta de clientes. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
const require = createRequire(import.meta.url);
const xlsx = require('../electron/xlsx.cjs');

/* Lector ZIP independiente del módulo: recorre los encabezados LOCALES (el módulo lee el
 * directorio central), verifica firma, CRC y tamaños. */
function unzipIndependiente(buf) {
  const partes = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const metodo = buf.readUInt16LE(p + 8), crc = buf.readUInt32LE(p + 14);
    const comp = buf.readUInt32LE(p + 18), tam = buf.readUInt32LE(p + 22);
    const ln = buf.readUInt16LE(p + 26), le = buf.readUInt16LE(p + 28);
    const nombre = buf.slice(p + 30, p + 30 + ln).toString('utf8');
    const crudo = buf.slice(p + 30 + ln + le, p + 30 + ln + le + comp);
    const datos = metodo === 0 ? crudo : zlib.inflateRawSync(crudo);
    expect(datos.length).toBe(tam);
    expect(zlib.crc32(datos)).toBe(crc);
    partes[nombre] = datos.toString('utf8');
    p += 30 + ln + le + comp;
  }
  expect(buf.readUInt32LE(p)).toBe(0x02014b50);                // sigue el directorio central
  const fin = buf.length - 22;
  expect(buf.readUInt32LE(fin)).toBe(0x06054b50);
  expect(buf.readUInt16LE(fin + 10)).toBe(Object.keys(partes).length);
  expect(buf.readUInt32LE(fin + 16)).toBe(p);                  // offset del central correcto
  return partes;
}

/* Un .xlsx "como lo guarda Excel": deflate, sharedStrings, tipos s/n/str, celdas omitidas. */
function zipDeflate(entradas) {
  const loc = [], cen = []; let off = 0;
  for (const [nombre, texto] of entradas) {
    const n = Buffer.from(nombre), d = Buffer.from(texto), c = zlib.deflateRawSync(d), crc = zlib.crc32(d);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(c.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(3, 28);
    loc.push(lh, n, Buffer.from([1, 2, 3]), c);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(c.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt16LE(2, 30); ch.writeUInt16LE(1, 32); ch.writeUInt32LE(off, 42);
    cen.push(ch, n, Buffer.from([0, 0, 9]));
    off += 30 + n.length + 3 + c.length;
  }
  const cb = Buffer.concat(cen), fin = Buffer.alloc(22 + 5);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(entradas.length, 8); fin.writeUInt16LE(entradas.length, 10); fin.writeUInt32LE(cb.length, 12); fin.writeUInt32LE(off, 16); fin.writeUInt16LE(5, 20);
  return Buffer.concat([...loc, cb, fin]);   // con comentario de 5 bytes al final
}

describe('escribir', () => {
  const FILAS = [['Cliente', 'Teléfonos', 'Cámara', 'RTSP'], ['Edificio "Sol" & Luna', '099 123', 'Portón <calle>', "rtsp://u:p'w@10.0.0.5/1"], ['Ñandú\u0001\u0007', '', null, 42]];

  it('genera un ZIP válido con las partes de OOXML y los datos adentro', () => {
    const buf = xlsx.escribir(FILAS, 'Clientes & más');
    expect(buf.slice(0, 4).toString('hex')).toBe('504b0304');
    const p = unzipIndependiente(buf);
    expect(Object.keys(p)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']);
    expect(p['[Content_Types].xml']).toContain('PartName="/xl/worksheets/sheet1.xml"');
    expect(p['_rels/.rels']).toContain('Target="xl/workbook.xml"');
    expect(p['xl/workbook.xml']).toContain('<sheet name="Clientes &amp; más" sheetId="1" r:id="rId1"/>');
    expect(p['xl/_rels/workbook.xml.rels']).toContain('Target="worksheets/sheet1.xml"');
    const hoja = p['xl/worksheets/sheet1.xml'];
    expect(hoja).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">Edificio &quot;Sol&quot; &amp; Luna</t></is></c>');
    expect(hoja).toContain('Portón &lt;calle&gt;');
    expect(hoja).not.toMatch(/[\u0001\u0007]/);              // control: Excel no abriría
    expect(hoja).toContain('<c r="D3"');
  });

  it('ida y vuelta: lo que se escribe se lee igual (todo como texto)', () => {
    expect(xlsx.leer(xlsx.escribir(FILAS))).toEqual([
      FILAS[0], FILAS[1], ['Ñandú', '', '', '42'],
    ]);
  });

  it('columnas más allá de la Z (AA, AB…) y hoja sin nombre ni filas', () => {
    const fila = Array.from({ length: 28 }, (_, i) => 'c' + i);
    const buf = xlsx.escribir([fila]);
    expect(unzipIndependiente(buf)['xl/worksheets/sheet1.xml']).toContain('<c r="AB1"');
    expect(xlsx.leer(buf)[0]).toEqual(fila);
    const vacio = xlsx.escribir(null);
    expect(unzipIndependiente(vacio)['xl/workbook.xml']).toContain('name="Clientes"');
    expect(xlsx.leer(vacio)).toEqual([]);
    expect(xlsx.leer(xlsx.escribir([null, ['x']]))).toEqual([[], ['x']]);
  });
});

describe('leer lo que guarda Excel', () => {
  const SST = '<sst><si><t>Nombre</t></si><si><r><t>Edi</t></r><r><t xml:space="preserve">ficio &amp; Cía</t></r></si><si><t>&#209;o &apos;x&apos;</t></si></sst>';
  const HOJA = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>3.5</v></c><c r="C2" t="str"><v>a&lt;b</v></c><c r="D2"/><c r="E2" t="s"><v>99</v></c><c r="F2" t="n"></c></row>'
    + '</sheetData></worksheet>';

  it('deflate + sharedStrings + celdas omitidas en su columna', () => {
    const buf = zipDeflate([['xl/sharedStrings.xml', SST], ['xl/worksheets/sheet3.xml', HOJA]]);
    expect(xlsx.leer(buf)).toEqual([
      ['Nombre', '', "Ño 'x'"],
      ['Edificio & Cía', '3.5', 'a<b', '', '', ''],
    ]);
  });

  it('sin sharedStrings los índices quedan vacíos; sin hoja o sin ZIP, error claro', () => {
    expect(xlsx.leer(zipDeflate([['xl/worksheets/sheet1.xml', HOJA]]))[0]).toEqual(['', '', '']);
    expect(() => xlsx.leer(zipDeflate([['xl/workbook.xml', '<x/>']]))).toThrow('el archivo no tiene ninguna hoja');
    expect(() => xlsx.leer(Buffer.from('no soy un zip, soy un csv;con;columnas'))).toThrow('el archivo no es un .xlsx válido');
  });

  it('una parte corrupta se ignora; un directorio central truncado corta la lectura', () => {
    const buf = zipDeflate([['xl/sharedStrings.xml', SST], ['xl/worksheets/sheet1.xml', HOJA]]);
    const roto = Buffer.from(buf);
    // corromper los datos deflate de la primera parte (sharedStrings)
    roto[30 + 'xl/sharedStrings.xml'.length + 3] ^= 0xff;
    roto[30 + 'xl/sharedStrings.xml'.length + 4] ^= 0xff;
    expect(xlsx.leer(roto)[1][0]).toBe('');                    // sin tabla: el índice no resuelve
    const fin = buf.length - 27;
    const sinCentral = Buffer.from(buf); sinCentral.writeUInt32LE(0, sinCentral.readUInt32LE(fin + 16));
    expect(() => xlsx.leer(sinCentral)).toThrow('el archivo no tiene ninguna hoja');
  });

  /* Excel escribe filas vacías auto-cerradas cuando sólo tienen formato. La regex de filas
   * la "pega" con la siguiente: la fila en blanco desaparece pero la de datos llega entera
   * y en sus columnas, que es lo que importa al importar. */
  it('una fila vacía auto-cerrada (<row/>) no hace perder la fila siguiente', () => {
    const hoja = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>uno</t></is></c></row><row r="2" ht="15" customHeight="1"/><row r="3"><c r="A3" t="inlineStr"><is><t>tres</t></is></c></row></sheetData></worksheet>';
    expect(xlsx.leer(zipDeflate([['xl/worksheets/sheet1.xml', hoja]]))).toEqual([['uno'], ['tres']]);
  });
});
