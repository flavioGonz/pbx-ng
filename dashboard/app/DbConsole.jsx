/* DbConsole.jsx - consola de PostgreSQL (estado + tablas + mantenimiento) */
'use client';
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, Badge, SimpleGrid, ThemeIcon, Table, Button, TextInput, Loader, Center, ScrollArea, Tooltip, ActionIcon } from '@mantine/core';
import { IconDatabase, IconRefresh, IconBolt, IconReload, IconSearch, IconActivity, IconServer2 } from '@tabler/icons-react';
import { toast } from './notify';

export default function DbConsole() {
  const [d, setD] = useState(null); const [q, setQ] = useState(''); const [busy, setBusy] = useState('');
  async function load() { try { setD(await fetch('/backend/api/db').then((r) => r.json())); } catch (_) { setD({ error: true }); } }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  async function maint(table) { setBusy(table || 'all'); const r = await fetch('/backend/api/db/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(table ? { table } : {}) }).then((x) => x.json()).catch(() => ({ error: 1 })); setBusy(''); toast(r.error ? 'Error en mantenimiento' : ('VACUUM ANALYZE ejecutado' + (table ? ' en ' + table : '')), r.error ? 'bad' : 'ok'); setTimeout(load, 600); }
  if (!d) return <Center mih={360}><Stack align="center" gap="sm"><Loader size="lg" color="cyan" /><Text c="dimmed" size="sm">Cargando estado de la base…</Text></Stack></Center>;
  if (d.error) return <Card withBorder radius="md" padding="lg"><Text c="red" fw={600}>No se pudo consultar PostgreSQL.</Text></Card>;
  const tables = (d.tables || []).filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Stack gap="lg">
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between"><Group gap="sm"><ThemeIcon size={40} radius="md" variant="light" color="cyan"><IconDatabase size={22} /></ThemeIcon><div><Text fw={800} lh={1.1}>PostgreSQL</Text><Text size="xs" c="dimmed">{d.version || ''}</Text></div></Group><Group gap="xs"><Badge size="lg" variant="filled" color="teal" leftSection={<IconBolt size={12} />}>Operativa</Badge><Tooltip label="Refrescar"><ActionIcon variant="default" onClick={load}><IconRefresh size={16} /></ActionIcon></Tooltip></Group></Group>
      </Card>
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Tamaño</Text><Text fw={700} size="xl">{d.size || '-'}</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Uptime</Text><Text fw={700} size="sm">{d.uptime || '-'}</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Conexiones</Text><Text fw={700} size="xl">{d.conn ? d.conn.total : 0}<Text span size="sm" c="dimmed"> / {d.conn ? d.conn.max : '-'}</Text></Text><Text size="xs" c="dimmed">{d.conn ? d.conn.active : 0} activas · {d.conn ? d.conn.idle : 0} idle</Text></Card>
        <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Tablas</Text><Text fw={700} size="xl">{(d.tables || []).length}</Text></Card>
      </SimpleGrid>
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="sm"><Text fw={700}>Tablas</Text><Group gap="xs"><TextInput size="xs" placeholder="Buscar tabla…" value={q} onChange={(e) => setQ(e.target.value)} leftSection={<IconSearch size={14} />} /><Button size="xs" variant="light" color="cyan" leftSection={<IconReload size={14} />} loading={busy === 'all'} onClick={() => maint()}>VACUUM ANALYZE global</Button></Group></Group>
        <ScrollArea.Autosize mah={460}>
          <Table highlightOnHover stickyHeader><Table.Thead><Table.Tr><Table.Th>Tabla</Table.Th><Table.Th ta="right">Filas</Table.Th><Table.Th ta="right">Tamaño</Table.Th><Table.Th ta="right">Mant.</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{tables.length === 0 ? <Table.Tr><Table.Td colSpan={4}><Text c="dimmed" ta="center" py="md" size="sm">Sin coincidencias.</Text></Table.Td></Table.Tr> : tables.map((t) => <Table.Tr key={t.name}><Table.Td ff="monospace" fz="sm">{t.name}</Table.Td><Table.Td ta="right">{(t.rows || 0).toLocaleString()}</Table.Td><Table.Td ta="right" fz="sm">{t.size}</Table.Td><Table.Td ta="right"><Tooltip label="VACUUM ANALYZE"><ActionIcon variant="subtle" color="cyan" loading={busy === t.name} onClick={() => maint(t.name)}><IconReload size={15} /></ActionIcon></Tooltip></Table.Td></Table.Tr>)}</Table.Tbody></Table>
        </ScrollArea.Autosize>
      </Card>
    </Stack>
  );
}
