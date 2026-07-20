'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SimpleGrid, Card, Text, Title, Stack, Table, Badge, Group, ThemeIcon, RingProgress, Progress, ActionIcon, Tooltip, Box } from '@mantine/core';
import { IconPhone, IconUsers, IconHeadset, IconBolt, IconPhoneIncoming, IconPhoneOutgoing, IconPhoneOff, IconClock, IconMaximize, IconMinimize, IconArrowDownLeft, IconArrowUpRight, IconActivity, IconPhoneCall, IconUserCheck } from '@tabler/icons-react';
import { useLive } from '../useLive';
import Slot from '../Slot';

function fmtDur(s) { if (s == null || s < 0) return '—'; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; const p = n => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`; }

function Spark({ data, color = '#ffffff' }) {
  if (!data || data.length < 2) return null;
  const w = 120, h = 34, max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * (h - 4) - 2}`).join(' ');
  return <svg width={w} height={h} style={{ display: 'block' }}><polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" /></svg>;
}

function Kpi({ label, value, sub, icon: Icon, accent, color = 'blue', spark }) {
  return (
    <Card radius="lg" padding="lg" shadow="sm" withBorder={!accent}
      style={accent ? { background: 'linear-gradient(135deg,#1d4ed8,#143196)', color: '#fff', border: 'none', overflow: 'hidden' } : {}}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} c={accent ? undefined : 'dimmed'} style={accent ? { color: 'rgba(255,255,255,.85)' } : {}}>{label}</Text>
          <Text fw={800} fz={48} lh={1} mt={2}><Slot value={value} /></Text>
          {sub && <Text size="xs" mt={6} c={accent ? undefined : 'dimmed'} style={accent ? { color: 'rgba(255,255,255,.8)' } : {}}>{sub}</Text>}
        </div>
        {accent && spark ? <div style={{ alignSelf: 'flex-end' }}><Spark data={spark} /></div> :
          <ThemeIcon size={52} radius="md" variant={accent ? 'transparent' : 'light'} color={color}><Icon size={30} opacity={accent ? .5 : 1} /></ThemeIcon>}
      </Group>
    </Card>
  );
}

export default function Wallboard() {
  const { snap, connected } = useLive();
  const [wb, setWb] = useState({ today: {}, queues: [] });
  const [now, setNow] = useState(Date.now());
  const [hist, setHist] = useState([]);
  const [fs, setFs] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const lastRef = useRef(-1);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  async function loadWb() { try { setWb(await fetch('/backend/api/wallboard').then(r => r.json())); } catch (_) {} }
  useEffect(() => { loadWb(); const t = setInterval(loadWb, 8000); return () => clearInterval(t); }, []);

  const eps = snap?.extensions || [], ch = snap?.channels || [], qs = snap?.queues || [];
  useEffect(() => {
    if (!snap) return;
    if (lastRef.current !== ch.length) { lastRef.current = ch.length; }
    setHist(h => [...h, ch.length].slice(-30));
  }, [snap?.ts]);

  const online = eps.filter(e => e.status === 'online').length;
  const inCall = eps.filter(e => e.status === 'online' && (e.channels || 0) > 0).length;
  const idle = Math.max(0, online - inCall);
  const offline = Math.max(0, eps.length - online);
  const agents = qs.reduce((a, q) => a + (q.agents_online || 0), 0);
  const agentsTotal = qs.reduce((a, q) => a + (q.agents_total || 0), 0);
  const waiting = (wb.queues || []).reduce((a, q) => a + (q.waiting || 0), 0);
  const t = wb.today || {};
  const answeredPct = t.total ? Math.round((t.answered || 0) * 100 / t.total) : 0;

  const qmerge = useMemo(() => qs.map(q => ({ ...q, ...(wb.queues || []).find(w => w.name === q.name) })), [qs, wb]);

  const clock = new Date(now);
  const hh = String(clock.getHours()).padStart(2, '0'), mm = String(clock.getMinutes()).padStart(2, '0'), sss = String(clock.getSeconds()).padStart(2, '0');
  const fecha = clock.toLocaleDateString('es-UY', { weekday: 'long', day: 'numeric', month: 'long' });

  function toggleFs() {
    if (!document.fullscreenElement) { document.documentElement.requestFullscreen?.().then(() => setFs(true)).catch(() => {}); }
    else { document.exitFullscreen?.().then(() => setFs(false)).catch(() => {}); }
  }
  useEffect(() => { const h = () => setFs(!!document.fullscreenElement); document.addEventListener('fullscreenchange', h); return () => document.removeEventListener('fullscreenchange', h); }, []);

  const callDir = (c) => /from-trunk|trunk/i.test(c.name) ? 'in' : 'out';
  const stateColor = (s) => /up|answer/i.test(s) ? 'teal' : /ring/i.test(s) ? 'yellow' : 'blue';

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'teal.5', to: 'teal.8', deg: 135 }}><IconBolt size={24} /></ThemeIcon>
          <div><Title order={2} lh={1.1}>Wallboard</Title><Text c="dimmed" size="sm" tt="capitalize">{mounted ? fecha : ''}</Text></div>
        </Group>
        <Group gap="md" wrap="nowrap">
          <Badge size="lg" radius="md" variant="light" color={connected ? 'teal' : 'gray'} leftSection={<span className="pbx-pip pbx-pulse" style={{ background: connected ? 'var(--mantine-color-teal-6)' : 'var(--mantine-color-gray-5)' }} />}>{connected ? 'En vivo' : 'Sin conexión'}</Badge>
          <Group gap={4} wrap="nowrap"><IconClock size={26} opacity={.5} /><Text fw={800} fz={34} ff="monospace" lh={1}>{mounted ? hh : '--'}:{mounted ? mm : '--'}<Text span fz={20} c="dimmed">:{mounted ? sss : '--'}</Text></Text></Group>
          <Tooltip label={fs ? 'Salir de pantalla completa' : 'Pantalla completa'}><ActionIcon size={42} radius="md" variant="default" onClick={toggleFs}>{fs ? <IconMinimize size={20} /> : <IconMaximize size={20} />}</ActionIcon></Tooltip>
        </Group>
      </Group>

      {/* KPIs principales */}
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Kpi label="Llamadas activas" value={snap ? ch.length : '—'} sub={waiting > 0 ? `${waiting} en espera` : 'sin cola de espera'} accent spark={hist} />
        <Kpi label="Extensiones en línea" value={snap ? `${online}` : '—'} sub={`de ${eps.length} · ${inCall} en llamada`} icon={IconUsers} color="blue" />
        <Kpi label="Agentes disponibles" value={snap ? agents : '—'} sub={`de ${agentsTotal} en colas`} icon={IconUserCheck} color="grape" />
        <Kpi label="Llamadas hoy" value={t.total != null ? t.total : '—'} sub={`${answeredPct}% atendidas`} icon={IconPhoneCall} color="teal" />
      </SimpleGrid>

      {/* tira de hoy + desglose extensiones */}
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={700} fz="sm" tt="uppercase" c="dimmed" mb="md">Resumen de hoy</Text>
          <SimpleGrid cols={4}>
            <div><Group gap={6}><IconHeadset size={16} color="var(--mantine-color-teal-6)" /><Text fz="xs" c="dimmed">Atendidas</Text></Group><Text fw={800} fz={28} c="teal"><Slot value={t.answered ?? '—'} /></Text></div>
            <div><Group gap={6}><IconPhoneOff size={16} color="var(--mantine-color-red-6)" /><Text fz="xs" c="dimmed">Perdidas</Text></Group><Text fw={800} fz={28} c="red"><Slot value={t.missed ?? '—'} /></Text></div>
            <div><Group gap={6}><IconArrowDownLeft size={16} color="var(--mantine-color-blue-6)" /><Text fz="xs" c="dimmed">Entrantes</Text></Group><Text fw={800} fz={28}><Slot value={t.inbound ?? '—'} /></Text></div>
            <div><Group gap={6}><IconArrowUpRight size={16} color="var(--mantine-color-grape-6)" /><Text fz="xs" c="dimmed">Salientes</Text></Group><Text fw={800} fz={28}><Slot value={t.outbound ?? '—'} /></Text></div>
          </SimpleGrid>
          <Group justify="space-between" mt="md"><Text fz="xs" c="dimmed">Tasa de atención</Text><Text fz="xs" fw={600}>{answeredPct}%</Text></Group>
          <Progress.Root size="lg" mt={4}><Progress.Section value={answeredPct} color="teal" /></Progress.Root>
          <Text fz="xs" c="dimmed" mt="sm">Duración media de conversación: <b>{fmtDur(t.avg_talk)}</b></Text>
        </Card>

        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={700} fz="sm" tt="uppercase" c="dimmed" mb="md">Estado de las extensiones</Text>
          <Group align="center" gap="xl">
            <RingProgress size={150} thickness={16} roundCaps
              sections={[{ value: eps.length ? idle * 100 / eps.length : 0, color: 'teal' }, { value: eps.length ? inCall * 100 / eps.length : 0, color: 'blue' }, { value: eps.length ? offline * 100 / eps.length : 0, color: 'gray.4' }]}
              label={<div style={{ textAlign: 'center' }}><Text fw={800} fz={28} lh={1}><Slot value={online} /></Text><Text fz="xs" c="dimmed">en línea</Text></div>} />
            <Stack gap="xs" style={{ flex: 1 }}>
              <Group justify="space-between"><Group gap={8}><span style={{ width: 11, height: 11, borderRadius: 3, background: 'var(--mantine-color-teal-5)' }} /><Text fz="sm">Disponibles</Text></Group><Text fw={700}>{idle}</Text></Group>
              <Group justify="space-between"><Group gap={8}><span style={{ width: 11, height: 11, borderRadius: 3, background: 'var(--mantine-color-blue-5)' }} /><Text fz="sm">En llamada</Text></Group><Text fw={700}>{inCall}</Text></Group>
              <Group justify="space-between"><Group gap={8}><span style={{ width: 11, height: 11, borderRadius: 3, background: 'var(--mantine-color-gray-4)' }} /><Text fz="sm">Desconectados</Text></Group><Text fw={700}>{offline}</Text></Group>
            </Stack>
          </Group>
        </Card>
      </SimpleGrid>

      {/* colas */}
      <div>
        <Text fw={700} c="dimmed" tt="uppercase" fz="sm" mb="sm">Colas en tiempo real</Text>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          {qmerge.length === 0 ? <Text c="dimmed">Sin colas configuradas.</Text> : qmerge.map(q => {
            const pct = q.agents_total ? q.agents_online * 100 / q.agents_total : 0;
            return (
              <Card key={q.name} withBorder radius="lg" padding="lg" shadow="sm" style={q.waiting > 0 ? { borderColor: 'var(--mantine-color-orange-4)', boxShadow: '0 0 0 1px var(--mantine-color-orange-3)' } : {}}>
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <div style={{ minWidth: 0 }}>
                    <Text fw={700} truncate>{q.label || q.name}</Text>
                    <Text fz="xs" c="dimmed">Acceso {q.access_exten || '—'}{q.strategy ? ' · ' + q.strategy : ''}</Text>
                  </div>
                  <RingProgress size={56} thickness={6} roundCaps sections={[{ value: pct, color: pct >= 100 ? 'teal' : pct > 0 ? 'blue' : 'gray.4' }]} label={<Text ta="center" fz={11} fw={700}>{q.agents_online}/{q.agents_total}</Text>} />
                </Group>
                <Group mt="md" gap="lg">
                  <div><Text fz="xs" c="dimmed">En espera</Text><Text fw={800} fz={26} c={q.waiting > 0 ? 'orange' : undefined}>{q.waiting ?? 0}</Text></div>
                  <div><Text fz="xs" c="dimmed">Espera máx.</Text><Text fw={700} fz={18}>{fmtDur(q.holdtime)}</Text></div>
                  <div><Text fz="xs" c="dimmed">Atend./Aband.</Text><Text fw={700} fz={18}><Text span c="teal">{q.completed ?? 0}</Text>/<Text span c="red">{q.abandoned ?? 0}</Text></Text></div>
                </Group>
              </Card>
            );
          })}
        </SimpleGrid>
      </div>

      {/* llamadas en curso */}
      <div>
        <Group justify="space-between" mb="sm"><Text fw={700} c="dimmed" tt="uppercase" fz="sm">Llamadas en curso</Text><Badge variant="light" color="blue" size="lg">{ch.length}</Badge></Group>
        <Card withBorder radius="lg" padding={0} shadow="sm">
          {ch.length === 0 ? <Group justify="center" py={48}><ThemeIcon size={48} radius="xl" variant="light" color="gray"><IconPhone size={26} /></ThemeIcon><Text c="dimmed">No hay llamadas en curso</Text></Group> :
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead><Table.Tr><Table.Th>Dir.</Table.Th><Table.Th>Origen</Table.Th><Table.Th>Conectado con</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Duración</Table.Th><Table.Th>Canal</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{ch.map(c => {
                const dir = callDir(c); const dur = c.started ? (now - new Date(c.started).getTime()) / 1000 : null;
                return (
                  <Table.Tr key={c.id}>
                    <Table.Td><ThemeIcon size={28} radius="md" variant="light" color={dir === 'in' ? 'blue' : 'grape'}>{dir === 'in' ? <IconArrowDownLeft size={16} /> : <IconArrowUpRight size={16} />}</ThemeIcon></Table.Td>
                    <Table.Td fw={600}>{c.caller || '—'}</Table.Td>
                    <Table.Td>{c.connected || '—'}</Table.Td>
                    <Table.Td><Badge variant="light" color={stateColor(c.state)}>{c.state}</Badge></Table.Td>
                    <Table.Td ff="monospace" fw={600}>{fmtDur(dur)}</Table.Td>
                    <Table.Td ff="monospace" fz="xs" c="dimmed">{c.name}</Table.Td>
                  </Table.Tr>
                );
              })}</Table.Tbody>
            </Table>}
        </Card>
      </div>
    </Stack>
  );
}
