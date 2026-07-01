'use client';
import { useEffect, useState, useRef } from 'react';
import { Stack, Card, Group, Text, Button, Table, Badge, ActionIcon, Modal, TextInput, Textarea, Select, Switch, ThemeIcon, SimpleGrid, Divider, PasswordInput, Alert, Tooltip, Progress, Slider } from '@mantine/core';
import { IconRobot, IconPlus, IconEdit, IconTrash, IconHash, IconBolt, IconKey, IconDeviceFloppy, IconPhoneCall, IconHeadset, IconUsers, IconInfoCircle, IconMicrophone2, IconBrain, IconServer2, IconRefresh, IconPlayerPlay } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

const PROVIDERS = [{ value: 'demo', label: 'Demo (offline · Vosk + espeak)' }, { value: 'openai', label: 'OpenAI (Whisper + GPT + TTS)' }];
const MODELS = [{ value: 'gpt-4o-mini', label: 'gpt-4o-mini (rápido/económico)' }, { value: 'gpt-4o', label: 'gpt-4o (máxima calidad)' }];
const OPENAI_VOICES = [{ value: 'nova', label: 'Nova' }, { value: 'alloy', label: 'Alloy' }, { value: 'shimmer', label: 'Shimmer' }, { value: 'onyx', label: 'Onyx' }, { value: 'echo', label: 'Echo' }, { value: 'fable', label: 'Fable' }];
const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
const empty = { name: '', exten: '', provider: 'demo', model: 'gpt-4o-mini', voice: 'es_MX-claude-high', greeting_text: '', system_prompt: '', sales_exten: '', support_exten: '', default_exten: '', crm_webhook: '', enabled: true };

export default function AiAgents() {
  const [list, setList] = useState([]); const [opened, setOpened] = useState(false); const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false);
  const [keySet, setKeySet] = useState(false); const [keyVal, setKeyVal] = useState(''); const [keySaving, setKeySaving] = useState(false);
  const [voz, setVoz] = useState(null); const [vozUrl, setVozUrl] = useState(''); const [vozSpeed, setVozSpeed] = useState('1.0'); const [vozSaving, setVozSaving] = useState(false);
  const [vozList, setVozList] = useState([]); const [edgeList, setEdgeList] = useState([]); const previewRef = useRef(null);
  async function loadVozList() { try { const v = await fetch('/backend/api/voz/voices').then(r => r.json()); setVozList((v.installed || []).map(x => x.key)); setEdgeList(v.edge || []); } catch (_) {} }
  async function preview(voice) { try { const r = await fetch('/backend/api/voz/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: form.greeting_text || 'Hola, esta es la voz del agente.', voice }) }); if (!r.ok) { toast('No se pudo generar el audio', 'bad'); return; } const b = await r.blob(); if (previewRef.current) { previewRef.current.src = URL.createObjectURL(b); previewRef.current.play().catch(() => {}); } } catch (_) {} }
  async function loadVoz() { try { setVoz(await fetch('/backend/api/voz').then(r => r.json())); } catch (_) { setVoz({ ok: false }); } }
  async function saveVoz() { setVozSaving(true); const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voz_url: vozUrl, voz_length_scale: vozSpeed }) }).then(x => x.json()).catch(() => ({ error: 1 })); setVozSaving(false); toast(r.error ? 'Error' : 'Servicio de voz guardado', r.error ? 'bad' : 'ok'); loadVoz(); }
  async function load() { try { setList(await fetch('/backend/api/ai-agents').then(r => r.json())); } catch (_) {} }
  async function loadKey() { try { const s = await fetch('/backend/api/settings').then(r => r.json()); setKeySet(s.openai_api_key === '__SET__'); if (s.voz_url) setVozUrl(s.voz_url); if (s.voz_length_scale) setVozSpeed(s.voz_length_scale); } catch (_) {} }
  useEffect(() => { load(); loadKey(); loadVoz(); loadVozList(); const t = setInterval(() => { load(); loadVoz(); }, 8000); return () => clearInterval(t); }, []);
  const up = (k, v) => setForm(s => ({ ...s, [k]: v }));
  function edit(a) { setForm({ ...empty, ...a }); setOpened(true); }
  function nuevo() { setForm(empty); setOpened(true); }
  async function save() {
    if (!form.name || !form.exten) { toast('Nombre y número de acceso son obligatorios', 'bad'); return; }
    setSaving(true);
    const url = form.id ? '/backend/api/ai-agents/' + form.id : '/backend/api/ai-agents';
    const r = await fetch(url, { method: form.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast(form.id ? 'Agente actualizado' : 'Agente creado (acceso ' + form.exten + ')', 'ok'); setOpened(false); load(); }
  }
  async function del(a) { if (!confirm('¿Eliminar el agente ' + a.name + '?')) return; await fetch('/backend/api/ai-agents/' + a.id, { method: 'DELETE' }); toast('Agente eliminado', 'info'); load(); }
  async function saveKey() {
    setKeySaving(true);
    const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openai_api_key: keyVal }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setKeySaving(false); if (r.error) toast('Error al guardar la clave', 'bad'); else { toast('Clave guardada', 'ok'); setKeyVal(''); loadKey(); }
  }

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconRobot size={24} />} title="Agentes IA" subtitle="IVR conversacional · voz a voz (STT → LLM → TTS)" color="pink"
        right={<Button leftSection={<IconPlus size={16} />} onClick={nuevo}>Nuevo agente</Button>} />

      <Card withBorder radius="lg" padding="lg">
        <Group gap="sm" mb="sm"><ThemeIcon variant="light" color="violet"><IconKey size={18} /></ThemeIcon><Text fw={600}>Proveedor de IA</Text>
          <Badge variant="light" color={keySet ? 'teal' : 'gray'}>{keySet ? 'OpenAI configurado' : 'Modo demo (offline)'}</Badge></Group>
        <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />} mb="md">
          Sin clave, los agentes funcionan en <b>modo demo</b> 100% offline (Vosk para entender, voz sintética local). Cargá tu clave de OpenAI para STT/LLM/TTS de máxima calidad y elegí proveedor «OpenAI» en cada agente.
        </Alert>
        <Group align="flex-end" gap="sm">
          <PasswordInput label="OpenAI API Key" placeholder={keySet ? '•••••••••• (guardada)' : 'sk-...'} value={keyVal} onChange={e => setKeyVal(e.currentTarget.value)} style={{ flex: 1, maxWidth: 460 }} leftSection={<IconKey size={15} />} />
          <Button leftSection={<IconDeviceFloppy size={16} />} loading={keySaving} disabled={!keyVal} onClick={saveKey}>Guardar clave</Button>
        </Group>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Group justify="space-between" mb="sm">
          <Group gap="sm"><ThemeIcon variant="light" color="teal"><IconServer2 size={18} /></ThemeIcon><Text fw={600}>Servicio de Voz IA · Piper + Whisper</Text>
            <Badge variant="light" color={voz?.ok ? 'teal' : 'red'}>{voz?.ok ? 'En línea · ' + voz.latency_ms + 'ms' : 'Sin conexión'}</Badge></Group>
          <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={loadVoz}>Refrescar</Button>
        </Group>
        {voz?.ok ? <>
          <SimpleGrid cols={{ base: 2, sm: 4 }} mb="md">
            <div><Text size="xs" c="dimmed">Whisper (STT)</Text><Text fw={700}>{voz.whisper}</Text></div>
            <div><Text size="xs" c="dimmed">Voz (TTS)</Text><Text fw={700} truncate>{voz.default_voice}</Text></div>
            <div><Text size="xs" c="dimmed">CPU ({voz.metrics?.ncpu} nucleos)</Text><Group gap={6} wrap="nowrap"><Progress value={voz.metrics?.cpu_pct || 0} color={(voz.metrics?.cpu_pct || 0) > 80 ? 'red' : 'teal'} style={{ flex: 1 }} /><Text size="xs" w={36}>{voz.metrics?.cpu_pct}%</Text></Group></div>
            <div><Text size="xs" c="dimmed">Memoria</Text><Group gap={6} wrap="nowrap"><Progress value={voz.metrics?.mem_pct || 0} color="blue" style={{ flex: 1 }} /><Text size="xs" w={70}>{voz.metrics?.mem_used_mb}/{voz.metrics?.mem_total_mb}MB</Text></Group></div>
          </SimpleGrid>
          <Group gap="xs"><Text size="xs" c="dimmed">Voces instaladas:</Text>{(voz.voices || []).map(v => <Badge key={v} variant="light" radius="sm">{v}</Badge>)}</Group>
        </> : <Alert variant="light" color="red">No se pudo contactar el servicio de voz en {vozUrl}.{voz?.error ? ' (' + voz.error + ')' : ''}</Alert>}
        <Divider my="sm" label="Parametros" labelPosition="center" />
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
          <TextInput label="URL del servicio (contenedor pbxng-voz)" value={vozUrl} onChange={e => setVozUrl(e.currentTarget.value)} leftSection={<IconServer2 size={15} />} />
          <div><Text size="sm" fw={500}>Velocidad de habla</Text><Text size="xs" c="dimmed" mb={10}>Menor = mas rapido · 1.0 = normal</Text>
            <Slider min={0.7} max={1.4} step={0.05} value={parseFloat(vozSpeed) || 1.0} onChange={v => setVozSpeed(String(v))} marks={[{ value: 0.8, label: 'rapido' }, { value: 1.0, label: 'normal' }, { value: 1.3, label: 'lento' }]} /></div>
        </SimpleGrid>
        <Group justify="flex-end" mt="xl"><Button leftSection={<IconDeviceFloppy size={16} />} loading={vozSaving} onClick={saveVoz}>Guardar configuracion de voz</Button></Group>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        {list.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin agentes. Creá uno con «Nuevo agente».</Text> :
          <Table.ScrollContainer minWidth={640}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr><Th icon={<IconRobot size={13} />}>Agente</Th><Th icon={<IconHash size={13} />}>Acceso</Th><Th icon={<IconBrain size={13} />}>Proveedor</Th><Th icon={<IconMicrophone2 size={13} />}>Voz</Th><Th icon={<IconBolt size={13} />}>Estado</Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>{list.map(a => (
                <Table.Tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => edit(a)}>
                  <Table.Td fw={600}>{a.name}</Table.Td>
                  <Table.Td ff="monospace">{a.exten}</Table.Td>
                  <Table.Td><Badge variant="light" color={a.provider === 'openai' ? 'teal' : 'grape'}>{a.provider === 'openai' ? 'OpenAI · ' + a.model : 'Demo'}</Badge></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{a.voice}</Text></Table.Td>
                  <Table.Td><Badge variant="dot" color={a.enabled ? 'teal' : 'gray'}>{a.enabled ? 'Activo' : 'Inactivo'}</Badge></Table.Td>
                  <Table.Td ta="right" onClick={e => e.stopPropagation()}><Group gap={4} justify="flex-end"><ActionIcon variant="subtle" onClick={() => edit(a)}><IconEdit size={17} /></ActionIcon><ActionIcon variant="subtle" color="red" onClick={() => del(a)}><IconTrash size={17} /></ActionIcon></Group></Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>}
      </Card>

      <Modal opened={opened} onClose={() => setOpened(false)} size="lg" radius="lg" centered
        title={<Group gap="sm"><ThemeIcon size={38} radius="md" variant="light" color="pink"><IconRobot size={20} /></ThemeIcon><div><Text fw={800} lh={1.1}>{form.id ? 'Editar agente' : 'Nuevo agente IA'}</Text><Text size="xs" c="dimmed">IVR conversacional</Text></div></Group>}>
        <Stack gap="md">
          <SimpleGrid cols={2}>
            <TextInput label="Nombre" description="Identifica al agente. Ej: Recepción" value={form.name} onChange={e => up('name', e.currentTarget.value)} required />
            <TextInput label="Número de acceso" description="Interno que dispara el bot. Ej: 7700" value={form.exten} onChange={e => up('exten', e.currentTarget.value)} ff="monospace" required leftSection={<IconHash size={15} />} />
          </SimpleGrid>
          <SimpleGrid cols={3}>
            <Select label="Proveedor" data={PROVIDERS} value={form.provider} onChange={v => up('provider', v)} />
            <Select label="Modelo (OpenAI)" data={MODELS} value={form.model} onChange={v => up('model', v)} disabled={form.provider !== 'openai'} />
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <Select label="Voz" description={form.provider === 'openai' ? 'Voces de OpenAI' : 'Voces instaladas (gestionalas en Voz IA)'} data={form.provider === 'openai' ? OPENAI_VOICES : [{ group: 'Local · Piper (offline)', items: vozList.map(k => ({ value: k, label: k })) }, { group: 'Latinoamérica · Edge (online)', items: edgeList.map(v => ({ value: v.key, label: v.label })) }]} value={form.voice} onChange={v => up('voice', v)} style={{ flex: 1 }} searchable />
              {form.provider !== 'openai' && <Tooltip label="Escuchar voz"><ActionIcon variant="light" size={36} onClick={() => preview(form.voice)} disabled={!form.voice}><IconPlayerPlay size={16} /></ActionIcon></Tooltip>}
            </Group>
          </SimpleGrid>
          <Textarea label="Saludo inicial" description="Lo que dice el bot al atender. Si lo dejás vacío, usa uno por defecto." value={form.greeting_text} onChange={e => up('greeting_text', e.currentTarget.value)} autosize minRows={2} placeholder="Hola, gracias por llamar a IES. ¿En qué puedo ayudarte?" />
          <Textarea label="Instrucciones (system prompt)" description="Personalidad y reglas del agente. Ej: Sos el asistente de IES, amable y conciso; ofrecé ventas o soporte." value={form.system_prompt} onChange={e => up('system_prompt', e.currentTarget.value)} autosize minRows={3} />
          <Divider label="Transferencias (function-calling)" labelPosition="center" />
          <SimpleGrid cols={3}>
            <TextInput label="Interno Ventas" value={form.sales_exten} onChange={e => up('sales_exten', e.currentTarget.value)} ff="monospace" placeholder="1001" leftSection={<IconPhoneCall size={14} />} />
            <TextInput label="Interno Soporte" value={form.support_exten} onChange={e => up('support_exten', e.currentTarget.value)} ff="monospace" placeholder="1002" leftSection={<IconHeadset size={14} />} />
            <TextInput label="Interno por defecto" value={form.default_exten} onChange={e => up('default_exten', e.currentTarget.value)} ff="monospace" placeholder="1001" leftSection={<IconUsers size={14} />} />
          </SimpleGrid>
          <TextInput label="Webhook CRM (opcional)" description="URL que recibe {query, caller} y devuelve {result}. El bot la usa para consultar datos del cliente." value={form.crm_webhook} onChange={e => up('crm_webhook', e.currentTarget.value)} placeholder="https://tu-crm/api/lookup" />
          <Switch label="Agente activo" checked={form.enabled !== false} onChange={e => up('enabled', e.currentTarget.checked)} />
          <audio ref={previewRef} style={{ display: 'none' }} />
          <Divider />
          <Group justify="flex-end"><Button variant="default" onClick={() => setOpened(false)}>Cancelar</Button><Button onClick={save} loading={saving} leftSection={<IconDeviceFloppy size={16} />}>{form.id ? 'Guardar' : 'Crear agente'}</Button></Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
