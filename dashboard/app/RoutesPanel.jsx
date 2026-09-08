/* RoutesPanel.jsx - rutas estaticas del nucleo (Asterisk) con dropdown de interfaz + modal de edicion */
'use client';
import { useEffect, useState } from 'react';
import { Card, Group, Text, Table, Button, ActionIcon, Tooltip, Modal, TextInput, Select, Stack, Badge, Code } from '@mantine/core';
import { IconPlus, IconEdit, IconTrash, IconRoute, IconAlertTriangle, IconNetwork } from '@tabler/icons-react';
import { toast } from './notify';
import { apiPost, usePoll } from './api';

export default function RoutesPanel({ scope }) {
  const isAst = true;   // el borde (SBC-NG) es otro producto: sus rutas viven en su panel
  const [routes, setRoutes] = useState([]); const [ifaces, setIfaces] = useState([]);
  const [open, setOpen] = useState(false); const [editId, setEditId] = useState(null);
  const [f, setF] = useState({ dest: '', gw: '', dev: '', note: '' }); const [busy, setBusy] = useState(false);
  /* Cada 8 s como antes, pero pausado con la pestaña oculta. */
  const { data: net, error: netError, recargar: load } = usePoll('/asterisk/net', 30000);
  useEffect(() => {
    if (!net) return;
    setRoutes(net.managed || []); setIfaces((net.ifaces || []).map((x) => x.name));
  }, [net]);
  useEffect(() => { if (netError) setRoutes([]); }, [netError]);
  function openNew() { setEditId(null); setF({ dest: '', gw: '', dev: '', note: '' }); setOpen(true); }
  function openEdit(r) { setEditId(r.id); setF({ dest: r.dest || '', gw: r.gw || '', dev: r.dev || '', note: r.note || '' }); setOpen(true); }
  async function save() {
    if (!f.dest.trim() || (!f.gw.trim() && !f.dev.trim())) { toast('Indicá destino y gateway o interfaz', 'bad'); return; }
    setBusy(true);
    try {
      // Editar = borrar y volver a agregar; si el borrado falla no se agrega la duplicada.
      if (editId) await apiPost('/asterisk/route', { action: 'del', id: editId });
      await apiPost('/asterisk/route', { action: 'add', ...f });
      setOpen(false);
      toast(editId ? 'Ruta actualizada' : 'Ruta agregada (se aplica en segundos)', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
    finally { setBusy(false); setTimeout(load, 800); }
  }
  async function del(r) {
    if (!confirm('¿Quitar la ruta ' + r.dest + '?')) return;
    // Antes decía «Ruta quitada» aunque el agente rechazara el pedido.
    try { await apiPost('/asterisk/route', { action: 'del', id: r.id }); toast('Ruta quitada', 'info'); }
    catch (e) { toast(e.message, 'bad'); }
    finally { setTimeout(load, 600); }
  }
  const host = 'Asterisk (núcleo)';
  const col = 'blue';
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
