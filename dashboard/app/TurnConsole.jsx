/* TurnConsole.jsx - consola de gestion de Coturn (TURN/STUN) */
'use client';
import { useEffect, useState } from 'react';
import { Stack, Group, Text, Badge, Card, SimpleGrid, Table, Button, TextInput, NumberInput, PasswordInput, ThemeIcon, Divider, Code, ScrollArea, Box, Tooltip, ActionIcon, Loader, Center } from '@mantine/core';
import { IconArrowsLeftRight, IconRefresh, IconDeviceFloppy, IconBolt, IconWorld, IconHash, IconKey, IconPlugConnected, IconCloud, IconTestPipe, IconReload, IconCpu } from '@tabler/icons-react';
import { toast } from './notify';

export default function TurnConsole() {
  const [d, setD] = useState(null);
  const [cfg, setCfg] = useState({ realm: '', listening_port: '', min_port: '', max_port: '', external_ip: '', user_name: '', user_password: '' });
  const [busy, setBusy] = useState('');
  const [testOut, setTestOut] = useState('');
  const [logs, setLogs] = useState('');

  async function load() {
    try {
      const h = await fetch('/backend/api/turn').then((r) => r.json());
      setD(h);
      setCfg((c) => ({ ...c, realm: h.realm || '', listening_port: h.listening_port || '', min_port: h.min_port || '', max_port: h.max_port || '', external_ip: h.external_ip || '', user_name: h.user_name || '' }));
    } catch (_) { setD({ error: true }); }
  }
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, []);

  async function save() {
    setBusy('save');
    const body = { realm: cfg.realm, listening_port: cfg.listening_port, min_port: cfg.min_port, max_port: cfg.max_port, external_ip: cfg.external_ip, user_name: cfg.user_name };
    if (cfg.user_password) body.user_password = cfg.user_password;
    const r = await fetch('/backend/api/turn/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ error: 1 }));
    setBusy('');
    if (r.error) { toast('No se pudo guardar: ' + r.error, 'bad'); return; }
    toast('Configuración aplicada (Turn-NG reiniciado)' + (cfg.user_password ? ' · recordá que cambiar la credencial obliga a recargar los softphones' : ''), 'ok');
    setCfg((c) => ({ ...c, user_password: '' })); setTimeout(load, 800);
  }
  async function restart() { setBusy('restart'); const r = await fetch('/backend/api/turn/restart', { method: 'POST' }).then((x) => x.json()).catch(() => ({})); setBusy(''); toast(r.ok ? 'Turn-NG reiniciado' : 'No se pudo reiniciar', r.ok ? 'ok' : 'bad'); setTimeout(load, 800); }
  async function test() { setBusy('test'); setTestOut(''); const r = await fetch('/backend/api/turn/test', { method: 'POST' }).then((x) => x.json()).catch(() => ({ out: 'error' })); setBusy(''); setTestOut(r.out || JSON.stringify(r)); }
  async function showLogs() { setBusy('logs'); const r = await fetch('/backend/api/turn/logs').then((x) => x.json()).catch(() => ({ log: 'error' })); setBusy(''); setLogs(r.log || ''); }

  if (!d) return <Center mih={360}><Stack align="center" gap="sm"><Loader size="lg" color="cyan" /><Text c="dimmed" size="sm">Cargando estado de Turn-NG…</Text></Stack></Center>;
  if (d.error) return <Card withBorder radius="md" padding="lg"><Text c="red" fw={600}>No se pudo contactar el agente TURN (CT106:8091).</Text><Text size="sm" c="dimmed" mt={4}>Verificá que el servicio pbxng-turn esté activo.</Text></Card>;

  const m = d.metrics || {};
  const flag = (on, label) => <Badge variant="light" color={on ? 'teal' : 'gray'} size="sm">{label}: {on ? 'sí' : 'no'}</Badge>;

  return (
    <Stack gap="lg">
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="xs">
          <Group gap="sm">
            <ThemeIcon size={40} radius="md" variant="light" color="cyan"><IconArrowsLeftRight size={22} /></ThemeIcon>
            <div><Text fw={800} lh={1.1}>Turn-NG Server</Text><Text size="xs" c="dimmed">Relay de medios WebRTC (TURN/STUN)</Text></div>
          </Group>
          <Group gap="xs">
            <Badge size="lg" variant="filled" color={d.active === 'active' ? 'teal' : 'red'} leftSection={<IconBolt size={12} />}>{d.active === 'active' ? 'Operativo' : 'Caído'}</Badge>
            <Tooltip label="Refrescar"><ActionIcon variant="default" onClick={load}><IconRefresh size={16} /></ActionIcon></Tooltip>
          </Group>
        </Group>
        <Group gap="xs" mt={4}>{flag(d.tls, 'TLS')}{flag(d.dtls, 'DTLS')}{flag(d.lt_cred, 'lt-cred')}{flag(d.fingerprint, 'fingerprint')}{flag(d.cli, 'CLI')}</Group>
      </Card>

      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Realm</Text><Text fw={700} size="sm">{d.realm || '-'}</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Puerto señalización</Text><Text fw={700}>{d.listening_port}</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Rango relay</Text><Text fw={700} size="sm">{d.min_port}–{d.max_port}</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Sesiones activas</Text><Text fw={700} size="xl" c={d.sessions?.length ? 'teal' : undefined}>{d.sessions?.length || 0}</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">IP externa</Text><Text fw={700} size="xs" ff="monospace">{d.external_ip || '-'}</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Usuario TURN</Text><Text fw={700} size="sm">{d.user_name || '-'}</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">CPU (load)</Text><Text fw={700}>{m.load ?? '-'}</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Memoria</Text><Text fw={700} size="sm">{m.mem_used_mb || 0}/{m.mem_total_mb || 0} MB</Text></Card>
      </SimpleGrid>

      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="sm"><Text fw={700}>Sesiones / allocations en vivo</Text><Badge variant="light">{d.sessions?.length || 0}</Badge></Group>
        {(!d.sessions || d.sessions.length === 0)
          ? <Text size="sm" c="dimmed">No hay sesiones TURN activas en este momento.</Text>
          : <Table striped highlightOnHover><Table.Thead><Table.Tr><Table.Th>ID</Table.Th><Table.Th>Usuario</Table.Th><Table.Th>Realm</Table.Th><Table.Th>Proto</Table.Th><Table.Th>Origen</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{d.sessions.map((s, i) => <Table.Tr key={i}><Table.Td ff="monospace" fz="xs">{s.id}</Table.Td><Table.Td>{s.user || '-'}</Table.Td><Table.Td fz="xs">{s.realm || '-'}</Table.Td><Table.Td>{s.proto || '-'}</Table.Td><Table.Td ff="monospace" fz="xs">{s.addr || '-'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
      </Card>

      <Card withBorder radius="md" padding="md">
        <Text fw={700} mb={4}>Configuración</Text>
        <Text size="xs" c="dimmed" mb="sm">Al guardar se reescribe turnserver.conf (con backup) y se reinicia el servidor TURN. Cambiar la credencial obliga a recargar los softphones.</Text>
        <Stack gap="sm">
          <Group grow>
            <TextInput label="Realm" leftSection={<IconWorld size={15} />} value={cfg.realm} onChange={(e) => setCfg({ ...cfg, realm: e.target.value })} description="Dominio de autenticación TURN" />
            <NumberInput label="Puerto de señalización" leftSection={<IconHash size={15} />} value={Number(cfg.listening_port) || 0} onChange={(v) => setCfg({ ...cfg, listening_port: String(v) })} description="STUN/TURN (típico 3478)" />
          </Group>
          <Group grow>
            <NumberInput label="Relay puerto mínimo" value={Number(cfg.min_port) || 0} onChange={(v) => setCfg({ ...cfg, min_port: String(v) })} description="Inicio del rango RTP relay" />
            <NumberInput label="Relay puerto máximo" value={Number(cfg.max_port) || 0} onChange={(v) => setCfg({ ...cfg, max_port: String(v) })} description="Fin del rango RTP relay" />
          </Group>
          <TextInput label="IP externa" leftSection={<IconCloud size={15} />} value={cfg.external_ip} onChange={(e) => setCfg({ ...cfg, external_ip: e.target.value })} description="IP pública (o pública/privada) que anuncia el servidor TURN" />
          <Group grow>
            <TextInput label="Usuario TURN" leftSection={<IconKey size={15} />} value={cfg.user_name} onChange={(e) => setCfg({ ...cfg, user_name: e.target.value })} description="Credencial estática (lt-cred)" />
            <PasswordInput label="Contraseña TURN" leftSection={<IconKey size={15} />} placeholder="(sin cambios)" value={cfg.user_password} onChange={(e) => setCfg({ ...cfg, user_password: e.target.value })} description="Dejar vacío para no cambiarla" />
          </Group>
          <Group>
            <Button leftSection={<IconDeviceFloppy size={16} />} loading={busy === 'save'} onClick={save} color="teal">Guardar y aplicar</Button>
            <Button variant="light" color="orange" leftSection={<IconReload size={16} />} loading={busy === 'restart'} onClick={restart}>Reiniciar Turn-NG</Button>
            <Button variant="light" leftSection={<IconTestPipe size={16} />} loading={busy === 'test'} onClick={test}>Probar TURN</Button>
            <Button variant="subtle" color="gray" loading={busy === 'logs'} onClick={showLogs}>Ver logs</Button>
          </Group>
          {testOut && <Box><Text size="xs" c="dimmed" mb={4}>Resultado de la prueba</Text><Code block style={{ maxHeight: 180, overflow: 'auto', fontSize: 11 }}>{testOut}</Code></Box>}
          {logs && <Box><Text size="xs" c="dimmed" mb={4}>Logs recientes</Text><ScrollArea h={200}><Code block style={{ fontSize: 10.5 }}>{logs}</Code></ScrollArea></Box>}
        </Stack>
      </Card>
    </Stack>
  );
}
