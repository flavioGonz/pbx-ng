'use client';
// Sección admin · CRM. Lista de clientes en tabla estilizada; cada cliente tiene su
// ruta propia /clientes/[id] (ficha). Tab secundaria: editor de la encuesta.
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card, Text, Group, ThemeIcon, Badge, Button, TextInput, Select, Switch, Table, Avatar,
  ScrollArea, ActionIcon, Tooltip, Tabs, Paper, Stack,
} from '@mantine/core';
import {
  IconAddressBook, IconUsers, IconClipboardList, IconSearch, IconPlus, IconTrash,
  IconUserCheck, IconBuilding, IconDeviceCctv, IconId, IconRefresh, IconChevronRight,
  IconDeviceFloppy, IconPhone,
} from '@tabler/icons-react';
import { toast } from '../notify';

const API = '/backend/api';
const j = (u, o) => fetch(u, o).then(r => r.ok ? r.json() : Promise.reject(r)).catch(() => null);
const initials = (n) => (n || '?').split(/[\s.]+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

export default function ClientesList() {
  const router = useRouter();
  const [tab, setTab] = useState('clientes');
  const [clients, setClients] = useState([]);
  const [q, setQ] = useState('');
  const [fields, setFields] = useState([]);

  const load = useCallback(() => j(API + '/clients').then(d => Array.isArray(d) && setClients(d)), []);
  useEffect(() => { load(); j(API + '/survey/fields').then(d => Array.isArray(d) && setFields(d)); }, [load]);

  async function newClient() {
    const c = await j(API + '/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nuevo cliente' }) });
    if (c && c.id) router.push('/clientes/' + c.id);
  }
  async function saveFields() { await j(API + '/survey/fields', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }); toast('Encuesta guardada', 'ok'); }
  const setF = (i, k, v) => setFields(f => f.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const addField = () => setFields(f => [...f, { label: 'Nuevo campo', ftype: 'text', options: [], required: false }]);
  const delField = (i) => setFields(f => f.filter((_, idx) => idx !== i));

  const fc = clients.filter(c => !q || (c.name || '').toLowerCase().includes(q.toLowerCase()) || (c.phones || []).join(',').includes(q));
  const tot = clients.reduce((a, c) => ({ p: a.p + (c.persons || 0), s: a.s + (c.spaces || 0), d: a.d + (c.devices || 0) }), { p: 0, s: 0, d: 0 });

  return (
    <div>
      <Group justify="space-between" mb="md" wrap="nowrap">
        <Group gap="sm"><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'grape.6', to: 'violet.8' }}><IconAddressBook size={24} /></ThemeIcon>
          <div><Text fw={800} fz="xl" lh={1.05}>Clientes</Text><Text fz="xs" c="dimmed">Fichas de clientes: personas autorizadas, espacios y dispositivos de video</Text></div>
        </Group>
        <Group gap="sm">
          <Paper withBorder radius="md" px="md" py={6}><Text fz={11} c="dimmed">Clientes</Text><Text fw={800} fz="lg" lh={1}>{clients.length}</Text></Paper>
          <Paper withBorder radius="md" px="md" py={6}><Text fz={11} c="dimmed">Autorizados</Text><Text fw={800} fz="lg" lh={1}>{tot.p}</Text></Paper>
          <Paper withBorder radius="md" px="md" py={6}><Text fz={11} c="dimmed">Dispositivos</Text><Text fw={800} fz="lg" lh={1}>{tot.d}</Text></Paper>
        </Group>
      </Group>

      <Tabs value={tab} onChange={setTab} mb="md">
        <Tabs.List>
          <Tabs.Tab value="clientes" leftSection={<IconUsers size={15} />}>Clientes</Tabs.Tab>
          <Tabs.Tab value="encuesta" leftSection={<IconClipboardList size={15} />}>Encuesta post-llamada</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {tab === 'clientes' && (
        <Card withBorder radius="lg" p="sm" shadow="sm">
          <Group justify="space-between" mb="xs">
            <TextInput w={320} size="sm" radius="md" leftSection={<IconSearch size={15} />} placeholder="Buscar cliente…" value={q} onChange={e => setQ(e.currentTarget.value)} />
            <Group gap={8}>
              <Tooltip label="Recargar"><ActionIcon variant="light" size={34} onClick={load}><IconRefresh size={17} /></ActionIcon></Tooltip>
              <Button size="sm" color="grape" leftSection={<IconPlus size={16} />} onClick={newClient}>Nuevo cliente</Button>
            </Group>
          </Group>
          <ScrollArea>
            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Cliente</Table.Th>
                  <Table.Th>Teléfonos</Table.Th>
                  <Table.Th style={{ textAlign: 'center' }}>Autorizados</Table.Th>
                  <Table.Th style={{ textAlign: 'center' }}>Espacios</Table.Th>
                  <Table.Th style={{ textAlign: 'center' }}>Dispositivos</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {fc.length === 0 ? (
                  <Table.Tr><Table.Td colSpan={6}><Text c="dimmed" ta="center" py="xl">No hay clientes. Creá uno con “Nuevo cliente”.</Text></Table.Td></Table.Tr>
                ) : fc.map(c => (
                  <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => router.push('/clientes/' + c.id)}>
                    <Table.Td><Group gap={10} wrap="nowrap"><Avatar size={36} radius="xl" color="grape">{initials(c.name)}</Avatar><div style={{ minWidth: 0 }}><Text fw={700} fz="sm" truncate>{c.name}</Text>{c.doc && <Text fz={11} c="dimmed"><IconId size={10} style={{ verticalAlign: -1 }} /> {c.doc}</Text>}</div></Group></Table.Td>
                    <Table.Td><Text fz="sm" c={(c.phones || []).length ? undefined : 'dimmed'}>{(c.phones || []).join(', ') || '—'}</Text></Table.Td>
                    <Table.Td style={{ textAlign: 'center' }}>{c.persons ? <Badge color="blue" variant="light" leftSection={<IconUserCheck size={12} />}>{c.persons}</Badge> : <Text c="dimmed" fz="sm">0</Text>}</Table.Td>
                    <Table.Td style={{ textAlign: 'center' }}>{c.spaces ? <Badge color="teal" variant="light" leftSection={<IconBuilding size={12} />}>{c.spaces}</Badge> : <Text c="dimmed" fz="sm">0</Text>}</Table.Td>
                    <Table.Td style={{ textAlign: 'center' }}>{c.devices ? <Badge color="grape" variant="light" leftSection={<IconDeviceCctv size={12} />}>{c.devices}</Badge> : <Text c="dimmed" fz="sm">0</Text>}</Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}><ActionIcon variant="subtle" onClick={e => { e.stopPropagation(); router.push('/clientes/' + c.id); }}><IconChevronRight size={18} /></ActionIcon></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Card>
      )}

      {tab === 'encuesta' && (
        <Card withBorder radius="lg" p="md" shadow="sm" style={{ maxWidth: 720 }}>
          <Group justify="space-between" mb="sm"><Text fw={700}>Campos de la encuesta post-llamada</Text><Group gap={6}><Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={addField}>Campo</Button><Button size="xs" color="teal" leftSection={<IconDeviceFloppy size={14} />} onClick={saveFields}>Guardar</Button></Group></Group>
          <Stack gap={8}>
            {fields.map((f, i) => (
              <Card key={i} withBorder radius="md" p="sm">
                <Group gap={8} align="flex-end">
                  <TextInput style={{ flex: 1 }} size="xs" label="Etiqueta" value={f.label} onChange={e => setF(i, 'label', e.currentTarget.value)} />
                  <Select size="xs" w={130} label="Tipo" data={[{ value: 'text', label: 'Texto' }, { value: 'select', label: 'Lista' }, { value: 'rating', label: 'Puntaje 1-5' }, { value: 'bool', label: 'Sí/No' }]} value={f.ftype} onChange={v => setF(i, 'ftype', v)} />
                  <Switch size="sm" label="Obligatorio" checked={!!f.required} onChange={e => setF(i, 'required', e.currentTarget.checked)} />
                  <ActionIcon variant="subtle" color="red" onClick={() => delField(i)}><IconTrash size={16} /></ActionIcon>
                </Group>
                {f.ftype === 'select' && <TextInput mt={6} size="xs" label="Opciones (coma)" value={(f.options || []).join(', ')} onChange={e => setF(i, 'options', e.currentTarget.value.split(',').map(x => x.trim()).filter(Boolean))} />}
              </Card>
            ))}
          </Stack>
        </Card>
      )}
    </div>
  );
}
