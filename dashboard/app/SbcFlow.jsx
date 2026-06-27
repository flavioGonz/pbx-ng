'use client';
import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Stack, Text, Group, Badge, Card, Modal, Table, SimpleGrid, ThemeIcon, List, Divider, Box } from '@mantine/core';
import { IconShieldLock, IconServer2, IconWorld, IconArrowsLeftRight, IconUsers, IconApps, IconDeviceLandlinePhone, IconRouteAltLeft, IconLock, IconBolt } from '@tabler/icons-react';
import { useLive } from './useLive';

function Node({ data }) {
  const st = data.status;
  const col = st === 'ok' || st === true ? '#16a34a' : st === 'pending' ? '#d97706' : st === 'down' ? '#dc2626' : '#64748b';
  return (
    <div className="sbc-node" style={{ width: 200, borderRadius: 16, padding: '12px 14px', cursor: 'pointer', background: data.accent ? 'linear-gradient(160deg,#1d4ed8,#1e3a8a)' : '#ffffff', color: data.accent ? '#fff' : '#1e293b', border: '1px solid ' + (data.accent ? 'transparent' : 'rgba(15,23,42,.10)'), boxShadow: '0 8px 24px rgba(30,50,120,.12)', backdropFilter: 'blur(6px)', transition: 'transform .15s, box-shadow .15s' }}>
      <Handle type="target" position={Position.Left} style={{ background: '#94a3b8' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#94a3b8' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 30, height: 30, borderRadius: 9, background: data.accent ? 'rgba(255,255,255,.18)' : 'rgba(47,116,230,.16)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: data.accent ? '#fff' : '#2f74e6' }}>{data.icon}</div>
        <div style={{ lineHeight: 1.15 }}><div style={{ fontWeight: 700, fontSize: 14 }}>{data.title}</div>{data.ip && <div style={{ fontSize: 11, opacity: .7, fontFamily: 'monospace' }}>{data.ip}</div>}</div>
        <span style={{ marginLeft: 'auto', width: 9, height: 9, borderRadius: '50%', background: col, boxShadow: '0 0 0 3px ' + col + '22' }} />
      </div>
      {data.metrics && <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {data.metrics.map((m, i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span style={{ opacity: .7 }}>{m.label}</span><b>{m.value}</b></div>)}
      </div>}
      {data.hint && <div style={{ marginTop: 8, fontSize: 10.5, opacity: .65, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: '#7c3aed' }} />{data.hint}</div>}
    </div>
  );
}
const nodeTypes = { pbx: Node };

const INFO = {
  wan: { icon: <IconWorld size={22} />, color: 'blue', sub: 'Punto de entrada publico de la plataforma', what: 'Representa Internet y la IP publica de la sede. Todo el trafico externo (clientes WebRTC, troncales SIP del operador y relay de medios) entra por aqui mediante port-forwarding en el firewall.', points: ['IP publica 200.40.182.246 con NAT hacia la LAN 172.26.20.0/24', 'Puertos publicados: 443 (HTTPS/WSS), 5060/5061 (SIP), 3478 + rango RTP (TURN)', 'Primera capa de la defensa en capas: solo se exponen los puertos imprescindibles'] },
  npm: { icon: <IconShieldLock size={22} />, color: 'indigo', sub: 'Terminacion TLS y proxy inverso (Nginx Proxy Manager)', what: 'Termina el cifrado TLS/WSS con certificados Lets Encrypt para el dominio pbx.ies.com.uy y enruta cada ruta al servicio interno correcto. Es lo que permite que el softphone WebRTC funcione desde el navegador sin plugins.', points: ['/ → dashboard Next.js (3001), /socket.io → API (3000), /ws → Asterisk (8088)', 'proxy_read_timeout 3600s para mantener vivos los WebSocket de senalizacion', 'Renovacion automatica del certificado SSL'] },
  coturn: { icon: <IconArrowsLeftRight size={22} />, color: 'cyan', sub: 'Servidor STUN/TURN para NAT traversal', what: 'Cuando un cliente WebRTC esta detras de un firewall simetrico y no puede establecer medios directos, Coturn actua de relay del audio/video (RTP) garantizando que la llamada tenga sonido en ambos sentidos.', points: ['realm pbx.ies.com.uy - escucha en :3478 (UDP/TCP) + rango relay 49152-65535', 'Credenciales temporales inyectadas en el cliente', 'Solo se usa como ultimo recurso (STUN primero, TURN si hace falta)'] },
  kamailio: { icon: <IconRouteAltLeft size={22} />, color: 'grape', sub: 'Session Border Controller (senalizacion)', what: 'Proxy SIP de borde que protege a Asterisk: distribuye el registro y las llamadas con dispatcher, aplica anti-flood (pike) y bloquea escaneres/fuerza bruta antes de que lleguen al core. Gestionable desde la pestana Configuracion.', points: ['dispatcher → reparte hacia los Asterisk activos', 'pike + htable(ipban) → mitigacion de DDoS y escaneo SIP', 'rtpengine ancla y relaya el RTP en el borde (userspace), ocultando a Asterisk', 'Administrado via agente que sincroniza estado y comandos contra la base de datos'] },
  asterisk: { icon: <IconServer2 size={22} />, color: 'blue', sub: 'Nucleo de comunicaciones (PBX)', what: 'El motor que procesa las llamadas: registra los internos (chan_pjsip), ejecuta el plan de marcado en tiempo real desde PostgreSQL, hace transcoding entre codecs y puentea WebRTC ↔ SIP. La API lo controla por ARI/AMI.', points: ['Asterisk 22 LTS - chan_pjsip - realtime (ARA) sobre PostgreSQL', 'Transcoding nativo ulaw/alaw/g722; WebRTC con SRTP/DTLS', 'Expone ARI (control de llamadas) y AMI (eventos en vivo)'] },
  troncales: { icon: <IconDeviceLandlinePhone size={22} />, color: 'teal', sub: 'Enlaces con operadores SIP (PSTN)', what: 'Las troncales conectan la PBX con la red telefonica publica a traves de proveedores SIP, permitiendo llamadas entrantes y salientes hacia numeros externos.', points: ['Cada troncal = endpoint PJSIP + registro contra el proveedor', 'Estado registrada = enlace activo con el operador', 'Las salientes se enrutan por el dialplan segun prefijo'] },
  internos: { icon: <IconUsers size={22} />, color: 'blue', sub: 'Extensiones de usuario (WebRTC y SIP)', what: 'Los internos son las extensiones de los usuarios: telefonos fisicos (SIP/UDP/TLS) y softphones en navegador o PWA (WebRTC/WSS). Comparten plan de marcado y pueden llamarse entre si.', points: ['WebRTC: ulaw/g722 + SRTP/DTLS sobre WSS', 'SIP fisico: G.711/G.722 sobre UDP o TLS', 'Estado en vivo via AMI (registrado / en llamada / offline)'] },
  apps: { icon: <IconApps size={22} />, color: 'orange', sub: 'Aplicaciones de telefonia', what: 'Funciones de valor construidas sobre el core: colas/ACD, IVR, conferencias, grupos de timbrado, paging y buzones de voz. Se aprovisionan dinamicamente desde el panel hacia el dialplan realtime.', points: ['Colas (ACD) con estrategias de reparto y agentes', 'IVR, ConfBridge, ring groups, paging y voicemail', 'Todo configurable sin tocar archivos en el servidor'] },
};

export default function SbcFlow() {
  const { snap } = useLive();
  const [sbc, setSbc] = useState(null); const [trunks, setTrunks] = useState([]); const [sys, setSys] = useState(null);
  const [sel, setSel] = useState(null);
  async function load() {
    try { setSbc(await fetch('/backend/api/sbc').then(r => r.json())); } catch (_) {}
    try { setTrunks(await fetch('/backend/api/trunks').then(r => r.json())); } catch (_) {}
    try { setSys(await fetch('/backend/api/system').then(r => r.json())); } catch (_) {}
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  const eps = snap?.extensions || []; const ch = snap?.channels || []; const qs = snap?.queues || [];
  const online = eps.filter(e => e.status === 'online').length;
  const trunkOnline = trunks.filter(t => t.status === 'online').length;
  const comp = (g, n) => (sys?.components || []).find(c => c.group === g && c.name.includes(n))?.status;

  const nodes = useMemo(() => ([
    { id: 'wan', type: 'pbx', position: { x: 0, y: 180 }, data: { title: 'Internet / WAN', ip: '200.40.182.246', icon: <IconWorld size={17} />, status: 'ok' } },
    { id: 'npm', type: 'pbx', position: { x: 250, y: 40 }, data: { title: 'Proxy NPM', ip: '172.26.20.17', icon: <IconShieldLock size={17} />, status: comp('Seguridad', 'Proxy') || 'ok', metrics: [{ label: 'TLS / WSS', value: 'pbx.ies.com.uy' }] } },
    { id: 'coturn', type: 'pbx', position: { x: 250, y: 320 }, data: { title: 'Coturn (TURN)', ip: '172.26.20.204', icon: <IconArrowsLeftRight size={17} />, status: comp('WebRTC', 'TURN') || 'ok', metrics: [{ label: 'NAT relay', value: ':3478' }] } },
    { id: 'kamailio', type: 'pbx', position: { x: 250, y: 175 }, data: { title: 'SBC Kamailio', ip: '172.26.20.205', icon: <IconServer2 size={17} />, status: sbc && !sbc.error ? 'ok' : 'pending', hint: 'Clic para ver detalle', metrics: [{ label: 'Req/s', value: sbc?.stats?.rates?.rcv_requests != null ? sbc.stats.rates.rcv_requests : '-' }, { label: 'Bloqueadas', value: (sbc?.banned || []).length }, { label: 'Media', value: sbc?.rtpengine?.up ? (sbc.rtpengine.sessions || 0) + ' ses.' : '-' }] } },
    { id: 'asterisk', type: 'pbx', position: { x: 560, y: 175 }, data: { title: 'Asterisk PBX', ip: '172.26.20.183', icon: <IconServer2 size={17} />, accent: true, status: snap?.health?.ami ? 'ok' : 'down', metrics: [{ label: 'Version', value: sys?.asterisk || '-' }, { label: 'Llamadas', value: ch.length }] } },
    { id: 'troncales', type: 'pbx', position: { x: 870, y: 40 }, data: { title: 'Troncales', icon: <IconDeviceLandlinePhone size={17} />, status: trunks.length ? 'ok' : 'pending', metrics: [{ label: 'Totales', value: trunks.length }, { label: 'Registradas', value: trunkOnline }] } },
    { id: 'internos', type: 'pbx', position: { x: 870, y: 185 }, data: { title: 'Internos', icon: <IconUsers size={17} />, status: 'ok', metrics: [{ label: 'Registrados', value: online + '/' + eps.length }] } },
    { id: 'apps', type: 'pbx', position: { x: 870, y: 320 }, data: { title: 'Aplicaciones', icon: <IconApps size={17} />, status: 'ok', metrics: [{ label: 'Colas', value: qs.length }] } },
  ]), [sbc, trunks, sys, snap]);

  const e = (id, s, t, color, label) => ({ id, source: s, target: t, animated: true, label, style: { stroke: color, strokeWidth: 2 }, labelStyle: { fontSize: 10, fill: '#64748b' }, markerEnd: { type: MarkerType.ArrowClosed, color } });
  const edges = [
    e('e1', 'wan', 'npm', '#1d4ed8', 'HTTPS/WSS'), e('e2', 'wan', 'kamailio', '#7c3aed', 'SIP'), e('e3', 'wan', 'coturn', '#0891b2', 'TURN'),
    e('e4', 'npm', 'asterisk', '#1d4ed8', '/ws'), e('e5', 'kamailio', 'asterisk', '#7c3aed', 'dispatcher'),
    e('e6', 'asterisk', 'troncales', '#16a34a'), e('e7', 'asterisk', 'internos', '#16a34a'), e('e8', 'asterisk', 'apps', '#64748b'),
  ];

  const node = nodes.find(n => n.id === sel);
  const info = sel ? INFO[sel] : null;
  const stColor = (st) => st === 'ok' ? 'teal' : st === 'pending' ? 'orange' : st === 'down' ? 'red' : 'gray';
  const stLabel = (st) => st === 'ok' ? 'Operativo' : st === 'pending' ? 'Pendiente' : st === 'down' ? 'Caido' : '-';

  return (
    <>
      <style>{`.sbc-node:hover{transform:translateY(-2px);box-shadow:0 14px 34px rgba(30,50,120,.22)!important;} .sbc-flow{animation:sbcfade .45s ease;} @keyframes sbcfade{from{opacity:0;transform:scale(.99)}to{opacity:1;transform:none}}`}</style>
      <div className="sbc-flow" style={{ position: 'relative', height: '72vh', borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(120,130,150,.16)', background: 'radial-gradient(720px 360px at 72% -10%, rgba(47,116,230,.05), transparent), #f6f8fb' }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }}
          onNodeClick={(_, n) => setSel(n.id)} nodesDraggable={false} nodesConnectable={false} minZoom={0.4} maxZoom={1.6}>
          <Background color="#cdd7e4" gap={22} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <Modal opened={!!sel} onClose={() => setSel(null)} size="lg" radius="lg" centered overlayProps={{ blur: 3, backgroundOpacity: 0.45 }}
        title={info && node && <Group gap="sm"><ThemeIcon size={42} radius="md" variant="light" color={info.color}>{info.icon}</ThemeIcon><div><Text fw={800} size="lg" lh={1.1}>{node.data.title}</Text><Text size="xs" c="dimmed">{info.sub}</Text></div></Group>}>
        {info && node &&
          <Stack gap="md">
            <Group gap="xs">
              <Badge variant="light" color={stColor(node.data.status)} leftSection={<IconBolt size={12} />}>{stLabel(node.data.status)}</Badge>
              {node.data.ip && <Badge variant="light" color="gray" ff="monospace">{node.data.ip}</Badge>}
              {node.data.metrics?.map((m, i) => <Badge key={i} variant="dot" color="blue">{m.label}: {m.value}</Badge>)}
            </Group>
            <Box><Text fw={600} size="sm" mb={4}>Que hace?</Text><Text size="sm" c="dimmed">{info.what}</Text></Box>
            <Box><Text fw={600} size="sm" mb={6}>Como funciona</Text>
              <List spacing={6} size="sm" icon={<ThemeIcon size={18} radius="xl" variant="light" color={info.color}><IconLock size={11} /></ThemeIcon>}>
                {info.points.map((p, i) => <List.Item key={i}>{p}</List.Item>)}
              </List></Box>
            {sel === 'troncales' && <><Divider label="Troncales configuradas" labelPosition="center" />
              {trunks.length === 0 ? <Text size="sm" c="dimmed">Aun no hay troncales. Agregalas desde Telefonia → Troncales.</Text> :
                <Table><Table.Thead><Table.Tr><Table.Th>Troncal</Table.Th><Table.Th>Proveedor</Table.Th><Table.Th>Estado</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>{trunks.map(t => <Table.Tr key={t.name}><Table.Td fw={600}>{t.name}</Table.Td><Table.Td fz="xs">{t.provider_host}</Table.Td><Table.Td><Badge variant="light" color={t.status === 'online' ? 'teal' : 'gray'}>{t.status}</Badge></Table.Td></Table.Tr>)}</Table.Tbody></Table>}</>}
            {sel === 'internos' && <><Divider label="Internos en vivo" labelPosition="center" />
              <SimpleGrid cols={3}>
                <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Total</Text><Text fw={700} size="xl">{eps.length}</Text></Card>
                <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">En linea</Text><Text fw={700} size="xl" c="teal">{online}</Text></Card>
                <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">WebRTC</Text><Text fw={700} size="xl" c="blue">{eps.filter(x => x.webrtc).length}</Text></Card>
              </SimpleGrid></>}
            {sel === 'asterisk' && <><Divider label="Estado del nucleo" labelPosition="center" />
              <SimpleGrid cols={3}>
                <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Version</Text><Text fw={700}>{sys?.asterisk || '-'}</Text></Card>
                <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Llamadas activas</Text><Text fw={700} size="xl">{ch.length}</Text></Card>
                <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">AMI / ARI</Text><Badge variant="light" color={snap?.health?.ami ? 'teal' : 'red'}>{snap?.health?.ami ? 'conectado' : 'caido'}</Badge></Card>
              </SimpleGrid></>}
          </Stack>}
      </Modal>
    </>
  );
}
