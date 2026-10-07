/* ============================================================================
 *  Modo de red: el plan que se le muestra al operador ANTES de aplicarlo.
 *
 *  Cambiar el modo de red puede cortar la conexión con el panel, así que lo que se
 *  prueba acá es que el plan diga exactamente lo que va a hacer, y que se niegue a
 *  armar uno que deja la central sin red (la misma placa de WAN y LAN, una placa
 *  que no existe, un puente con una sola placa).
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, TABLA_NFT } = require('../netmode');

const IFACES = [{ name: 'eth0', rol: 'wan' }, { name: 'eth1', rol: 'lan' }];
const textos = (p) => p.map((x) => x.texto);

test('router con NAT y ruteo: levanta las placas, prende ip_forward y enmascara por la WAN', () => {
  const p = plan({ modo: 'router', wan_if: 'eth0', lan_if: 'eth1', nat: true, forward: true }, IFACES);
  const t = textos(p);
  assert.match(t[0], /ip link del br0/, 'primero se desarma el puente de un modo switch anterior');
  assert.equal(t[1], 'ip link set eth0 up && ip link set eth1 up');
  assert.equal(t[2], 'sysctl -w net.ipv4.ip_forward=1');
  assert.match(t[3], new RegExp(`nft add table ip ${TABLA_NFT}`));
  assert.match(t[3], /oifname "eth0" masquerade/);
  assert.match(p[3].desc, /enmascarar el tráfico de eth1 al salir por eth0/);
});

test('router sin NAT ni ruteo: apaga ip_forward y quita la tabla de NAT', () => {
  const p = plan({ wan_if: 'eth0', lan_if: 'eth1', bridge: 'br9' }, IFACES);
  const t = textos(p);
  assert.match(t[0], /ip link del br9/, 'el nombre del puente configurado es el que se desarma');
  assert.equal(t[2], 'sysctl -w net.ipv4.ip_forward=0');
  assert.match(p[2].desc, /Deshabilitar el ruteo/);
  assert.match(t[3], /nft delete table ip pbxng 2>\/dev\/null \|\| true/);
  assert.match(p[3].desc, /Quitar el NAT/);
});

test('router: se niega a armar un plan que deja la central sin red', () => {
  assert.throws(() => plan({ wan_if: 'eth0' }, IFACES), /cuál es la WAN y cuál es la LAN/);
  assert.throws(() => plan({ lan_if: 'eth1' }, IFACES), /cuál es la WAN y cuál es la LAN/);
  assert.throws(() => plan({ wan_if: 'eth0', lan_if: 'eth0' }, IFACES), /no pueden ser la misma placa/);
  assert.throws(() => plan({ wan_if: 'eth0', lan_if: 'eth7' }, IFACES), /la placa eth7 no existe/);
  /* Sin la lista de placas, ninguna existe. */
  assert.throws(() => plan({ wan_if: 'eth0', lan_if: 'eth1' }), /la placa eth0 no existe/);
});

test('switch: puentea las placas LAN y las de modo bridge, nunca el puente ni las deshabilitadas', () => {
  const ifaces = [
    { name: 'eth0', rol: 'lan' },
    { name: 'eth1', modo: 'bridge' },
    { name: 'eth2', rol: 'lan', deshabilitada: true },
    { name: 'eth3', rol: 'wan' },
    { name: 'br0', modo: 'bridge' },
  ];
  const p = plan({ modo: 'switch' }, ifaces);
  const t = textos(p);
  /* La deshabilitada se baja ANTES de todo lo demás. */
  assert.equal(t[0], 'ip link set eth2 down');
  assert.match(p[0].desc, /deshabilitada a propósito/);
  assert.match(t[1], /nft delete table/);
  assert.equal(t[2], 'sysctl -w net.ipv4.ip_forward=0');
  assert.match(t[3], /ip link add name br0 type bridge/);
  const enchufadas = p.filter((x) => /Enchufar/.test(x.desc)).map((x) => x.desc);
  assert.deepEqual(enchufadas, ['Enchufar eth0 al puente', 'Enchufar eth1 al puente']);
  assert.equal(t[t.length - 1], 'ip link set br0 up');
});

test('switch con una sola placa no es un puente: se rechaza', () => {
  assert.throws(() => plan({ modo: 'switch' }, [{ name: 'eth0', rol: 'lan' }]), /al menos dos placas/);
  assert.throws(() => plan({ modo: 'switch' }), /al menos dos placas/);
});

test('rutas estáticas: con y sin gateway, placa y métrica; las que no tienen destino no van', () => {
  const p = plan({ wan_if: 'eth0', lan_if: 'eth1' }, IFACES, [
    { destino: '10.0.0.0/8', gateway: '192.168.1.1', iface: 'eth1', metrica: 50 },
    { destino: '172.16.0.0/12' },
    { gateway: '1.2.3.4' },
    null,
  ]);
  const rutas = p.filter((x) => /^Ruta /.test(x.desc));
  assert.equal(rutas.length, 2);
  assert.equal(rutas[0].desc, 'Ruta 10.0.0.0/8 vía 192.168.1.1');
  assert.equal(rutas[0].texto, 'ip route replace 10.0.0.0/8 via 192.168.1.1 dev eth1 metric 50');
  assert.equal(rutas[1].desc, 'Ruta 172.16.0.0/12');
  assert.equal(rutas[1].texto, 'ip route replace 172.16.0.0/12');
});

test('cada paso trae su texto legible: el comando de shell tal cual, o los argumentos unidos', () => {
  const p = plan({ wan_if: 'eth0', lan_if: 'eth1' }, IFACES);
  for (const x of p) {
    assert.equal(x.texto, x.cmd[0] === 'sh' ? x.cmd[2] : x.cmd.join(' '));
    assert.ok(x.desc);
  }
});
