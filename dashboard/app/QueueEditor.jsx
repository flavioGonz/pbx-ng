/* QueueEditor.jsx — editor completo de una cola (campos nativos de app_queue + anuncios por TTS) */
'use client';
import { useEffect, useRef, useState } from 'react';
import { Modal, Tabs, Stack, Group, TextInput, NumberInput, Select, Switch, Textarea, Button, Text, Divider, Loader, ActionIcon, Tooltip } from '@mantine/core';
import { IconDeviceFloppy, IconPlayerPlay, IconSparkles, IconVolume } from '@tabler/icons-react';
import { toast } from './notify';

const STRAT = [['ringall', 'Timbrar todos'], ['rrmemory', 'Round-robin con memoria'], ['leastrecent', 'El que hace más que no atiende'], ['fewestcalls', 'El que menos llamadas atendió'], ['random', 'Aleatoria'], ['linear', 'Lineal (por orden)'], ['wrandom', 'Aleatoria ponderada']];
const YN = [['yes', 'Sí'], ['no', 'No']];
const JOIN = [['yes', 'Siempre (aunque no haya agentes)'], ['no', 'No entrar si no hay agentes conectados'], ['strict', 'Estricto: tampoco si están todos en pausa']];
const LEAVE = [['no', 'Quedarse en la cola'], ['yes', 'Sacar la llamada si no quedan agentes'], ['strict', 'Estricto: también si están todos en pausa']];
const HOLD = [['no', 'No anunciar'], ['once', 'Una sola vez'], ['yes', 'En cada anuncio']];
const DEST = [['hangup', 'Colgar'], ['ext', 'Extensión'], ['voicemail', 'Buzón de voz'], ['queue', 'Otra cola'], ['ivr', 'IVR / número extensión']];

export default function QueueEditor({ queue, opened, onClose, onSaved, voices = [] }) {
  const creating = !queue;
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [play, setPlay] = useState('');
  const audioRef = useRef(null);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!opened) return;
    setF(queue ? { ...queue } : {
      strategy: 'ringall', timeout: 20, retry: 5, wrapuptime: 10, maxlen: 0, musiconhold: 'default',
      servicelevel: 30, weight: 0, joinempty: 'yes', leavewhenempty: 'no', ringinuse: 'no', autofill: 'yes',
      autopause: 'no', reportholdtime: 'no', memberdelay: 0, announce_position: 'no', announce_holdtime: 'no',
      announce_frequency: 0, periodic_announce_frequency: 60, max_wait: 0, timeout_dest: 'hangup', record: false,
    });
  }, [opened, queue]);

  async function preview(text) {
    if (!text || !text.trim()) return;
    setPlay(text);
    try {
      const r = await fetch('/backend/api/queues/preview-announce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: f.voice }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'error');
      const b = await r.blob();
      if (audioRef.current) { audioRef.current.src = URL.createObjectURL(b); audioRef.current.play(); }
    } catch (e) { toast('No se pudo generar el audio: ' + e.message, 'bad'); }
    finally { setPlay(''); }
  }

  async function save() {
    setBusy(true);
    const url = creating ? '/backend/api/queues' : '/backend/api/queues/' + encodeURIComponent(f.name);
    const r = await fetch(url, { method: creating ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) })
      .then(x => x.json()).catch(() => ({ error: 'fallo de red' }));
    setBusy(false);
    if (r.error) { toast('No se pudo guardar: ' + r.error, 'bad'); return; }
    toast('Cola ' + (f.label || f.name) + ' guardada', 'ok');
    onSaved && onSaved(r); onClose();
  }

  const sel = (label, key, opts, desc) => (
    <Select label={label} description={desc} value={String(f[key] ?? '')} onChange={v => up(key, v)} data={opts.map(([v, l]) => ({ value: v, label: l }))} allowDeselect={false} />
  );
  const num = (label, key, desc, min = 0) => (
    <NumberInput label={label} description={desc} min={min} value={Number(f[key] ?? 0)} onChange={v => up(key, Number(v) || 0)} />
  );

  return (
    <Modal opened={opened} onClose={onClose} size="xl" radius="lg" centered
      title={<Text fw={700}>{creating ? 'Nueva cola' : 'Cola ' + (f.label || f.name)}</Text>}>
      <audio ref={audioRef} style={{ display: 'none' }} />
      <Tabs defaultValue="basico" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="basico">Básico</Tabs.Tab>
          <Tabs.Tab value="anuncios" leftSection={<IconSparkles size={14} />}>Anuncios</Tabs.Tab>
          <Tabs.Tab value="avanzado">Avanzado</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="basico">
          <Stack gap="sm">
            <Group grow>
              <TextInput label="Nombre" description="Identificador interno, sin espacios. Ej: ventas." value={f.name || ''} disabled={!creating} onChange={e => up('name', e.target.value)} required />
              <TextInput label="Etiqueta" description="Nombre visible. Ej: Ventas." value={f.label || ''} onChange={e => up('label', e.target.value)} />
              <TextInput label="Número de acceso" description="Lo que se marca para entrar. Ej: 8001." value={f.access_exten || ''} onChange={e => up('access_exten', e.target.value)} required />
            </Group>
            <Group grow>
              {sel('Estrategia', 'strategy', STRAT, 'Cómo se reparten las llamadas entre los agentes')}
              <TextInput label="Música en espera" description="Clase de MOH" value={f.musiconhold || 'default'} onChange={e => up('musiconhold', e.target.value)} />
            </Group>
            <Group grow>
              {num('Timbrado del agente (s)', 'timeout', 'Cuánto suena en cada agente antes de pasar al siguiente')}
              {num('Reintento (s)', 'retry', 'Espera antes de volver a intentar con los agentes')}
              {num('Descanso del agente (s)', 'wrapuptime', 'Tiempo para tipificar antes de recibir otra llamada')}
            </Group>
            <Group grow>
              {num('Capacidad máxima', 'maxlen', '0 = sin límite de llamadas en espera')}
              {num('Espera máxima (s)', 'max_wait', '0 = sin límite. Al vencer, va al destino de abajo')}
              <Switch label="Grabar llamadas de esta cola" description="MixMonitor automático" mt={26} checked={!!f.record} onChange={e => up('record', e.currentTarget.checked)} />
            </Group>
            <Divider label="Al vencer la espera máxima" labelPosition="left" />
            <Group grow>
              {sel('Destino', 'timeout_dest', DEST)}
              <TextInput label="Valor del destino" description="Extensión, buzón, nombre de cola o número de IVR" disabled={f.timeout_dest === 'hangup'} value={f.timeout_value || ''} onChange={e => up('timeout_value', e.target.value)} />
            </Group>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="anuncios">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text size="sm" c="dimmed">Escribí el texto: lo sintetiza el motor de voz propio. No hace falta subir ningún WAV.</Text>
              <Select w={230} size="xs" placeholder="Voz" value={f.voice || ''} onChange={v => up('voice', v)} data={voices} allowDeselect />
            </Group>
            <div>
              <Group justify="space-between" mb={4}>
                <Text size="sm" fw={600}>Bienvenida (se reproduce al entrar a la cola)</Text>
                <Tooltip label="Escuchar"><ActionIcon variant="light" loading={play === f.welcome_text} onClick={() => preview(f.welcome_text)}><IconPlayerPlay size={15} /></ActionIcon></Tooltip>
              </Group>
              <Textarea autosize minRows={2} placeholder="Bienvenido a Infratec. Su llamada es importante; en unos instantes lo atenderá un asesor."
                value={f.welcome_text || ''} onChange={e => up('welcome_text', e.target.value)} />
            </div>
            <div>
              <Group justify="space-between" mb={4}>
                <Text size="sm" fw={600}>Anuncio periódico (mientras espera)</Text>
                <Tooltip label="Escuchar"><ActionIcon variant="light" loading={play === f.periodic_text} onClick={() => preview(f.periodic_text)}><IconPlayerPlay size={15} /></ActionIcon></Tooltip>
              </Group>
              <Textarea autosize minRows={2} placeholder="Todos nuestros asesores están ocupados. Aguarde en línea, por favor."
                value={f.periodic_text || ''} onChange={e => up('periodic_text', e.target.value)} />
              <Group grow mt="xs">
                {num('Cada cuántos segundos', 'periodic_announce_frequency', 'Repetición del anuncio periódico', 0)}
              </Group>
            </div>
            <Divider label="Anuncios automáticos de la cola (voz del sistema)" labelPosition="left" />
            <Group grow>
              {sel('Anunciar la posición', 'announce_position', [['no', 'No'], ['yes', 'Sí'], ['limit', 'Solo hasta el límite'], ['more', 'Solo si hay más que el límite']])}
              {sel('Anunciar el tiempo de espera', 'announce_holdtime', HOLD)}
              {num('Frecuencia de los anuncios (s)', 'announce_frequency', '0 = no anunciar posición/espera', 0)}
            </Group>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="avanzado">
          <Stack gap="sm">
            <Group grow>
              {sel('Entrar a la cola cuando no hay agentes', 'joinempty', JOIN)}
              {sel('Sacar de la cola si se quedan sin agentes', 'leavewhenempty', LEAVE)}
            </Group>
            <Group grow>
              {sel('Timbrar a agentes que ya están en llamada', 'ringinuse', YN)}
              {sel('Autofill (repartir en paralelo)', 'autofill', YN)}
              {sel('Pausar al agente que no atiende', 'autopause', [['no', 'No'], ['yes', 'Sí'], ['all', 'Sí, en todas sus colas']])}
            </Group>
            <Group grow>
              {num('SLA objetivo (s)', 'servicelevel', 'Llamadas atendidas dentro de este tiempo')}
              {num('Peso de la cola', 'weight', 'Prioridad frente a otras colas con los mismos agentes')}
              {num('Demora antes de conectar (s)', 'memberdelay', 'Pausa entre que el agente atiende y entra el audio')}
            </Group>
            <Group grow>
              {sel('Informar al agente el tiempo que esperó el cliente', 'reportholdtime', YN)}
            </Group>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      <Group justify="flex-end" mt="lg">
        <Button variant="default" onClick={onClose}>Cancelar</Button>
        <Button leftSection={<IconDeviceFloppy size={16} />} loading={busy} onClick={save}>{creating ? 'Crear cola' : 'Guardar cambios'}</Button>
      </Group>
    </Modal>
  );
}
