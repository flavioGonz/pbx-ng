'use client';
// Libreta de clientes (CRM) — Drawer para supervisor/admin. ABM de clientes,
// personas autorizadas, espacios, dispositivos (RTSP) y editor de encuesta.
import { useEffect, useState, useCallback } from 'react';
import {
  Drawer, Tabs, TextInput, Textarea, Button, Group, Stack, Text, Card, ActionIcon,
  Badge, Select, ScrollArea, Divider, ThemeIcon, Switch, Box,
} from '@mantine/core';
import {
  IconUsers, IconPlus, IconTrash, IconDeviceCctv, IconBuilding, IconUserCheck,
  IconClipboardList, IconSearch, IconDeviceFloppy, IconRefresh, IconAddressBook, IconBell,
} from '@tabler/icons-react';
import { toast } from './notify';

const API = '/backend/api';
const j = (u, o) => fetch(u, o).then(r => r.ok ? r.json() : Promise.reject(r)).catch(() => null);

function Section({ icon, title, color, children, right }) {
  return (
    <Card withBorder radius="md" p="sm" mt="sm">
      <Group justify="space-between" mb={6}><Group gap={8}><ThemeIcon size={26} radius="md" variant="light" color={color}>{icon}</ThemeIcon><Text fw={700} fz="sm">{title}</Text></Group>{right}</Group>
      {children}
    </Card>
  );
}

export default function ClientesLibreta({ opened, onClose }) {
  const [tab, setTab] = useState('clientes');
  const [clients, setClients] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState({ name: '', doc: '', address: '', phones: '', notes: '' });
  const [np, setNp] = useState({ name: '', doc: '', relation: '', valid_until: '' });
  const [nsp, setNsp] = useState({ name: '', kind: '' });
  const [nd, setNd] = useState({ label: '', type: 'camera', rtsp_url: '' });
  const [fields, setFields] = useState([]);

  const loadClients = useCallback(() => j(API + '/clients').then(d => Array.isArray(d) && setClients(d)), []);
  useEffect(() => { if (opened) { loadClients(); j(API + '/survey/fields').then(d => Array.isArray(d) && setFields(d)); } }, [opened, loadClients]);

  async function openClient(id) {
    const c = await j(API + '/clients/' + id);
    if (!c) return;
    setSel(c);
    setForm({ name: c.name || '', doc: c.doc || '', address: c.address || '', phones: (c.phones || []).join(', '), notes: c.notes || '' });
  }
  async function newClient() {
    const c = await j(API + '/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nuevo cliente' }) });
    if (c) { await loadClients(); openClient(c.id); toast('Cliente creado', 'ok'); }
  }
  async function saveClient() {
    if (!sel) return;
    const c = await j(API + '/clients/' + sel.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, phones: form.phones }) });
    if (c) { toast('Guardado', 'ok'); loadClients(); }
  }
  async function delClient() {
    if (!sel || !confirm('¿Eliminar cliente y todos sus datos?')) return;
    await j(API + '/clients/' + sel.id, { method: 'DELETE' }); setSel(null); loadClients(); toast('Eliminado', 'ok');
  }
  async function addPerson() { if (!np.name) return; await j(API + '/clients/' + sel.id + '/persons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(np) }); setNp({ name: '', doc: '', relation: '', valid_until: '' }); openClient(sel.id); }
  async function delPerson(id) { await j(API + '/persons/' + id, { method: 'DELETE' }); openClient(sel.id); }
  async function addSpace() { if (!nsp.name) return; await j(API + '/clients/' + sel.id + '/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nsp) }); setNsp({ name: '', kind: '' }); openClient(sel.id); }
  async function delSpace(id) { await j(API + '/spaces/' + id, { method: 'DELETE' }); openClient(sel.id); }
  async function addDevice() { if (!nd.label) return; await j(API + '/clients/' + sel.id + '/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nd) }); setNd({ label: '', type: 'camera', rtsp_url: '' }); openClient(sel.id); }
  async function delDevice(id) { await j(API + '/devices/' + id, { method: 'DELETE' }); openClient(sel.id); }

  async function saveFields() { await j(API + '/survey/fields', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }); toast('Encuesta guardada', 'ok'); }
  function setF(i, k, v) { setFields(f => f.map((x, idx) => idx === i ? { ...x, [k]: v } : x)); }
  function addField() { setFields(f => [...f, { label: 'Nuevo campo', ftype: 'text', options: [], required: false }]); }
  function delField(i) { setFields(f => f.filter((_, idx) => idx !== i)); }

  const fc = clients.filter(c => !q || (c.name || '').toLowerCase().includes(q.toLowerCase()) || (c.phones || []).join(',').includes(q));

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size={sel ? 900 : 520} radius="lg"
      title={<Group gap={8}><ThemeIcon variant="light" color="grape" radius="md"><IconAddressBook size={18} /></ThemeIcon><Text fw={800}>Libreta de clientes</Text></Group>}>
      <Tabs value={tab} onChange={setTab} mb="sm">
        <Tabs.List>
          <Tabs.Tab value="clientes" leftSection={<IconUsers size={15} />}>Clientes</Tabs.Tab>
          <Tabs.Tab value="encuesta" leftSection={<IconClipboardList size={15} />}>Encuesta</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {tab === 'clientes' && (
        <div style={{ display: 'grid', gridTemplateColumns: sel ? '300px 1fr' : '1fr', gap: 14 }}>
          <Stack gap={8}>
            <Group gap={8}><TextInput style={{ flex: 1 }} size="sm" radius="md" leftSection={<IconSearch size={14} />} placeholder="Buscar cliente…" value={q} onChange={e => setQ(e.currentTarget.value)} /><ActionIcon size={36} variant="light" color="teal" onClick={newClient}><IconPlus size={18} /></ActionIcon></Group>
            <ScrollArea h={560}>
              <Stack gap={6}>
                {fc.length === 0 ? <Text c="dimmed" ta="center" py="lg" fz="sm">Sin clientes. Creá uno con +</Text> : fc.map(c => (
                  <Card key={c.id} withBorder radius="md" p="xs" style={{ cursor: 'pointer', borderColor: sel && sel.id === c.id ? 'var(--mantine-color-grape-5)' : undefined }} onClick={() => openClient(c.id)}>
                    <Text fw={700} fz="sm" truncate>{c.name}</Text>
                    <Group gap={6} mt={4}>
                      <Badge size="xs" variant="light" color="blue">{c.persons} pers.</Badge>
                      <Badge size="xs" variant="light" color="teal">{c.spaces} esp.</Badge>
                      <Badge size="xs" variant="light" color="grape">{c.devices} disp.</Badge>
                    </Group>
                  </Card>
                ))}
              </Stack>
            </ScrollArea>
          </Stack>

          {sel && (
            <ScrollArea h={600}>
              <Group justify="space-between"><Text fw={800} fz="lg">{form.name || 'Cliente'}</Text><Group gap={6}><Button size="xs" variant="light" color="teal" leftSection={<IconDeviceFloppy size={15} />} onClick={saveClient}>Guardar</Button><ActionIcon variant="light" color="red" onClick={delClient}><IconTrash size={16} /></ActionIcon></Group></Group>
              <Stack gap={8} mt="sm">
                <Group grow><TextInput label="Nombre" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.currentTarget.value }))} /><TextInput label="Documento" value={form.doc} onChange={e => setForm(f => ({ ...f, doc: e.currentTarget.value }))} /></Group>
                <TextInput label="Teléfonos (separados por coma)" description="Se usan para identificar al que llama" value={form.phones} onChange={e => setForm(f => ({ ...f, phones: e.currentTarget.value }))} />
                <TextInput label="Dirección" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.currentTarget.value }))} />
                <Textarea label="Notas" autosize minRows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.currentTarget.value }))} />
              </Stack>

              <Section icon={<IconUserCheck size={15} />} color="blue" title={'Personas autorizadas (' + (sel.persons?.length || 0) + ')'}>
                <Stack gap={6}>
                  {(sel.persons || []).map(p => <Group key={p.id} justify="space-between" wrap="nowrap"><Text fz="sm"><b>{p.name}</b>{p.relation ? ' · ' + p.relation : ''}{p.doc ? ' · ' + p.doc : ''}{p.valid_until ? ' · vence ' + p.valid_until : ''}</Text><ActionIcon size="sm" variant="subtle" color="red" onClick={() => delPerson(p.id)}><IconTrash size={14} /></ActionIcon></Group>)}
                  <Group gap={6} align="flex-end"><TextInput style={{ flex: 1 }} size="xs" placeholder="Nombre" value={np.name} onChange={e => setNp(v => ({ ...v, name: e.currentTarget.value }))} /><TextInput size="xs" w={110} placeholder="Vínculo" value={np.relation} onChange={e => setNp(v => ({ ...v, relation: e.currentTarget.value }))} /><TextInput size="xs" w={110} placeholder="Documento" value={np.doc} onChange={e => setNp(v => ({ ...v, doc: e.currentTarget.value }))} /><Button size="xs" variant="light" onClick={addPerson}>Agregar</Button></Group>
                </Stack>
              </Section>

              <Section icon={<IconBuilding size={15} />} color="teal" title={'Espacios (' + (sel.spaces?.length || 0) + ')'}>
                <Stack gap={6}>
                  {(sel.spaces || []).map(s => <Group key={s.id} justify="space-between" wrap="nowrap"><Text fz="sm"><b>{s.name}</b>{s.kind ? ' · ' + s.kind : ''}</Text><ActionIcon size="sm" variant="subtle" color="red" onClick={() => delSpace(s.id)}><IconTrash size={14} /></ActionIcon></Group>)}
                  <Group gap={6} align="flex-end"><TextInput style={{ flex: 1 }} size="xs" placeholder="Nombre / unidad" value={nsp.name} onChange={e => setNsp(v => ({ ...v, name: e.currentTarget.value }))} /><TextInput size="xs" w={140} placeholder="Tipo" value={nsp.kind} onChange={e => setNsp(v => ({ ...v, kind: e.currentTarget.value }))} /><Button size="xs" variant="light" onClick={addSpace}>Agregar</Button></Group>
                </Stack>
              </Section>

              <Section icon={<IconDeviceCctv size={15} />} color="grape" title={'Dispositivos de video (' + (sel.devices?.length || 0) + ')'}>
                <Stack gap={6}>
                  {(sel.devices || []).map(d => <Group key={d.id} justify="space-between" wrap="nowrap"><div style={{ minWidth: 0 }}><Text fz="sm"><b>{d.label}</b> <Badge size="xs" variant="light" color={d.type === 'intercom' ? 'orange' : 'grape'}>{d.type}</Badge></Text><Text fz={11} c="dimmed" truncate>{d.rtsp_url || 'sin URL'} · src: {d.go2rtc_src}</Text></div><ActionIcon size="sm" variant="subtle" color="red" onClick={() => delDevice(d.id)}><IconTrash size={14} /></ActionIcon></Group>)}
                  <Group gap={6} align="flex-end"><TextInput size="xs" w={130} placeholder="Etiqueta" value={nd.label} onChange={e => setNd(v => ({ ...v, label: e.currentTarget.value }))} /><Select size="xs" w={110} data={[{ value: 'intercom', label: 'Intercom' }, { value: 'camera', label: 'Cámara' }]} value={nd.type} onChange={v => setNd(s => ({ ...s, type: v }))} /><TextInput style={{ flex: 1 }} size="xs" placeholder="rtsp://usuario:pass@ip:554/stream" value={nd.rtsp_url} onChange={e => setNd(v => ({ ...v, rtsp_url: e.currentTarget.value }))} /><Button size="xs" variant="light" color="grape" onClick={addDevice}>Agregar</Button></Group>
                </Stack>
              </Section>
            </ScrollArea>
          )}
        </div>
      )}

      {tab === 'encuesta' && (
        <Stack gap={8}>
          <Group justify="space-between"><Text fw={700} fz="sm">Campos de la encuesta post-llamada</Text><Group gap={6}><Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={addField}>Campo</Button><Button size="xs" color="teal" leftSection={<IconDeviceFloppy size={14} />} onClick={saveFields}>Guardar</Button></Group></Group>
          {fields.map((f, i) => (
            <Card key={i} withBorder radius="md" p="sm">
              <Group gap={8} align="flex-end">
                <TextInput style={{ flex: 1 }} size="xs" label="Etiqueta" value={f.label} onChange={e => setF(i, 'label', e.currentTarget.value)} />
                <Select size="xs" w={130} label="Tipo" data={[{ value: 'text', label: 'Texto' }, { value: 'select', label: 'Lista' }, { value: 'rating', label: 'Puntaje 1-5' }, { value: 'bool', label: 'Sí/No' }]} value={f.ftype} onChange={v => setF(i, 'ftype', v)} />
                <Switch size="sm" label="Obligatorio" checked={!!f.required} onChange={e => setF(i, 'required', e.currentTarget.checked)} />
                <ActionIcon variant="subtle" color="red" onClick={() => delField(i)}><IconTrash size={16} /></ActionIcon>
              </Group>
              {f.ftype === 'select' && <TextInput mt={6} size="xs" label="Opciones (separadas por coma)" value={(f.options || []).join(', ')} onChange={e => setF(i, 'options', e.currentTarget.value.split(',').map(x => x.trim()).filter(Boolean))} />}
            </Card>
          ))}
        </Stack>
      )}
    </Drawer>
  );
}
