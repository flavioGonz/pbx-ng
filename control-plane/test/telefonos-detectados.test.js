'use strict';
const test = require('node:test');
const assert = require('node:assert');
const d = require('../telefonos-detectados');

const CONTACTOS = [
  { endpoint: '2001', uri: 'sip:2001@192.168.99.9:6000;ob', user_agent: 'UniFi VoIP Phone' },
  { endpoint: '2002', uri: 'sip:2002@192.168.99.254:5062', user_agent: 'PBX-NG Softphone' },
  { endpoint: '3001', uri: 'sip:3001@192.168.1.40:5060', user_agent: 'Yealink SIP-T46S 66.85.0.5' },
  { endpoint: '3002', uri: 'sip:3002@192.168.1.41:5060', user_agent: 'Grandstream GXP1625 1.0.4.128 00:0b:82:11:22:33' },
  { endpoint: '7000', uri: 'sip:7000@192.168.1.60:5060', user_agent: 'Akuvox R29 29.30.4.18' },
];

test('el softphone no aparece: no hay nada que aprovisionar en él', () => {
  const r = d.detectar(CONTACTOS, []);
  assert.ok(!r.find(x => x.ext === '2002'), 'el softphone no debería listarse');
});

test('un teléfono registrado y no dado de alta sale como pendiente', () => {
  const r = d.detectar(CONTACTOS, []);
  const y = r.find(x => x.ext === '3001');
  assert.equal(y.aprovisionado, false);
  assert.equal(y.marca, 'Yealink');
  assert.equal(y.vendor, 'yealink');
  assert.equal(y.agenda, 'yealink');
  assert.equal(y.ip, '192.168.1.40');
});

test('si ya está dado de alta, se marca — y se usa la MAC de la central, no la adivinada', () => {
  const r = d.detectar(CONTACTOS, [{ ext: '3001', mac: 'aabbccddeeff', vendor: 'yealink' }]);
  const y = r.find(x => x.ext === '3001');
  assert.equal(y.aprovisionado, true);
  assert.equal(y.mac, 'aabbccddeeff');
});

test('la MAC se lee del User-Agent cuando el teléfono la regala', () => {
  const r = d.detectar(CONTACTOS, []);
  assert.equal(r.find(x => x.ext === '3002').mac, '000b82112233');
});

test('sin MAC no se inventa ninguna: mejor escribirla que aprovisionar el aparato equivocado', () => {
  const r = d.detectar(CONTACTOS, []);
  assert.equal(r.find(x => x.ext === '3001').mac, '');
});

test('Akuvox usa el dialecto de libreta de Fanvil', () => {
  const r = d.detectar(CONTACTOS, []);
  const a = r.find(x => x.ext === '7000');
  assert.equal(a.vendor, 'akuvox');
  assert.equal(a.agenda, 'fanvil');
});

test('una marca sin libreta remota lo dice con null, no ofrece una URL inútil', () => {
  const r = d.detectar(CONTACTOS, []);
  const u = r.find(x => x.ext === '2001');
  assert.equal(u.marca, 'UniFi VoIP Phone');
  assert.equal(u.agenda, null);
});

test('una marca que no conocemos se lista igual: registrado es registrado', () => {
  const r = d.detectar([{ endpoint: '4000', uri: 'sip:4000@10.0.0.5', user_agent: 'MarcaRara 1.0' }], []);
  assert.equal(r.length, 1);
  assert.equal(r[0].marca, 'Desconocida');
  assert.equal(r[0].agenda, null);
});

test('los pendientes salen primero: son los que hay que atender', () => {
  const r = d.detectar(CONTACTOS, [{ ext: '3001', mac: 'aabbccddeeff', vendor: 'yealink' }]);
  assert.equal(r[0].aprovisionado, false);
  assert.equal(r[r.length - 1].aprovisionado, true);
});

test('un teléfono con dos contactos registrados se cuenta una vez', () => {
  const r = d.detectar([CONTACTOS[2], { ...CONTACTOS[2], uri: 'sip:3001@192.168.1.99:5060' }], []);
  assert.equal(r.length, 1);
});

test('el modelo sale del User-Agent sin confundirse con la versión de firmware', () => {
  assert.equal(d.modeloDe('Yealink SIP-T46S 66.85.0.5', d.marcaDe('Yealink SIP-T46S 66.85.0.5')), 'SIP-T46S');
});
