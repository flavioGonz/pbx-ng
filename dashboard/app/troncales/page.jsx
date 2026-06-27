'use client';
import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Stack, Title, Text, Group, Button, Badge, Card, ActionIcon, Modal, TextInput, PasswordInput, SegmentedControl, Switch, ThemeIcon, Flex, ScrollArea } from '@mantine/core';
import { IconPlus, IconTrash, IconEdit, IconRouteAltLeft, IconServer2, IconUsers, IconDeviceLandlinePhone, IconTag, IconWorld, IconHash, IconUser, IconLock } from '@tabler/icons-react';
import { useLive } from '../useLive';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

function TNode({ data }) {
  const accent = data.accent;
  const col = data.status === 'online' ? '#16a34a' : data.status === 'offline' ? '#dc2626' : data.status === 'sbc' ? '#7c3aed' : '#64748b';
  return (
    <div style={{ width: 184, borderRadius: 15, padding: '11px 13px', background: accent === 'kam' ? 'linear-gradient(160deg,#6d28d9,#4c1d95)' : accent === 'ast' ? 'linear-gradient(160deg,#1d4ed8,#1e3a8a)' : '#ffffff', color: accent ? '#fff' : '#1e293b', border: '1px solid ' + (accent ? 'transparent' : 'rgba(15,23,42,.10)'), boxShadow: '0 8px 22px rgba(30,50,120,.14)' }}>
      <Handle type="target" position={Position.Left} style={{ background: '#94a3b8' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#94a3b8' }} />
      <Group gap={8} wrap="nowrap">
        <div style={{ width: 28, height: 28, borderRadius: 8, background: accent ? 'rgba(255,255,255,.18)' : 'rgba(47,116,230,.16)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: accent ? '#fff' : '#2f74e6' }}>{data.icon}</div>
        <div style={{ lineHeight: 1.15, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 13.5 }}>{data.title}</div>{data.sub && <div style={{ fontSize: 10.5, opacity: .7, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{data.sub}</div>}</div>
        {data.dot !== false && <span style={{ marginLeft: 'auto', width: 9, height: 9, borderRadius: '50%', background: col, boxShadow: '0 0 0 3px ' + col + '22', flex: 'none' }} />}
      </Group>
      {data.badge && <div style={{ marginTop: 8 }}><span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: accent ? 'rgba(255,255,255,.16)' : 'rgba(47,116,230,.16)', color: accent ? '#fff' : '#2f74e6', fontWeight: 600 }}>{data.badge}</span></div>}
    </div>
  );
}
const nodeTypes = { t: TNode };
const blank = { name: '', kind: 'asterisk', provider_host: '', provider_port: '5060', username: '', password: '', do_register: true };

export default function Troncales() {
  const { snap } = useLive();
  const [trunks, setTrunks] = useState([]); const [open, setOpen] = useState(false); const [f, setF] = useState(blank); const [saving, setSaving] = useState(false); const [editing, setEditing] = useState(false);
  async function load() { try { setTrunks(await fetch('/backend/api/trunks').then(r => r.json())); } catch (_) {} }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  function openNew() { setEditing(false); setF(blank); setOpen(true); }
  function openEdit(t) { setEditing(true); setF({ name: t.name, kind: t.kind || 'asterisk', provider_host: t.provider_host || '', provider_port: String(t.provider_port || '5060'), username: t.username || '', password: '', do_register: !!t.do_register }); setOpen(true); }
  async function create() {
    if (!f.name || !f.provider_host) { toast('Nombre y host del proveedor son obligatorios', 'bad'); return; }
    setSaving(true);
    const url = editing ? '/backend/api/trunks/' + encodeURIComponent(f.name) : '/backend/api/trunks';
    const r = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast(editing ? 'Troncal actualizada' : 'Troncal ' + r.created + ' creada', 'ok'); setF(blank); setOpen(false); load(); }
  }
  async function del(t) { if (!confirm('¿Eliminar la troncal ' + t.name + '?')) return; await fetch('/backend/api/trunks/' + t.name, { method: 'DELETE' }); toast('Troncal eliminada', 'info'); load(); }

  const ch = (snap?.channels || []).length;
  const kamTrunks = trunks.filter(t => t.kind === 'kamailio'); const astTrunks = trunks.filter(t => t.kind !== 'kamailio');

  const { nodes, edges } = useMemo(() => {
    const ns = [], es = [];
    const COL_T = 40, COL_KAM = 380, COL_AST = 660, COL_INT = 940;
    const ROW = 210, STEP = 96;
    ns.push({ id: 'kam', type: 't', position: { x: COL_KAM, y: ROW }, data: { title: 'SBC Kamailio', sub: '172.26.20.205', icon: <IconRouteAltLeft size={16} />, accent: 'kam', status: 'sbc', badge: kamTrunks.length + ' troncal(es)' } });
    ns.push({ id: 'ast', type: 't', position: { x: COL_AST, y: ROW }, data: { title: 'Asterisk PBX', sub: '172.26.20.183', icon: <IconServer2 size={16} />, accent: 'ast', status: snap?.health?.ami ? 'online' : 'down', badge: ch + ' llamada(s)' } });
    ns.push({ id: 'int', type: 't', position: { x: COL_INT, y: ROW }, data: { title: 'Internos', icon: <IconUsers size={16} />, dot: false, badge: (snap?.extensions || []).length + ' extensiones' } });
    es.push({ id: 'k-a', source: 'kam', target: 'ast', type: 'smoothstep', animated: true, label: 'dispatcher', style: { stroke: '#7c3aed', strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: '#7c3aed' } });
    es.push({ id: 'a-i', source: 'ast', target: 'int', type: 'smoothstep', animated: true, style: { stroke: '#16a34a', strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: '#16a34a' } });
    // Todas las troncales en la columna izquierda, centradas frente a la fila de hubs
    const all = [...kamTrunks.map(t => ({ t, kind: 'kamailio' })), ...astTrunks.map(t => ({ t, kind: 'asterisk' }))];
    const start = ROW - ((all.length - 1) * STEP) / 2;
    all.forEach((it, i) => {
      const id = 'tk-' + it.t.name; const kind = it.kind; const stt = it.t.status;
      const online = stt === 'online'; const offline = stt === 'offline';
      const ecol = offline ? '#dc2626' : online ? '#16a34a' : (kind === 'kamailio' ? '#7c3aed' : '#1d4ed8');
      ns.push({ id, type: 't', position: { x: COL_T, y: start + i * STEP }, data: { title: it.t.name, sub: it.t.provider_host, icon: <IconDeviceLandlinePhone size={16} />, status: stt, badge: (kind === 'kamailio' ? 'Kamailio' : 'Asterisk') + (offline ? ' · caída' : online ? ' · activa' : '') } });
      es.push({ id: 'e-' + id, source: id, target: kind === 'kamailio' ? 'kam' : 'ast', type: 'smoothstep', animated: online, style: { stroke: ecol, strokeWidth: 2, strokeDasharray: offline ? '6 4' : undefined }, markerEnd: { type: MarkerType.ArrowClosed, color: ecol } });
    });
    return { nodes: ns, edges: es };
  }, [trunks, snap]);

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconDeviceLandlinePhone size={24} />} title="Troncales" subtitle="Enlaces con operadores SIP · por Asterisk o por el SBC Kamailio" color="teal"
        right={<Button leftSection={<IconPlus size={16} />} onClick={openNew}>Nueva troncal</Button>} />

      <Flex gap="lg" align="stretch" wrap="wrap">
        <Card withBorder radius="lg" padding={0} shadow="sm" style={{ overflow: 'hidden', flex: '1 1 440px', minWidth: 0 }}>
          <div style={{ height: 470, background: 'radial-gradient(720px 360px at 72% -10%, rgba(47,116,230,.05), transparent), #f6f8fb' }}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.22 }} defaultEdgeOptions={{ type: 'smoothstep' }} proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false} minZoom={0.4} maxZoom={1.4}>
              <Background color="#cdd7e4" gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </Card>

        <Card withBorder radius="lg" padding="md" shadow="sm" style={{ flex: '0 0 340px', maxWidth: '100%' }}>
          <Group justify="space-between" mb="sm"><Text fw={600}>Troncales configuradas</Text><Badge variant="light" color="gray">{trunks.length}</Badge></Group>
          {trunks.length === 0 ? <Text c="dimmed" ta="center" py="xl" size="sm">Sin troncales. Creá una hacia tu operador SIP.</Text> :
            <ScrollArea.Autosize mah={420}>
              <Stack gap={8}>
                {trunks.map(t => (
                  <Card key={t.name} withBorder radius="md" padding="xs" style={{ background: t.kind === 'kamailio' ? 'rgba(124,58,237,.04)' : 'rgba(29,78,216,.04)' }}>
                    <Group justify="space-between" wrap="nowrap" gap={6}>
                      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                        <ThemeIcon size={28} radius="md" variant="light" color={t.kind === 'kamailio' ? 'grape' : 'blue'}>{t.kind === 'kamailio' ? <IconRouteAltLeft size={15} /> : <IconServer2 size={15} />}</ThemeIcon>
                        <div style={{ minWidth: 0 }}><Text fw={600} fz="sm" truncate>{t.name}</Text><Text fz={11} c="dimmed" ff="monospace" truncate>{t.provider_host}:{t.provider_port}</Text></div>
                      </Group>
                      <Group gap={2} wrap="nowrap"><ActionIcon variant="subtle" color="gray" size="sm" onClick={() => openEdit(t)}><IconEdit size={15} /></ActionIcon><ActionIcon variant="subtle" color="red" size="sm" onClick={() => del(t)}><IconTrash size={15} /></ActionIcon></Group>
                    </Group>
                    <Group gap={6} mt={6}>
                      <Badge size="xs" variant="light" color={t.kind === 'kamailio' ? 'grape' : 'blue'}>{t.kind === 'kamailio' ? 'Kamailio' : 'Asterisk'}</Badge>
                      <Badge size="xs" variant="filled" color={t.status === 'online' ? 'teal' : t.status === 'offline' ? 'red' : t.status === 'sbc' ? 'grape' : 'gray'}>{t.detail || (t.status === 'online' ? 'Conectada' : t.status === 'offline' ? 'Caída' : t.status === 'sbc' ? 'En el SBC' : 'Sin datos')}</Badge>
                    </Group>
                  </Card>
                ))}
              </Stack>
            </ScrollArea.Autosize>}
        </Card>
      </Flex>

      <Modal opened={open} onClose={() => setOpen(false)} centered radius="lg" size="md" title={<Group gap="sm"><ThemeIcon size={38} radius="md" variant="light" color="teal"><IconDeviceLandlinePhone size={20} /></ThemeIcon><div><Text fw={800} lh={1.1}>{editing ? 'Editar troncal' : 'Nueva troncal'}</Text><Text size="xs" c="dimmed">Enlace con tu operador SIP</Text></div></Group>}>
        <Stack gap="sm">
          <div>
            <Text size="sm" fw={500} mb={4}>¿Dónde vive la troncal?</Text>
            <SegmentedControl fullWidth value={f.kind} onChange={v => set('kind', v)} data={[{ value: 'asterisk', label: 'Asterisk (directo)' }, { value: 'kamailio', label: 'SBC Kamailio' }]} />
            <Text size="xs" c="dimmed" mt={6}>{f.kind === 'kamailio' ? 'El borde Kamailio gestiona el enlace con el operador (seguridad/registro en el SBC). Requiere el provider para la prueba final.' : 'Asterisk se registra y enruta directo contra el operador (modo actual, probado).'}</Text>
          </div>
          <TextInput label="Nombre" leftSection={<IconTag size={15} />} placeholder="proveedor-1" value={f.name} onChange={e => set('name', e.target.value)} required disabled={editing} description={editing ? 'El nombre no se puede cambiar' : 'Identificador único de la troncal. Ej: proveedor-1.'} />
          <Group grow>
            <TextInput label="Host del proveedor" leftSection={<IconWorld size={15} />} placeholder="sip.proveedor.com" value={f.provider_host} onChange={e => set('provider_host', e.target.value)} required description="Servidor SIP del operador. Ej: sip.proveedor.com." />
            <TextInput label="Puerto" leftSection={<IconHash size={15} />} value={f.provider_port} onChange={e => set('provider_port', e.target.value)} w={130} description="Ej: 5060." />
          </Group>
          <Group grow>
            <TextInput label="Usuario" leftSection={<IconUser size={15} />} value={f.username} onChange={e => set('username', e.target.value)} description="Usuario SIP del operador." />
            <PasswordInput label="Contraseña" leftSection={<IconLock size={15} />} placeholder={editing ? '(sin cambios)' : ''} value={f.password} onChange={e => set('password', e.target.value)} description="Clave SIP del operador." />
          </Group>
          <Switch label="Registrarse contra el proveedor" checked={f.do_register} onChange={e => set('do_register', e.currentTarget.checked)} />
          <Button onClick={create} loading={saving} mt="xs">{editing ? 'Guardar cambios' : 'Crear troncal'}</Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
