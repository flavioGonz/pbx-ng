'use client';
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, Button, Table, Badge, ActionIcon, Modal, TextInput, Textarea, Select, Switch, ThemeIcon, SimpleGrid, Divider, PasswordInput, Alert, Tooltip } from '@mantine/core';
import { IconRobot, IconPlus, IconEdit, IconTrash, IconHash, IconBolt, IconKey, IconDeviceFloppy, IconPhoneCall, IconHeadset, IconUsers, IconInfoCircle, IconMicrophone2, IconBrain } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

const PROVIDERS = [{ value: 'demo', label: 'Demo (offline · Vosk + espeak)' }, { value: 'openai', label: 'OpenAI (Whisper + GPT + TTS)' }];
const MODELS = [{ value: 'gpt-4o-mini', label: 'gpt-4o-mini (rápido/económico)' }, { value: 'gpt-4o', label: 'gpt-4o (máxima calidad)' }];
const VOICES = [{ value: 'es-419', label: 'Español latino (demo)' }, { value: 'nova', label: 'Nova (OpenAI)' }, { value: 'alloy', label: 'Alloy (OpenAI)' }, { value: 'shimmer', label: 'Shimmer (OpenAI)' }, { value: 'onyx', label: 'Onyx (OpenAI)' }];
const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
const empty = { name: '', exten: '', provider: 'demo', model: 'gpt-4o-mini', voice: 'es-419', greeting_text: '', system_prompt: '', sales_exten: '', support_exten: '', default_exten: '', crm_webhook: '', enabled: true };

export default function AiAgents() {
  const [list, setList] = useState([]); const [opened, setOpened] = useState(false); const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false);
  const [keySet, setKeySet] = useState(false); const [keyVal, setKeyVal] = useState(''); const [keySaving, setKeySaving] = useState(false);
  async function load() { try { setList(await fetch('/backend/api/ai-agents').then(r => r.json())); } catch (_) {} }
  async function loadKey() { try { const s = await fetch('/backend/api/settings').then(r => r.json()); setKeySet(s.openai_api_key === '__SET__'); } catch (_) {} }
  useEffect(() => { load(); loadKey(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
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
            <Select label="Voz" data={VOICES} value={form.voice} onChange={v => up('voice', v)} />
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
          <Divider />
          <Group justify="flex-end"><Button variant="default" onClick={() => setOpened(false)}>Cancelar</Button><Button onClick={save} loading={saving} leftSection={<IconDeviceFloppy size={16} />}>{form.id ? 'Guardar' : 'Crear agente'}</Button></Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
