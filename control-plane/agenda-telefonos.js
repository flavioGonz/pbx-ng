'use strict';
/* ============================================================================
 *  PBX-NG · La libreta de la central, en el idioma de cada teléfono.
 *
 *  UN TELÉFONO DE ESCRITORIO NO SABE PEDIRLE CONTACTOS A UNA API. Lo que sí sabe hacer
 *  —Yealink, Grandstream, Fanvil/Akuvox, Snom, todos— es ir cada tantas horas a una URL,
 *  bajar un XML y mostrarlo en la tecla de Contactos. El problema es que **cada marca
 *  inventó su propio XML**: el `<AddressBook>` de Grandstream no lo entiende un Yealink y
 *  al revés. Así que la central sirve la MISMA libreta en varios dialectos y el teléfono
 *  elige el suyo.
 *
 *  POR QUÉ ACÁ Y NO EN CADA TELÉFONO: la alternativa real es cargar los contactos a mano
 *  en cada aparato, y eso se desactualiza el mismo día. Con esto, se agrega un interno en
 *  el panel y aparece solo en todos los teléfonos en el próximo refresco.
 *
 *  Este archivo NO sabe de HTTP ni de la base: recibe una lista de contactos ya armada y
 *  devuelve texto. Así los formatos se prueban sin levantar una central.
 * ==========================================================================*/

/* XML sin comillas ni ampersands sueltos. Un solo `&` sin escapar hace que el teléfono
 * descarte el archivo ENTERO y muestre la agenda vacía, sin decir por qué. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    /* Los de control rompen el parser de varios firmwares. */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}
/* Los teléfonos marcan lo que les damos: si va un número con espacios o paréntesis, el
 * usuario aprieta llamar y no pasa nada. Se deja sólo lo marcable. */
function numero(n) { return String(n == null ? '' : n).replace(/[^\d*#+]/g, '').slice(0, 32); }
const nombre = (s) => String(s == null ? '' : s).trim().slice(0, 64);

/* ── Normalización ────────────────────────────────────────────────────────
 * Un contacto es { nombre, numeros: [...], grupo }. De acá para abajo, ninguna marca
 * ve de dónde salió: internos y clientes son lo mismo. */
function normalizar(lista) {
  const vistos = new Set();
  return (lista || [])
    .map((c) => ({
      nombre: nombre(c.nombre),
      grupo: nombre(c.grupo) || 'Central',
      numeros: (Array.isArray(c.numeros) ? c.numeros : [c.numeros]).map(numero).filter(Boolean).slice(0, 3),
    }))
    .filter((c) => c.nombre && c.numeros.length)
    /* Sin repetidos: el mismo número dos veces en la agenda de un teléfono se ve como un
     * error de la central, aunque venga de dos lados de la base. */
    .filter((c) => { const k = c.grupo + '|' + c.numeros[0]; if (vistos.has(k)) return false; vistos.add(k); return true; })
    .sort((a, b) => a.grupo.localeCompare(b.grupo, 'es') || a.nombre.localeCompare(b.nombre, 'es'));
}
function porGrupo(cs) {
  const m = new Map();
  for (const c of cs) { if (!m.has(c.grupo)) m.set(c.grupo, []); m.get(c.grupo).push(c); }
  return m;
}

/* ── Yealink ───────────────────────────────────────────────────────────────
 * `<YealinkIPPhoneBook>` con menús: cada menú es una carpeta en el teléfono, y de ahí
 * sale la separación entre internos y clientes sin que nadie la configure. */
function yealink(lista, titulo) {
  const cs = normalizar(lista);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<YealinkIPPhoneBook>',
    '  <Title>' + esc(titulo || 'Central') + '</Title>'];
  for (const [g, items] of porGrupo(cs)) {
    out.push('  <Menu Name="' + esc(g) + '">');
    for (const c of items) {
      const p = c.numeros;
      out.push('    <Unit Name="' + esc(c.nombre) + '" Phone1="' + esc(p[0] || '') +
        '" Phone2="' + esc(p[1] || '') + '" Phone3="' + esc(p[2] || '') + '" default_photo="Resource:"/>');
    }
    out.push('  </Menu>');
  }
  out.push('</YealinkIPPhoneBook>', '');
  return out.join('\r\n');
}

/* ── Grandstream ───────────────────────────────────────────────────────────
 * `<AddressBook>`: un `<Contact>` por persona y un `<Phone>` por número. El
 * `<accountindex>` dice por qué cuenta SIP marcar; 1 es la primera línea. */
function grandstream(lista) {
  const cs = normalizar(lista);
  const grupos = Array.from(porGrupo(cs).keys());
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<AddressBook>'];
  grupos.forEach((g, i) => {
    out.push('  <Group>', '    <id>' + (i + 1) + '</id>', '    <name>' + esc(g) + '</name>', '  </Group>');
  });
  let id = 0;
  for (const c of cs) {
    id++;
    out.push('  <Contact>', '    <id>' + id + '</id>',
      '    <FirstName>' + esc(c.nombre) + '</FirstName>', '    <LastName></LastName>',
      '    <Groups><groupid>' + (grupos.indexOf(c.grupo) + 1) + '</groupid></Groups>');
    for (const n of c.numeros) {
      out.push('    <Phone type="Work">', '      <phonenumber>' + esc(n) + '</phonenumber>',
        '      <accountindex>1</accountindex>', '    </Phone>');
    }
    out.push('  </Contact>');
  }
  out.push('</AddressBook>', '');
  return out.join('\r\n');
}

/* ── Fanvil (y Akuvox, que usa el mismo) ──────────────────────────────────
 * `<PhoneBook>` plano: una entrada por número. No tiene carpetas, así que el grupo se
 * antepone al nombre — es eso o perderlo. */
function fanvil(lista) {
  const cs = normalizar(lista);
  const varios = porGrupo(cs).size > 1;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<PhoneBook>'];
  for (const c of cs) {
    for (const n of c.numeros) {
      out.push('  <DirectoryEntry>',
        '    <Name>' + esc(varios ? c.grupo + ' · ' + c.nombre : c.nombre) + '</Name>',
        '    <Telephone>' + esc(n) + '</Telephone>', '  </DirectoryEntry>');
    }
  }
  out.push('</PhoneBook>', '');
  return out.join('\r\n');
}

/* ── Snom ──────────────────────────────────────────────────────────────────
 * El minibrowser: mismo esqueleto que Fanvil con otro nombre de raíz. */
function snom(lista) {
  const cs = normalizar(lista);
  const varios = porGrupo(cs).size > 1;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<SnomIPPhoneDirectory>'];
  for (const c of cs) {
    for (const n of c.numeros) {
      out.push('  <DirectoryEntry>',
        '    <Name>' + esc(varios ? c.grupo + ' · ' + c.nombre : c.nombre) + '</Name>',
        '    <Telephone>' + esc(n) + '</Telephone>', '  </DirectoryEntry>');
    }
  }
  out.push('</SnomIPPhoneDirectory>', '');
  return out.join('\r\n');
}

/* ── CSV ───────────────────────────────────────────────────────────────────
 * Para la marca que no está en la lista: casi todos los teléfonos importan un CSV a mano,
 * y sirve además para mirar la libreta sin abrir un XML. */
function csv(lista) {
  const cs = normalizar(lista);
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const out = ['grupo,nombre,numero'];
  for (const c of cs) for (const n of c.numeros) out.push([q(c.grupo), q(c.nombre), q(n)].join(','));
  return out.join('\r\n') + '\r\n';
}

const FORMATOS = {
  yealink: { fn: yealink, tipo: 'application/xml; charset=utf-8', ext: 'xml' },
  grandstream: { fn: grandstream, tipo: 'application/xml; charset=utf-8', ext: 'xml' },
  fanvil: { fn: fanvil, tipo: 'application/xml; charset=utf-8', ext: 'xml' },
  akuvox: { fn: fanvil, tipo: 'application/xml; charset=utf-8', ext: 'xml' },   // mismo dialecto
  snom: { fn: snom, tipo: 'application/xml; charset=utf-8', ext: 'xml' },
  csv: { fn: csv, tipo: 'text/csv; charset=utf-8', ext: 'csv' },
};

/* Rinde la libreta en el formato pedido. Devuelve null si la marca no se conoce — el que
 * llama decide si eso es un 404 o un CSV de consuelo. */
function rendir(formato, lista, titulo) {
  const f = FORMATOS[String(formato || '').toLowerCase()];
  if (!f) return null;
  return { cuerpo: f.fn(lista, titulo), tipo: f.tipo };
}

module.exports = { rendir, normalizar, yealink, grandstream, fanvil, snom, csv, FORMATOS, _esc: esc, _numero: numero };
