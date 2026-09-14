/* ============================================================================
 *  PBX-NG · Sistema de diseño de emails
 *
 *  Un solo layout base, con "temas" por tipo de mensaje (seguridad, acceso,
 *  infraestructura, fraude, buzón, resumen, alta de usuario). Cada tipo tiene su
 *  color de acento, su ícono y su tono.
 *
 *  Reglas de HTML para correo (no son caprichos: Gmail/Outlook los exigen):
 *    - TABLAS para el layout. Nada de flexbox ni grid: Gmail los descarta.
 *    - CSS INLINE. Los <style> en <head> los borra Gmail en la vista móvil.
 *    - Ancho fijo 600 px, imágenes con width/height, sin position/float.
 *    - Preheader oculto: es el texto de vista previa en la bandeja.
 * ==========================================================================*/
'use strict';

// Paleta por tipo de mensaje
const THEMES = {
  security:  { accent: '#e11d48', soft: '#fff1f3', icon: '🛡️', kicker: 'Seguridad' },
  attack:    { accent: '#be123c', soft: '#fff1f3', icon: '🚨', kicker: 'Seguridad · ataque en curso' },
  auth:      { accent: '#2563eb', soft: '#eff6ff', icon: '🔑', kicker: 'Acceso al panel' },
  infra:     { accent: '#dc2626', soft: '#fef2f2', icon: '⚡', kicker: 'Infraestructura' },
  recovered: { accent: '#16a34a', soft: '#f0fdf4', icon: '✅', kicker: 'Servicio recuperado' },
  fraud:     { accent: '#7c3aed', soft: '#f5f3ff', icon: '💸', kicker: 'Antifraude' },
  queue:     { accent: '#ea580c', soft: '#fff7ed', icon: '🎧', kicker: 'Colas' },
  voicemail: { accent: '#4f46e5', soft: '#eef2ff', icon: '📩', kicker: 'Nuevo mensaje de voz' },
  digest:    { accent: '#0d9488', soft: '#f0fdfa', icon: '📊', kicker: 'Resumen diario' },
  access:    { accent: '#1d4ed8', soft: '#eff6ff', icon: '📱', kicker: 'Tu acceso al softphone' },
  meeting:   { accent: '#0891b2', soft: '#ecfeff', icon: '📅', kicker: 'Invitación a una reunión' },
  fax:       { accent: '#0f766e', soft: '#f0fdfa', icon: '📠', kicker: 'Fax recibido' },
  info:      { accent: '#475569', soft: '#f8fafc', icon: 'ℹ️', kicker: 'Aviso' },
};
const THEME_BY_EVENT = {
  'security.attack': 'attack', 'security.ban': 'security',
  'auth.login': 'auth', 'auth.login_failed': 'security',
  'trunk.down': 'infra', 'trunk.failover': 'infra', 'service.down': 'infra', 'extension.offline': 'infra',
  'fraud.long_call': 'fraud', 'fraud.after_hours': 'fraud', 'fraud.international': 'fraud',
  'queue.no_agents': 'queue', 'digest.daily': 'digest', 'ccreport.scheduled': 'digest',
};
const themeFor = (kind) => THEMES[kind] || THEMES.info;
const esc = (t) => String(t == null ? '' : t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** Layout base. Todo lo demás se construye encima de esto. */
function shell({ brand = 'PBX-NG', kind = 'info', kicker, title, subtitle = '', preheader = '', body = '', cta = null, foot = '' }) {
  const t = themeFor(kind);
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f1f4f9;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader || subtitle || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f4f9;padding:26px 12px;">
 <tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(16,24,40,.08);font-family:-apple-system,'Segoe UI',Roboto,Inter,Arial,sans-serif;">

   <!-- barra de acento -->
   <tr><td style="height:5px;background:${t.accent};line-height:5px;font-size:0;">&nbsp;</td></tr>

   <!-- encabezado -->
   <tr><td style="padding:22px 26px 0 26px;">
     <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
       <td width="46" valign="top">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
         <td align="center" valign="middle" width="42" height="42" style="width:42px;height:42px;background:${t.soft};border-radius:11px;font-size:20px;line-height:42px;">${t.icon}</td>
        </tr></table>
       </td>
       <td valign="middle" style="padding-left:12px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:${t.accent};">${esc(kicker || t.kicker)}</div>
        <div style="font-size:19px;font-weight:700;color:#0f172a;line-height:1.3;margin-top:2px;">${esc(title)}</div>
       </td>
      </tr>
     </table>
     ${subtitle ? `<div style="font-size:13.5px;color:#64748b;line-height:1.5;margin-top:10px;">${esc(subtitle)}</div>` : ''}
   </td></tr>

   <!-- cuerpo -->
   <tr><td style="padding:18px 26px 0 26px;">${body}</td></tr>

   ${cta ? `<tr><td align="center" style="padding:22px 26px 4px 26px;">
     <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td align="center" style="background:${t.accent};border-radius:10px;">
       <a href="${esc(cta.url)}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">${esc(cta.label)}</a>
      </td></tr></table>
   </td></tr>` : ''}

   ${foot ? `<tr><td style="padding:18px 26px 0 26px;">
     <div style="border-top:1px solid #eef1f7;padding-top:14px;font-size:12.5px;color:#64748b;line-height:1.55;">${foot}</div>
   </td></tr>` : ''}

   <tr><td style="padding:20px 26px 24px 26px;">
     <div style="font-size:11px;color:#94a3b8;line-height:1.5;">Enviado automáticamente por <b style="color:#64748b;">${esc(brand)}</b>. No respondas a este correo.</div>
   </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`;
}

/** Tabla clave→valor (el bloque de datos de casi todos los mails). */
function rowsTable(rows = [], accent) {
  if (!rows.length) return '';
  const body = rows.map(([k, v], i) => `
    <tr>
      <td style="padding:9px 0;border-bottom:${i === rows.length - 1 ? 'none' : '1px solid #f1f5f9'};font-size:13px;color:#64748b;">${esc(k)}</td>
      <td align="right" style="padding:9px 0;border-bottom:${i === rows.length - 1 ? 'none' : '1px solid #f1f5f9'};font-size:13px;color:#0f172a;font-weight:600;">${esc(v)}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef1f7;border-radius:12px;padding:4px 14px;">${body}</table>`;
}

/** Aviso destacado (el "qué hacer") con el color del tipo. */
function callout(text, kind) {
  const t = themeFor(kind);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;background:${t.soft};border-left:3px solid ${t.accent};border-radius:8px;">
    <tr><td style="padding:12px 14px;font-size:13px;color:#334155;line-height:1.55;">${text}</td></tr></table>`;
}

/** Tarjetas de números (resumen diario). */
function kpiGrid(kpis = [], accent = '#0d9488') {
  const cells = [];
  for (let i = 0; i < kpis.length; i += 2) {
    const pair = [kpis[i], kpis[i + 1]].filter(Boolean);
    cells.push(`<tr>${pair.map((k) => `
      <td width="50%" style="padding:5px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #eef1f7;border-radius:12px;">
          <tr><td align="center" style="padding:14px 8px;">
            <div style="font-size:26px;font-weight:800;color:${k.color || accent};line-height:1.1;">${esc(k.value)}</div>
            <div style="font-size:11.5px;color:#64748b;margin-top:4px;">${esc(k.label)}</div>
          </td></tr>
        </table>
      </td>`).join('') + (pair.length === 1 ? '<td width="50%"></td>' : '')}</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cells.join('')}</table>`;
}

// ---------------------------------------------------------------- por tipo
/** Alerta genérica del motor (seguridad, acceso, infra, fraude, colas). */
function alertEmail({ brand, event, severity, title, lines = [], foot = '', panelUrl = '' }) {
  let kind = THEME_BY_EVENT[event] || 'info';
  if (severity === 'info' && (event === 'trunk.down' || event === 'trunk.failover' || event === 'service.down')) kind = 'recovered';
  const t = themeFor(kind);
  const sub = severity === 'crit' ? 'Requiere tu atención ahora.' : severity === 'warn' ? 'Conviene revisarlo.' : '';
  const body = rowsTable(lines, t.accent) + (foot ? callout(foot, kind) : '');
  return shell({
    brand, kind, title, subtitle: sub,
    preheader: title + (lines[0] ? ' · ' + lines[0][0] + ': ' + lines[0][1] : ''),
    body,
    cta: panelUrl ? { url: panelUrl, label: 'Ver en el panel' } : null,
  });
}

/** Resumen diario: números grandes + top internos. */
function digestEmail({ brand, title, kpis = [], rows = [], panelUrl = '', subtitle, foot = '' }) {
  const t = themeFor('digest');
  const body = kpiGrid(kpis, t.accent)
    + (rows.length ? `<div style="font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94a3b8;margin:18px 0 8px;">Detalle</div>` + rowsTable(rows, t.accent) : '');
  return shell({
    brand, kind: 'digest', title,
    // El resumen diario dice "ayer"; los informes de call center traen su propio período.
    subtitle: subtitle === undefined ? 'Así estuvo la central ayer.' : subtitle,
    preheader: title,
    body,
    cta: panelUrl ? { url: panelUrl, label: 'Abrir el panel' } : null,
    foot,
  });
}

/** Buzón de voz: quién llamó + transcripción destacada + audio adjunto. */
function voicemailEmail({ brand, mailbox, fullname, from, when, duration, transcript, hasAudio, panelUrl = '' }) {
  const t = themeFor('voicemail');
  const rows = [
    ['De', from || 'desconocido'],
    ['Para', 'Interno ' + mailbox + (fullname ? ' · ' + fullname : '')],
    ['Fecha', when],
    ['Duración', (duration || 0) + ' s'],
  ];
  let body = rowsTable(rows, t.accent);
  if (transcript) {
    body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${t.soft};border-radius:12px;">
      <tr><td style="padding:16px 18px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:${t.accent};margin-bottom:7px;">Transcripción automática</div>
        <div style="font-size:14.5px;color:#1e293b;line-height:1.6;font-style:italic;">“${esc(transcript)}”</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:9px;">Generada por IA a partir del audio; puede contener errores.</div>
      </td></tr></table>`;
  }
  if (hasAudio) body += callout('🎧 El audio del mensaje va <b>adjunto</b> a este correo.', 'voicemail');
  return shell({
    brand, kind: 'voicemail',
    title: 'Nuevo mensaje de voz de ' + (from || 'desconocido'),
    subtitle: '',
    preheader: transcript ? transcript.slice(0, 110) : 'Mensaje de voz para el interno ' + mailbox,
    body,
    cta: panelUrl ? { url: panelUrl, label: 'Escuchar en el panel' } : null,
    foot: 'También podés escucharlo marcando <b>*97</b> desde tu interno.',
  });
}

/** Fax recibido: de quién, cuántas páginas y el documento adjunto. */
function faxEmail({ brand, caja, de, remoto, did, cuando, paginas, estado, detalle, adjuntos = [], panelUrl = '' }) {
  const t = themeFor('fax');
  const rows = [
    ['De', de || 'desconocido'],
    remoto ? ['Identificación del aparato', remoto] : null,
    did ? ['Número llamado', did] : null,
    ['Caja', caja || '—'],
    ['Fecha', cuando],
    ['Páginas', String(paginas || 0)],
  ].filter(Boolean);
  let body = rowsTable(rows, t.accent);
  /* Un fax incompleto se avisa arriba y con todas las letras: el que lo recibe tiene que
   * saber que le faltan páginas ANTES de archivarlo, no cuando el cliente reclama. */
  if (estado !== 'ok') body += callout('⚠️ La transmisión <b>no terminó bien</b>' + (detalle ? ': ' + esc(detalle) : '') + '. Puede faltar parte del documento; conviene pedir que lo reenvíen.', 'security');
  if (adjuntos.length) body += callout('📎 Va adjunto: <b>' + adjuntos.map(esc).join('</b>, <b>') + '</b>.', 'fax');
  return shell({
    brand, kind: 'fax',
    title: 'Fax de ' + (de || 'desconocido') + ' · ' + (paginas || 0) + (paginas === 1 ? ' página' : ' páginas'),
    subtitle: caja ? 'Recibido en «' + caja + '»' : '',
    preheader: 'Fax de ' + (de || 'desconocido') + ' (' + (paginas || 0) + ' pág.)',
    body,
    cta: panelUrl ? { url: panelUrl, label: 'Ver la bandeja de faxes' } : null,
    foot: 'El documento también queda guardado en el panel, en Aplicaciones → Fax.',
  });
}

/** Alta de softphone: QR grande + link. */
function enrollEmail({ brand, ext, url }) {
  const t = themeFor('access');
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef1f7;border-radius:14px;">
      <tr><td align="center" style="padding:22px 18px 8px;">
        <div style="font-size:12px;color:#64748b;margin-bottom:14px;">Escaneá este código con la cámara del celular</div>
        <img src="cid:qr" width="220" height="220" alt="Código QR de acceso" style="display:block;border-radius:12px;" />
        <div style="margin-top:16px;font-size:13px;color:#64748b;">Interno asignado</div>
        <div style="font-size:26px;font-weight:800;color:${t.accent};letter-spacing:1px;">${esc(ext)}</div>
      </td></tr>
    </table>
    ${callout('¿Usás la app de escritorio? Pegá el enlace de abajo en el botón <b>QR</b> de la pantalla de acceso y se configura sola.', 'access')}
    <div style="margin-top:14px;font-size:12px;color:#94a3b8;word-break:break-all;">${esc(url)}</div>`;
  return shell({
    brand, kind: 'access',
    title: 'Tu teléfono está listo',
    subtitle: 'Configurá tu softphone en un paso: escaneá el QR o abrí el enlace.',
    preheader: 'Acceso al softphone · interno ' + ext,
    body,
    cta: { url, label: 'Configurar mi teléfono' },
    foot: 'El acceso vence en <b>24 horas</b>. Si expira, pedí uno nuevo al administrador.',
  });
}

/** Invitación a una sala de reunión: cómo entrar, con qué PIN y cuándo.
 *  El PIN que llega acá es el del ROL del invitado (salas.js nunca manda el de
 *  moderador a un participante): este layout sólo lo muestra grande, porque es el
 *  dato que el invitado va a buscar con el teléfono ya marcando. */
function meetingEmail({ brand, sala, numero, externo = '', pin, moderador = false, cuando = null, duracion = null, nota = '', panelUrl = '' }) {
  const t = themeFor('meeting');
  const filas = [['Sala', sala], ['Marcá', numero]];
  if (externo) filas.push(['Desde afuera', externo]);
  filas.push(['Cuándo', cuando ? (cuando + (duracion ? ' · ' + duracion + ' min' : '')) : 'Disponible en cualquier momento']);
  if (moderador) filas.push(['Tu rol', 'Moderador']);
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef1f7;border-radius:14px;">
      <tr><td align="center" style="padding:20px 18px 16px;">
        <div style="font-size:12px;color:#64748b;">Marcá desde tu teléfono</div>
        <div style="font-size:30px;font-weight:800;color:${t.accent};letter-spacing:2px;">${esc(numero)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:12px;">y cuando te lo pida, tu PIN</div>
        <div style="font-size:30px;font-weight:800;color:#0f172a;letter-spacing:6px;">${esc(pin)}</div>
      </td></tr>
    </table>
    <div style="height:14px;"></div>
    ${rowsTable(filas, t.accent)}
    ${nota ? callout(esc(nota), 'meeting') : ''}
    ${moderador
      ? callout('Sos <b>moderador</b>: este PIN silencia, expulsa y abre la sala. No lo reenvíes a los demás participantes, que tienen el suyo.', 'meeting')
      : callout('La música de espera suena hasta que entra el moderador. Si la reunión está agendada, la sala <b>sólo abre en esa franja</b>.', 'meeting')}`;
  return shell({
    brand, kind: 'meeting',
    title: 'Reunión: ' + sala,
    subtitle: cuando ? ('Te esperamos el ' + cuando + '.') : 'Podés entrar cuando quieras.',
    preheader: 'Marcá ' + numero + ' · PIN ' + pin,
    body,
    cta: panelUrl ? { url: panelUrl, label: 'Ver la sala en el panel' } : null,
    foot: 'Tu PIN es personal: con él entrás a la reunión sin que nadie te abra la puerta.',
  });
}

/** Prueba de SMTP. */
function testEmail({ brand }) {
  return shell({
    brand, kind: 'recovered',
    kicker: 'Prueba de correo',
    title: 'El correo funciona',
    subtitle: 'La configuración SMTP de la central es correcta.',
    body: callout('Ya podés activar el envío de mensajes de voz por correo y las alertas automáticas.', 'recovered'),
  });
}

module.exports = { shell, rowsTable, callout, kpiGrid, alertEmail, digestEmail, voicemailEmail, faxEmail, enrollEmail, meetingEmail, testEmail, THEMES, THEME_BY_EVENT };
