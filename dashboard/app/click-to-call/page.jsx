'use client';
import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Stack, Card, Group, Text, Button, Table, Badge, ActionIcon, Modal, TextInput, Textarea, Select, Switch, ThemeIcon, SimpleGrid, Divider, Tooltip, CopyButton } from '@mantine/core';
import { IconWorldShare, IconPlus, IconEdit, IconTrash, IconQrcode, IconCopy, IconCheck, IconHash, IconBolt, IconDeviceFloppy, IconExternalLink, IconPhoneCall } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

const DTYPES = [{ value: 'extension', label: 'Interno' }, { value: 'queue', label: 'Cola' }, { value: 'ringgroup', label: 'Ring Group' }, { value: 'ivr', label: 'IVR' }, { value: 'ai', label: 'Agente IA' }];
const DLABEL = Object.fromEntries(DTYPES.map(d => [d.value, d.label]));
const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
const empty = { name: '', dest_type: 'extension', dest_value: '', intro: '', require_name: true, collect_geo: false, video: false, enabled: true };

export default function Click2Call() {
  const [list, setList] = useState([]); const [opened, setOpened] = useState(false); const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false);
  const [qr, setQr] = useState(null);
  const base = typeof window !== 'undefined' ? window.location.origin : 'https://pbx.ies.com.uy';
  const urlOf = (t) => base + '/call/' + t;
  async function load() { try { setList(await fetch('/backend/api/c2c').then(r => r.json())); } catch (_) {} }
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);
  const up = (k, v) => setForm(s => ({ ...s, [k]: v }));
  function nuevo() { setForm(empty); setOpened(true); }
  function edit(l) { setForm({ ...empty, ...l }); setOpened(true); }
  async function save() {
    if (!form.name || !form.dest_value) { toast('Nombre y destino son obligatorios', 'bad'); return; }
    setSaving(true);
    const url = form.id ? '/backend/api/c2c/' + form.id : '/backend/api/c2c';
    const r = await fetch(url, { method: form.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast(form.id ? 'Enlace actualizado' : 'Enlace creado', 'ok'); setOpened(false); load(); }
  }
  async function del(l) { if (!confirm('¿Eliminar el enlace ' + l.name + '?')) return; await fetch('/backend/api/c2c/' + l.id, { method: 'DELETE' }); toast('Enlace eliminado', 'info'); load(); }

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconWorldShare size={24} />} title="Click-to-Call público" subtitle="Enlaces y códigos QR para que clientes llamen por WebRTC sin instalar nada" color="teal"
        right={<Button leftSection={<IconPlus size={16} />} onClick={nuevo}>Nuevo enlace</Button>} />

      <Card withBorder radius="lg" padding="lg">
        {list.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin enlaces. Creá uno con «Nuevo enlace».</Text> :
          <Table.ScrollContainer minWidth={680}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr><Th icon={<IconWorldShare size={13} />}>Enlace</Th><Th icon={<IconPhoneCall size={13} />}>Destino</Th><Th icon={<IconBolt size={13} />}>Estado</Th><Th icon={<IconExternalLink size={13} />}>URL pública</Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>{list.map(l => (
                <Table.Tr key={l.id}>
                  <Table.Td fw={600} style={{ cursor: 'pointer' }} onClick={() => edit(l)}>{l.name}</Table.Td>
                  <Table.Td><Badge variant="light" color="grape">{DLABEL[l.dest_type] || l.dest_type} {l.dest_value}</Badge></Table.Td>
                  <Table.Td><Badge variant="dot" color={l.enabled ? 'teal' : 'gray'}>{l.enabled ? 'Activo' : 'Inactivo'}</Badge></Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Text size="xs" c="dimmed" ff="monospace" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>/call/{l.token}</Text>
                      <CopyButton value={urlOf(l.token)}>{({ copied, copy }) => <Tooltip label={copied ? 'Copiado' : 'Copiar URL'}><ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy}>{copied ? <IconCheck size={15} /> : <IconCopy size={15} />}</ActionIcon></Tooltip>}</CopyButton>
                    </Group>
                  </Table.Td>
                  <Table.Td ta="right"><Group gap={4} justify="flex-end">
                    <Tooltip label="Ver QR"><ActionIcon variant="subtle" color="teal" onClick={() => setQr(l)}><IconQrcode size={17} /></ActionIcon></Tooltip>
                    <ActionIcon variant="subtle" onClick={() => edit(l)}><IconEdit size={17} /></ActionIcon>
                    <ActionIcon variant="subtle" color="red" onClick={() => del(l)}><IconTrash size={17} /></ActionIcon>
                  </Group></Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>}
      </Card>

      <Modal opened={opened} onClose={() => setOpened(false)} size="lg" radius="lg" centered
        title={<Group gap="sm"><ThemeIcon size={38} radius="md" variant="light" color="teal"><IconWorldShare size={20} /></ThemeIcon><div><Text fw={800} lh={1.1}>{form.id ? 'Editar enlace' : 'Nuevo enlace Click-to-Call'}</Text><Text size="xs" c="dimmed">Llamada WebRTC pública</Text></div></Group>}>
        <Stack gap="md">
          <TextInput label="Nombre del enlace" description="Lo ve el cliente como título. Ej: Hablá con Ventas" value={form.name} onChange={e => up('name', e.currentTarget.value)} required />
          <SimpleGrid cols={2}>
            <Select label="Tipo de destino" data={DTYPES} value={form.dest_type} onChange={v => up('dest_type', v)} />
            <TextInput label="Destino" description="Número del interno/cola/IVR/agente. Ej: 1001" value={form.dest_value} onChange={e => up('dest_value', e.currentTarget.value)} ff="monospace" required leftSection={<IconHash size={15} />} />
          </SimpleGrid>
          <Textarea label="Texto de bienvenida" description="Subtítulo que ve el cliente en la página. Ej: Te respondemos al instante." value={form.intro} onChange={e => up('intro', e.currentTarget.value)} autosize minRows={2} />
          <Divider label="Opciones" labelPosition="center" />
          <SimpleGrid cols={2}>
            <Switch label="Pedir nombre del cliente" checked={form.require_name !== false} onChange={e => up('require_name', e.currentTarget.checked)} />
            <Switch label="Solicitar geolocalización" checked={!!form.collect_geo} onChange={e => up('collect_geo', e.currentTarget.checked)} />
            <Switch label="Habilitar video" checked={!!form.video} onChange={e => up('video', e.currentTarget.checked)} />
            <Switch label="Enlace activo" checked={form.enabled !== false} onChange={e => up('enabled', e.currentTarget.checked)} />
          </SimpleGrid>
          <Divider />
          <Group justify="flex-end"><Button variant="default" onClick={() => setOpened(false)}>Cancelar</Button><Button onClick={save} loading={saving} leftSection={<IconDeviceFloppy size={16} />}>{form.id ? 'Guardar' : 'Crear enlace'}</Button></Group>
        </Stack>
      </Modal>

      <Modal opened={!!qr} onClose={() => setQr(null)} size="sm" radius="lg" centered title={<Text fw={800}>QR · {qr && qr.name}</Text>}>
        {qr && <Stack align="center" gap="md">
          <div style={{ background: '#fff', padding: 16, borderRadius: 16, border: '1px solid #e5eaf3' }}><QRCodeSVG value={urlOf(qr.token)} size={208} level="M" /></div>
          <Text size="sm" c="dimmed" ta="center">El cliente escanea o abre el enlace y llama con un toque, desde el navegador.</Text>
          <Group gap="xs" w="100%">
            <TextInput readOnly value={urlOf(qr.token)} style={{ flex: 1 }} ff="monospace" size="xs" />
            <CopyButton value={urlOf(qr.token)}>{({ copied, copy }) => <Button size="xs" variant="light" color={copied ? 'teal' : 'blue'} leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={copy}>{copied ? 'Copiado' : 'Copiar'}</Button>}</CopyButton>
          </Group>
          <Button component="a" href={urlOf(qr.token)} target="_blank" variant="subtle" leftSection={<IconExternalLink size={15} />} size="xs">Abrir página de llamada</Button>
        </Stack>}
      </Modal>
    </Stack>
  );
}
