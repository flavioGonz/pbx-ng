'use strict';
const test = require('node:test');
const assert = require('node:assert');
const pipe = require('../ai-pipeline');

/* El caso real: la api se reinicia (pasa en cada despliegue) mientras alguien habla con
 * el agente. Asterisk deja el canal del que llamó parado dentro de la aplicación Stasis,
 * esperando órdenes de un proceso que ya no existe. Nadie lo cuelga: el interno queda
 * ocupado y el panel muestra una llamada eterna. Esto prueba que el barrido lo levanta. */
function ariFalso(canales) {
  const colgados = [];
  return {
    colgados,
    channels: {
      list: async () => canales,
      hangup: async ({ channelId }) => { colgados.push(channelId); },
    },
  };
}
const viejo = new Date(Date.now() - 300000).toISOString();
const reciente = new Date().toISOString();

test('cuelga la llamada que quedó parada en la aplicación de IA sin sesión', async () => {
  const ari = ariFalso([{ id: 'c1', name: 'PJSIP/2002-28', creationtime: viejo, dialplan: { app_data: 'pbxng,ai,1' } }]);
  pipe._setAri(ari);
  await pipe._barrer();
  assert.deepEqual(ari.colgados, ['c1']);
});

test('no toca una llamada recién entrada: todavía se está armando la sesión', async () => {
  const ari = ariFalso([{ id: 'c2', name: 'PJSIP/2002-29', creationtime: reciente, dialplan: { app_data: 'pbxng,ai,1' } }]);
  pipe._setAri(ari);
  await pipe._barrer();
  assert.deepEqual(ari.colgados, []);
});

test('no toca la llamada de una sesión viva', async () => {
  const ari = ariFalso([{ id: 'c3', name: 'PJSIP/2002-30', creationtime: viejo, dialplan: { app_data: 'pbxng,ai,1' } }]);
  pipe._setAri(ari);
  const ses = pipe._sesiones();
  ses.set('viva', { channel: { id: 'c3' }, uuid: 'viva', nacida: Date.now() });
  try { await pipe._barrer(); } finally { ses.delete('viva'); }
  assert.deepEqual(ari.colgados, []);
});

test('sigue colgando el canal de medios sin sesión (lo de antes no se rompió)', async () => {
  const uuid = 'f845ed80-93ac-4df6-a834-872f74a96916';
  const ari = ariFalso([{ id: 'm1', name: 'AudioSocket/127.0.0.1:9092-' + uuid, creationtime: viejo, dialplan: { app_data: 'pbxng,' + uuid } }]);
  pipe._setAri(ari);
  await pipe._barrer();
  assert.deepEqual(ari.colgados, ['m1']);
});

test('los canales ajenos no se tocan nunca', async () => {
  const ari = ariFalso([
    { id: 'x1', name: 'PJSIP/1008-01', creationtime: viejo, dialplan: { app_data: 'otra-app,cosa' } },
    { id: 'x2', name: 'PJSIP/1009-02', creationtime: viejo, dialplan: {} },
  ]);
  pipe._setAri(ari);
  await pipe._barrer();
  assert.deepEqual(ari.colgados, []);
});

/* El caso que se vio en pbx01 el 28/9: el proveedor cerró la sesión del modelo y la
 * llamada quedó ARRIBA, con el visitante escuchando silencio; el canal llevaba quince
 * minutos así. El tope de duración es la última red: si algo se escapó de todos los
 * caminos de cierre, el barrido lo corta igual. */
test('el tope de duración corta una sesión que quedó viva de más', async () => {
  const ari = ariFalso([]);
  pipe._setAri(ari);
  const ses = pipe._sesiones();
  const colgado = [];
  ses.set('eterna', {
    uuid: 'eterna', nacida: Date.now() - 16 * 60000,
    channel: { id: 'cE', hangup: async () => { colgado.push('cE'); } },
    log: () => {},
  });
  try { await pipe._barrer(); } finally { ses.delete('eterna'); }
  assert.deepEqual(colgado, ['cE'], 'la llamada pasada de tiempo tiene que colgarse');
});

test('una sesión dentro del tope no se toca', async () => {
  const ari = ariFalso([]);
  pipe._setAri(ari);
  const ses = pipe._sesiones();
  const colgado = [];
  ses.set('normal', {
    uuid: 'normal', nacida: Date.now() - 60000,
    channel: { id: 'cN', hangup: async () => { colgado.push('cN'); } },
    log: () => {},
  });
  try { await pipe._barrer(); } finally { ses.delete('normal'); }
  assert.deepEqual(colgado, []);
});
