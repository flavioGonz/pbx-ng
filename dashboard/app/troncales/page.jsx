'use client';
import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Stack, Text, Group, Button, Badge, Card, ActionIcon, Modal, TextInput, PasswordInput, NumberInput, SegmentedControl, Switch, Select, MultiSelect, ThemeIcon, ScrollArea, Divider, Tooltip, Box, Paper, FileButton } from '@mantine/core';
import { IconPlus, IconTrash, IconEdit, IconRouteAltLeft, IconServer2, IconUsers, IconDeviceLandlinePhone, IconTag, IconWorld, IconHash, IconUser, IconLock, IconPlugConnected, IconAdjustmentsAlt, IconWaveSine, IconArrowsExchange, IconRefresh, IconX, IconKey, IconBroadcast, IconPhoto } from '@tabler/icons-react';
import { useLive } from '../useLive';
import { toast } from '../notify';

const CODECS = ['ulaw', 'alaw', 'g722', 'g729', 'opus', 'gsm'];
const blank = {
  name: '', kind: 'asterisk', callerid: '', mode: 'register',
  provider_host: '', provider_port: '5060', transport: 'udp',
  username: '', password: '', from_user: '', from_domain: '',
  codecs: ['ulaw', 'alaw'], dtmf_mode: 'rfc4733', nat: true, direct_media: false,
  qualify_frequency: 60, expiration: 3600, retry_interval: 60, context: 'from-trunk',
  outbound_enabled: true, outbound_prefix: '0', outbound_strip: 0, logo: '',
};

function TNode({ data }) {
  const accent = data.accent;
  const col = data.status === 'online' ? '#16a34a' : data.status === 'offline' ? '#dc2626' : data.status === 'sbc' ? '#7c3aed' : '#64748b';
  if (data.logo) {
    return (
      <div style={{ width: 156, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: data.clickable ? 'pointer' : 'default', position: 'relative' }}>
        <Handle type="target" position={Position.Left} style={{ background: '#94a3b8' }} />
        <Handle type="source" position={Position.Right} style={{ background: '#94a3b8' }} />
        <div style={{ position: 'relative' }}>
          <img src={data.logo} alt="" style={{ width: 74, height: 74, objectFit: 'contain', filter: 'drop-shadow(0 5px 12px rgba(15,42,74,.20))' }} />
          {data.dot !== false && <span style={{ position: 'absolute', top: 1, right: -3, width: 13, height: 13, borderRadius: '50%', background: col, border: '2px solid var(--mantine-color-body)', boxShadow: '0 0 0 2px ' + col + '33' }} />}
        </div>
        <div style={{ textAlign: 'center', lineHeight: 1.25, maxWidth: 154 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--mantine-color-text)' }}>{data.title}</div>
          {data.sub && <div style={{ fontSize: 10.5, opacity: .6, fontFamily: 'monospace', color: 'var(--mantine-color-text)' }}>{data.sub}</div>}
          {data.badge && <div style={{ fontSize: 10, opacity: .72, marginTop: 1, color: 'var(--mantine-color-text)' }}>{data.badge}</div>}
        </div>
      </div>
    );
  }
  return (
    <div style={{ width: data.clickable ? 200 : 186, borderRadius: 15, padding: '11px 13px', cursor: data.clickable ? 'pointer' : 'default', background: data.tint === 'down' ? 'linear-gradient(160deg,#ef4444,#b91c1c)' : data.tint === 'up' ? 'linear-gradient(160deg,#2f74e6,#1750c2)' : accent === 'kam' ? 'linear-gradient(160deg,#6d28d9,#4c1d95)' : accent === 'ast' ? 'linear-gradient(160deg,#1d4ed8,#1e3a8a)' : '#ffffff', color: (accent || data.tint) ? '#fff' : '#1e293b', border: '1px solid ' + ((accent || data.tint) ? 'transparent' : 'rgba(15,23,42,.10)'), boxShadow: '0 6px 18px rgba(30,50,120,.12)' }}>
      <Handle type="target" position={Position.Left} style={{ background: '#94a3b8' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#94a3b8' }} />
      <Group gap={8} wrap="nowrap">
        <div style={{ width: 30, height: 30, borderRadius: 8, background: data.logo ? '#fff' : (accent || data.tint) ? 'rgba(255,255,255,.2)' : 'rgba(47,116,230,.16)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: (accent || data.tint) ? '#fff' : '#2f74e6', flex: 'none', overflow: 'hidden', padding: data.logo ? 3 : 0 }}>{data.logo ? <img src={data.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : data.icon}</div>
        <div style={{ lineHeight: 1.15, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{data.title}</div>{data.sub && <div style={{ fontSize: 10.5, opacity: .7, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{data.sub}</div>}</div>
        {data.dot !== false && <span style={{ marginLeft: 'auto', width: 9, height: 9, borderRadius: '50%', background: col, boxShadow: '0 0 0 3px ' + col + '22', flex: 'none' }} />}
      </Group>
      {data.badge && <div style={{ marginTop: 8 }}><span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: accent ? 'rgba(255,255,255,.16)' : 'rgba(47,116,230,.16)', color: accent ? '#fff' : '#2f74e6', fontWeight: 600 }}>{data.badge}</span></div>}
    </div>
  );
}
const nodeTypes = { t: TNode };

export default function Troncales() {
  const { snap } = useLive();
  const [trunks, setTrunks] = useState([]); const [open, setOpen] = useState(false); const [f, setF] = useState(blank);
  const [saving, setSaving] = useState(false); const [editing, setEditing] = useState(false); const [showList, setShowList] = useState(true); const [sel, setSel] = useState(null);
  async function load() { try { setTrunks(await fetch('/backend/api/trunks').then(r => r.json())); } catch (_) {} }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  async function onLogo(file) {
    if (!file) return;
    try {
      const img = new Image(); const url = URL.createObjectURL(file);
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const max = 128, sc = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      set('logo', cv.toDataURL('image/png'));
      URL.revokeObjectURL(url);
    } catch (_) { toast('No se pudo procesar el logo', 'bad'); }
  }
  function openNew() { setEditing(false); setF(blank); setOpen(true); }
  async function openEdit(t) {
    setEditing(true);
    let adv = {};
    try { const d = await fetch('/backend/api/trunks/' + encodeURIComponent(t.name) + '/detail').then(r => r.json()); adv = d.adv || {}; } catch (_) {}
    setF({ ...blank, ...adv, name: t.name, kind: t.kind || 'asterisk', password: '', provider_port: String(adv.provider_port || t.provider_port || '5060') });
    setOpen(true);
  }
  async function create() {
    if (!f.name || !f.provider_host) { toast('Nombre y host del proveedor son obligatorios', 'bad'); return; }
    setSaving(true);
    const url = editing ? '/backend/api/trunks/' + encodeURIComponent(f.name) : '/backend/api/trunks';
    const body = { ...f, provider_port: +f.provider_port || 5060 };
    if (editing && !f.password) delete body.password;
    const r = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast(editing ? 'Troncal actualizada' : 'Troncal ' + (r.created || f.name) + ' creada', 'ok'); setOpen(false); load(); }
  }
  async function del(t) { if (!confirm('¿Eliminar la troncal ' + t.name + '?')) return; await fetch('/backend/api/trunks/' + t.name, { method: 'DELETE' }); toast('Troncal eliminada', 'info'); setSel(null); load(); }

  const ch = (snap?.channels || []).length;
  const online = trunks.filter(t => t.status === 'online').length;
  const kamTrunks = trunks.filter(t => t.kind === 'kamailio'); const astTrunks = trunks.filter(t => t.kind !== 'kamailio');

  const { nodes, edges } = useMemo(() => {
    const ns = [], es = [];
    const COL_T = 40, COL_KAM = 380, COL_AST = 660, COL_INT = 940; const ROW = 230, STEP = 100;
    ns.push({ id: 'kam', type: 't', position: { x: COL_KAM, y: ROW }, data: { title: 'SBC-NG', sub: '172.26.20.205', icon: <IconRouteAltLeft size={16} />, accent: 'kam', status: 'sbc', badge: kamTrunks.length + ' troncal(es)' } });
    ns.push({ id: 'ast', type: 't', position: { x: COL_AST, y: ROW }, data: { title: 'Asterisk PBX', sub: '172.26.20.183', icon: <IconServer2 size={16} />, accent: 'ast', status: snap?.health?.ami ? 'online' : 'down', badge: ch + ' llamada(s)' } });
    ns.push({ id: 'int', type: 't', position: { x: COL_INT, y: ROW }, data: { title: 'Internos', icon: <IconUsers size={16} />, dot: false, badge: (snap?.extensions || []).length + ' extensiones' } });
    es.push({ id: 'k-a', source: 'kam', target: 'ast', type: 'smoothstep', animated: true, label: 'dispatcher', style: { stroke: '#7c3aed', strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: '#7c3aed' } });
    es.push({ id: 'a-i', source: 'ast', target: 'int', type: 'smoothstep', animated: true, style: { stroke: '#16a34a', strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: '#16a34a' } });
    const all = [...kamTrunks.map(t => ({ t, kind: 'kamailio' })), ...astTrunks.map(t => ({ t, kind: 'asterisk' }))];
    const start = ROW - ((all.length - 1) * STEP) / 2;
    all.forEach((it, i) => {
      const id = 'tk-' + it.t.name; const kind = it.kind; const stt = it.t.status;
      const on = stt === 'online'; const off = stt === 'offline';
      const ecol = off ? '#dc2626' : on ? '#2f74e6' : (kind === 'kamailio' ? '#7c3aed' : '#94a3b8');
      ns.push({ id, type: 't', position: { x: COL_T, y: start + i * STEP }, data: { name: it.t.name, clickable: true, title: it.t.name, sub: it.t.provider_host, icon: <IconDeviceLandlinePhone size={16} />, logo: it.t.logo || (it.t.adv && it.t.adv.logo), tint: stt === 'offline' ? 'down' : stt === 'online' ? 'up' : undefined, status: stt, badge: (it.t.mode === 'ip' ? 'IP' : 'Registro') + ' · ' + (it.t.transport || 'udp').toUpperCase() } });
      es.push({ id: 'e-' + id, source: id, target: kind === 'kamailio' ? 'kam' : 'ast', type: 'smoothstep', animated: off, label: it.t.rtt != null ? (Math.round(it.t.rtt) + ' ms') : (on ? 'levantada' : off ? 'caida' : undefined), labelStyle: { fontSize: 10, fontWeight: 700, fill: ecol }, labelBgStyle: { fill: 'var(--mantine-color-body)', fillOpacity: 0.85 }, labelBgPadding: [4, 2], labelBgBorderRadius: 6, style: { stroke: ecol, strokeWidth: 2.2, strokeDasharray: off ? '6 4' : undefined }, markerEnd: { type: MarkerType.ArrowClosed, color: ecol } });
    });
    return { nodes: ns, edges: es };
  }, [trunks, snap]);

  const onNodeClick = (_, n) => { if (n.data?.clickable) { const t = trunks.find(x => x.name === n.data.name); if (t) { setSel(t); } } };
  const stBadge = (t) => <Badge size="xs" variant="filled" color={t.status === 'online' ? 'teal' : t.status === 'offline' ? 'red' : t.status === 'sbc' ? 'grape' : 'gray'}>{t.detail || (t.status === 'online' ? 'Conectada' : t.status === 'offline' ? 'Caída' : t.status === 'sbc' ? 'En el SBC' : 'Sin datos')}</Badge>;
  const glass = { background: 'rgba(255,255,255,.86)', backdropFilter: 'blur(10px)', border: '1px solid rgba(15,23,42,.08)', boxShadow: '0 10px 30px rgba(15,42,74,.10)' };
  const isAst = f.kind !== 'kamailio';

  return (
    <div style={{ position: 'relative', height: 'calc(100vh - 40px)', borderRadius: 18, overflow: 'hidden', border: '1px solid rgba(15,23,42,.10)', background: 'radial-gradient(820px 420px at 72% -12%, rgba(47,116,230,.06), transparent), #f6f8fb' }}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.18 }} defaultEdgeOptions={{ type: 'smoothstep' }} proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false} onNodeClick={onNodeClick} minZoom={0.3} maxZoom={1.6}>
        <Background color="#cdd7e4" gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* overlay: titulo + stats */}
      <Paper style={{ position: 'absolute', top: 16, left: 16, padding: '10px 14px', borderRadius: 14, ...glass }}>
        <Group gap={10} wrap="nowrap">
          <ThemeIcon size={34} radius="md" variant="light" color="teal"><IconDeviceLandlinePhone size={19} /></ThemeIcon>
          <div>
            <Text fw={800} fz="sm" lh={1.1}>Troncales SIP</Text>
            <Text fz={11} c="dimmed">Enlaces con operadores · Asterisk o SBC</Text>
          </div>
          <Divider orientation="vertical" />
          <Group gap={14}>
            <div style={{ textAlign: 'center' }}><Text fw={800} fz="lg" lh={1}>{trunks.length}</Text><Text fz={10} c="dimmed">totales</Text></div>
            <div style={{ textAlign: 'center' }}><Text fw={800} fz="lg" lh={1} c="teal">{online}</Text><Text fz={10} c="dimmed">activas</Text></div>
          </Group>
        </Group>
      </Paper>

      {/* overlay: acciones */}
      <Group style={{ position: 'absolute', top: 16, right: 16 }} gap={8}>
        <Tooltip label={showList ? 'Ocultar lista' : 'Ver lista'}><ActionIcon size={38} radius="md" variant="default" onClick={() => setShowList(s => !s)} style={glass}><IconAdjustmentsAlt size={18} /></ActionIcon></Tooltip>
        <Tooltip label="Refrescar"><ActionIcon size={38} radius="md" variant="default" onClick={load} style={glass}><IconRefresh size={18} /></ActionIcon></Tooltip>
        <Button leftSection={<IconPlus size={16} />} onClick={openNew} radius="md" style={{ boxShadow: '0 8px 20px rgba(20,150,120,.25)' }} color="teal">Nueva troncal</Button>
      </Group>

      {/* overlay: lista */}
      {showList && (
        <Paper style={{ position: 'absolute', top: 70, right: 16, width: 300, maxHeight: 'calc(100% - 90px)', borderRadius: 16, overflow: 'hidden', ...glass }}>
          <Group justify="space-between" px="md" py="xs" style={{ borderBottom: '1px solid rgba(15,23,42,.06)' }}><Text fw={700} fz="sm">Configuradas</Text><Badge variant="light" color="gray">{trunks.length}</Badge></Group>
          {trunks.length === 0 ? <Text c="dimmed" ta="center" py="xl" px="md" size="sm">Sin troncales todavía. Creá una hacia tu operador SIP.</Text> :
            <ScrollArea.Autosize mah={460}><Stack gap={6} p={8}>
              {trunks.map(t => (
                <Card key={t.name} withBorder radius="md" padding="xs" style={{ cursor: 'pointer', borderColor: sel?.name === t.name ? 'var(--mantine-color-teal-4)' : undefined, background: t.kind === 'kamailio' ? 'rgba(124,58,237,.04)' : 'rgba(29,78,216,.04)' }} onClick={() => setSel(t)}>
                  <Group justify="space-between" wrap="nowrap" gap={6}>
                    <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                      {t.logo ? <div style={{ width: 28, height: 28, borderRadius: 8, background: '#fff', border: '1px solid var(--mantine-color-default-border)', overflow: 'hidden', flex: 'none', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><img src={t.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div> : <ThemeIcon size={28} radius="md" variant="light" color={t.kind === 'kamailio' ? 'grape' : 'blue'}>{t.kind === 'kamailio' ? <IconRouteAltLeft size={15} /> : <IconServer2 size={15} />}</ThemeIcon>}
                      <div style={{ minWidth: 0 }}><Text fw={600} fz="sm" truncate>{t.name}</Text><Text fz={11} c="dimmed" ff="monospace" truncate>{t.provider_host}:{t.provider_port}</Text></div>
                    </Group>
                    <Group gap={2} wrap="nowrap"><ActionIcon variant="subtle" color="gray" size="sm" onClick={e => { e.stopPropagation(); openEdit(t); }}><IconEdit size={15} /></ActionIcon><ActionIcon variant="subtle" color="red" size="sm" onClick={e => { e.stopPropagation(); del(t); }}><IconTrash size={15} /></ActionIcon></Group>
                  </Group>
                  <Group gap={6} mt={6}>
                    <Badge size="xs" variant="light" color={t.mode === 'ip' ? 'indigo' : 'blue'}>{t.mode === 'ip' ? 'IP / Peer' : 'Registro'}</Badge>
                    <Badge size="xs" variant="light" color="gray">{(t.transport || 'udp').toUpperCase()}</Badge>
                    {stBadge(t)}
                  </Group>
                </Card>
              ))}
            </Stack></ScrollArea.Autosize>}
        </Paper>
      )}

      {/* overlay: detalle del nodo seleccionado */}
      {sel && (
        <Paper style={{ position: 'absolute', bottom: 16, left: 16, width: 320, borderRadius: 16, padding: 14, ...glass }}>
          <Group justify="space-between" mb={6}>
            <Group gap={8}><ThemeIcon size={30} radius="md" variant="light" color={sel.kind === 'kamailio' ? 'grape' : 'blue'}>{sel.kind === 'kamailio' ? <IconRouteAltLeft size={16} /> : <IconDeviceLandlinePhone size={16} />}</ThemeIcon><Text fw={800}>{sel.name}</Text></Group>
            <ActionIcon variant="subtle" color="gray" onClick={() => setSel(null)}><IconX size={16} /></ActionIcon>
          </Group>
          <Stack gap={5}>
            <Group justify="space-between"><Text fz="xs" c="dimmed">Estado</Text>{stBadge(sel)}</Group>
            <Group justify="space-between"><Text fz="xs" c="dimmed">Proveedor</Text><Text fz="xs" ff="monospace">{sel.provider_host}:{sel.provider_port}</Text></Group>
            <Group justify="space-between"><Text fz="xs" c="dimmed">Modo</Text><Badge size="xs" variant="light" color={sel.mode === 'ip' ? 'indigo' : 'blue'}>{sel.mode === 'ip' ? 'IP / Peer' : 'Registro'}</Badge></Group>
            <Group justify="space-between"><Text fz="xs" c="dimmed">Transporte</Text><Badge size="xs" variant="light" color="gray">{(sel.transport || 'udp').toUpperCase()}</Badge></Group>
            {sel.username && <Group justify="space-between"><Text fz="xs" c="dimmed">Usuario</Text><Text fz="xs" ff="monospace">{sel.username}</Text></Group>}
          </Stack>
          <Group grow mt="sm"><Button size="xs" variant="light" leftSection={<IconEdit size={14} />} onClick={() => openEdit(sel)}>Configurar</Button><Button size="xs" variant="light" color="red" leftSection={<IconTrash size={14} />} onClick={() => del(sel)}>Eliminar</Button></Group>
        </Paper>
      )}

      {/* editor completo */}
      <Modal opened={open} onClose={() => setOpen(false)} centered radius="lg" size="lg" scrollAreaComponent={ScrollArea.Autosize}
        title={<Group gap="sm"><ThemeIcon size={38} radius="md" variant="light" color="teal"><IconDeviceLandlinePhone size={20} /></ThemeIcon><div><Text fw={800} lh={1.1}>{editing ? 'Configurar troncal' : 'Nueva troncal'}</Text><Text size="xs" c="dimmed">Enlace con tu operador SIP</Text></div></Group>}>
        <Stack gap="md">
          <Divider label="General" labelPosition="left" />
          <div>
            <Text size="sm" fw={500} mb={4}>¿Dónde vive la troncal?</Text>
            <SegmentedControl fullWidth value={f.kind} onChange={v => set('kind', v)} disabled={editing} data={[{ value: 'asterisk', label: 'Asterisk (directo)' }, { value: 'kamailio', label: 'SBC-NG' }]} />
          </div>
          <Group grow>
            <TextInput label="Nombre" leftSection={<IconTag size={15} />} placeholder="proveedor-1" value={f.name} onChange={e => set('name', e.target.value)} required disabled={editing} description={editing ? 'No se puede cambiar' : 'Identificador único'} />
            <TextInput label="Caller ID saliente" leftSection={<IconUser size={15} />} placeholder='"Empresa" <099...>' value={f.callerid} onChange={e => set('callerid', e.target.value)} description="Identificación que verá el destino" />
          </Group>
          <Group gap="md" align="center" wrap="nowrap">
            <div style={{ width: 56, height: 56, borderRadius: 12, border: '1px dashed var(--mantine-color-default-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--mantine-color-default-hover)', overflow: 'hidden', flex: 'none' }}>{f.logo ? <img src={f.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 4 }} /> : <IconPhoto size={22} style={{ opacity: .4 }} />}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" fw={500}>Logo del proveedor (PNG)</Text>
              <Text size="xs" c="dimmed">Se muestra en la topología. PNG transparente recomendado.</Text>
              <Group gap="xs" mt={6}>
                <FileButton onChange={onLogo} accept="image/png,image/jpeg,image/svg+xml">{(props) => <Button {...props} size="xs" variant="light" leftSection={<IconPhoto size={14} />}>Subir logo</Button>}</FileButton>
                {f.logo && <Button size="xs" variant="subtle" color="red" onClick={() => set('logo', '')}>Quitar</Button>}
              </Group>
            </div>
          </Group>

          <Divider label="Conexión" labelPosition="left" />
          {isAst && <div>
            <Text size="sm" fw={500} mb={4}>Modo de la troncal</Text>
            <SegmentedControl fullWidth value={f.mode} onChange={v => set('mode', v)} data={[{ value: 'register', label: 'Registro (usuario/clave)' }, { value: 'ip', label: 'IP / Peer (sin registro)' }]} />
            <Text size="xs" c="dimmed" mt={6}>{f.mode === 'ip' ? 'El operador autentica por dirección IP; la PBX no se registra. Típico en enlaces dedicados/SIP trunk por IP.' : 'La PBX se registra contra el operador con usuario y contraseña (lo más común).'}</Text>
          </div>}
          <Group grow>
            <TextInput label="Host del proveedor" leftSection={<IconWorld size={15} />} placeholder="sip.proveedor.com" value={f.provider_host} onChange={e => set('provider_host', e.target.value)} required />
            <TextInput label="Puerto" leftSection={<IconHash size={15} />} value={f.provider_port} onChange={e => set('provider_port', e.target.value)} w={110} />
            <Select label="Transporte" value={f.transport} onChange={v => set('transport', v)} data={[{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }, { value: 'tls', label: 'TLS (cifrado)' }]} w={140} leftSection={<IconPlugConnected size={15} />} />
          </Group>

          {isAst && <>
            <Divider label="Autenticación" labelPosition="left" />
            <Group grow>
              <TextInput label="Usuario" leftSection={<IconUser size={15} />} value={f.username} onChange={e => set('username', e.target.value)} description={f.mode === 'ip' ? 'Opcional en modo IP' : 'Usuario SIP del operador'} />
              <PasswordInput label="Contraseña" leftSection={<IconLock size={15} />} placeholder={editing ? '(sin cambios)' : ''} value={f.password} onChange={e => set('password', e.target.value)} />
            </Group>
            <Group grow>
              <TextInput label="From user" leftSection={<IconKey size={15} />} placeholder="(usuario)" value={f.from_user} onChange={e => set('from_user', e.target.value)} description="Identidad en el From (si el operador lo exige)" />
              <TextInput label="From domain" leftSection={<IconWorld size={15} />} placeholder="(host del proveedor)" value={f.from_domain} onChange={e => set('from_domain', e.target.value)} />
            </Group>

            <Divider label="Medios y códecs" labelPosition="left" />
            <MultiSelect label="Códecs permitidos (en orden de prioridad)" data={CODECS} value={f.codecs} onChange={v => set('codecs', v)} leftSection={<IconWaveSine size={15} />} clearable={false} />
            <Group grow>
              <Select label="DTMF" value={f.dtmf_mode} onChange={v => set('dtmf_mode', v)} data={[{ value: 'rfc4733', label: 'RFC 4733 (recomendado)' }, { value: 'inband', label: 'Inband' }, { value: 'info', label: 'SIP INFO' }, { value: 'auto', label: 'Auto' }]} leftSection={<IconBroadcast size={15} />} />
              <NumberInput label="Qualify (s)" value={f.qualify_frequency} onChange={v => set('qualify_frequency', v)} min={0} max={300} description="Keepalive al proveedor" />
            </Group>
            <Group gap="xl">
              <Switch label="Detrás de NAT (symmetric RTP)" checked={f.nat} onChange={e => set('nat', e.currentTarget.checked)} />
              <Switch label="Direct media (RTP directo)" checked={f.direct_media} onChange={e => set('direct_media', e.currentTarget.checked)} />
            </Group>

            <Divider label="Avanzado" labelPosition="left" />
            <Group grow>
              <TextInput label="Contexto entrante" value={f.context} onChange={e => set('context', e.target.value)} description="Dónde caen las llamadas entrantes" />
              {f.mode === 'register' && <NumberInput label="Expiración registro (s)" value={f.expiration} onChange={v => set('expiration', v)} min={60} max={7200} />}
            </Group>
            <div>
              <Switch label="Crear ruta de salida automática" checked={f.outbound_enabled} onChange={e => set('outbound_enabled', e.currentTarget.checked)} />
              {f.outbound_enabled && <Group grow mt="xs">
                <TextInput label="Prefijo de salida" value={f.outbound_prefix} onChange={e => set('outbound_prefix', e.target.value)} placeholder="0" description="Discar prefijo + número (vacío = cualquier número)" />
                <NumberInput label="Quitar dígitos" value={f.outbound_strip} onChange={v => set('outbound_strip', v)} min={0} max={10} description="Cuántos dígitos quitar antes de enviar" />
              </Group>}
            </div>
          </>}
          {!isAst && <Text size="xs" c="dimmed">La troncal se gestiona en el borde SBC-NG (registro/seguridad en el SBC). Los parámetros de códec/NAT se administran desde la consola del SBC.</Text>}

          <Button onClick={create} loading={saving} mt="xs" size="md" color="teal">{editing ? 'Guardar cambios' : 'Crear troncal'}</Button>
        </Stack>
      </Modal>
    </div>
  );
}
