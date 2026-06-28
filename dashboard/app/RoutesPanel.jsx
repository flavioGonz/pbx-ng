/* RoutesPanel.jsx - rutas estaticas con dropdown de interfaz + modal de edicion (SBC o Asterisk) */
'use client';
import { useEffect, useState } from 'react';
import { Card, Group, Text, Table, Button, ActionIcon, Tooltip, Modal, TextInput, Select, Stack, Badge, Code } from '@mantine/core';
import { IconPlus, IconEdit, IconTrash, IconRoute, IconAlertTriangle, IconNetwork } from '@tabler/icons-react';
import { toast } from './notify';

export default function RoutesPanel({ scope }) {
  const isAst = scope === 'asterisk';
  const [routes, setRoutes] = useState([]); const [ifaces, setIfaces] = useState([]);
  const [open, setOpen] = useState(false); const [editId, setEditId] = useState(null);
  const [f, setF] = useState({ dest: '', gw: '', dev: '', note: '' }); const [busy, setBusy] = useState(false);
  async function load() {
    try {
      if (isAst) { const d = await fetch('/backend/api/asterisk/net').then((r) => r.json()); setRoutes(d.managed || []); setIfaces(((d.ifaces) || []).map((x) => x.name)); }
      else { const r = await fetch('/backend/api/sbc/routes').then((r) => r.json()); setRoutes(Array.isArray(r) ? r : []); const s = await fetch('/backend/api/sbc').then((r) => r.json()); setIfaces((((s.stats || {}).net || {}).ifaces || []).map((x) => x.name)); }
    } catch (_) {}
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  function openNew() { setEditId(null); setF({ dest: '', gw: '', dev: '', note: '' }); setOpen(true); }
  function openEdit(r) { setEditId(r.id); setF({ dest: r.dest || '', gw: r.gw || '', dev: r.dev || '', note: r.note || '' }); setOpen(true); }
  async function save() {
    if (!f.dest.trim() || (!f.gw.trim() && !f.dev.trim())) { toast('Indicá destino y gateway o interfaz', 'bad'); return; }
    setBusy(true);
    try {
      if (isAst) {
        if (editId) await fetch('/backend/api/asterisk/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'del', id: editId }) });
        await fetch('/backend/api/asterisk/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', ...f }) });
      } else {
        if (editId) await fetch('/backend/api/sbc/routes/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editId }) });
        await fetch('/backend/api/sbc/routes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
      }
    } catch (_) {}
    setBusy(false); setOpen(false); toast(editId ? 'Ruta actualizada' : 'Ruta agregada (se aplica en segundos)', 'ok'); setTimeout(load, 800);
  }
  async function del(r) {
    if (!confirm('¿Quitar la ruta ' + r.dest + '?')) return;
    try {
      if (isAst) await fetch('/backend/api/asterisk/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'del', id: r.id }) });
      else await fetch('/backend/api/sbc/routes/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id }) });
    } catch (_) {}
    toast('Ruta quitada', 'info'); setTimeout(load, 600);
  }
  const host = isAst ? 'Asterisk (CT103)' : 'SBC (CT107)';
  const col = isAst ? 'blue' : 'grape';
  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="sm"><Group gap="xs"><Text fw={700}>Rutas estáticas</Text><Badge variant="light" color={col}>{host}</Badge></Group><Button size="xs" leftSection={<IconPlus size={14} />} onClick={openNew}>Nueva ruta</Button></Group>
      <Table highlightOnHover><Table.Thead><Table.Tr><Table.Th>Destino</Table.Th><Table.Th>Gateway</Table.Th><Table.Th>Interfaz</Table.Th><Table.Th>Nota</Table.Th><Table.Th ta="right">Acción</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{routes.length === 0 ? <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="md" size="sm">Sin rutas estáticas. Todo sale por la ruta por defecto.</Text></Table.Td></Table.Tr> : routes.map((r) => (
          <Table.Tr key={r.id}><Table.Td ff="monospace" fz="sm">{r.dest}</Table.Td><Table.Td ff="monospace" fz="sm">{r.gw || '—'}</Table.Td><Table.Td ff="monospace" fz="sm">{r.dev || '—'}</Table.Td><Table.Td fz="sm">{r.note || ''}</Table.Td>
            <Table.Td ta="right"><Group gap={4} justify="flex-end" wrap="nowrap"><Tooltip label="Editar"><ActionIcon variant="subtle" color="gray" onClick={() => openEdit(r)}><IconEdit size={15} /></ActionIcon></Tooltip><Tooltip label="Quitar"><ActionIcon variant="subtle" color="red" onClick={() => del(r)}><IconTrash size={15} /></ActionIcon></Tooltip></Group></Table.Td></Table.Tr>))}</Table.Tbody></Table>
      <Group gap="xs" mt="sm"><IconAlertTriangle size={15} color="var(--mantine-color-orange-6)" /><Text size="xs" c="dimmed">Se aplican con <Code>ip route replace</Code> en {host}. Una ruta mal configurada puede afectar la conectividad; verificá gateway e interfaz.</Text></Group>
      <Modal opened={open} onClose={() => setOpen(false)} centered radius="lg" title={<Group gap="sm"><IconRoute size={20} /><Text fw={800}>{editId ? 'Editar ruta' : 'Nueva ruta estática'} — {host}</Text></Group>}>
        <Stack gap="md">
          <TextInput label="Destino (red/host)" description="Ej 200.40.10.0/24 o 1.2.3.4" placeholder="0.0.0.0/0" value={f.dest} onChange={(e) => setF({ ...f, dest: e.target.value })} required leftSection={<IconRoute size={15} />} />
          <TextInput label="Gateway (via)" description="IP del próximo salto (opcional si elegís interfaz)" placeholder="172.26.30.1" value={f.gw} onChange={(e) => setF({ ...f, gw: e.target.value })} />
          <Select label="Interfaz de salida (dev)" description="Elegí la interfaz para evitar errores de tipeo" placeholder="(automática)" data={ifaces} value={f.dev || null} onChange={(v) => setF({ ...f, dev: v || '' })} clearable searchable leftSection={<IconNetwork size={15} />} />
          <TextInput label="Nota (opcional)" placeholder="ej WAN troncal Antel" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <Button onClick={save} loading={busy} color={col}>{editId ? 'Guardar cambios' : 'Agregar ruta'}</Button>
        </Stack>
      </Modal>
    </Card>
  );
}
