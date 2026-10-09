/* ============================================================================
 *  Marcación (marcacion.js): las piezas puras que deciden por dónde sale una llamada
 *  de la DISA o del callback, y el dialplan que se escribe.
 *
 *  `rutaGanadora` es lo que impide que una DISA «sólo nacional» curse una internacional:
 *  tiene que elegir la MISMA ruta que elegiría Asterisk (ext_cmp1 de pbx.c), y negar
 *  cuando no se puede saber. Acá se recorre cada símbolo de patrón y cada desempate.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const rutas = [];
const m = require('../marcacion')({
  app: { get() {}, put() {}, post() {}, delete() {} },
  pool: { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) },
  amiAction: async () => ({}), setDialplan: async () => {}, exigirExt: () => true, clientIp: () => '127.0.0.1',
  agentToken: '', errorHttp: () => {}, broadcastSoon: () => {},
});
void rutas;

test('matchPatron: cada símbolo de Asterisk, el guion ignorado y lo raro del lado seguro', () => {
  const casos = [
    ['_NXXXXXX', '2900123', true], ['_NXX-XXXX', '2900123', true], ['_NXXXXXX', '1900123', false],
    ['_ZXX', '100', true], ['_ZXX', '000', false], ['_zx', '10', true], ['_nx', '20', true], ['_xx', '99', true],
    ['_09[1-9]XXXXXX', '099123456', true], ['_09[1-9]XXXXXX', '090123456', false], ['_[24]X', '41', true],
    ['_0X.', '0', false], ['_0X.', '01', false], ['_0X.', '012', true], ['_00!', '00', true], ['_00!', '0012345', true],
    ['2001', '2001', true], ['2001', '2002', false], ['_*7X', '*71', false], ['_*7X', '71', false],
    ['_9[', '91', false], ['_9[abc]', '91', false], ['', '1', false], ['_X', '', false], ['_X', 'a', false], [null, '1', false],
  ];
  for (const [p, n, esperado] of casos) assert.equal(m.matchPatron(p, n), esperado, p + ' vs ' + n);
});

test('rutaGanadora: gana la más específica, como ext_cmp1', () => {
  const R = [
    { id: 1, pattern: '_0X.' },          // «salida por 0»
    { id: 2, pattern: '_00.' },          // internacional
    { id: 3, pattern: '_09[1-9]XXXXXX' },  // celulares
    { id: 4, pattern: '_2XXXXXXX' },
    { id: 5, pattern: '_*X' },           // no se entiende: fuera de la comparación
    { id: 6, pattern: '_2[0-9]XXXXXX' },  // empata con la 4 en especificidad
  ];
  assert.equal(m.rutaGanadora(R, '0034911222333').ruta.id, 2, 'la internacional le gana a «salida por 0»');
  assert.equal(m.rutaGanadora(R, '099123456').ruta.id, 3);
  assert.equal(m.rutaGanadora(R, '012345').ruta.id, 1);
  const e = m.rutaGanadora(R, '29001234');
  assert.equal(e.empate, true, 'dos patrones igual de específicos: no se puede saber cuál cursa');
  assert.equal(m.rutaGanadora(R, '5'), null);
  assert.equal(m.rutaGanadora(null, '5'), null);
  assert.equal(m.rutaGanadora([{ id: 9, pattern: '_N!' }, { id: 8, pattern: '_N.' }], '22').ruta.id, 8, '`.` le gana a `!`');
  assert.equal(m.rutaGanadora([{ id: 1, pattern: '_2XX' }, { id: 1, pattern: '_2XX' }], '211').empate, false, 'la misma ruta dos veces no es empate');
  assert.equal(m.rutaGanadora([{ id: 1, pattern: '_2[-]X' }], '21'), null, 'un rango sin dígitos no se entiende');
  assert.equal(m.rutaGanadora([{ id: 1, pattern: '_2-X' }, { id: 2, pattern: '_2[1-3]' }], '21').ruta.id, 2);
});

test('filasDisa: topes acotados, CallerID opcional, y el PIN nunca dentro del dialplan', () => {
  const f = m.filasDisa({ id: 7, nombre: 'Guardia', max_intentos: 99, max_digitos: 1, dur_seg: 5, dial_seg: 9999, callerid: '29001234' });
  const txt = f.map((r) => r.join(' ')).join('\n');
  assert.match(txt, /GotoIf \$\[\$\{INTENTO\} < 10\]/, 'max_intentos tiene techo 10');
  assert.match(txt, /DNUM,vm-enter-num-to-call,3,/, 'max_digitos tiene piso 3');
  assert.match(txt, /TIMEOUT\(absolute\)=30/);
  assert.match(txt, /Local\/\$\{FNUM\}@internal\/n,300/);
  assert.match(txt, /CALLERID\(num\)=29001234/);
  assert.match(txt, /CURLOPT\(timeout\)=4/);
  /* Las etiquetas se resuelven a prioridades: no queda ningún <<...>> sin reemplazar. */
  assert.doesNotMatch(txt, /<</);
  const sin = m.filasDisa({ id: 1 }).map((r) => r.join(' ')).join('\n');
  assert.doesNotMatch(sin, /CALLERID\(num\)=/);
  assert.match(sin, /INTENTO\} < 3/);
});

test('filasCallback: sin PIN cuelga y llama; con PIN pide la clave antes', () => {
  const lista = m.filasCallback({ id: 3, nombre: 'Vuelta', modo: 'lista' }).map((r) => r.join(' ')).join('\n');
  assert.doesNotMatch(lista, /Answer/, 'en modo lista no se atiende: el que llama no paga');
  assert.doesNotMatch(lista, /pin=/);
  for (const modo of ['pin', 'lista_pin']) {
    const p = m.filasCallback({ id: 3, modo }).map((r) => r.join(' ')).join('\n');
    assert.match(p, /Read CPIN,vm-password/);
    assert.match(p, /&pin=\$\{URIENCODE\(\$\{CPIN\}\)\}/);
  }
});

test('filasDbn: opciones y contexto de buzones validados, el de marcado siempre internal', () => {
  const f = (d) => m.filasDbn(d).find((r) => r[1] === 'Directory')[2];
  assert.equal(f({ opciones: 'fe', vm_context: 'oficina' }), 'oficina,internal,fe');
  assert.equal(f({ opciones: 'x;System(rm)', vm_context: 'a,b' }), 'default,internal,e', 'lo que no valida cae a los valores seguros');
  assert.equal(f({}), 'default,internal', 'sin opciones, el Directory va sin el tercer argumento');
});

test('filasAbrevPropio: lee la AstDB del propio interno y filtra el destino', () => {
  const t = m.filasAbrevPropio('*75').map((r) => r.join(' ')).join('\n');
  assert.match(t, /\$\{EXTEN:3\}/);
  assert.match(t, /FILTER\(0-9,\$\{DB\(abrev\/\$\{MIEXT\}-/);
  assert.match(t, /Goto internal,\$\{ADEST\},1/);
});
