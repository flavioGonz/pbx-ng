'use client';
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, Button, Table, Badge, ActionIcon, Modal, TextInput, Select, ThemeIcon, SimpleGrid, Divider, Tooltip, CopyButton, Alert, Code, List } from '@mantine/core';
import { IconDeviceLandlinePhone, IconPlus, IconEdit, IconTrash, IconCopy, IconCheck, IconHash, IconBolt, IconDeviceFloppy, IconInfoCircle, IconServer2, IconRouter, IconWifi } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

const VENDORS = [{ value: 'yealink', label: 'Yealink' }, { value: 'grandstream', label: 'Grandstream' }];
const fileFor = (v, mac) => v === 'grandstream' ? 'cfg' + mac + '.xml' : mac + '.cfg';
const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
const empty = { mac: '', vendor: 'yealink', model: '', ext: '', label: '', line_label: '' };
const online = (t) => t && (Date.now() - new Date(t).getTime()) < 10 * 60 * 1000;

export default function Telefonos() {
  const [list, setList] = useState([]); const [opened, setOpened] = useState(false); const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false);
  const [srv, setSrv] = useState(''); const [srvSaving, setSrvSaving] = useState(false);
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  async function load() { try { setList(await fetch('/backend/api/phones').then(r => r.json())); } catch (_) {} }
  async function loadSrv() { try { const s = await fetch('/backend/api/settings').then(r => r.json()); setSrv(s.prov_sip_server || ''); } catch (_) {} }
  useEffect(() => { load(); loadSrv(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);
  const up = (k, v) => setForm(s => ({ ...s, [k]: v }));
  function nuevo() { setForm(empty); setOpened(true); }
  function edit(p) { setForm({ ...empty, ...p }); setOpened(true); }
  async function save() {
    if (!form.mac || !form.ext) { toast('MAC e interno son obligatorios', 'bad'); return; }
    setSaving(true);
    const url = form.id ? '/backend/api/phones/' + form.id : '/backend/api/phones';
    const r = await fetch(url, { method: form.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast(form.id ? 'Teléfono actualizado' : 'Teléfono aprovisionado (interno ' + form.ext + ')', 'ok'); setOpened(false); load(); }
  }
  async function del(p) { if (!confirm('¿Eliminar el teléfono ' + p.mac + '?')) return; await fetch('/backend/api/phones/' + p.id, { method: 'DELETE' }); toast('Teléfono eliminado', 'info'); load(); }
  async function saveSrv() { setSrvSaving(true); const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prov_sip_server: srv }) }).then(x => x.json()).catch(() => ({ error: 1 })); setSrvSaving(false); toast(r.error ? 'Error' : 'Servidor SIP guardado', r.error ? 'bad' : 'ok'); }

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconDeviceLandlinePhone size={24} />} title="Aprovisionamiento de teléfonos" subtitle="Auto-config de teléfonos físicos (Yealink, Grandstream) por dirección MAC" color="blue"
        right={<Button leftSection={<IconPlus size={16} />} onClick={nuevo}>Nuevo teléfono</Button>} />

      <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />} title="Cómo configurar los teléfonos">
        <Text size="sm" mb={6}>Apuntá los teléfonos al servidor de aprovisionamiento (por <b>DHCP opción 66</b> en toda la red, o manualmente en cada teléfono):</Text>
        <Group gap="xs" mb={8}><Code>{base}/prov</Code><CopyButton value={base + '/prov'}>{({ copied, copy }) => <Button size="compact-xs" variant="light" color={copied ? 'teal' : 'blue'} leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />} onClick={copy}>{copied ? 'Copiado' : 'Copiar URL'}</Button>}</CopyButton></Group>
        <List size="xs" spacing={2} c="dimmed">
          <List.Item>Yealink pide <Code>&lt;mac&gt;.cfg</Code> · Grandstream pide <Code>cfg&lt;mac&gt;.xml</Code> — se generan solos según la base de datos.</List.Item>
          <List.Item>El teléfono toma su interno, contraseña y codecs automáticamente al arrancar; el usuario solo lo enchufa a la red.</List.Item>
        </List>
      </Alert>

      <Card withBorder radius="lg" padding="md">
        <Group align="flex-end" gap="sm">
          <TextInput label="Servidor SIP para los teléfonos" description="IP/host que se inyecta en la config (registro UDP/5060)" value={srv} onChange={e => setSrv(e.currentTarget.value)} placeholder="ip-del-asterisk" style={{ flex: 1, maxWidth: 360 }} leftSection={<IconServer2 size={15} />} />
          <Button variant="light" leftSection={<IconDeviceFloppy size={16} />} loading={srvSaving} onClick={saveSrv}>Guardar</Button>
        </Group>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        {list.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin teléfonos. Agregá uno con «Nuevo teléfono».</Text> :
          <Table.ScrollContainer minWidth={720}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr><Th icon={<IconRouter size={13} />}>MAC</Th><Th icon={<IconDeviceLandlinePhone size={13} />}>Modelo</Th><Th icon={<IconHash size={13} />}>Interno</Th><Th>Etiqueta</Th><Th icon={<IconBolt size={13} />}>Estado</Th><Th icon={<IconWifi size={13} />}>Archivo</Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>{list.map(p => (
                <Table.Tr key={p.id}>
                  <Table.Td ff="monospace" fw={600} style={{ cursor: 'pointer' }} onClick={() => edit(p)}>{p.mac}</Table.Td>
                  <Table.Td><Badge variant="light" color={p.vendor === 'grandstream' ? 'orange' : 'blue'}>{p.vendor}{p.model ? ' · ' + p.model : ''}</Badge></Table.Td>
                  <Table.Td ff="monospace">{p.ext}</Table.Td>
                  <Table.Td>{p.label || '—'}</Table.Td>
                  <Table.Td><Badge variant="dot" color={online(p.last_seen) ? 'teal' : 'gray'}>{p.last_seen ? (online(p.last_seen) ? 'Aprovisionado' : 'Visto ' + new Date(p.last_seen).toLocaleDateString('es-UY')) : 'Pendiente'}</Badge></Table.Td>
                  <Table.Td><Group gap={4} wrap="nowrap"><Code style={{ fontSize: 11 }}>{fileFor(p.vendor, p.mac)}</Code><CopyButton value={base + '/prov/' + fileFor(p.vendor, p.mac)}>{({ copied, copy }) => <Tooltip label={copied ? 'Copiado' : 'Copiar URL del config'}><ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy}>{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</ActionIcon></Tooltip>}</CopyButton></Group></Table.Td>
                  <Table.Td ta="right"><Group gap={4} justify="flex-end"><ActionIcon variant="subtle" onClick={() => edit(p)}><IconEdit size={17} /></ActionIcon><ActionIcon variant="subtle" color="red" onClick={() => del(p)}><IconTrash size={17} /></ActionIcon></Group></Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>}
      </Card>

      <Modal opened={opened} onClose={() => setOpened(false)} size="lg" radius="lg" centered
        title={<Group gap="sm"><ThemeIcon size={38} radius="md" variant="light" color="blue"><IconDeviceLandlinePhone size={20} /></ThemeIcon><div><Text fw={800} lh={1.1}>{form.id ? 'Editar teléfono' : 'Nuevo teléfono físico'}</Text><Text size="xs" c="dimmed">Auto-provisioning por MAC</Text></div></Group>}>
        <Stack gap="md">
          <SimpleGrid cols={2}>
            <TextInput label="Dirección MAC" description="Sin separadores o con : / -. Ej: 805ec0aabbcc" value={form.mac} onChange={e => up('mac', e.currentTarget.value)} ff="monospace" required leftSection={<IconRouter size={15} />} disabled={!!form.id} />
            <Select label="Fabricante" data={VENDORS} value={form.vendor} onChange={v => up('vendor', v)} />
          </SimpleGrid>
          <SimpleGrid cols={2}>
            <TextInput label="Modelo (opcional)" value={form.model} onChange={e => up('model', e.currentTarget.value)} placeholder="T31P / GRP2601" />
            <TextInput label="Interno" description="Extensión SIP que usará el teléfono" value={form.ext} onChange={e => up('ext', e.currentTarget.value)} ff="monospace" required leftSection={<IconHash size={15} />} />
          </SimpleGrid>
          <SimpleGrid cols={2}>
            <TextInput label="Nombre a mostrar" value={form.label} onChange={e => up('label', e.currentTarget.value)} placeholder="Recepción" />
            <TextInput label="Etiqueta de línea" description="Texto en la tecla de línea" value={form.line_label} onChange={e => up('line_label', e.currentTarget.value)} placeholder="Recepción IES" />
          </SimpleGrid>
          <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>Se crea/actualiza el interno SIP (UDP) con su contraseña. El teléfono lo toma al pedir <Code>{fileFor(form.vendor, form.mac || '<mac>')}</Code>.</Alert>
          <Divider />
          <Group justify="flex-end"><Button variant="default" onClick={() => setOpened(false)}>Cancelar</Button><Button onClick={save} loading={saving} leftSection={<IconDeviceFloppy size={16} />}>{form.id ? 'Guardar' : 'Aprovisionar'}</Button></Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
