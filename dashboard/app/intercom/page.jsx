'use client';
// Sección admin · Intercom. Tabla de clientes; por cliente se asocian dispositivos
// de video (porteros / cámaras) que sirven de apoyo a la videollamada. El preview
// usa go2rtc por detrás (MSE), pero NO se expone su panel ni su URL acá.
import { useEffect, useState, useCallback } from 'react';
import Intercom from '../Intercom';
import {
  Card, Text, Group, ThemeIcon, Badge, Button, TextInput, Select, Table, Avatar,
  ScrollArea, ActionIcon, Tooltip, Drawer, Stack, Divider, Paper, SegmentedControl, Loader,
} from '@mantine/core';
import {
  IconDeviceCctv, IconBell, IconSearch, IconPlus, IconTrash, IconDeviceFloppy,
  IconVideo, IconSettings, IconMovie, IconPhone, IconId, IconRefresh, IconPlugConnected,
} from '@tabler/icons-react';
import { toast } from '../notify';

const API = '/backend/api';
const j = (u, o) => fetch(u, o).then(r => r.ok ? r.json() : Promise.reject(r)).catch(() => null);
const initials = (n) => (n || '?').split(/[\s.]+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const typeMeta = (t) => t === 'intercom'
  ? { label: 'Portero', color: 'orange', icon: <IconBell size={12} /> }
  : { label: 'Cámara', color: 'grape', icon: <IconDeviceCctv size={12} /> };

export default function IntercomAdmin() {
  const [clients, setClients] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [cli, setCli] = useState(null);       // detalle del cliente en el drawer
  const [streams, setStreams] = useState([]);
  const [cols, setCols] = useState('2');
  const [nd, setNd] = useState({ label: '', type: 'intercom', rtsp_url: '' });

  const load = useCallback(() => j(API + '/clients').then(d => Array.isArray(d) && setClients(d)), []);
  useEffect(() => { load(); }, [load]);

  async function manage(id) {
    setOpen(true); setLoading(true); setStreams([]);
    const c = await j(API + '/clients/' + id); setCli(c); setLoading(false);
    refreshPreview(id);
  }
  async function refreshPreview(id) {
    const s = await j(API + '/intercom/streams?client=' + id);
    setStreams(Array.isArray(s) ? s : []);
  }
  async function addDevice() {
    if (!nd.label || !cli) return;
    await j(API + '/clients/' + cli.id + '/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nd) });
    setNd({ label: '', type: 'intercom', rtsp_url: '' });
    const c = await j(API + '/clients/' + cli.id); setCli(c); load();
    toast('Dispositivo asociado', 'ok');
    setTimeout(() => refreshPreview(cli.id), 1200);
  }
  async function delDevice(did) {
    await j(API + '/devices/' + did, { method: 'DELETE' });
    const c = await j(API + '/clients/' + cli.id); setCli(c); load(); refreshPreview(cli.id);
  }

  const fc = clients.filter(c => !q || (c.name || '').toLowerCase().includes(q.toLowerCase()) || (c.phones || []).join(',').includes(q));
  const tot = clients.reduce((a, c) => ({ i: a.i + (c.intercoms || 0), k: a.k + (c.cameras || 0) }), { i: 0, k: 0 });

  return (
    <div>
      <Group justify="space-between" mb="md" wrap="nowrap">
        <Group gap="sm"><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'grape.6', to: 'violet.8' }}><IconDeviceCctv size={24} /></ThemeIcon>
          <div><Text fw={800} fz="xl" lh={1.05}>Intercom · Video de clientes</Text><Text fz="xs" c="dimmed">Porteros y cámaras asociados a cada cliente, como apoyo a la videollamada</Text></div>
        </Group>
        <Group gap="sm">
          <Paper withBorder radius="md" px="md" py={6}><Group gap={6}><IconBell size={15} color="var(--mantine-color-orange-6)" /><div><Text fz={11} c="dimmed">Porteros</Text><Text fw={800} fz="lg" lh={1}>{tot.i}</Text></div></Group></Paper>
          <Paper withBorder radius="md" px="md" py={6}><Group gap={6}><IconDeviceCctv size={15} color="var(--mantine-color-grape-6)" /><div><Text fz={11} c="dimmed">Cámaras</Text><Text fw={800} fz="lg" lh={1}>{tot.k}</Text></div></Group></Paper>
        </Group>
      </Group>

      <Card withBorder radius="lg" p="sm" shadow="sm">
        <Group justify="space-between" mb="xs">
          <TextInput w={320} size="sm" radius="md" leftSection={<IconSearch size={15} />} placeholder="Buscar cliente…" value={q} onChange={e => setQ(e.currentTarget.value)} />
          <Tooltip label="Recargar"><ActionIcon variant="light" size={34} onClick={load}><IconRefresh size={17} /></ActionIcon></Tooltip>
        </Group>
        <ScrollArea>
          <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Cliente</Table.Th>
                <Table.Th>Teléfonos</Table.Th>
                <Table.Th style={{ textAlign: 'center' }}>Porteros</Table.Th>
                <Table.Th style={{ textAlign: 'center' }}>Cámaras</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Acción</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {fc.length === 0 ? (
                <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="xl">No hay clientes. Cargalos en <b>Clientes</b>.</Text></Table.Td></Table.Tr>
              ) : fc.map(c => (
                <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => manage(c.id)}>
                  <Table.Td><Group gap={10} wrap="nowrap"><Avatar size={36} radius="xl" color="grape">{initials(c.name)}</Avatar><div style={{ minWidth: 0 }}><Text fw={700} fz="sm" truncate>{c.name}</Text>{c.doc && <Text fz={11} c="dimmed"><IconId size={10} style={{ verticalAlign: -1 }} /> {c.doc}</Text>}</div></Group></Table.Td>
                  <Table.Td><Text fz="sm" c={(c.phones || []).length ? undefined : 'dimmed'}>{(c.phones || []).join(', ') || '—'}</Text></Table.Td>
                  <Table.Td style={{ textAlign: 'center' }}>{c.intercoms ? <Badge color="orange" variant="light" leftSection={<IconBell size={12} />}>{c.intercoms}</Badge> : <Text c="dimmed" fz="sm">0</Text>}</Table.Td>
                  <Table.Td style={{ textAlign: 'center' }}>{c.cameras ? <Badge color="grape" variant="light" leftSection={<IconDeviceCctv size={12} />}>{c.cameras}</Badge> : <Text c="dimmed" fz="sm">0</Text>}</Table.Td>
                  <Table.Td style={{ textAlign: 'right' }}><Button size="xs" variant="light" leftSection={<IconSettings size={14} />} onClick={e => { e.stopPropagation(); manage(c.id); }}>Gestionar</Button></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Card>

      <Drawer opened={open} onClose={() => setOpen(false)} position="right" size="xl" padding="lg"
        title={<Group gap={10}><Avatar size={34} radius="xl" color="grape">{initials(cli && cli.name)}</Avatar><div><Text fw={800}>{cli ? cli.name : 'Cliente'}</Text><Text fz="xs" c="dimmed">Dispositivos de video</Text></div></Group>}>
        {loading ? <Group justify="center" py="xl"><Loader /></Group> : cli && (
          <Stack gap="md">
            <Card withBorder radius="md" p="sm">
              <Text fw={700} fz="sm" mb={8}>Asociar dispositivo</Text>
              <Group gap={8} align="flex-end">
                <TextInput style={{ flex: 1 }} size="xs" label="Etiqueta" placeholder="Portero principal" value={nd.label} onChange={e => setNd(v => ({ ...v, label: e.currentTarget.value }))} />
                <Select size="xs" w={130} label="Tipo" data={[{ value: 'intercom', label: 'Portero' }, { value: 'camera', label: 'Cámara' }]} value={nd.type} onChange={v => setNd(s => ({ ...s, type: v }))} />
              </Group>
              <TextInput mt={8} size="xs" label="URL RTSP" leftSection={<IconMovie size={13} />} placeholder="rtsp://usuario:pass@ip:554/Streaming/Channels/101" value={nd.rtsp_url} onChange={e => setNd(v => ({ ...v, rtsp_url: e.currentTarget.value }))} />
              <Group justify="flex-end" mt={8}><Button size="xs" leftSection={<IconPlus size={14} />} onClick={addDevice}>Asociar</Button></Group>
            </Card>

            <div>
              <Text fw={700} fz="sm" mb={6}>Asociados ({(cli.devices || []).length})</Text>
              <Stack gap={6}>
                {(cli.devices || []).length === 0 ? <Text c="dimmed" fz="sm">Sin dispositivos. Asociá un portero o cámara arriba.</Text> :
                  (cli.devices || []).map(d => { const m = typeMeta(d.type); return (
                    <Paper key={d.id} withBorder radius="md" p="xs">
                      <Group justify="space-between" wrap="nowrap">
                        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                          <ThemeIcon size={30} radius="md" variant="light" color={m.color}>{m.icon}</ThemeIcon>
                          <div style={{ minWidth: 0 }}><Text fz="sm" fw={600} truncate>{d.label} <Badge size="xs" variant="light" color={m.color}>{m.label}</Badge></Text><Text fz={11} c="dimmed" truncate>{d.rtsp_url || 'sin URL RTSP'}</Text></div>
                        </Group>
                        <ActionIcon variant="subtle" color="red" onClick={() => delDevice(d.id)}><IconTrash size={15} /></ActionIcon>
                      </Group>
                    </Paper>
                  ); })}
              </Stack>
            </div>

            <Divider label={<Group gap={6}><IconVideo size={14} /> Preview en vivo</Group> } labelPosition="center" />
            <Group justify="space-between">
              <Text fz="xs" c="dimmed">{streams.length ? streams.length + ' flujo(s) activos' : 'Sin flujos (agregá dispositivos con URL RTSP)'}</Text>
              <Group gap={8}>
                <SegmentedControl size="xs" value={cols} onChange={setCols} data={[{ label: '1', value: '1' }, { label: '2', value: '2' }]} />
                <Button size="xs" variant="light" leftSection={<IconPlugConnected size={14} />} onClick={() => refreshPreview(cli.id)}>Actualizar</Button>
              </Group>
            </Group>
            <Intercom streams={streams} columns={parseInt(cols, 10)} emptyHint="Agregá un portero o cámara con URL RTSP para ver el video acá." />
          </Stack>
        )}
      </Drawer>
    </div>
  );
}
