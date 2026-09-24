/* ============================================================================
 *  El agente de IA como MIEMBRO de una cola (solapa «Agente IA» del editor).
 *
 *  Lo que estas pruebas cuidan es lo que diferencia «un agente más» de «un destino al que
 *  la cola rebota», y las trampas que tiene:
 *    · N simultáneas = N miembros con interfaces DISTINTAS (un solo miembro atiende de a
 *      una, porque Asterisk lo marca ocupado mientras habla) — y ese número es el tope de
 *      gasto, porque cada sesión del modelo se paga por minuto;
 *    · `desborde` se hace con la PENALIDAD de la cola, no con un destino de timeout;
 *    · apagar tiene que dejar la cola EXACTAMENTE como estaba: sin miembros de IA y sin
 *      extensiones sueltas en el dialplan;
 *    · y guardar desde otra solapa NO puede apagar el agente sin que nadie lo pida.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

const miembrosIA = (ctx, cola) => ctx.db
  .query("SELECT interface, membername, penalty FROM queue_members WHERE queue_name=$1 AND interface LIKE 'Local/ia%' ORDER BY interface", [cola])
  .then((r) => r.rows);
const extsIA = (ctx, cola) => ctx.db
  .query("SELECT DISTINCT exten FROM extensions WHERE context='ivr' AND exten LIKE $1 ORDER BY exten", ['ia' + cola + '_%'])
  .then((r) => r.rows.map((x) => x.exten));

test('cola: el agente de IA entra como miembro, con su penalidad y su tope', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  const ag = await api('POST', '/api/ai-agents', { token: admin, body: {
    name: 'Portero', exten: '9700', provider: 'openai-realtime', model: 'gpt-realtime-2.1-mini', voice: 'alloy' } });
  assert.equal(ag.status, 201, JSON.stringify(ag.json));
  const agenteId = ag.json.created;

  const cola = await api('POST', '/api/queues', { token: admin, body: { name: 'porteria', label: 'Portería', access_exten: '8010' } });
  assert.equal(cola.status, 201, JSON.stringify(cola.json));

  await t.test('una cola nueva NO tiene IA: una actualización no pone a un robot a atender', async () => {
    assert.equal(cola.json.ia_modo, 'apagado');
    assert.equal((await miembrosIA(ctx, 'porteria')).length, 0);
  });

  await t.test('desborde: la IA queda con MENOS prioridad que los humanos', async () => {
    const r = await api('PUT', '/api/queues/porteria', { token: admin, body: { label: 'Portería', ia_agente_id: agenteId, ia_modo: 'desborde', ia_simultaneas: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const m = await miembrosIA(ctx, 'porteria');
    assert.equal(m.length, 1, 'tiene que haber un miembro de IA');
    assert.equal(m[0].penalty, 1, 'en desborde la penalidad tiene que ser 1: si no, la IA atiende ANTES que las personas');
    assert.match(m[0].membername, /^IA /, 'el miembro tiene que decir que es la IA: lo ve el supervisor en el tablero');
    assert.deepEqual(await extsIA(ctx, 'porteria'), ['iaporteria_1'], 'falta la extensión Local del miembro');
  });

  await t.test('primero: misma prioridad que los humanos', async () => {
    const r = await api('PUT', '/api/queues/porteria', { token: admin, body: { ia_agente_id: agenteId, ia_modo: 'primero' } });
    assert.equal(r.status, 200);
    const m = await miembrosIA(ctx, 'porteria');
    assert.equal(m[0].penalty, 0);
  });

  await t.test('N simultáneas = N miembros con interfaces distintas', async () => {
    await api('PUT', '/api/queues/porteria', { token: admin, body: { ia_agente_id: agenteId, ia_modo: 'primero', ia_simultaneas: 3 } });
    const m = await miembrosIA(ctx, 'porteria');
    assert.equal(m.length, 3, 'con 3 simultáneas tienen que ser 3 miembros: uno solo atiende de a una llamada');
    assert.equal(new Set(m.map((x) => x.interface)).size, 3, 'las interfaces se repiten: Asterisk las trata como un solo miembro');
    assert.deepEqual(await extsIA(ctx, 'porteria'), ['iaporteria_1', 'iaporteria_2', 'iaporteria_3']);

    // Y bajar el número tiene que LIMPIAR lo que sobra, no dejarlo colgado.
    await api('PUT', '/api/queues/porteria', { token: admin, body: { ia_agente_id: agenteId, ia_modo: 'primero', ia_simultaneas: 1 } });
    assert.equal((await miembrosIA(ctx, 'porteria')).length, 1);
    assert.deepEqual(await extsIA(ctx, 'porteria'), ['iaporteria_1'], 'quedaron extensiones de los miembros que ya no existen');
  });

  await t.test('el tope de simultáneas se respeta aunque lo pidan más alto', async () => {
    await api('PUT', '/api/queues/porteria', { token: admin, body: { ia_agente_id: agenteId, ia_modo: 'primero', ia_simultaneas: 99 } });
    assert.equal((await miembrosIA(ctx, 'porteria')).length, 10, 'sin tope, una ráfaga de timbres abre 99 sesiones que se pagan por minuto');
    await api('PUT', '/api/queues/porteria', { token: admin, body: { ia_agente_id: agenteId, ia_modo: 'primero', ia_simultaneas: 2 } });
  });

  await t.test('guardar desde OTRA solapa no apaga el agente', async () => {
    /* El cuerpo de la solapa Básico no trae los campos de IA. Si eso se interpretara como
     * «apagar», guardar el nombre de la cola dejaría al portero sin atender y nadie
     * sabría por qué. */
    const r = await api('PUT', '/api/queues/porteria', { token: admin, body: { label: 'Portería (renombrada)', max_wait: 30 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ia_modo, 'primero', 'guardar otra solapa apagó el agente');
    assert.equal((await miembrosIA(ctx, 'porteria')).length, 2);
  });

  await t.test('apagar deja la cola exactamente como estaba', async () => {
    const r = await api('PUT', '/api/queues/porteria', { token: admin, body: { ia_modo: 'apagado', ia_agente_id: null } });
    assert.equal(r.status, 200);
    assert.equal((await miembrosIA(ctx, 'porteria')).length, 0, 'quedaron miembros de IA en una cola apagada');
    assert.deepEqual(await extsIA(ctx, 'porteria'), [], 'quedaron extensiones de IA en el dialplan');
  });

  await t.test('un agente deshabilitado en Voz no atiende, aunque la cola lo tenga puesto', async () => {
    await api('PUT', '/api/ai-agents/' + agenteId, { token: admin, body: { name: 'Portero', exten: '9700', provider: 'openai-realtime', enabled: false } });
    const r = await api('PUT', '/api/queues/porteria', { token: admin, body: { ia_agente_id: agenteId, ia_modo: 'primero', ia_simultaneas: 2 } });
    assert.equal(r.status, 200);
    assert.equal((await miembrosIA(ctx, 'porteria')).length, 0,
      'la cola timbraría a un agente apagado: las llamadas caerían en un miembro que no contesta');
  });

  await t.test('borrar el agente no deja la cola apuntando a un id que no existe', async () => {
    await api('PUT', '/api/ai-agents/' + agenteId, { token: admin, body: { name: 'Portero', exten: '9700', provider: 'openai-realtime', enabled: true } });
    await api('PUT', '/api/queues/porteria', { token: admin, body: { ia_agente_id: agenteId, ia_modo: 'primero', ia_simultaneas: 1 } });
    assert.equal((await miembrosIA(ctx, 'porteria')).length, 1);

    assert.equal((await api('DELETE', '/api/ai-agents/' + agenteId, { token: admin })).status, 200);
    const { rows } = await ctx.db.query("SELECT ia_agente_id FROM pbxng_queues WHERE name='porteria'");
    assert.equal(rows[0].ia_agente_id, null, 'la cola quedó apuntando a un agente borrado: se vería «IA encendida» sin nadie detrás');
  });

  await t.test('un modo inventado no se guarda', async () => {
    const antes = (await api('GET', '/api/queues/porteria', { token: admin })).json.ia_modo;
    await api('PUT', '/api/queues/porteria', { token: admin, body: { ia_modo: 'siempre-y-para-todo' } });
    const despues = (await api('GET', '/api/queues/porteria', { token: admin })).json.ia_modo;
    assert.equal(despues, antes, 'se guardó un modo que el backend no entiende');
  });
});
