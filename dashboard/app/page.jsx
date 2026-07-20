'use client';
import { useEffect, useState, useRef } from 'react';
import { SimpleGrid, Card, Group, Text, Title, ThemeIcon, Badge, Stack, RingProgress, Progress, Box, Divider } from '@mantine/core';
import Slot from './Slot';
import { IconServer2, IconCpu, IconDatabase, IconDeviceLandlinePhone, IconUsers, IconPhone, IconHeadset, IconUsersGroup, IconClock, IconActivity, IconWorld, IconShieldLock, IconRouteAltLeft, IconCircleFilled, IconDeviceSdCard, IconLayoutDashboard } from '@tabler/icons-react';
import PageHeader from './PageHeader';
import SystemOverview from './SystemOverview';
import { useLive } from './useLive';

const fmtB = (n) => { if (n == null) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = +n; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i]; };
const fmtUp = (s) => { s = parseInt(s) || 0; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + 'd ' : '') + h + 'h ' + m + 'm'; };

// Gráfico de área inline (CPU + Memoria), sin dependencias
function AreaChart({ cpu, mem, h = 150 }) {
  const w = 320; const n = Math.max(cpu.length, 2);
  const pts = (arr) => arr.map((v, i) => [(i / (n - 1)) * w, h - (Math.max(0, Math.min(100, v)) / 100) * (h - 8) - 4]);
  const line = (p) => p.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
  const area = (p) => p.length ? line(p) + ` L${w} ${h} L0 ${h} Z` : '';
  const cp = pts(cpu.length ? cpu : [0, 0]); const mp = pts(mem.length ? mem : [0, 0]);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: h }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="gcpu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4f7fd9" stopOpacity=".35" /><stop offset="1" stopColor="#4f7fd9" stopOpacity="0" /></linearGradient>
        <linearGradient id="gmem" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b06ad6" stopOpacity=".3" /><stop offset="1" stopColor="#b06ad6" stopOpacity="0" /></linearGradient>
      </defs>
      {[25, 50, 75].map(y => <line key={y} x1="0" x2={w} y1={h - (y / 100) * (h - 8) - 4} y2={h - (y / 100) * (h - 8) - 4} stroke="rgba(120,130,150,.12)" strokeWidth="1" />)}
      <path d={area(mp)} fill="url(#gmem)" /><path d={line(mp)} fill="none" stroke="#b06ad6" strokeWidth="2" />
      <path d={area(cp)} fill="url(#gcpu)" /><path d={line(cp)} fill="none" stroke="#4f7fd9" strokeWidth="2" />
    </svg>
  );
}
function Donut({ value, color, label, center, sub }) {
  return (
    <Stack align="center" gap={4}>
      <RingProgress size={130} thickness={11} roundCaps sections={[{ value, color }]} label={<div style={{ textAlign: 'center' }}><Text fw={800} fz="lg" lh={1}>{center}</Text>{sub && <Text fz={10} c="dimmed">{sub}</Text>}</div>} />
      <Text size="sm" c="dimmed">{label}</Text>
    </Stack>
  );
}
function StatRow({ icon, label, value, color = 'pbx' }) {
  return <Group justify="space-between" wrap="nowrap" py={6} style={{ borderBottom: '1px solid var(--mantine-color-gray-1)' }}>
    <Group gap={8} wrap="nowrap"><ThemeIcon size={26} radius="md" variant="light" color={color}>{icon}</ThemeIcon><Text size="sm" c="dimmed">{label}</Text></Group>
    <Text fw={700} size="sm">{value}</Text></Group>;
}
function Bar({ label, value, total, color = 'pbx' }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return <Box mb="sm"><Group justify="space-between" mb={3}><Text size="sm" c="dimmed">{label}</Text><Text size="sm" fw={600}>{value}{total != null ? ' / ' + total : ''}</Text></Group><Progress value={pct} color={color} radius="xl" size="sm" /></Box>;
}

export default function Resumen() {
  const { snap, connected } = useLive();
  const [m, setM] = useState(null); const [sys, setSys] = useState(null); const [trunks, setTrunks] = useState([]);
  const [topo, setTopo] = useState(null);
  const [hist, setHist] = useState({ cpu: [], mem: [] });
  const histRef = useRef({ cpu: [], mem: [] });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await fetch('/backend/api/metrics').then(r => r.json());
        if (!alive) return; setM(d);
        const memPct = d.mem ? Math.round((d.mem.used / d.mem.total) * 100) : 0;
        const hc = [...histRef.current.cpu, d.cpu || 0].slice(-40);
        const hm = [...histRef.current.mem, memPct].slice(-40);
        histRef.current = { cpu: hc, mem: hm }; setHist({ cpu: hc, mem: hm });
      } catch (_) {}
    };
    tick(); const t = setInterval(tick, 3000);
    fetch('/backend/api/system').then(r => r.json()).then(d => alive && setSys(d)).catch(() => {});
    fetch('/backend/api/topology').then(r => r.json()).then(d => alive && setTopo(d)).catch(() => {});
    fetch('/backend/api/trunks').then(r => r.json()).then(d => alive && setTrunks(Array.isArray(d) ? d : [])).catch(() => {});
    const ts = setInterval(() => { fetch('/backend/api/trunks').then(r => r.json()).then(d => alive && setTrunks(Array.isArray(d) ? d : [])).catch(() => {}); }, 10000);
    return () => { alive = false; clearInterval(t); clearInterval(ts); };
  }, []);

  const eps = snap?.extensions || [], ch = snap?.channels || [], qs = snap?.queues || [], h = snap?.health || {};
  const online = eps.filter(e => e.status === 'online').length;
  const webrtc = eps.filter(e => e.webrtc).length;
  const diskPct = m?.disk ? Math.round((m.disk.used / m.disk.total) * 100) : 0;
  const memPct = m?.mem ? Math.round((m.mem.used / m.mem.total) * 100) : 0;
  const trAvail = trunks.filter(t => t.status === 'online').length;
  const trSbc = trunks.filter(t => t.status === 'sbc').length;
  const trDown = trunks.filter(t => t.status === 'offline').length;
  const trOther = trunks.length - trAvail - trSbc - trDown;

  const comps = sys?.components || [];
  const svcList = [
    { n: 'Asterisk (AMI/ARI)', ok: h.ari && h.ami, ip: topo?.nodes?.asterisk || '-' },
    { n: 'Base de datos', ok: h.db, ip: topo?.nodes?.db || '-' },
    { n: 'SBC-NG', ok: true, ip: topo?.nodes?.sbc || '-' },
    { n: 'Turn-NG Server', ok: (comps.find(c => /TURN/i.test(c.name)) || {}).status !== 'down', ip: topo?.nodes?.turn || '-' },
    { n: 'Proxy NPM (TLS/WSS)', ok: (comps.find(c => /Proxy/i.test(c.name)) || {}).status !== 'down', ip: topo?.nodes?.npm || '-' },
  ];

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconLayoutDashboard size={24} />} title="Resumen" subtitle="Estado de la plataforma en tiempo real" color="pbx"
        right={<Badge size="lg" radius="sm" variant="light" color={connected ? 'teal' : 'gray'} leftSection={<IconCircleFilled size={9} className="pbx-pulse" />}>{connected ? 'En vivo' : 'Conectando…'}</Badge>} />

      {/* Infraestructura completa: cada nodo con sus recursos, interfaces y servicios */}
      <SystemOverview />

      {/* Fila 1: espacio · recursos · servicios */}
      <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="lg">
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={600} mb="md">Uso de espacio</Text>
          <SimpleGrid cols={2}>
            <Donut value={diskPct} color={diskPct > 85 ? 'red' : 'pbx'} label="Disco" center={diskPct + '%'} sub={m?.disk ? fmtB(m.disk.used) : ''} />
            <Donut value={memPct} color={memPct > 85 ? 'red' : 'grape'} label="Memoria" center={memPct + '%'} sub={m?.mem ? fmtB(m.mem.used) : ''} />
          </SimpleGrid>
          <Divider my="sm" />
          <Group justify="space-between"><Text size="xs" c="dimmed">Disco total</Text><Text size="xs" fw={600}>{m?.disk ? fmtB(m.disk.total) : '—'}</Text></Group>
          <Group justify="space-between"><Text size="xs" c="dimmed">Base de datos</Text><Text size="xs" fw={600}>{fmtB(m?.db_size)}</Text></Group>
        </Card>

        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={600} mb="md">Uso de recursos</Text>
          <Group align="flex-start" wrap="nowrap" gap="md">
            <Box style={{ flex: 1, minWidth: 0 }}><AreaChart cpu={hist.cpu} mem={hist.mem} /></Box>
            <Stack gap={2} w={92}>
              <Text fw={800} fz={26} lh={1} c="#4f7fd9"><Slot value={m?.cpu ?? 0} />%</Text><Text size="xs" c="dimmed" mb="sm">CPU</Text>
              <Text fw={800} fz={26} lh={1} c="#b06ad6"><Slot value={memPct} />%</Text><Text size="xs" c="dimmed">Memoria</Text>
            </Stack>
          </Group>
          <Group gap="lg" mt="xs"><Group gap={5}><span style={{ width: 10, height: 10, borderRadius: 3, background: '#4f7fd9' }} /><Text size="xs" c="dimmed">CPU ({m?.cores || '?'} cores)</Text></Group><Group gap={5}><span style={{ width: 10, height: 10, borderRadius: 3, background: '#b06ad6' }} /><Text size="xs" c="dimmed">Memoria</Text></Group><Text size="xs" c="dimmed" ml="auto">load {m?.load ? m.load[0].toFixed(2) : '—'}</Text></Group>
        </Card>

        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={600} mb="md">Servicios principales</Text>
          <Stack gap={2}>
            {svcList.map(s => (
              <Group key={s.n} justify="space-between" py={7} style={{ borderBottom: '1px solid var(--mantine-color-gray-1)' }}>
                <Group gap={8}><ThemeIcon size={28} radius="md" variant="light" color={s.ok ? 'teal' : 'red'}><IconServer2 size={15} /></ThemeIcon><div><Text size="sm" fw={500} lh={1.1}>{s.n}</Text><Text size="xs" c="dimmed" ff="monospace">{s.ip}</Text></div></Group>
                <Badge variant="light" color={s.ok ? 'teal' : 'red'}>{s.ok ? 'Operativo' : 'Caído'}</Badge>
              </Group>
            ))}
          </Stack>
        </Card>
      </SimpleGrid>

      {/* Fila 2: PBX · interfaces · troncales */}
      <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="lg">
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={600} mb="md">Estado del PBX</Text>
          <StatRow icon={<IconClock size={15} />} label="Hora del sistema" value={snap ? new Date(snap.ts).toLocaleString('es-UY', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—'} />
          <StatRow icon={<IconPhone size={15} />} label="Llamadas activas" value={ch.length} color="teal" />
          <StatRow icon={<IconUsers size={15} />} label="Usuarios WebRTC" value={webrtc} color="grape" />
          <StatRow icon={<IconActivity size={15} />} label="Uptime servidor" value={fmtUp(m?.uptime)} color="orange" />
          <Box mt="md">
            <Bar label="Extensiones registrados" value={online} total={eps.length} color="teal" />
            <Bar label="Colas / ACD" value={qs.length} total={qs.length || 1} color="violet" />
          </Box>
        </Card>

        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={600} mb="md">Estado de interfaces</Text>
          <Stack gap={2}>
            {(comps.length ? comps : svcList.map(s => ({ name: s.n, status: s.ok ? 'ok' : 'down', detail: s.ip }))).slice(0, 8).map((c, i) => (
              <Group key={i} justify="space-between" py={7} style={{ borderBottom: '1px solid var(--mantine-color-gray-1)' }}>
                <Group gap={8}><IconCircleFilled size={9} color={c.status === 'ok' ? 'var(--mantine-color-teal-6)' : c.status === 'pending' ? 'var(--mantine-color-yellow-6)' : c.status === 'down' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-gray-5)'} /><Text size="sm">{c.name}</Text></Group>
                <Text size="xs" c="dimmed" ff="monospace" truncate maw={150}>{c.detail || ''}</Text>
              </Group>
            ))}
          </Stack>
        </Card>

        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group justify="space-between" mb="md"><Text fw={600}>Troncales</Text><Badge variant="light" color="gray">{trunks.length} total</Badge></Group>
          <Group wrap="nowrap" gap="lg" align="center">
            <RingProgress size={120} thickness={12} roundCaps
              sections={[{ value: trunks.length ? (trAvail / trunks.length) * 100 : 0, color: 'teal' }, { value: trunks.length ? (trSbc / trunks.length) * 100 : 0, color: 'grape' }, { value: trunks.length ? (trDown / trunks.length) * 100 : 0, color: 'red' }]}
              label={<div style={{ textAlign: 'center' }}><Text fw={800} fz="xl" lh={1}>{trunks.length}</Text><Text fz={10} c="dimmed">troncales</Text></div>} />
            <Stack gap={6} style={{ flex: 1 }}>
              <Group justify="space-between"><Group gap={6}><IconCircleFilled size={9} color="var(--mantine-color-teal-6)" /><Text size="sm" c="dimmed">Disponibles</Text></Group><Text fw={700} size="sm">{trAvail}</Text></Group>
              <Group justify="space-between"><Group gap={6}><IconCircleFilled size={9} color="var(--mantine-color-grape-6)" /><Text size="sm" c="dimmed">En el SBC</Text></Group><Text fw={700} size="sm">{trSbc}</Text></Group>
              <Group justify="space-between"><Group gap={6}><IconCircleFilled size={9} color="var(--mantine-color-red-6)" /><Text size="sm" c="dimmed">Caídas</Text></Group><Text fw={700} size="sm">{trDown}</Text></Group>
              <Group justify="space-between"><Group gap={6}><IconCircleFilled size={9} color="var(--mantine-color-gray-5)" /><Text size="sm" c="dimmed">Sin registrar</Text></Group><Text fw={700} size="sm">{trOther}</Text></Group>
            </Stack>
          </Group>
          <Divider my="sm" />
          <Stack gap={4}>
            {trunks.slice(0, 4).map(t => (
              <Group key={t.name} justify="space-between"><Group gap={6}><IconDeviceLandlinePhone size={14} color="var(--mantine-color-gray-6)" /><Text size="sm" truncate maw={150}>{t.name}</Text></Group><IconCircleFilled size={9} color={t.status === 'online' ? 'var(--mantine-color-teal-6)' : t.status === 'sbc' ? 'var(--mantine-color-grape-6)' : t.status === 'offline' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-gray-5)'} /></Group>
            ))}
            {trunks.length === 0 && <Text size="sm" c="dimmed" ta="center" py="sm">Sin troncales configuradas.</Text>}
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
