'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ag = require('../agenda-telefonos');

const LISTA = [
  { nombre: 'Juan Pérez', numeros: ['2001'], grupo: 'Internos' },
  { nombre: 'Ana & Cía', numeros: ['2002'], grupo: 'Internos' },
  { nombre: 'Edificio Sur', numeros: ['099 123 456', '+59824001122'], grupo: 'Clientes' },
];

test('el ampersand del nombre se escapa: sin esto el teléfono descarta el XML entero', () => {
  for (const f of ['yealink', 'grandstream', 'fanvil', 'snom']) {
    const { cuerpo } = ag.rendir(f, LISTA);
    assert.ok(cuerpo.includes('&amp;'), f + ' no escapó el &');
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(cuerpo), f + ' dejó un & suelto');
  }
});

test('los números quedan marcables: sin espacios ni signos', () => {
  const { cuerpo } = ag.rendir('fanvil', LISTA);
  assert.ok(cuerpo.includes('<Telephone>099123456</Telephone>'));
  assert.ok(!cuerpo.includes('099 123 456'));
});

test('el + de un internacional se conserva', () => {
  assert.equal(ag._numero('+598 2 400 11 22'), '+59824001122');
});

test('Yealink arma una carpeta por grupo', () => {
  const x = ag.yealink(LISTA, 'Infratec');
  assert.ok(x.includes('<Title>Infratec</Title>'));
  assert.ok(x.includes('<Menu Name="Internos">'));
  assert.ok(x.includes('<Menu Name="Clientes">'));
  assert.ok(x.includes('Phone1="2001"'));
});

test('Yealink pone los tres teléfonos del mismo contacto en la misma entrada', () => {
  const x = ag.yealink([{ nombre: 'Portería', numeros: ['7700', '7701'], grupo: 'Internos' }]);
  assert.ok(/Phone1="7700"\s+Phone2="7701"/.test(x));
});

test('Grandstream numera los grupos y los referencia desde el contacto', () => {
  const x = ag.grandstream(LISTA);
  assert.ok(x.includes('<name>Clientes</name>'));
  assert.ok(x.includes('<FirstName>Juan Pérez</FirstName>'));
  assert.ok(/<Groups><groupid>\d+<\/groupid><\/Groups>/.test(x));
  assert.ok(x.includes('<accountindex>1</accountindex>'));
});

test('Fanvil y Akuvox hablan el mismo dialecto', () => {
  assert.equal(ag.rendir('akuvox', LISTA).cuerpo, ag.rendir('fanvil', LISTA).cuerpo);
});

test('sin carpetas, el grupo se antepone al nombre para no perderlo', () => {
  const x = ag.fanvil(LISTA);
  assert.ok(x.includes('Clientes · Edificio Sur'));
});

test('un solo grupo no ensucia los nombres', () => {
  const x = ag.fanvil([{ nombre: 'Juan', numeros: ['2001'], grupo: 'Internos' }]);
  assert.ok(x.includes('<Name>Juan</Name>'));
});

test('los contactos sin número o sin nombre no llegan al teléfono', () => {
  const cs = ag.normalizar([{ nombre: 'Sin número', numeros: [] }, { nombre: '', numeros: ['2003'] }, { nombre: 'Ok', numeros: ['2004'] }]);
  assert.deepEqual(cs.map(c => c.nombre), ['Ok']);
});

test('el mismo número dos veces en el mismo grupo se muestra una sola vez', () => {
  const cs = ag.normalizar([
    { nombre: 'Juan', numeros: ['2001'], grupo: 'Internos' },
    { nombre: 'Juan P', numeros: ['2001'], grupo: 'Internos' },
  ]);
  assert.equal(cs.length, 1);
});

test('el CSV sale con encabezado y comillas dobladas', () => {
  const x = ag.csv([{ nombre: 'Dice "hola"', numeros: ['2001'], grupo: 'Internos' }]);
  assert.ok(x.startsWith('grupo,nombre,numero'));
  assert.ok(x.includes('"Dice ""hola"""'));
});

test('una marca que no conocemos devuelve null, no un XML inventado', () => {
  assert.equal(ag.rendir('marca-rara', LISTA), null);
});

test('la lista vacía sale como un XML válido y vacío, no como un error', () => {
  const x = ag.yealink([]);
  assert.ok(x.includes('<YealinkIPPhoneBook>') && x.includes('</YealinkIPPhoneBook>'));
});
