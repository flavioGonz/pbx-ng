'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, useNodesState, useEdgesState, addEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Modal, Stack, Group, Button, TextInput, NumberInput, Select, ActionIcon, Text, Badge, FileButton, Tooltip, Divider, Box } from '@mantine/core';
import { IconPlus, IconTrash, IconDeviceFloppy, IconPlayerPlay, IconUpload, IconPhoneCall, IconList, IconMail, IconUsersGroup, IconArrowsSplit, IconHandStop, IconRobot, IconArrowLeft } from '@tabler/icons-react';
import { toast } from './notify';

const DEST = {
  extension: { label: 'Interno', color: '#0ea5e9', icon: IconPhoneCall },
  ringgroup: { label: 'Ring Group', color: '#8b5cf6', icon: IconUsersGroup },
  queue: { label: 'Cola', color: '#f59e0b', icon: IconList },
  voicemail: { label: 'Buzon', color: '#6366f1', icon: IconMail },
  ivr: { label: 'Otro IVR', color: '#14b8a6', icon: IconList },
  ai: { label: 'Agente IA', color: '#ec4899', icon: IconRobot },
  hangup: { label: 'Colgar', color: '#94a3b8', icon: IconHandStop },
};

function EntryNode({ data }) {
  return (
    <div style={{ width: 256, background: 'linear-gradient(135deg,#0f2a4a,#16467a)', color: '#fff', borderRadius: 16, padding: 14, boxShadow: '0 8px 24px rgba(15,42,74,.35)', border: '1px solid rgba(255,255,255,.15)' }}>
      <Group gap={8} mb={6}><IconArrowsSplit size={18} /><Text fw={700} fz="sm">Menu de voz</Text></Group>
      <Text fz={11} c="rgba(255,255,255,.7)">Acceso</Text>
      <Text ff="monospace" fw={700} fz="lg" mb={6}>{data.exten || '-'}</Text>
      <Group gap={6} wrap="nowrap">
        <Badge size="xs" variant="white" color="dark" leftSection={<IconPlayerPlay size={10} />} style={{ maxWidth: 150 }}>{data.greeting || 'sin audio'}</Badge>
        <Badge size="xs" variant="light" color="gray">{data.timeout}s</Badge>
      </Group>
      <Handle type="source" position={Position.Right} style={{ background: '#38bdf8', width: 10, height: 10 }} />
    </div>
  );
}
function OptionNode({ data }) {
  const d = DEST[data.dest_type] || DEST.extension; const Icon = d.icon;
  return (
    <div style={{ width: 210, background: 'rgba(26,34,48,.95)', borderRadius: 14, padding: 12, boxShadow: '0 8px 22px rgba(0,0,0,.45)', border: `2px solid ${d.color}55` }}>
      <Handle type="target" position={Position.Left} style={{ background: d.color, width: 10, height: 10 }} />
      <Group justify="space-between" mb={6}>
        <Badge size="lg" radius="md" variant="filled" color="dark" ff="monospace">{data.digit || '?'}</Badge>
        <Group gap={4}><Icon size={15} color={d.color} /><Text fz={11} c="dimmed">{d.label}</Text></Group>
      </Group>
      <Text ff="monospace" fw={600} fz="sm" c={data.dest_type === 'hangup' ? 'dimmed' : undefined}>{data.dest_type === 'hangup' ? 'fin de llamada' : (data.dest_value || '-')}</Text>
    </div>
  );
}
const nodeTypes = { entry: EntryNode, option: OptionNode };
let _id = 1; const nid = () => 'o' + (_id++);

export default function IvrDesigner({ ivr, prompts: promptsProp, onClose, onSaved, embedded = false }) {
  const [name, setName] = useState(ivr?.name || '');
  const [exten, setExten] = useState(ivr?.exten || '');
  const [greeting, setGreeting] = useState(ivr?.greeting || 'demo-congrats');
  const [timeout, setTimeoutV] = useState(ivr?.timeout || 8);
  const [prompts, setPrompts] = useState(promptsProp || []);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [sel, setSel] = useState(null);
  const audioRef = useRef(null);

  useEffect(() => { if (!promptsProp) fetch('/backend/api/prompts').then(r => r.json()).then(d => setPrompts(Array.isArray(d) ? d : [])).catch(() => {}); }, [promptsProp]);

  useEffect(() => {
    if (ivr?.flow?.nodes?.length) {
      setNodes(ivr.flow.nodes); setEdges(ivr.flow.edges || []);
      const mx = Math.max(0, ...ivr.flow.nodes.filter(n => n.id[0] === 'o').map(n => +n.id.slice(1) || 0)); _id = mx + 1;
    } else {
      const opts = ivr?.options || [];
      const en = { id: 'entry', type: 'entry', position: { x: 40, y: 180 }, data: {}, draggable: true };
      const ons = opts.map((o, i) => ({ id: nid(), type: 'option', position: { x: 360, y: 40 + i * 130 }, data: { ...o }, draggable: true }));
      setNodes([en, ...ons]);
      setEdges(ons.map(n => ({ id: 'e' + n.id, source: 'entry', target: n.id, animated: true, markerEnd: { type: MarkerType.ArrowClosed }, label: n.data.digit, style: { stroke: '#16467a', strokeWidth: 2 } })));
    }
  }, [ivr]);

  useEffect(() => { setNodes(ns => ns.map(n => n.id === 'entry' ? { ...n, data: { exten, greeting, timeout } } : n)); }, [exten, greeting, timeout]);

  const onConnect = useCallback((p) => setEdges(e => addEdge({ ...p, animated: true, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#16467a', strokeWidth: 2 } }, e)), []);

  function addOption() {
    const id = nid(); const y = 40 + (nodes.filter(n => n.type === 'option').length) * 130;
    const data = { digit: String(nodes.filter(n => n.type === 'option').length + 1), dest_type: 'extension', dest_value: '' };
    setNodes(ns => [...ns, { id, type: 'option', position: { x: 360, y }, data, draggable: true }]);
    setEdges(es => [...es, { id: 'e' + id, source: 'entry', target: id, animated: true, markerEnd: { type: MarkerType.ArrowClosed }, label: data.digit, style: { stroke: '#16467a', strokeWidth: 2 } }]);
    setSel(id);
  }
  function updSel(k, v) {
    setNodes(ns => ns.map(n => n.id === sel ? { ...n, data: { ...n.data, [k]: v } } : n));
    if (k === 'digit') setEdges(es => es.map(e => e.target === sel ? { ...e, label: v } : e));
  }
  function delSel() { setNodes(ns => ns.filter(n => n.id !== sel)); setEdges(es => es.filter(e => e.target !== sel && e.source !== sel)); setSel(null); }
  const selNode = nodes.find(n => n.id === sel);

  async function save() {
    if (!name || !exten) { toast('Nombre y numero de acceso son obligatorios', 'bad'); return; }
    const options = nodes.filter(n => n.type === 'option' && n.data.digit !== '').map(n => ({ digit: n.data.digit, dest_type: n.data.dest_type, dest_value: n.data.dest_value || '' }));
    const flow = { nodes, edges };
    const body = JSON.stringify({ name, exten, greeting, timeout, options, flow });
    const url = ivr?.id ? '/backend/api/ivr/' + ivr.id : '/backend/api/ivr';
    const method = ivr?.id ? 'PUT' : 'POST';
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body }).then(x => x.json()).catch(() => ({ error: 'red' }));
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast(ivr?.id ? 'IVR actualizado' : 'IVR creado (acceso ' + exten + ')', 'ok'); onSaved && onSaved(); onClose && onClose(); }
  }

  function playGreeting() {
    const p = prompts.find(x => x.name === greeting);
    if (!p) { toast('Ese audio no esta en la biblioteca (audio de sistema)', 'info'); return; }
    if (audioRef.current) { audioRef.current.src = '/backend/api/prompts/' + p.id + '/audio'; audioRef.current.play().catch(() => {}); }
  }
  async function uploadAudio(file) {
    if (!file) return;
    const buf = await file.arrayBuffer(); const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const nm = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const fmt = (file.name.split('.').pop() || 'wav').toLowerCase();
    const r = await fetch('/backend/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm, format: fmt, data: b64 }) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    if (r.error) toast('Error subiendo audio: ' + r.error, 'bad'); else { toast('Audio "' + nm + '" cargado', 'ok'); setGreeting(nm); fetch('/backend/api/prompts').then(r => r.json()).then(d => setPrompts(Array.isArray(d) ? d : [])).catch(() => {}); }
  }

  const promptData = [...new Set([greeting, ...prompts.map(p => p.name), 'demo-congrats', 'vm-goodbye', 'hello-world'])].filter(Boolean).map(n => ({ value: n, label: n }));

  const inner = (
    <Stack gap={0} style={{ height: '100%' }}>
      <Group justify="space-between" px="lg" py="sm" style={{ borderBottom: '1px solid rgba(120,130,150,.14)', background: 'rgba(18,24,34,.92)', borderTopLeftRadius: embedded ? 16 : 0, borderTopRightRadius: embedded ? 16 : 0 }}>
        <Group gap="sm">
          <Badge size="lg" variant="gradient" gradient={{ from: '#0f2a4a', to: '#16467a' }} leftSection={<IconArrowsSplit size={14} />}>Disenador IVR</Badge>
          <TextInput placeholder="Nombre del IVR" value={name} onChange={e => setName(e.target.value)} w={200} />
          <TextInput placeholder="Acceso (ej 700)" value={exten} onChange={e => setExten(e.target.value)} w={130} ff="monospace" />
        </Group>
        <Group gap="sm">
          <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={onClose}>{embedded ? 'Volver' : 'Cancelar'}</Button>
          <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save}>Guardar</Button>
        </Group>
      </Group>
      <Group gap={0} style={{ flex: 1, minHeight: 0 }} align="stretch" wrap="nowrap">
        <Box style={{ flex: 1, minWidth: 0, position: 'relative', background: 'radial-gradient(700px 360px at 70% -10%, rgba(47,116,230,.10), transparent), #0d1117' }}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => n.type === 'option' && setSel(n.id)} fitView proOptions={{ hideAttribution: true }} defaultEdgeOptions={{ animated: true }}>
            <Background color="#243042" gap={22} />
            <Controls showInteractive={false} />
          </ReactFlow>
          <Button pos="absolute" bottom={18} left={18} leftSection={<IconPlus size={16} />} onClick={addOption} radius="xl" style={{ boxShadow: '0 6px 18px rgba(15,42,74,.25)' }}>Anadir opcion</Button>
        </Box>
        <Box w={320} p="lg" style={{ borderLeft: '1px solid rgba(120,130,150,.14)', background: 'rgba(18,24,34,.92)', overflowY: 'auto' }}>
          <Text fw={700} mb="xs">Saludo y menu</Text>
          <Stack gap="sm">
            <Group gap="xs" align="flex-end">
              <Select label="Audio de saludo" data={promptData} value={greeting} onChange={setGreeting} searchable style={{ flex: 1 }} />
              <Tooltip label="Reproducir"><ActionIcon variant="light" size="lg" onClick={playGreeting}><IconPlayerPlay size={16} /></ActionIcon></Tooltip>
            </Group>
            <FileButton onChange={uploadAudio} accept="audio/*">{(props) => <Button {...props} variant="light" leftSection={<IconUpload size={15} />} size="xs">Subir audio nuevo</Button>}</FileButton>
            <NumberInput label="Espera de digito (s)" value={timeout} onChange={setTimeoutV} min={1} max={30} />
          </Stack>
          <Divider my="md" />
          {selNode ? (
            <>
              <Group justify="space-between" mb="xs"><Text fw={700}>Opcion seleccionada</Text><ActionIcon variant="subtle" color="red" onClick={delSel}><IconTrash size={17} /></ActionIcon></Group>
              <Stack gap="sm">
                <TextInput label="Digito" value={selNode.data.digit} onChange={e => updSel('digit', e.target.value)} placeholder="1" ff="monospace" />
                <Select label="Destino" value={selNode.data.dest_type} onChange={v => updSel('dest_type', v)} data={Object.entries(DEST).map(([v, d]) => ({ value: v, label: d.label }))} />
                {selNode.data.dest_type !== 'hangup' &&
                  <TextInput label={selNode.data.dest_type === 'extension' ? 'Interno' : selNode.data.dest_type === 'queue' ? 'Cola' : selNode.data.dest_type === 'voicemail' ? 'Buzon' : selNode.data.dest_type === 'ivr' ? 'Acceso del IVR' : selNode.data.dest_type === 'ai' ? 'Acceso del agente IA' : 'Numero de acceso'}
                    value={selNode.data.dest_value} onChange={e => updSel('dest_value', e.target.value)} placeholder="1001" ff="monospace" />}
              </Stack>
            </>
          ) : <Text c="dimmed" fz="sm" ta="center" py="lg">Hace clic en una opcion del lienzo para editarla, o "Anadir opcion".</Text>}
        </Box>
      </Group>
      <audio ref={audioRef} style={{ display: 'none' }} />
    </Stack>
  );

  if (embedded) return (
    <Box style={{ height: 'calc(100vh - 150px)', minHeight: 460, borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(120,130,150,.16)' }}>{inner}</Box>
  );
  return (
    <Modal opened onClose={onClose} fullScreen radius={0} padding={0} withCloseButton={false} styles={{ body: { height: '100vh', padding: 0 } }}>{inner}</Modal>
  );
}
