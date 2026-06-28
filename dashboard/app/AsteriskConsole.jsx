/* AsteriskConsole.jsx - consola del nucleo Asterisk (Nucleo / Red / Dialplan / Seguridad) */
'use client';
import { useEffect, useState } from 'react';
import { Tabs, Stack, Group, Text, Badge, Card, SimpleGrid, ThemeIcon, Table } from '@mantine/core';
import { IconServer2, IconActivity, IconNetwork, IconTerminal2, IconShieldLock, IconPlugConnected, IconBolt, IconInfoCircle, IconRouter } from '@tabler/icons-react';
import { useLive } from './useLive';
import RoutesPanel from './RoutesPanel';
import Dialplan from './dialplan/page';

export default function AsteriskConsole() {
  const { snap } = useLive();
  const [core, setCore] = useState(null); const [net, setNet] = useState(null); const [f2b, setF2b] = useState(null);
  async function load() { try { setCore(await fetch('/backend/api/asterisk/core').then((r) => r.json())); } catch (_) {} try { setNet(await fetch('/backend/api/asterisk/net').then((r) => r.json())); } catch (_) {} }
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, []);
  useEffect(() => { const lf = () => fetch('/backend/api/security').then((r) => r.json()).then(setF2b).catch(() => {}); lf(); const t = setInterval(lf, 8000); return () => clearInterval(t); }, []);
  const ch = (snap && snap.channels) || []; const m = (core && core.metrics) || {};
  const flag = (on, l) => <Badge variant="light" color={on ? 'teal' : 'gray'} size="sm">{l}</Badge>;
  return (
    <Tabs defaultValue="core" variant="pills" radius="md" keepMounted={false}>
      <Tabs.List mb="md">
        <Tabs.Tab value="core" leftSection={<IconActivity size={16} />}>Núcleo</Tabs.Tab>
        <Tabs.Tab value="net" leftSection={<IconNetwork size={16} />}>Red</Tabs.Tab>
        <Tabs.Tab value="dialplan" leftSection={<IconTerminal2 size={16} />}>Dialplan</Tabs.Tab>
        <Tabs.Tab value="sec" leftSection={<IconShieldLock size={16} />}>Seguridad</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="core">
        {!core ? <Text c="dimmed" size="sm">Cargando estado de Asterisk…</Text> : core.error ? <Card withBorder radius="md" padding="lg"><Text c="red" fw={600}>No se pudo contactar el agente de Asterisk (CT103:8092).</Text></Card> : <Stack gap="lg">
          <Card withBorder radius="md" padding="md"><Group justify="space-between"><Group gap="sm"><ThemeIcon size={40} radius="md" variant="light" color="blue"><IconServer2 size={22} /></ThemeIcon><div><Text fw={800} lh={1.1}>Asterisk PBX</Text><Text size="xs" c="dimmed">172.26.20.183 · {core.version}</Text></div></Group><Badge size="lg" variant="filled" color={snap && snap.health && snap.health.ami ? 'teal' : 'red'} leftSection={<IconBolt size={12} />}>{snap && snap.health && snap.health.ami ? 'Operativo' : 'Sin AMI'}</Badge></Group></Card>
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Versión</Text><Text fw={700} size="sm">{core.version || '-'}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Uptime</Text><Text fw={700} size="sm">{core.uptime || '-'}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Canales activos</Text><Text fw={700} size="xl">{ch.length}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Endpoints</Text><Text fw={700} size="xl">{core.endpoints || 0}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">CPU (load)</Text><Text fw={700}>{m.load ?? '-'}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Memoria</Text><Text fw={700} size="sm">{m.mem_used_mb || 0}/{m.mem_total_mb || 0} MB</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">AMI / ARI</Text><Group gap={4} mt={4}>{flag(snap && snap.health && snap.health.ami, 'AMI')}{flag(snap && snap.health && snap.health.ari, 'ARI')}</Group></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Realtime</Text><Text fw={700} size="sm">PostgreSQL (ARA)</Text></Card>
          </SimpleGrid>
          <Card withBorder radius="md" padding="md"><Text fw={700} mb="xs">Transportes PJSIP</Text><Group gap="xs">{(core.transports || []).map((t) => <Badge key={t.id} variant="light" color="blue" leftSection={<IconPlugConnected size={12} />}>{t.id} · {(t.proto || '').toUpperCase()}</Badge>)}</Group></Card>
          <Card withBorder radius="md" padding="md"><Text fw={700} mb="xs">Módulos clave</Text><Group gap="xs">{Object.entries(core.modules || {}).map(([k, v]) => <Badge key={k} variant="light" color={v ? 'teal' : 'red'}>{k}: {v ? 'cargado' : 'no'}</Badge>)}</Group></Card>
        </Stack>}
      </Tabs.Panel>

      <Tabs.Panel value="net">
        <Card withBorder radius="md" padding="md" mb="md" style={{ background: 'var(--mantine-color-blue-light)' }}><Group gap="xs" mb={4}><IconInfoCircle size={16} /><Text fw={700} size="sm">Red de Asterisk (CT103)</Text></Group><Text size="sm" c="dimmed">Interfaces y rutas estáticas propias del núcleo Asterisk. Son independientes de las del SBC (que se gestionan en SBC-NG → Red).</Text></Card>
        <Card withBorder radius="md" padding="md" mb="md"><Text fw={700} mb="xs">Interfaces / WAN</Text>
          {!net || (net.ifaces || []).length === 0 ? <Text size="sm" c="dimmed">Sin datos del agente.</Text> :
            <Table verticalSpacing={6}><Table.Thead><Table.Tr><Table.Th>Interfaz</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Direcciones</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{net.ifaces.map((fi) => <Table.Tr key={fi.name}><Table.Td><Group gap={6} wrap="nowrap"><IconRouter size={15} color="var(--mantine-color-blue-6)" /><Text ff="monospace" fz="sm">{fi.name}</Text></Group></Table.Td><Table.Td><Badge size="sm" variant="light" color={/UP/i.test(fi.state) ? 'teal' : 'gray'}>{fi.state || '-'}</Badge></Table.Td><Table.Td>{(fi.addrs || []).map((a) => <Text key={a} ff="monospace" fz="xs">{a}</Text>)}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
        </Card>
        <RoutesPanel scope="asterisk" />
      </Tabs.Panel>

      <Tabs.Panel value="dialplan"><Dialplan /></Tabs.Panel>

      <Tabs.Panel value="sec">
        <Card withBorder radius="md" padding="md" mb="md" style={{ background: 'var(--mantine-color-blue-light)' }}><Group gap="xs" mb={4}><IconShieldLock size={16} /><Text fw={700} size="sm">Fail2Ban del núcleo (Asterisk)</Text></Group><Text size="sm" c="dimmed">Jails de Fail2Ban analizando los logs de PJSIP. Gestión completa (whitelist, mapa, política) en Sistema → Seguridad.</Text></Card>
        {!f2b ? <Text size="sm" c="dimmed">Cargando…</Text> : (f2b.jails || []).length === 0 ? <Text size="sm" c="dimmed">Sin jails de Fail2Ban activos.</Text> :
          <Stack gap="sm">{(f2b.jails || []).map((j) => { const bl = Array.isArray(j.banned) ? j.banned : []; return <Card key={j.jail} withBorder radius="md" padding="sm"><Group justify="space-between"><Text fw={700}>{j.jail}</Text><Group gap={6}><Badge variant="light" color="red">{bl.length} baneadas</Badge><Badge variant="light" color="orange">{j.total_failed || 0} intentos</Badge></Group></Group></Card>; })}</Stack>}
      </Tabs.Panel>
    </Tabs>
  );
}
