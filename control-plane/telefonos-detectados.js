'use strict';
/* ============================================================================
 *  PBX-NG · Qué teléfono se registró, y si la central lo conoce.
 *
 *  EL PROBLEMA QUE RESUELVE: un teléfono configurado a mano se registra igual y anda
 *  perfecto para hablar — pero nunca le pidió nada a la central, así que no recibió la
 *  libreta, ni los codecs, ni nada que venga del aprovisionamiento. Desde afuera se ve
 *  idéntico a uno aprovisionado: registrado, verde, andando. La diferencia sólo aparece
 *  cuando alguien busca un contacto y la agenda está vacía, y ahí no hay ninguna pista de
 *  por qué.
 *
 *  Así que la central mira quién se registró, adivina la marca del `User-Agent` —que el
 *  teléfono manda en cada REGISTER, gratis— y dice en voz alta cuáles no están dados de
 *  alta. Es la diferencia entre «probá a ver» y «este aparato no está aprovisionado».
 *
 *  No sabe de HTTP ni de la base: recibe filas y devuelve filas.
 * ==========================================================================*/

/* Las marcas se reconocen por su User-Agent porque es lo único que mandan todas sin que
 * nadie configure nada. La lista es por prefijo y en orden: `akuvox` antes que `fanvil`
 * porque algunos Akuvox se anuncian con los dos. */
const MARCAS = [
  { re: /akuvox/i, vendor: 'akuvox', nombre: 'Akuvox', agenda: 'fanvil' },
  { re: /fanvil/i, vendor: 'fanvil', nombre: 'Fanvil', agenda: 'fanvil' },
  { re: /yealink/i, vendor: 'yealink', nombre: 'Yealink', agenda: 'yealink' },
  { re: /grandstream|\bgxp|\bgrp|\bht8|\bwp8/i, vendor: 'grandstream', nombre: 'Grandstream', agenda: 'grandstream' },
  { re: /snom/i, vendor: 'snom', nombre: 'Snom', agenda: 'snom' },
  { re: /htek/i, vendor: 'htek', nombre: 'Htek', agenda: 'yealink' },        // firmware hermano del Yealink
  { re: /polycom|poly\b/i, vendor: 'polycom', nombre: 'Polycom', agenda: null },
  { re: /cisco|linksys|spa\d/i, vendor: 'cisco', nombre: 'Cisco / Linksys', agenda: null },
  { re: /unifi/i, vendor: 'unifi', nombre: 'UniFi VoIP Phone', agenda: null },
  { re: /pbx-ng softphone/i, vendor: 'pbxng', nombre: 'Softphone PBX-NG', agenda: null, propio: true },
  { re: /linphone|zoiper|microsip|groundwire|bria|jitsi|sipnetic/i, vendor: 'softphone', nombre: 'Softphone', agenda: null, propio: true },
];

function marcaDe(ua) {
  const t = String(ua || '');
  for (const m of MARCAS) if (m.re.test(t)) return m;
  return null;
}
/* El modelo: lo que viene después de la marca y antes de la versión de firmware. No es
 * exacto para todas, y por eso es informativo — la decisión la toma la marca. */
function modeloDe(ua, m) {
  if (!m) return '';
  const resto = String(ua || '').replace(m.re, ' ').trim();
  const tok = resto.split(/\s+/).filter(Boolean);
  const mod = tok.find(t => /[a-z]/i.test(t) && /\d/.test(t) && !/^\d+(\.\d+)+$/.test(t));
  return (mod || tok[0] || '').slice(0, 24);
}
/* La MAC, si el teléfono la regala. Grandstream la manda en el User-Agent y varios la
 * ponen en el Contact; el resto no, y no se inventa: sin MAC hay que escribirla a mano,
 * que es mejor que aprovisionar el aparato equivocado. */
function macDe(...textos) {
  for (const t of textos) {
    const m = String(t || '').match(/\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b[0-9a-f]{12}\b/i);
    if (m) {
      const limpia = m[0].replace(/[:-]/g, '').toLowerCase();
      /* Doce hex seguidos también puede ser un id de sesión cualquiera: sólo se acepta si
       * el texto habla de una MAC o si vino con separadores. */
      if (/[:-]/.test(m[0]) || /mac/i.test(t)) return limpia;
    }
  }
  return '';
}
function ipDe(uri) {
  const m = String(uri || '').match(/@([0-9a-zA-Z.\-]+)(?::(\d+))?/);
  return m ? m[1] : '';
}

/* Cruza lo que se registró contra lo que la central tiene dado de alta.
 *   contactos: [{ endpoint, uri, user_agent }]
 *   phones:    [{ mac, vendor, ext }]
 * Devuelve una fila por teléfono FÍSICO registrado —los softphones no se aprovisionan—
 * con `aprovisionado` y, cuando se puede, la marca y la MAC ya adivinadas. */
function detectar(contactos, phones) {
  const porExt = new Map();
  for (const p of phones || []) porExt.set(String(p.ext), p);
  const vistos = new Set();
  const out = [];
  for (const c of contactos || []) {
    const ext = String(c.endpoint || '');
    if (!ext || vistos.has(ext)) continue;
    const m = marcaDe(c.user_agent);
    /* Un softphone no se aprovisiona: listarlo como «pendiente» sería mandar a alguien a
     * dar de alta algo que no existe. */
    if (m && m.propio) continue;
    vistos.add(ext);
    const alta = porExt.get(ext) || null;
    out.push({
      ext,
      ua: String(c.user_agent || '').slice(0, 80),
      marca: m ? m.nombre : 'Desconocida',
      vendor: m ? m.vendor : '',
      modelo: modeloDe(c.user_agent, m),
      /* `agenda` es el dialecto de libreta que entiende. null = esa marca no tiene libreta
       * remota, y hay que decirlo en vez de ofrecer una URL que no va a usar nunca. */
      agenda: m ? m.agenda : null,
      ip: ipDe(c.uri),
      mac: (alta && alta.mac) || macDe(c.user_agent, c.uri),
      aprovisionado: !!alta,
    });
  }
  return out.sort((a, b) => (a.aprovisionado - b.aprovisionado) || String(a.ext).localeCompare(String(b.ext), 'es', { numeric: true }));
}

module.exports = { detectar, marcaDe, modeloDe, macDe, ipDe, MARCAS };
