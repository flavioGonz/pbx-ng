/* ============================================================================
 *  Las plantillas de correo (emails.js): que digan lo que tienen que decir, que lo que
 *  viene de afuera se escape, y que lo sensible (el PIN) no aparezca donde se ve sin
 *  abrir el correo.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../emails');

/* El preheader es el <div> oculto del principio: lo que se ve en la bandeja sin abrir. */
const preheader = (html) => (/<div style="display:none;[^"]*">([^<]*)<\/div>/.exec(html) || [])[1];
const titulo = (html) => (/<title>([^<]*)<\/title>/.exec(html) || [])[1];

test('alerta: tema por evento, tabla de datos y botón al panel sólo si hay URL', () => {
  const a = e.alertEmail({ brand: 'Sur', event: 'security.attack', severity: 'crit', title: 'Ataque <b>', lines: [['IP', '1.2.3.4'], ['Intentos', 30]], foot: 'pie', panelUrl: 'https://pbx/seguridad' });
  assert.equal(titulo(a), 'Ataque &lt;b&gt;');
  assert.match(a, new RegExp(e.THEMES.attack.accent));
  assert.match(a, /1\.2\.3\.4/);
  assert.match(a, /https:\/\/pbx\/seguridad/);
  const sin = e.alertEmail({ event: 'evento.nuevo', severity: 'info', title: 'x' });
  assert.match(sin, new RegExp(e.THEMES.info.accent), 'un evento sin tema cae en info');
  assert.doesNotMatch(sin, /Abrir el panel/);
  for (const sev of ['warn', 'info', 'crit']) assert.ok(e.alertEmail({ event: 'trunk.down', severity: sev, title: 't' }));
});

test('resumen: tarjetas de KPI de a dos (todas), filas extra y subtítulo', () => {
  const kpis = Array.from({ length: 8 }, (_, i) => ({ label: 'K' + i, value: i }));
  const d = e.digestEmail({ brand: 'Sur', title: 'Resumen', kpis, rows: [['Top interno 1', '2001 · 5']], panelUrl: 'https://pbx/', subtitle: 'Sub', foot: 'f' });
  for (let i = 0; i < 8; i++) assert.match(d, new RegExp('K' + i), 'no se pierde ninguna tarjeta');
  assert.match(d, /Top interno 1/);
  assert.match(d, /Sub/);
  assert.ok(e.digestEmail({ title: 'vacío' }));
  assert.doesNotMatch(e.kpiGrid([]), /<td/, 'sin KPI no hay tarjetas');
  assert.match(e.kpiGrid([{ label: 'a', value: 1 }, { label: 'b', value: 2 }, { label: 'c', value: 3 }]), /c/);
  assert.equal(e.rowsTable([]), '');
});

test('buzón de voz: transcripción destacada y escapada, aviso del adjunto, preheader con la transcripción', () => {
  const v = e.voicemailEmail({ brand: 'Sur', mailbox: '2001', fullname: 'Ana', from: '099 <script>', when: 'hoy', duration: 7, transcript: 'Hola <img src=x> te llamo por la factura de setiembre y algo más largo para el preheader '.repeat(2), hasAudio: true, panelUrl: 'https://pbx/voz' });
  assert.match(v, /Transcripción automática/);
  assert.doesNotMatch(v, /<img src=x>/, 'la transcripción no puede inyectar HTML');
  assert.match(v, /va <b>adjunto<\/b>/);
  assert.match(preheader(v), /^Hola &lt;img/, 'el preheader es el principio de la transcripción, escapado');
  assert.ok(preheader(v).length < 160, 'y corto: se recorta a 110 caracteres antes de escapar');
  assert.match(v, /Escuchar en el panel/);
  const sin = e.voicemailEmail({ mailbox: '2001' });
  assert.match(titulo(sin), /desconocido/);
  assert.equal(preheader(sin), 'Mensaje de voz para el interno 2001');
  assert.doesNotMatch(sin, /Transcripción automática|adjunto/);
});

test('PIN del buzón: el PIN está en el cuerpo pero NO en el título ni en el preheader', () => {
  const p = e.vmPinEmail({ brand: 'Sur', mailbox: '2001', fullname: 'Ana', pin: '482916' });
  assert.match(p, /482916/);
  assert.doesNotMatch(titulo(p), /482916/);
  assert.doesNotMatch(preheader(p), /482916/);
  assert.doesNotMatch(p, /Abrir el panel|Escuchar en el panel/, 'sin botón al panel: el dueño del buzón no entra ahí');
  assert.ok(e.vmPinEmail({ mailbox: '1', pin: '1234' }));
});

test('alta de softphone: QR, interno y enlace', () => {
  const x = e.enrollEmail({ brand: 'Sur', ext: '2001', url: 'https://pbx/enrol?t="x"' });
  assert.match(x, /cid:qr/);
  assert.match(x, /2001/);
  assert.match(x, /https:\/\/pbx\/enrol\?t=&quot;x&quot;/);
});

test('invitación a una sala: con enlace web primero, o con número y PIN; moderador avisado', () => {
  const web = e.meetingEmail({ brand: 'Sur', sala: 'Directorio', numero: '9001', externo: '+598 2900 0000', pin: '1234', cuando: 'lunes 10:00', duracion: 45, nota: 'Traer <números>', webUrl: 'https://pbx/sala/abc' });
  assert.ok(web.indexOf('Entrá desde el navegador') < web.indexOf('Marcá desde tu teléfono'), 'el enlace va antes que el número');
  assert.match(preheader(web), /^Entrá desde el navegador/);
  assert.match(web, /Entrar a la reunión/);
  assert.match(web, /45 min/);
  assert.match(web, /Traer &lt;números&gt;/);
  assert.match(web, /\+598 2900 0000/);
  const tel = e.meetingEmail({ sala: 'Equipo', numero: '9002', pin: '5555', moderador: true, panelUrl: 'https://pbx/salas' });
  assert.match(preheader(tel), /PIN 5555/);
  assert.match(tel, /Sos <b>moderador<\/b>/);
  assert.match(tel, /Disponible en cualquier momento/);
  assert.match(tel, /Ver la sala en el panel/);
  const sola = e.meetingEmail({ sala: 'S', numero: '1', pin: '2', cuando: 'hoy' });
  assert.match(sola, /Te esperamos el hoy/);
  assert.doesNotMatch(sola, /Ver la sala en el panel|Entrar a la reunión/);
});

test('prueba de SMTP y el layout base', () => {
  assert.match(e.testEmail({ brand: 'Sur' }), /El correo funciona/);
  const s = e.shell({ title: 't', kicker: 'K', cta: { url: 'https://x', label: 'Ir' }, foot: 'F' });
  assert.match(s, /K/);
  assert.match(s, /Ir/);
  assert.match(e.callout('hola', 'tipo-que-no-existe'), /hola/);
});
