'use client';
import { useEffect, useMemo, useState } from 'react';
import { Card, Group, Button, TextInput, Stack, Badge, Text, ActionIcon, Pill, Tooltip } from '@mantine/core';
import { IconPlus, IconTrash, IconEdit, IconMicrophone, IconVolume, IconClockPause } from '@tabler/icons-react';
import { useLive } from './useLive';
import { toast } from './notify';
import { apiDel, apiPost, useApi } from './api';
import QueueEditor from './QueueEditor';

const STRAT = { ringall: 'Timbrar todos', rrmemory: 'Round-robin', leastrecent: 'Menos reciente', fewestcalls: 'Menos llamadas', random: 'Aleatoria', linear: 'Lineal', wrandom: 'Aleatoria ponderada' };

export default function QueuePanel() {
  const { snap } = useLive();
  const live = snap?.queues || [];              // estado en vivo (agentes online, etc.)
  const [edit, setEdit] = useState(null);       // objeto cola | 'new' | null
  const [newAgent, setNewAgent] = useState({});

  // La configuración completa no cambia sola: se recarga a mano tras guardar o borrar.
  const { data: cfgList, error: cfgError, recargar: load } = useApi('/queues');
  const full = Array.isArray(cfgList) ? cfgList : [];
  useEffect(() => { if (cfgError) toast(cfgError.message, 'bad'); }, [cfgError]);

  const { data: vozVoices } = useApi('/voz/voices');
  const voices = useMemo(() => {
    const d = vozVoices || {};
    const edge = (d.edge || []).map(v => ({ value: v.key, label: v.label }));
    const piper = (d.installed || []).map(v => ({ value: v.key, label: v.label || v.key }));
    return [...edge, ...piper];
  }, [vozVoices]);

  const cfgOf = (name) => full.find(q => q.name === name) || {};

  async function delQ(name) {
    if (!confirm('¿Eliminar la cola ' + name + '?')) return;
    try { await apiDel('/queues/' + encodeURIComponent(name)); toast('Cola eliminada', 'info'); load(); }
    catch (e) { toast(e.message, 'bad'); }
  }
  async function addAgent(name) {
    const ext = (newAgent[name] || '').trim(); if (!ext) return;
    try {
      await apiPost('/queues/' + encodeURIComponent(name) + '/members', { ext });
      toast('Agente ' + ext + ' agregado', 'ok'); setNewAgent(s => ({ ...s, [name]: '' }));
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function rmAgent(name, ext) {
    // La lista de agentes viene del snapshot del socket, así que se refresca sola.
    try { await apiDel('/queues/' + encodeURIComponent(name) + '/members/' + encodeURIComponent(ext)); toast('Agente quitado', 'info'); }
    catch (e) { toast(e.message, 'bad'); }
  }

  return (
    <Stack>
      <Group justify="flex-end">
        <Button leftSection={<IconPlus size={16} />} onClick={() => setEdit('new')}>Nueva cola</Button>
      </Group>

      {live.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin colas.</Text> : live.map(q => {
        const c = cfgOf(q.name);
        return (
          <Card key={q.name} withBorder radius="lg" padding="lg" shadow="sm">
            <Group justify="space-between" mb="sm">
              <div>
                <Group gap="xs">
                  <Text fw={650}>{c.label || q.label || q.name}</Text>
                  <Badge variant="light" color={q.agents_online > 0 ? 'teal' : 'gray'}>{q.agents_online}/{q.agents_total} agentes</Badge>
                  {c.record && <Tooltip label="Grabación automática"><Badge variant="light" color="red" leftSection={<IconMicrophone size={11} />}>REC</Badge></Tooltip>}
                  {c.welcome_ref && <Tooltip label={c.welcome_text}><Badge variant="light" color="grape" leftSection={<IconVolume size={11} />}>Bienvenida</Badge></Tooltip>}
                  {Number(c.wrapuptime) > 0 && <Tooltip label="Descanso del agente entre llamadas"><Badge variant="light" color="blue" leftSection={<IconClockPause size={11} />}>{c.wrapuptime}s</Badge></Tooltip>}
                </Group>
                <Text size="xs" c="dimmed">
                  Acceso {c.access_exten || q.access_exten} · {STRAT[c.strategy || q.strategy] || q.strategy} · timbrado {c.timeout ?? q.timeout}s
                  {Number(c.max_wait) > 0 ? ` · espera máx ${c.max_wait}s → ${c.timeout_dest}${c.timeout_value ? ' ' + c.timeout_value : ''}` : ''}
                  {Number(c.maxlen) > 0 ? ` · máx ${c.maxlen} en cola` : ''}
                </Text>
              </div>
              <Group gap={6}>
                <Tooltip label="Editar"><ActionIcon variant="light" onClick={() => setEdit(c.name ? c : { name: q.name })}><IconEdit size={17} /></ActionIcon></Tooltip>
                <ActionIcon variant="subtle" color="red" onClick={() => delQ(q.name)}><IconTrash size={17} /></ActionIcon>
              </Group>
            </Group>

            <Group gap="xs" mb="sm">
              {(q.members || []).length === 0 ? <Text size="sm" c="dimmed">Sin agentes</Text> :
                q.members.map(m => (
                  <Pill key={m.ext} withRemoveButton onRemove={() => rmAgent(q.name, m.ext)}>
                    <Badge size="xs" variant="dot" color={m.status === 'online' ? 'teal' : 'gray'} style={{ border: 0, background: 'transparent', padding: 0 }}>{m.ext}</Badge>
                  </Pill>
                ))}
            </Group>
            <Group gap="xs">
              <TextInput placeholder="Extensión (ej 1002)" size="xs" value={newAgent[q.name] || ''}
                onChange={e => setNewAgent(s => ({ ...s, [q.name]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') addAgent(q.name); }} />
              <Button size="xs" variant="light" onClick={() => addAgent(q.name)}>Agregar agente</Button>
            </Group>
          </Card>
        );
      })}

      <QueueEditor opened={!!edit} queue={edit === 'new' ? null : edit} voices={voices}
        onClose={() => setEdit(null)} onSaved={() => load()} />
    </Stack>
  );
}
