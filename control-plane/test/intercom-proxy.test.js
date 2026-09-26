'use strict';
const test = require('node:test');
const assert = require('node:assert');
const p = require('../intercom-proxy');

test('por defecto apunta al go2rtc que viaja con la central', () => {
  assert.deepEqual(p.destinoDe(''), { host: 'pbxng-go2rtc', port: 1984, tls: false });
  assert.deepEqual(p.destinoDe('http://10.0.0.5:8080'), { host: '10.0.0.5', port: 8080, tls: false });
  assert.equal(p.destinoDe('https://video.cliente.com').port, 443);
});

/* La central no sabe con qué nombre la llaman desde afuera: lo único que lo sabe es lo
 * que reenvía el proxy inverso. Si esto se arma mal, el softphone termina pidiéndole el
 * video a «localhost» y no se ve nada. */
test('la base pública sale de lo que reenvía el proxy inverso', () => {
  const req = { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'pbx01.infratec.com.uy' } };
  assert.equal(p.basePublica(req), 'https://pbx01.infratec.com.uy/backend/api/intercom/g2');
});

test('sin Host no se inventa una base', () => {
  assert.equal(p.basePublica({ headers: {} }), '');
});

test('el token del softphone sólo puede mirar', () => {
  assert.equal(p.permitidoParaTelefono('GET', '/api/ws'), true);
  assert.equal(p.permitidoParaTelefono('GET', '/api/streams'), true);
  assert.equal(p.permitidoParaTelefono('GET', '/api/frame.jpeg'), true);
  assert.equal(p.permitidoParaTelefono('POST', '/api/streams'), false);
  assert.equal(p.permitidoParaTelefono('GET', '/api/config'), false);   // la config de go2rtc no
  assert.equal(p.permitidoParaTelefono('DELETE', '/api/ws'), false);
});
