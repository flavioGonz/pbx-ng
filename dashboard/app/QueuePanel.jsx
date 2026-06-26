'use client';
import { useState } from 'react';
import { Card, Group, Button, Modal, TextInput, Select, Stack, Badge, Text, ActionIcon, Pill, PillsInput } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useLive } from './useLive';
import { toast } from './notify';
const STRAT = [['ringall', 'Todos a la vez'], ['leastrecent', 'Menos reciente'], ['fewestcalls', 'Menos llamadas'], ['rrmemory', 'Round-robin'], ['random', 'Aleatoria']];
export default function QueuePanel() {
  const { snap } = useLive(); const list = snap?.queues || [];
  const [opened, { open, close }] = useDisclosure(false);
  const [f, setF] = useState({ strategy: 'ringall' }); const [newAgent, setNewAgent] = useState({});
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  async function create() {
    const r = await fetch('/backend/api/queues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) }).then(x => x.json());
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast('Cola ' + r.created + ' creada', 'ok'); setF({ strategy: 'ringall' }); close(); }
  }
  async function delQ(name) { if (!confirm('¿Eliminar la cola ' + name + '?')) return; await fetch('/backend/api/queues/' + name, { method: 'DELETE' }); toast('Cola eliminada', 'info'); }
  async function addAgent(name) { const ext = (newAgent[name] || '').trim(); if (!ext) return; await fetch('/backend/api/queues/' + name + '/members', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext }) }); toast('Agente ' + ext + ' agregado', 'ok'); setNewAgent(s => ({ ...s, [name]: '' })); }
  async function rmAgent(name, ext) { await fetch('/backend/api/queues/' + name + '/members/' + ext, { method: 'DELETE' }); toast('Agente quitado', 'info'); }
  return (
    <Stack>
      <Group justify="flex-end"><Button leftSection={<IconPlus size={16} />} onClick={open}>Nueva cola</Button></Group>
      {list.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin colas.</Text> :
        list.map(q => (
          <Card key={q.name} withBorder radius="lg" padding="lg" shadow="sm">
            <Group justify="space-between" mb="sm">
              <div><Group gap="xs"><Text fw={650}>{q.label || q.name}</Text>
                <Badge variant="light" color={q.agents_online > 0 ? 'teal' : 'gray'}>{q.agents_online}/{q.agents_total} agentes</Badge></Group>
                <Text size="xs" c="dimmed">Acceso {q.access_exten} · {q.strategy} · timeout {q.timeout}s</Text></div>
              <ActionIcon variant="subtle" color="red" onClick={() => delQ(q.name)}><IconTrash size={17} /></ActionIcon>
            </Group>
            <Group gap="xs" mb="sm">{(q.members || []).length === 0 ? <Text size="sm" c="dimmed">Sin agentes</Text> :
              q.members.map(m => <Pill key={m.ext} withRemoveButton onRemove={() => rmAgent(q.name, m.ext)}>
                <Badge size="xs" variant="dot" color={m.status === 'online' ? 'teal' : 'gray'} style={{ border: 0, background: 'transparent', padding: 0 }}>{m.ext}</Badge></Pill>)}</Group>
            <Group gap="xs"><TextInput placeholder="Interno (ej 1002)" size="xs" value={newAgent[q.name] || ''} onChange={e => setNewAgent(s => ({ ...s, [q.name]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') addAgent(q.name); }} />
              <Button size="xs" variant="light" onClick={() => addAgent(q.name)}>Agregar agente</Button></Group>
          </Card>
        ))}
      <Modal opened={opened} onClose={close} title="Nueva cola" centered radius="lg">
        <Stack>
          <TextInput label="Nombre (interno)" placeholder="ventas" value={f.name || ''} onChange={e => up('name', e.target.value)} required />
          <TextInput label="Etiqueta" placeholder="Ventas" value={f.label || ''} onChange={e => up('label', e.target.value)} />
          <TextInput label="Número de acceso" placeholder="8001" value={f.access_exten || ''} onChange={e => up('access_exten', e.target.value)} required />
          <Select label="Estrategia" value={f.strategy} onChange={v => up('strategy', v)} data={STRAT.map(([v, l]) => ({ value: v, label: l }))} />
          <Button onClick={create} mt="xs">Crear cola</Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
