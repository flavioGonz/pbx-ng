/* ============================================================================
 *  Estado en vivo de los internos (estados.js), sin base ni Asterisk de verdad.
 *
 *  Lo que se fija: que un `DeviceStateChange` llegue al panel como actividad (libre,
 *  timbrando, en llamada…) en un solo paquete por ráfaga; que el sembrado arranque con el
 *  estado de TODOS los aparatos y con las colas según Asterisk (no según la tabla, que no
 *  tiene a los agentes que entraron en caliente); y que «pausado» sea pausado en todas sus
 *  colas, no en una.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const initEstados = require('../estados');

function armar({ feats = [], qm = [], dispositivos = [], miembros = [], amiRoto = false, baseRota = false } = {}) {
  const emitidos = [];
  const ami = new EventEmitter();
  const io = { to: (sala) => ({ emit: (ev, d) => emitidos.push({ sala, ev, d }) }) };
  const pool = {
    async query(sql) {
      if (baseRota) throw new Error('base caída');
      if (/pbxng_ext_features/.test(sql)) return { rows: feats };
      if (/queue_members/.test(sql)) return { rows: qm };
      throw new Error(sql);
    },
  };
  const amiList = async (accion) => {
    if (amiRoto) throw new Error('AMI caído');
    return accion.Action === 'DeviceStateList' ? dispositivos : miembros;
  };
  const est = initEstados({ pool, ami, io, amiList });
  return { est, ami, emitidos };
}

test('DeviceStateChange: la ráfaga de una llamada sale en un solo paquete, traducida', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { est, ami, emitidos } = armar();
  est.iniciar();
  ami.emit('managerevent', { event: 'DeviceStateChange', device: 'PJSIP/2001', state: 'RINGING' });
  ami.emit('managerevent', { Event: 'DeviceStateChange', Device: 'PJSIP/2002', State: 'In Use' });
  ami.emit('managerevent', { event: 'DeviceStateChange', device: 'PJSIP/2002', state: 'INUSE' });   // igual que antes: nada
  ami.emit('managerevent', { event: 'DeviceStateChange', device: 'Local/2003@x-0001', state: 'INUSE' });   // no es un interno
  ami.emit('managerevent', { event: 'Newchannel' });
  ami.emit('managerevent', null);
  t.mock.timers.tick(60);
  assert.equal(emitidos.length, 1);
  assert.equal(emitidos[0].sala, 'state');
  assert.deepEqual(Object.keys(emitidos[0].d.internos).sort(), ['2001', '2002']);
  assert.equal(emitidos[0].d.internos['2001'].act, 'timbrando');
  assert.equal(emitidos[0].d.internos['2002'].act, 'en_llamada');
  for (const [crudo, act] of [['RINGINUSE', 'en_llamada_timbrando'], ['ONHOLD', 'en_espera'], ['NOT_INUSE', 'libre'], ['BUSY', 'en_llamada'], ['UNAVAILABLE', 'desconectado']]) {
    ami.emit('managerevent', { event: 'DeviceStateChange', device: 'PJSIP/2001', state: crudo });
    t.mock.timers.tick(60);
    assert.equal(emitidos.at(-1).d.internos['2001'].act, act, crudo);
  }
  assert.equal(est.instantanea().completo, true);
  assert.equal(est.filaDe('9999').act, 'desconectado');
});

test('colas por evento: pausado es pausado en TODAS, y salir de la cola lo saca', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { est, ami } = armar();
  est.iniciar();
  ami.emit('managerevent', { event: 'QueueMemberAdded', interface: 'PJSIP/2001', queue: 'ventas', paused: '0' });
  ami.emit('managerevent', { event: 'QueueMemberAdded', interface: 'PJSIP/2001', queue: 'soporte', paused: '0' });
  ami.emit('managerevent', { event: 'QueueMemberPause', interface: 'PJSIP/2001', queue: 'ventas', paused: '1', pausedreason: 'almuerzo' });
  assert.equal(est.filaDe('2001').pausa, false, 'pausado en una y activo en otra sigue atendiendo');
  ami.emit('managerevent', { event: 'QueueMemberRemoved', interface: 'PJSIP/2001', queue: 'soporte' });
  ami.emit('managerevent', { event: 'QueueMemberStatus', interface: 'PJSIP/2001', queue: 'ventas', paused: '1', pausedreason: 'almuerzo' });
  assert.deepEqual([est.filaDe('2001').pausa, est.filaDe('2001').pausa_motivo, est.filaDe('2001').colas], [true, 'almuerzo', ['ventas']]);
  ami.emit('managerevent', { event: 'QueueMemberStatus', interface: 'Local/x', queue: 'ventas' });
  ami.emit('managerevent', { event: 'QueueMemberStatus', interface: 'PJSIP/2002' });
  assert.deepEqual(est.filaDe('2002').colas, []);
});

test('sembrado: todos los aparatos, las colas según Asterisk y los desvíos según la base', async (t) => {
  const { est } = armar({
    dispositivos: [{ Device: 'PJSIP/2001', State: 'NOT_INUSE' }, { device: 'PJSIP/2002', state: 'INUSE' }, { Device: 'Custom:DND2001', State: 'INUSE' }],
    miembros: [{ Location: 'PJSIP/2001', Queue: 'ventas', Paused: '1' }, { Interface: 'PJSIP/2003', Queue: 'ventas', Paused: '0' }, { Location: 'SIP/x', Queue: 'v' }, { Location: 'PJSIP/2004' }],
    feats: [
      { ext: '2001', dnd: true, cfu: '', cfb: '', cfnr: '', fm: '' },
      { ext: '2002', dnd: false, cfu: '099', cfb: '', cfnr: '', fm: '' },
      { ext: '2003', dnd: false, cfu: '', cfb: '2010', cfnr: '', fm: '' },
      { ext: '2004', dnd: false, cfu: '', cfb: '', cfnr: '2011', fm: '' },
      { ext: '2005', dnd: false, cfu: '', cfb: '', cfnr: '', fm: '099111' },
    ],
    qm: [{ queue_name: 'soporte', interface: 'PJSIP/2003', paused: 1 }, { queue_name: 'x', interface: 'Local/1', paused: 0 }],
  });
  await est.sembrar();
  const f = (e) => est.filaDe(e);
  assert.deepEqual([f('2001').act, f('2001').dnd, f('2001').pausa, f('2001').colas], ['libre', true, true, ['ventas']]);
  assert.equal(f('2002').act, 'en_llamada');
  assert.deepEqual([f('2002').desvio, f('2002').desvio_a], ['incondicional', '099']);
  assert.deepEqual([f('2003').desvio, f('2003').colas, f('2003').pausa], ['ocupado', ['ventas', 'soporte'], false]);
  assert.equal(f('2004').desvio, 'sin_respuesta');
  assert.equal(f('2005').desvio, 'sigueme');
  assert.equal(est.instantanea().internos['2001'].ext, '2001');
});

test('sembrado con el AMI o la base caídos: no rompe; y al sacar las marcas se limpian', async () => {
  await armar({ amiRoto: true, baseRota: true }).est.sembrar();
  const feats = [{ ext: '2001', dnd: true }];
  const { est } = armar({ feats });
  await est.releerMarcas();
  assert.equal(est.filaDe('2001').dnd, true);
  feats.length = 0;   // se le sacó el DND en la base
  await est.releerMarcas();
  assert.equal(est.filaDe('2001').dnd, false, 'el panel tiene que ver que se sacó el DND');
});

test('arranque: siembra a los 2,5 s y reconcilia cada tanto', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let listas = 0;
  const ami = new EventEmitter();
  const est = initEstados({ pool: { query: async () => ({ rows: [] }) }, ami, io: { to: () => ({ emit() {} }) }, amiList: async () => { listas++; return []; } });
  est.iniciar();
  t.mock.timers.tick(2500);
  t.mock.timers.tick(30000);
  await new Promise((ok) => setImmediate(ok));
  assert.ok(listas >= 2);
});
