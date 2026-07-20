'use client';
/* SystemOverview - la foto de la infraestructura: cada nodo con sus recursos, sus interfaces
   de red y sus servicios. No solo el core: tambien el borde (SBC + rtpengine + TURN) y la IA. */
import { useEffect, useState } from 'react';
import { Card, Group, Text, Stack, Badge, Progress, SimpleGrid, ThemeIcon, Table, Tooltip, Divider, RingProgress, Box } from '@mantine/core';
import { IconServer2, IconShieldLock, IconCpu, IconDeviceSdCard, IconNetwork, IconDatabase, IconMicrophone2, IconMailbox, IconRobot, IconCircleFilled, IconArrowDown, IconArrowUp, IconAlertTriangle, IconPlugConnected } from '@tabler/icons-react';
import Slot from './Slot';

const fmtB = (n) => { if (n == null) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = +n; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i]; };
const fmtUp = (s) => { s = parseInt(s) || 0; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + 'd ' : '') + h + 'h ' + m + 'm'; };
const tone = (p) => (p == null ? 'gray' : p >= 90 ? 'red' : p >= 75 ? 'orange' : p >= 50 ? 'yellow' : 'teal');
const ICON = { core: IconServer2, edge: IconShieldLock, ai: IconRobot };

function Metric({ label, pct, detail, icon }) {
  return (
    <Box style={{ flex: 1, minWidth: 0 }}>
      <Group justify="space-between" mb={4} wrap="nowrap">
        <Group gap={5} wrap="nowrap">{icon}<Text size="xs" c="dimmed">{label}</Text></Group>
        <Text size="xs" fw={700}>{pct == null ? '—' : <><Slot value={pct} />%</>}</Text>
      </Group>
      <Progress value={pct || 0} color={tone(pct)} radius="xl" size="sm" animated={pct >= 90} />
      <Text size="10px" c="dimmed" mt={3} truncate>{detail || ' '}</Text>
    </Box>
  );
}

function NodeCard({ n }) {
  const Icon = ICON[n.role] || IconServer2;
  const dp = n.disk ? n.disk.pct : null;
  return (
    <Card withBorder radius="lg" padding="md" shadow="sm" style={{ opacity: n.ok ? 1 : .65 }}>
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={40} radius="md" variant="light" color={n.ok ? (n.role === 'edge' ? 'red' : n.role === 'ai' ? 'teal' : 'pbx') : 'gray'}><Icon size={21} /></ThemeIcon>
          <div style={{ minWidth: 0 }}>
            <Text fw={700} size="sm" truncate>{n.name}</Text>
            <Text size="xs" c="dimmed" ff="monospace">{n.host || '—'}{n.ncpu ? ` · ${n.ncpu} vCPU` : ''}</Text>
          </div>
        </Group>
        <Badge variant="light" color={n.ok ? 'teal' : 'red'} leftSection={<IconCircleFilled size={7} />}>
          {n.ok ? 'en línea' : 'sin respuesta'}
        </Badge>
      </Group>

      <Group gap="md" align="flex-start" wrap="nowrap">
        <Metric label="CPU" pct={n.cpu_pct} icon={<IconCpu size={13} opacity={.6} />}
          detail={n.load != null ? 'carga ' + Number(n.load).toFixed(2) : ''} />
        <Metric label="Memoria" pct={n.mem_pct} icon={<IconPlugConnected size={13} opacity={.6} />}
          detail={n.mem_total_mb ? `${(n.mem_used_mb / 1024).toFixed(1)} / ${(n.mem_total_mb / 1024).toFixed(1)} GB` : ''} />
        <Metric label="Disco" pct={dp} icon={<IconDeviceSdCard size={13} opacity={.6} />}
          detail={n.disk ? `${fmtB(n.disk.used)} de ${fmtB(n.disk.total)} · libre ${fmtB(n.disk.free)}` : 'no reportado'} />
      </Group>

      <Divider my="sm" />
      <Group justify="space-between">
        <Group gap={5}>
          {(n.services || []).map(s => <Badge key={s} size="xs" variant="dot" color={n.ok ? 'teal' : 'gray'}>{s}</Badge>)}
        </Group>
        <Text size="xs" c="dimmed">{n.uptime_s ? 'activo hace ' + fmtUp(n.uptime_s) : ''}</Text>
      </Group>
    </Card>
  );
}

export default function SystemOverview() {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = () => fetch('/backend/api/system/overview').then(r => r.json()).then(x => alive && setD(x)).catch(() => {});
    tick(); const t = setInterval(tick, 8000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const nodes = (d && d.nodes) || [];
  const st = (d && d.storage) || {};
  const ifaces = nodes.flatMap(n => (n.ifaces || []).map(i => ({ ...i, node: n.name, nodeId: n.id })));
  const caidos = nodes.filter(n => !n.ok);
  const discoLleno = nodes.filter(n => n.disk && n.disk.pct >= 85);

  return (
    <Stack gap="md">
      {(caidos.length > 0 || discoLleno.length > 0) && (
        <Card withBorder radius="lg" padding="sm" style={{ borderColor: 'var(--mantine-color-orange-4)', background: 'var(--mantine-color-orange-light)' }}>
          <Group gap={8}>
            <ThemeIcon size={28} radius="md" variant="light" color="orange"><IconAlertTriangle size={16} /></ThemeIcon>
            <Text size="sm">
              {caidos.length > 0 && <b>{caidos.map(n => n.name).join(', ')} sin respuesta. </b>}
              {discoLleno.length > 0 && <>Disco al límite en <b>{discoLleno.map(n => `${n.name} (${n.disk.pct}%)`).join(', ')}</b>: revisá las grabaciones.</>}
            </Text>
          </Group>
        </Card>
      )}

      <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
        {nodes.map(n => <NodeCard key={n.id} n={n} />)}
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="sm" mb="md">
            <ThemeIcon size={34} radius="md" variant="light" color="indigo"><IconNetwork size={18} /></ThemeIcon>
            <div><Text fw={700}>Interfaces de red</Text><Text size="xs" c="dimmed">Todas las placas de todos los nodos, con su tráfico acumulado</Text></div>
          </Group>
          {ifaces.length === 0 ? <Text c="dimmed" size="sm" ta="center" py="md">Sin datos de interfaces.</Text> :
            <Table.ScrollContainer minWidth={480}>
              <Table verticalSpacing="xs" highlightOnHover>
                <Table.Thead><Table.Tr>
                  <Table.Th>Nodo</Table.Th><Table.Th>Interfaz</Table.Th><Table.Th>Dirección</Table.Th>
                  <Table.Th>Estado</Table.Th><Table.Th>Recibido</Table.Th><Table.Th>Enviado</Table.Th>
                </Table.Tr></Table.Thead>
                <Table.Tbody>
                  {ifaces.map((i, k) => (
                    <Table.Tr key={k}>
                      <Table.Td><Text size="xs" c="dimmed">{i.node}</Text></Table.Td>
                      <Table.Td><Text size="sm" fw={600} ff="monospace">{i.name}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{(i.addrs || []).join(' · ') || '—'}</Text></Table.Td>
                      <Table.Td><Badge size="xs" variant="light" color={/up/i.test(i.state) ? 'teal' : 'gray'}>{i.state || '—'}</Badge></Table.Td>
                      <Table.Td><Group gap={4} wrap="nowrap"><IconArrowDown size={12} color="var(--mantine-color-teal-6)" /><Text size="xs">{fmtB(i.rx_bytes)}</Text></Group></Table.Td>
                      <Table.Td><Group gap={4} wrap="nowrap"><IconArrowUp size={12} color="var(--mantine-color-blue-6)" /><Text size="xs">{fmtB(i.tx_bytes)}</Text></Group></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
        </Card>

        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="sm" mb="md">
            <ThemeIcon size={34} radius="md" variant="light" color="grape"><IconDeviceSdCard size={18} /></ThemeIcon>
            <div><Text fw={700}>Uso de espacio</Text><Text size="xs" c="dimmed">Qué se está comiendo el disco</Text></div>
          </Group>
          {st.disk && (
            <Group align="center" gap="lg" mb="md" wrap="nowrap">
              <RingProgress size={112} thickness={11} roundCaps
                sections={[{ value: st.disk.pct, color: tone(st.disk.pct) }]}
                label={<div style={{ textAlign: 'center' }}><Text fw={800} fz="lg" lh={1}><Slot value={st.disk.pct} />%</Text><Text fz={10} c="dimmed">usado</Text></div>} />
              <Stack gap={6} style={{ flex: 1 }}>
                <Group justify="space-between"><Text size="xs" c="dimmed">Total</Text><Text size="xs" fw={700}>{fmtB(st.disk.total)}</Text></Group>
                <Group justify="space-between"><Text size="xs" c="dimmed">Ocupado</Text><Text size="xs" fw={700}>{fmtB(st.disk.used)}</Text></Group>
                <Group justify="space-between"><Text size="xs" c="dimmed">Libre</Text><Text size="xs" fw={700} c={st.disk.pct >= 85 ? 'red' : undefined}>{fmtB(st.disk.free)}</Text></Group>
              </Stack>
            </Group>
          )}
          <Divider mb="sm" />
          <Stack gap={10}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={8}><ThemeIcon size={26} radius="md" variant="light" color="red"><IconMicrophone2 size={14} /></ThemeIcon><Text size="sm">Grabaciones</Text></Group>
              <Tooltip label={st.recordings ? st.recordings.files + ' archivos' : 'sin datos'}>
                <Text size="sm" fw={700}>{st.recordings ? fmtB(st.recordings.bytes) : '—'}</Text>
              </Tooltip>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={8}><ThemeIcon size={26} radius="md" variant="light" color="orange"><IconMailbox size={14} /></ThemeIcon><Text size="sm">Buzones de voz</Text></Group>
              <Tooltip label={st.voicemail ? st.voicemail.files + ' archivos' : 'sin datos'}>
                <Text size="sm" fw={700}>{st.voicemail ? fmtB(st.voicemail.bytes) : '—'}</Text>
              </Tooltip>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={8}><ThemeIcon size={26} radius="md" variant="light" color="blue"><IconDatabase size={14} /></ThemeIcon><Text size="sm">Base de datos</Text></Group>
              <Tooltip label={st.db && st.db.ok ? `${st.db.cdr} llamadas en el CDR · ${st.db.conns} conexiones` : 'sin datos'}>
                <Text size="sm" fw={700}>{st.db && st.db.ok ? fmtB(st.db.bytes) : '—'}</Text>
              </Tooltip>
            </Group>
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
