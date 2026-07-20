'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { ReactFlow, Background, Handle, Position, MarkerType, useNodesState, useEdgesState, addEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Modal, Stack, Group, Button, TextInput, NumberInput, Select, ActionIcon, Text, Badge, FileButton, Tooltip, Divider, Box, Textarea, Paper } from '@mantine/core';
import { IconPlus, IconTrash, IconDeviceFloppy, IconPlayerPlay, IconUpload, IconPhoneCall, IconList, IconMail, IconUsersGroup, IconArrowsSplit, IconHandStop, IconRobot, IconArrowLeft, IconVolume } from '@tabler/icons-react';
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
    <div style={{ width: 262, background: 'linear-gradient(135deg,#0f2a4a,#1e5aa8)', color: '#fff', borderRadius: 18, padding: 16, boxShadow: '0 14px 34px rgba(15,42,74,.40)', border: '1px solid rgba(255,255,255,.18)' }}>
      <Group gap={8} mb={8}><div style={{ width: 30, height: 30, borderRadius: 9, background: 'rgba(255,255,255,.16)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IconArrowsSplit size={17} /></div><div><Text fw={800} fz="sm" lh={1}>Menú de voz</Text><Text fz={10} c="rgba(255,255,255,.6)">punto de entrada</Text></div></Group>
      <div style={{ background: 'rgba(255,255,255,.10)', borderRadius: 10, padding: '8px 10px', marginBottom: 8 }}>
        <Text fz={10} c="rgba(255,255,255,.6)">Número de acceso</Text>
        <Text ff="monospace" fw={800} fz="xl" lh={1.1}>{data.exten || '—'}</Text>
      </div>
      <Group gap={6} wrap="nowrap">
        <Badge size="sm" variant="white" color="dark" leftSection={<IconPlayerPlay size={10} />} style={{ maxWidth: 160, textTransform: 'none' }}>{data.greeting || 'sin audio'}</Badge>
        <Badge size="sm" variant="light" color="gray" style={{ background: 'rgba(255,255,255,.16)', color: '#fff' }}>{data.timeout}s</Badge>
      </Group>
      <Handle type="source" position={Position.Right} style={{ background: '#38bdf8', width: 12, height: 12, border: '2px solid #fff' }} />
    </div>
  );
}
function OptionNode({ data, selected }) {
  const d = DEST[data.dest_type] || DEST.extension; const Icon = d.icon;
  return (
    <div style={{ width: 214, background: '#fff', borderRadius: 15, padding: 13, boxShadow: selected ? `0 0 0 3px ${d.color}, 0 12px 28px rgba(15,42,74,.18)` : '0 10px 24px rgba(15,42,74,.12)', border: `2px solid ${d.color}44`, transition: 'box-shadow .15s' }}>
      <Handle type="target" position={Position.Left} style={{ background: d.color, width: 12, height: 12, border: '2px solid #fff' }} />
      <Group justify="space-between" mb={7} wrap="nowrap">
        <Badge size="lg" radius="md" variant="filled" color="dark" ff="monospace" style={{ fontSize: 15 }}>{data.digit || '?'}</Badge>
        <Group gap={5} wrap="nowrap"><div style={{ width: 24, height: 24, borderRadius: 7, background: d.color + '18', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={14} color={d.color} /></div><Text fz={11} c="dimmed">{d.label}</Text></Group>
      </Group>
      <Text ff="monospace" fw={700} fz="sm" c={data.dest_type === 'hangup' ? 'dimmed' : undefined}>{data.dest_type === 'hangup' ? 'fin de llamada' : (data.dest_value || '—')}</Text>
    </div>
  );
}
const nodeTypes = { entry: EntryNode, option: OptionNode };
let _id = 1; const nid = () => 'o' + (_id++);

export default function IvrDesigner({ ivr, prompts: promptsProp, onClose, onSaved, embedded = false }) {
  const [name, setName] = useState(ivr?.name || '');
  const [exten, setExten] = useState(ivr?.exten || '');
  const [greeting, setGreeting] = useState(ivr?.greeting || 'demo-congrats');
  const [ivrAudios, setIvrAudios] = useState([]);
  const [genOpen, setGenOpen] = useState(false); const [genText, setGenText] = useState(''); const [genName, setGenName] = useState(''); const [genVoice, setGenVoice] = useState(''); const [genVoices, setGenVoices] = useState([]); const [genBusy, setGenBusy] = useState(false);
  useEffect(() => { fetch('/backend/api/ivr/audios').then(r => r.json()).then(d => Array.isArray(d) && setIvrAudios(d)).catch(() => {}); fetch('/backend/api/voz').then(r => r.json()).then(d => { setGenVoices(d.voices || []); if (d.default_voice) setGenVoice(d.default_voice); }).catch(() => {}); }, []);
  async function previewGen() { try { const r = await fetch('/backend/api/voz/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: genText, voice: genVoice }) }); const b = await r.blob(); if (audioRef.current) { audioRef.current.src = URL.createObjectURL(b); audioRef.current.play().catch(() => {}); } } catch (_) {} }
  async function genAudio() { if (!genText.trim()) return; setGenBusy(true); const r = await fetch('/backend/api/ivr/gen-audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: genText, voice: genVoice || undefined, name: genName || undefined }) }).then(x => x.json()).catch(() => ({ error: 1 })); setGenBusy(false); if (r.error) { toast('Error generando audio: ' + r.error, 'bad'); return; } toast('Audio generado y desplegado a Asterisk', 'ok'); setGreeting(r.ref); setGenOpen(false); fetch('/backend/api/ivr/audios').then(x => x.json()).then(d => Array.isArray(d) && setIvrAudios(d)).catch(() => {}); }
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
      const en = { id: 'entry', type: 'entry', position: { x: 60, y: 200 }, data: {}, draggable: true };
      const ons = opts.map((o, i) => ({ id: nid(), type: 'option', position: { x: 420, y: 60 + i * 130 }, data: { ...o }, draggable: true }));
      setNodes([en, ...ons]);
      setEdges(ons.map(n => ({ id: 'e' + n.id, source: 'entry', target: n.id, animated: true, markerEnd: { type: MarkerType.ArrowClosed }, label: n.data.digit, style: { stroke: '#16467a', strokeWidth: 2 } })));
    }
  }, [ivr]);

  useEffect(() => { setNodes(ns => ns.map(n => n.id === 'entry' ? { ...n, data: { exten, greeting, timeout } } : n)); }, [exten, greeting, timeout]);

  const onConnect = useCallback((p) => setEdges(e => addEdge({ ...p, animated: true, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#16467a', strokeWidth: 2 } }, e)), []);

  function addOption() {
    const id = nid(); const y = 60 + (nodes.filter(n => n.type === 'option').length) * 130;
    const data = { digit: String(nodes.filter(n => n.type === 'option').length + 1), dest_type: 'extension', dest_value: '' };
    setNodes(ns => [...ns, { id, type: 'option', position: { x: 420, y }, data, draggable: true }]);
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

  async function playGreeting() {
    const p = prompts.find(x => x.name === greeting);
    if (p) { if (audioRef.current) { audioRef.current.src = '/backend/api/prompts/' + p.id + '/audio'; audioRef.current.play().catch(() => {}); } return; }
    const a = ivrAudios.find(x => x.ref === greeting);
    if (a) { try { const r = await fetch('/backend/api/voz/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: a.text, voice: a.voice }) }); const b = await r.blob(); if (audioRef.current) { audioRef.current.src = URL.createObjectURL(b); audioRef.current.play().catch(() => {}); } } catch (_) {} return; }
    toast('Audio de sistema: se escucha en la llamada (sin preview acá)', 'info');
  }
  async function uploadAudio(file) {
    if (!file) return;
    const buf = await file.arrayBuffer(); const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const nm = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const fmt = (file.name.split('.').pop() || 'wav').toLowerCase();
    const r = await fetch('/backend/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm, format: fmt, data: b64 }) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    if (r.error) toast('Error subiendo audio: ' + r.error, 'bad'); else { toast('Audio "' + nm + '" cargado', 'ok'); setGreeting(nm); fetch('/backend/api/prompts').then(r => r.json()).then(d => setPrompts(Array.isArray(d) ? d : [])).catch(() => {}); }
  }

  const promptData = [...new Set([greeting, ...prompts.map(p => p.name), ...ivrAudios.map(a => a.ref), 'demo-congrats', 'vm-goodbye', 'hello-world'])].filter(Boolean).map(n => ({ value: n, label: n }));
  const glass = { background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(12px)', border: '1px solid rgba(15,23,42,.08)', boxShadow: '0 12px 34px rgba(15,42,74,.14)' };

  const inner = (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: 'radial-gradient(900px 480px at 72% -12%, rgba(47,116,230,.06), transparent), #eef2f7' }}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        onNodeClick={(_, n) => n.type === 'option' && setSel(n.id)} onPaneClick={() => setSel(null)} fitView fitViewOptions={{ padding: 0.22 }} proOptions={{ hideAttribution: true }} defaultEdgeOptions={{ animated: true }} minZoom={0.3} maxZoom={1.7}>
        <Background color="#cbd5e1" gap={24} size={1.4} />
      </ReactFlow>

      {/* barra superior flotante */}
      <Paper style={{ position: 'absolute', top: 14, left: 14, right: 14, padding: '8px 12px', borderRadius: 14, zIndex: 6, ...glass }}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Badge size="lg" variant="gradient" gradient={{ from: '#0f2a4a', to: '#1e5aa8' }} leftSection={<IconArrowsSplit size={14} />}>Diseñador IVR</Badge>
            <TextInput placeholder="Nombre del IVR" value={name} onChange={e => setName(e.target.value)} w={190} size="sm" />
            <TextInput placeholder="Acceso (700)" value={exten} onChange={e => setExten(e.target.value)} w={120} ff="monospace" size="sm" />
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={onClose} size="sm">{embedded ? 'Volver' : 'Cancelar'}</Button>
            <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save} size="sm">Guardar</Button>
          </Group>
        </Group>
      </Paper>

      {/* panel saludo + menú (izquierda) */}
      <Paper style={{ position: 'absolute', top: 74, left: 14, width: 296, padding: 14, borderRadius: 16, zIndex: 5, ...glass }}>
        <Group gap={8} mb="sm"><div style={{ width: 26, height: 26, borderRadius: 8, background: 'rgba(29,78,216,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IconVolume size={15} color="#1d4ed8" /></div><Text fw={700} fz="sm">Saludo y menú</Text></Group>
        <Stack gap="sm">
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <Select label="Audio de saludo" data={promptData} value={greeting} onChange={setGreeting} searchable style={{ flex: 1 }} size="sm" />
            <Tooltip label="Reproducir"><ActionIcon variant="light" size="lg" onClick={playGreeting}><IconPlayerPlay size={16} /></ActionIcon></Tooltip>
            <Tooltip label="Generar con voz IA (TTS)"><ActionIcon variant="light" color="grape" size="lg" onClick={() => setGenOpen(true)}><IconRobot size={16} /></ActionIcon></Tooltip>
          </Group>
          <FileButton onChange={uploadAudio} accept="audio/*">{(props) => <Button {...props} variant="light" leftSection={<IconUpload size={15} />} size="xs">Subir audio nuevo</Button>}</FileButton>
          <NumberInput label="Espera de dígito (s)" value={timeout} onChange={setTimeoutV} min={1} max={30} size="sm" />
        </Stack>
      </Paper>

      {/* editor de la opción seleccionada (derecha) */}
      {selNode && (
        <Paper style={{ position: 'absolute', top: 74, right: 14, width: 296, padding: 14, borderRadius: 16, zIndex: 5, ...glass }}>
          <Group justify="space-between" mb="xs"><Group gap={8}><Badge size="lg" radius="md" variant="filled" color="dark" ff="monospace">{selNode.data.digit || '?'}</Badge><Text fw={700} fz="sm">Opción</Text></Group><ActionIcon variant="subtle" color="red" onClick={delSel}><IconTrash size={17} /></ActionIcon></Group>
          <Stack gap="sm">
            <TextInput label="Dígito marcado" value={selNode.data.digit} onChange={e => updSel('digit', e.target.value)} placeholder="1" ff="monospace" size="sm" />
            <Select label="Destino" value={selNode.data.dest_type} onChange={v => updSel('dest_type', v)} data={Object.entries(DEST).map(([v, d]) => ({ value: v, label: d.label }))} size="sm" />
            {selNode.data.dest_type !== 'hangup' &&
              <TextInput label={selNode.data.dest_type === 'extension' ? 'Interno' : selNode.data.dest_type === 'queue' ? 'Cola' : selNode.data.dest_type === 'voicemail' ? 'Buzón' : selNode.data.dest_type === 'ivr' ? 'Acceso del IVR' : selNode.data.dest_type === 'ai' ? 'Acceso del agente IA' : 'Número de acceso'}
                value={selNode.data.dest_value} onChange={e => updSel('dest_value', e.target.value)} placeholder="1001" ff="monospace" size="sm" />}
          </Stack>
        </Paper>
      )}

      {/* FAB añadir opción */}
      <Button pos="absolute" style={{ bottom: 20, left: 20, zIndex: 6, boxShadow: '0 10px 26px rgba(15,42,74,.30)' }} leftSection={<IconPlus size={16} />} onClick={addOption} radius="xl" size="md">Añadir opción</Button>

      <Modal opened={genOpen} onClose={() => setGenOpen(false)} title="Generar audio del saludo con IA (TTS)" centered radius="lg" zIndex={3000}>
        <Stack gap="sm">
          <Textarea label="Texto del saludo" placeholder="Bienvenido a la empresa. Marque 1 para ventas, 2 para soporte." autosize minRows={3} value={genText} onChange={(e) => setGenText(e.currentTarget.value)} />
          <Group grow><Select label="Voz" data={genVoices.map((v) => ({ value: v, label: v }))} value={genVoice} onChange={setGenVoice} searchable /><TextInput label="Nombre (opcional)" placeholder="saludo-principal" value={genName} onChange={(e) => setGenName(e.target.value)} /></Group>
          <Group justify="space-between"><Button variant="default" leftSection={<IconPlayerPlay size={15} />} onClick={previewGen} disabled={!genText.trim()}>Previsualizar</Button><Button color="grape" loading={genBusy} leftSection={<IconDeviceFloppy size={15} />} onClick={genAudio} disabled={!genText.trim()}>Generar y usar</Button></Group>
          <Text size="xs" c="dimmed">Se sintetiza con el contenedor de Voz y se despliega a Asterisk como audio del IVR.</Text>
        </Stack>
      </Modal>
      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  );

  if (embedded) return (
    <Box style={{ height: 'calc(100vh - 130px)', minHeight: 480, borderRadius: 16, overflow: 'hidden' }}>{inner}</Box>
  );
  return (
    <Modal opened onClose={onClose} fullScreen radius={0} padding={0} withCloseButton={false} styles={{ body: { height: '100vh', padding: 0 } }}>{inner}</Modal>
  );
}
