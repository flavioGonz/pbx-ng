/* ============================================================================
 *  Los .conf que genera el panel para lo que Asterisk no lee de la base.
 *
 *  El aparcado y la música en espera viven en archivos (pbxng.d/*.conf). Lo que se
 *  prueba es que el archivo diga lo que el operador configuró, que un nombre con
 *  caracteres raros no pueda escribir fuera de su carpeta ni romper el .conf, y que
 *  los defaults sean los que el manual promete.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Las carpetas se leen del entorno al cargar el módulo: van ANTES del require. */
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'astconf-'));
process.env.AST_CONF_DIR = path.join(RAIZ, 'pbxng.d');
process.env.AST_MOH_DIR = path.join(RAIZ, 'moh');
process.env.AST_MOH_DIR_ASTERISK = '/var/lib/asterisk/sounds/custom/moh';
const ac = require('../astconf');
test.after(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

const leer = (ruta) => fs.readFileSync(ruta, 'utf8');

test('las carpetas salen del entorno', () => {
  assert.equal(ac.DIR, process.env.AST_CONF_DIR);
  assert.equal(ac.MOH_DIR, process.env.AST_MOH_DIR);
});

test('aparcado con los defaults: 700, plazas 701-720, 300 s y vuelve a quien aparcó', () => {
  const ruta = ac.parking();
  assert.equal(ruta, path.join(ac.DIR, 'parking.conf'));
  const t = leer(ruta);
  assert.match(t, /GENERADO POR EL PANEL/);
  assert.match(t, /^\[default\]$/m);
  assert.match(t, /^parkext = 700$/m);
  assert.match(t, /^parkpos = 701-720$/m);
  assert.match(t, /^parkingtime = 300$/m);
  assert.match(t, /^comebacktoorigin = yes$/m);
});

test('aparcado configurado: plazas al revés se ordenan, el tiempo tiene piso de 10 s', () => {
  const t = leer(ac.parking({ parkext: '8;0 0', desde: '830', hasta: '810', parkingtime: '3', comebacktoorigin: false }));
  assert.match(t, /^parkext = 800$/m, 'los caracteres que no van en un número se descartan');
  assert.match(t, /^parkpos = 810-830$/m);
  assert.match(t, /^parkingtime = 10$/m);
  assert.match(t, /^comebacktoorigin = no$/m);
});

test('música en espera: una sección por clase, con orden y anuncio; «default» es de fábrica', () => {
  const ruta = ac.moh([
    { nombre: 'default' },
    { nombre: 'Recepción 1', sort: 'random', announcement: 'bienvenida.wav' },
    { nombre: 'ventas', sort: 'cualquiera' },
    { nombre: '' },
  ]);
  assert.equal(ruta, path.join(ac.DIR, 'moh.conf'));
  const t = leer(ruta);
  assert.match(t, /4 clase\(s\)/);
  assert.doesNotMatch(t, /^\[default\]$/m);
  assert.match(t, /^\[Recepcin1\]$/m, 'los espacios y acentos no llegan al nombre de la sección');
  assert.match(t, /^directory=\/var\/lib\/asterisk\/sounds\/custom\/moh\/Recepcin1$/m);
  assert.match(t, /^sort=random$/m);
  assert.match(t, /^announcement=bienvenida.wav$/m);
  assert.match(t, /^\[ventas\]\nmode=files\ndirectory=.*\/ventas\nsort=alpha$/m, 'un orden desconocido cae en alpha');
});

test('música en espera sin clases deja un archivo válido y vacío', () => {
  const t = leer(ac.moh());
  assert.match(t, /0 clase\(s\)/);
  assert.doesNotMatch(t, /^\[/m);
});

test('las carpetas de música: crear, listar sólo audios, y borrar sin salir de MOH_DIR', () => {
  const d = ac.mohCarpeta('../../etc/espera');
  assert.equal(path.dirname(d), ac.MOH_DIR, 'un nombre con ../ no puede salir de la carpeta de música');
  assert.ok(fs.statSync(d).isDirectory());
  for (const f of ['b.wav', 'a.MP3', 'notas.txt', 'c.gsm']) fs.writeFileSync(path.join(d, f), '');
  assert.deepEqual(ac.mohArchivos('../../etc/espera'), ['a.MP3', 'b.wav', 'c.gsm']);

  ac.mohBorrarCarpeta('../../etc/espera');
  assert.equal(fs.existsSync(d), false);
  assert.deepEqual(ac.mohArchivos('no-existe'), [], 'una clase sin carpeta no tiene audios');
});

test('borrar con un nombre vacío no borra la carpeta de música entera', () => {
  ac.mohCarpeta('queda');
  ac.mohBorrarCarpeta('');
  ac.mohBorrarCarpeta('///');
  assert.ok(fs.existsSync(path.join(ac.MOH_DIR, 'queda')));
});

test('escribir crea la carpeta si no existe y devuelve la ruta', () => {
  fs.rmSync(ac.DIR, { recursive: true, force: true });
  const ruta = ac.escribir('x.conf', 'hola');
  assert.equal(leer(ruta), 'hola');
});
