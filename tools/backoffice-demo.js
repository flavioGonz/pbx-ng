#!/usr/bin/env node
'use strict';
/* ============================================================================
 *  Backoffice de MENTIRA que habla el contrato de PBX-NG.
 *
 *  Para qué: probar la caja de herramientas remota sin esperar a que el equipo del cliente
 *  tenga su endpoint. Levanta las dos rutas con datos inventados, verifica la firma igual
 *  que tendría que hacerlo el de verdad, y —a propósito— publica también un par de
 *  herramientas MAL FORMADAS, para que se vea en el panel qué descarta la central y por qué.
 *
 *  Uso:
 *      PBXNG_SECRETO=loquesea node tools/backoffice-demo.js 8099
 *
 *  Después, en el panel: Agentes IA → el agente → Herramientas → Caja del backoffice,
 *  URL http://<esta-maquina>:8099 y el mismo secreto. «Probar» tiene que listar
 *  `bo_expensas_al_dia`, `bo_visita_agendada` y `bo_avisar_al_titular`, y mostrar las
 *  otras tres en «descartadas».
 *
 *  NO es un ejemplo de cómo guardar datos ni de cómo autenticar usuarios: es el mínimo
 *  para ejercitar el contrato. Vive en `tools/` y no en `control-plane/` por eso mismo.
 * ==========================================================================*/
const http = require('http');
const crypto = require('crypto');

const PUERTO = Number(process.argv[2] || 8099);
const SECRETO = process.env.PBXNG_SECRETO || '';

/* Datos de mentira: una unidad al día, una que debe, y una visita agendada. */
const UNIDADES = {
  402: { titular: 'Pérez', al_dia: true, visita: 'Juan Gómez, hoy de 14 a 18' },
  301: { titular: 'Rodríguez', al_dia: false, visita: null },
};

const CATALOGO = [
  { nombre: 'expensas_al_dia',
    descripcion: 'Dice si una unidad está al día con las expensas. Usala sólo si el visitante o el titular lo pregunta.',
    parametros: { type: 'object', properties: { unidad: { type: 'string', description: 'Número de unidad' } }, required: ['unidad'] } },
  { nombre: 'visita_agendada',
    descripcion: 'Dice si la unidad tiene una visita agendada para hoy y a nombre de quién.',
    parametros: { type: 'object', properties: { unidad: { type: 'string', description: 'Número de unidad' } }, required: ['unidad'] } },
  { nombre: 'avisar_al_titular',
    descripcion: 'Le manda un aviso al titular de la unidad de que hay alguien esperando en la puerta.',
    parametros: { type: 'object', properties: { unidad: { type: 'string' }, quien: { type: 'string', description: 'Quién está esperando' } }, required: ['unidad'] } },

  /* A propósito mal formadas: tienen que aparecer como descartadas en la pantalla de prueba. */
  { nombre: 'abrir_porton', descripcion: 'abre la puerta principal' },   // pisa una de la central
  { nombre: 'Con Mayúsculas', descripcion: 'nombre inválido' },          // nombre inválido
  { nombre: 'sin_texto' },                                               // sin descripción
];

const leer = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); });
const responder = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const cuerpo = await leer(req);
  /* La firma se verifica SIEMPRE, también en el demo: uno que no la verifica enseña a
   * integrarlo mal, y el que copia este archivo copia justamente esa parte. */
  if (SECRETO) {
    const esperada = crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('hex');
    const trae = String(req.headers['x-pbxng-firma'] || '');
    const ok = trae.length === esperada.length
      && crypto.timingSafeEqual(Buffer.from(trae), Buffer.from(esperada));
    if (!ok) { console.log('[bo] firma inválida'); return responder(res, 401, { ok: false, motivo: 'firma inválida' }); }
  }
  let j = {};
  try { j = JSON.parse(cuerpo || '{}'); } catch (_) { j = {}; }

  if (req.url.endsWith('/herramientas')) {
    console.log('[bo] catálogo pedido');
    return responder(res, 200, { herramientas: CATALOGO });
  }
  if (req.url.endsWith('/ejecutar')) {
    const u = UNIDADES[String((j.args || {}).unidad || '').trim()];
    console.log('[bo] ejecutar', j.herramienta, JSON.stringify(j.args || {}), '· llamante', (j.contexto || {}).llamante);
    if (!u) return responder(res, 200, { ok: false, motivo: 'no encontré esa unidad' });
    switch (j.herramienta) {
      case 'expensas_al_dia':
        return responder(res, 200, { ok: true, texto: u.al_dia ? 'La unidad está al día.' : 'La unidad tiene expensas pendientes.', datos: { al_dia: u.al_dia } });
      case 'visita_agendada':
        return responder(res, 200, u.visita
          ? { ok: true, texto: 'Hay una visita agendada: ' + u.visita }
          : { ok: false, motivo: 'no hay visitas agendadas para esa unidad' });
      case 'avisar_al_titular':
        return responder(res, 200, { ok: true, texto: 'Le avisé a ' + u.titular + ' que hay alguien esperando.' });
      default:
        return responder(res, 200, { ok: false, motivo: 'esa herramienta no existe acá' });
    }
  }
  responder(res, 404, { ok: false, motivo: 'ruta desconocida' });
}).listen(PUERTO, '0.0.0.0', () => {
  console.log('[bo] backoffice de prueba en :' + PUERTO + (SECRETO ? ' (firma exigida)' : ' (SIN firma: sólo para una prueba local)'));
});
