'use strict';
/* ============================================================================
 *  PBX-NG · modo de red del núcleo: ROUTER o SWITCH.
 *
 *  Igual que en SBC-NG, pero con una diferencia importante de arquitectura: acá el
 *  control-plane NO ejecuta los comandos. La API corre en la red de Docker; quien
 *  tiene las placas del host y NET_ADMIN es el **agente** que vive en el contenedor
 *  de Asterisk. Así que este módulo sólo ARMA el plan (la lista de comandos con su
 *  explicación) y el agente lo ejecuta paso a paso.
 *
 *  Los dos modos, en criollo:
 *    router → dos placas separadas (WAN y LAN), opcionalmente con NAT y ruteo entre
 *             ellas. La central hace de router de esa red.
 *    switch → las placas se unen en un puente (capa 2): la central queda "colgada"
 *             de la red existente, sin rutear ni enmascarar nada.
 *
 *  NO hay servidor DHCP y no lo va a haber: una central no es el router de la oficina.
 * ==========================================================================*/

const TABLA_NFT = 'pbxng';   // tabla de nftables propia (no pisar la del SBC)

/* Un `ip route` por cada ruta estática configurada. */
const cmdRuta = (r) => {
  const a = ['route', 'replace', r.destino];
  if (r.gateway) a.push('via', r.gateway);
  if (r.iface) a.push('dev', r.iface);
  if (r.metrica) a.push('metric', String(r.metrica));
  return a;
};
const pasosRutas = (rutas) => (rutas || [])
  .filter((r) => r && r.destino)
  .map((r) => ({ desc: `Ruta ${r.destino}${r.gateway ? ' vía ' + r.gateway : ''}`, cmd: ['ip', ...cmdRuta(r)] }));

function planRouter(cfg, ifaces) {
  const { wan_if, lan_if, nat, forward } = cfg;
  const pasos = [];

  if (!wan_if || !lan_if) throw new Error('en modo router hay que decir cuál es la WAN y cuál es la LAN');
  if (wan_if === lan_if) throw new Error('la WAN y la LAN no pueden ser la misma placa');
  const nombres = (ifaces || []).map((i) => i.name);
  for (const n of [wan_if, lan_if]) {
    if (!nombres.includes(n)) throw new Error(`la placa ${n} no existe en este equipo`);
  }

  const br = cfg.bridge || 'br0';
  pasos.push({ desc: 'Desarmar el puente si existía (venimos de modo switch)', cmd: ['sh', '-c', `ip link show ${br} >/dev/null 2>&1 && ip link del ${br} || true`] });
  pasos.push({ desc: 'Levantar las dos placas', cmd: ['sh', '-c', `ip link set ${wan_if} up && ip link set ${lan_if} up`] });
  pasos.push({
    desc: forward ? 'Habilitar el ruteo entre placas (ip_forward)' : 'Deshabilitar el ruteo entre placas',
    cmd: ['sysctl', '-w', `net.ipv4.ip_forward=${forward ? 1 : 0}`],
  });

  if (nat) {
    pasos.push({
      desc: `NAT: enmascarar el tráfico de ${lan_if} al salir por ${wan_if}`,
      cmd: ['sh', '-c',
        `nft delete table ip ${TABLA_NFT} 2>/dev/null; ` +
        `nft add table ip ${TABLA_NFT} && ` +
        `nft add chain ip ${TABLA_NFT} postrouting '{ type nat hook postrouting priority 100 ; }' && ` +
        `nft add rule ip ${TABLA_NFT} postrouting oifname "${wan_if}" masquerade`],
    });
  } else {
    pasos.push({ desc: 'Quitar el NAT', cmd: ['sh', '-c', `nft delete table ip ${TABLA_NFT} 2>/dev/null || true`] });
  }
  return pasos;
}

function planSwitch(cfg, ifaces) {
  const br = cfg.bridge || 'br0';
  // Miembros del puente: las placas marcadas LAN o en modo bridge. El puente nunca
  // es miembro de sí mismo.
  const miembros = (ifaces || [])
    .filter((i) => i.name !== br && !i.deshabilitada && (i.rol === 'lan' || i.modo === 'bridge'))
    .map((i) => i.name);
  if (miembros.length < 2) throw new Error('en modo switch hacen falta al menos dos placas en el puente');

  const pasos = [];
  pasos.push({ desc: 'Sin NAT: en modo switch la central no enmascara nada', cmd: ['sh', '-c', `nft delete table ip ${TABLA_NFT} 2>/dev/null || true`] });
  pasos.push({ desc: 'Sin ruteo entre placas: el puente trabaja en capa 2', cmd: ['sysctl', '-w', 'net.ipv4.ip_forward=0'] });
  pasos.push({ desc: `Crear el puente ${br} (es una interfaz más: tiene MAC, IP y estado)`, cmd: ['sh', '-c', `ip link show ${br} >/dev/null 2>&1 || ip link add name ${br} type bridge`] });
  for (const m of miembros) {
    pasos.push({ desc: `Enchufar ${m} al puente`, cmd: ['sh', '-c', `ip link set ${m} master ${br} && ip link set ${m} up`] });
  }
  pasos.push({ desc: `Levantar ${br}`, cmd: ['ip', 'link', 'set', br, 'up'] });
  return pasos;
}

const pasosDeshabilitar = (ifaces) => (ifaces || [])
  .filter((i) => i.deshabilitada)
  .map((i) => ({ desc: `Bajar la placa ${i.name} (deshabilitada a propósito)`, cmd: ['ip', 'link', 'set', i.name, 'down'] }));

/* El plan completo, con el texto que se le muestra al operador antes de aplicar.
 * Que se pueda LEER antes de ejecutar es la mitad de la función: cambiar el modo de
 * red puede cortar la conexión con el panel. */
function plan(cfg, ifaces, rutas) {
  const base = (cfg.modo === 'switch') ? planSwitch(cfg, ifaces) : planRouter(cfg, ifaces);
  const pasos = [...pasosDeshabilitar(ifaces), ...base, ...pasosRutas(rutas)];
  return pasos.map((p) => ({ ...p, texto: p.cmd[0] === 'sh' ? p.cmd[2] : p.cmd.join(' ') }));
}

module.exports = { plan, TABLA_NFT };
