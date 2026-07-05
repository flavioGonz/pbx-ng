'use client';
// Sección admin · CRM. Ficha de un cliente (ruta propia /clientes/[id]).
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Card, Text, Group, Badge, Button, TextInput, Textarea, Select, Stack, ThemeIcon,
  ActionIcon, Tooltip, Avatar, ScrollArea, Loader, Paper, Anchor,
} from '@mantine/core';
import {
  IconArrowLeft, IconUserCheck, IconBuilding, IconDeviceCctv, IconTrash, IconPlus,
  IconDeviceFloppy, IconId, IconMapPin, IconPhone, IconBell, IconAddressBook,
} from '@tabler/icons-react';
import { toast } from '../../notify';

const API = '/backend/api';
const j = (u, o) => fetch(u, o).then(r => r.ok ? r.json() : Promise.reject(r)).catch(() => null);
const initials = (n) => (n || '?').split(/[\s.]+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

function Section({ icon, title, color, count, children }) {
  return (
    <Card withBorder radius="md" p="sm" mt="sm" shadow="xs">
      <Group gap={8} mb={8}><ThemeIcon size={28} radius="md" variant="light" color={color}>{icon}</ThemeIcon><Text fw={700} fz="sm">{title}</Text>{count != null && <Badge size="sm" variant="light" color={color}>{count}</Badge>}</Group>
      {children}
    </Card>
  );
}

export default function ClienteFicha() {
  const { id } = useParams();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState({ name: '', doc: '', address: '', phones: '', notes: '' });
  const [np, setNp] = useState({ name: '', doc: '', relation: '', valid_until: '' });
  const [nsp, setNsp] = useState({ name: '', kind: '' });
  const [nd, setNd] = useState({ label: '', type: 'intercom', rtsp_url: '' });

  async function reload() {
    setLoading(true); const c = await j(API + '/clients/' + id); setLoading(false);
    if (!c) return; setSel(c);
    setForm({ name: c.name || '', doc: c.doc || '', address: c.address || '', phones: (c.phones || []).join(', '), notes: c.notes || '' });
  }
  useEffect(() => { reload(); }, [id]);

  async function save() { const c = await j(API + '/clients/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, phones: form.phones }) }); if (c) toast('Guardado', 'ok'); }
  async function del() { if (!confirm('¿Eliminar cliente y todos sus datos?')) return; await j(API + '/clients/' + id, { method: 'DELETE' }); toast('Eliminado', 'ok'); router.push('/clientes'); }
  async function addPerson() { if (!np.name) return; await j(API + '/clients/' + id + '/persons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(np) }); setNp({ name: '', doc: '', relation: '', valid_until: '' }); reload(); }
  async function delPerson(pid) { await j(API + '/persons/' + pid, { method: 'DELETE' }); reload(); }
  async function addSpace() { if (!nsp.name) return; await j(API + '/clients/' + id + '/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nsp) }); setNsp({ name: '', kind: '' }); reload(); }
  async function delSpace(sid) { await j(API + '/spaces/' + sid, { method: 'DELETE' }); reload(); }
  async function addDevice() { if (!nd.label) return; await j(API + '/clients/' + id + '/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nd) }); setNd({ label: '', type: 'intercom', rtsp_url: '' }); reload(); toast('Dispositivo agregado', 'ok'); }
  async function delDevice(did) { await j(API + '/devices/' + did, { method: 'DELETE' }); reload(); }

  if (loading && !sel) return <Group justify="center" py={80}><Loader /></Group>;
  if (!sel) return <Card withBorder radius="lg" p="xl"><Text c="dimmed" ta="center">Cliente no encontrado. <Anchor onClick={() => router.push('/clientes')}>Volver</Anchor></Text></Card>;

  return (
    <div>
      <Group justify="space-between" mb="md" wrap="nowrap">
        <Group gap="sm">
          <ActionIcon variant="light" size={38} radius="md" onClick={() => router.push('/clientes')}><IconArrowLeft size={20} /></ActionIcon>
          <Avatar size={44} radius="xl" color="grape">{initials(form.name)}</Avatar>
          <div><Text fw={800} fz="xl" lh={1.05}>{form.name || 'Cliente'}</Text><Text fz="xs" c="dimmed"><IconAddressBook size={11} style={{ verticalAlign: -1 }} /> Ficha de cliente</Text></div>
        </Group>
        <Group gap={6}>
          <Button variant="light" color="teal" leftSection={<IconDeviceFloppy size={16} />} onClick={save}>Guardar</Button>
          <Tooltip label="Eliminar cliente"><ActionIcon variant="light" color="red" size={36} onClick={del}><IconTrash size={17} /></ActionIcon></Tooltip>
        </Group>
      </Group>

      <ScrollArea>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
          <div>
            <Card withBorder radius="lg" p="md" shadow="sm">
              <Text fw={700} fz="sm" mb="sm">Datos</Text>
              <Stack gap={8}>
                <Group grow><TextInput label="Nombre" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.currentTarget.value }))} /><TextInput label="Documento" leftSection={<IconId size={14} />} value={form.doc} onChange={e => setForm(f => ({ ...f, doc: e.currentTarget.value }))} /></Group>
                <TextInput label="Teléfonos (coma)" description="Identifican al que llama para traer la ficha" leftSection={<IconPhone size={14} />} value={form.phones} onChange={e => setForm(f => ({ ...f, phones: e.currentTarget.value }))} />
                <TextInput label="Dirección" leftSection={<IconMapPin size={14} />} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.currentTarget.value }))} />
                <Textarea label="Notas" autosize minRows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.currentTarget.value }))} />
              </Stack>
            </Card>

            <Section icon={<IconUserCheck size={15} />} color="blue" title="Personas autorizadas" count={(sel.persons || []).length}>
              <Stack gap={6}>
                {(sel.persons || []).map(p => <Group key={p.id} justify="space-between" wrap="nowrap"><Text fz="sm"><b>{p.name}</b>{p.relation ? ' · ' + p.relation : ''}{p.doc ? ' · ' + p.doc : ''}{p.valid_until ? ' · vence ' + p.valid_until : ''}</Text><ActionIcon size="sm" variant="subtle" color="red" onClick={() => delPerson(p.id)}><IconTrash size={14} /></ActionIcon></Group>)}
                <Group gap={6} align="flex-end"><TextInput style={{ flex: 1 }} size="xs" placeholder="Nombre" value={np.name} onChange={e => setNp(v => ({ ...v, name: e.currentTarget.value }))} /><TextInput size="xs" w={100} placeholder="Vínculo" value={np.relation} onChange={e => setNp(v => ({ ...v, relation: e.currentTarget.value }))} /><TextInput size="xs" w={100} placeholder="Documento" value={np.doc} onChange={e => setNp(v => ({ ...v, doc: e.currentTarget.value }))} /><Button size="xs" variant="light" onClick={addPerson}>Agregar</Button></Group>
              </Stack>
            </Section>
          </div>

          <div>
            <Section icon={<IconBuilding size={15} />} color="teal" title="Espacios" count={(sel.spaces || []).length}>
              <Stack gap={6}>
                {(sel.spaces || []).map(s => <Group key={s.id} justify="space-between" wrap="nowrap"><Text fz="sm"><b>{s.name}</b>{s.kind ? ' · ' + s.kind : ''}</Text><ActionIcon size="sm" variant="subtle" color="red" onClick={() => delSpace(s.id)}><IconTrash size={14} /></ActionIcon></Group>)}
                <Group gap={6} align="flex-end"><TextInput style={{ flex: 1 }} size="xs" placeholder="Nombre / unidad" value={nsp.name} onChange={e => setNsp(v => ({ ...v, name: e.currentTarget.value }))} /><TextInput size="xs" w={130} placeholder="Tipo" value={nsp.kind} onChange={e => setNsp(v => ({ ...v, kind: e.currentTarget.value }))} /><Button size="xs" variant="light" color="teal" onClick={addSpace}>Agregar</Button></Group>
              </Stack>
            </Section>

            <Section icon={<IconDeviceCctv size={15} />} color="grape" title="Dispositivos de video" count={(sel.devices || []).length}>
              <Stack gap={6}>
                {(sel.devices || []).map(d => <Group key={d.id} justify="space-between" wrap="nowrap"><div style={{ minWidth: 0 }}><Text fz="sm"><b>{d.label}</b> <Badge size="xs" variant="light" color={d.type === 'intercom' ? 'orange' : 'grape'} leftSection={d.type === 'intercom' ? <IconBell size={10} /> : <IconDeviceCctv size={10} />}>{d.type === 'intercom' ? 'Portero' : 'Cámara'}</Badge></Text><Text fz={11} c="dimmed" truncate>{d.rtsp_url || 'sin URL'}</Text></div><ActionIcon size="sm" variant="subtle" color="red" onClick={() => delDevice(d.id)}><IconTrash size={14} /></ActionIcon></Group>)}
                <Group gap={6} align="flex-end"><TextInput size="xs" w={120} placeholder="Etiqueta" value={nd.label} onChange={e => setNd(v => ({ ...v, label: e.currentTarget.value }))} /><Select size="xs" w={105} data={[{ value: 'intercom', label: 'Portero' }, { value: 'camera', label: 'Cámara' }]} value={nd.type} onChange={v => setNd(s => ({ ...s, type: v }))} /><TextInput style={{ flex: 1 }} size="xs" placeholder="rtsp://usuario:pass@ip:554/stream" value={nd.rtsp_url} onChange={e => setNd(v => ({ ...v, rtsp_url: e.currentTarget.value }))} /><Button size="xs" variant="light" color="grape" onClick={addDevice}>Agregar</Button></Group>
              </Stack>
            </Section>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
