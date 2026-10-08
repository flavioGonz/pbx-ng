/* QueueEditor.jsx — editor completo de una cola (campos nativos de app_queue + anuncios por TTS) */
'use client';
import { useEffect, useRef, useState } from 'react';
import { Stack, Group, TextInput, NumberInput, Select, Switch, Textarea, Button, Text, Divider, Loader, ActionIcon, Tooltip } from '@mantine/core';
import DrawerNG from './DrawerNG';
import { IconDeviceFloppy, IconPlayerPlay, IconSparkles, IconVolume, IconRobot, IconAlertTriangle, IconUsersGroup, IconSettings, IconAdjustments } from '@tabler/icons-react';
import { toast } from './notify';
import { api, apiPost, apiPut } from './api';

const STRAT = [['ringall', 'Timbrar todos'], ['rrmemory', 'Round-robin con memoria'], ['leastrecent', 'El que hace más que no atiende'], ['fewestcalls', 'El que menos llamadas atendió'], ['random', 'Aleatoria'], ['linear', 'Lineal (por orden)'], ['wrandom', 'Aleatoria ponderada']];
const YN = [['yes', 'Sí'], ['no', 'No']];
const JOIN = [['yes', 'Siempre (aunque no haya agentes)'], ['no', 'No entrar si no hay agentes conectados'], ['strict', 'Estricto: tampoco si están todos en pausa']];
const LEAVE = [['no', 'Quedarse en la cola'], ['yes', 'Sacar la llamada si no quedan agentes'], ['strict', 'Estricto: también si están todos en pausa']];
const HOLD = [['no', 'No anunciar'], ['once', 'Una sola vez'], ['yes', 'En cada anuncio']];
const DEST = [['hangup', 'Colgar'], ['ext', 'Extensión'], ['voicemail', 'Buzón de voz'], ['queue', 'Otra cola'], ['ivr', 'IVR / número extensión']];

/* Los tres modos, con la explicación al lado: quien abre esta pantalla por primera vez
 * tiene que poder elegir sin leer un manual, y «desborde» es el que hay que recomendar
 * para empezar —los humanos siguen atendiendo y la IA toma lo que se caería—. */
const IA_MODOS = [
  ['apagado', 'Apagado — la cola funciona como siempre'],
  ['desborde', 'Desborde — atiende sólo si ningún humano puede (recomendado para empezar)'],
  ['primero', 'Primero — atiende la IA y escala cuando hace falta'],
];

export default function QueueEditor({ queue, opened, onClose, onSaved, voices = [] }) {
  const creating = !queue;
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [play, setPlay] = useState('');
  const [solapa, setSolapa] = useState('basico');
  const [agentes, setAgentes] = useState(null);       // null = todavía no se cargaron
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

  /* Los agentes se piden al abrir: si no hay ninguno, la solapa lo dice y manda a /voz
   * en vez de mostrar un desplegable vacío que no explica nada. */
  useEffect(() => {
    if (!opened) return;
    let vivo = true;
    api('/ai-agents').then((d) => { if (vivo) setAgentes(Array.isArray(d) ? d : []); }).catch(() => { if (vivo) setAgentes([]); });
    return () => { vivo = false; };
  }, [opened]);

  async function preview(text) {
    if (!text || !text.trim()) return;
    setPlay(text);
    try {
      // `raw` porque la respuesta es el WAV sintetizado, no JSON.
      const r = await api('/queues/preview-announce', { method: 'POST', body: { text, voice: f.voice }, raw: true });
      const b = await r.blob();
      if (audioRef.current) { audioRef.current.src = URL.createObjectURL(b); audioRef.current.play().catch(() => {}); }
    } catch (e) { toast('No se pudo generar el audio: ' + e.message, 'bad'); }
    finally { setPlay(''); }
  }

  async function save() {
    setBusy(true);
    try {
      const r = creating ? await apiPost('/queues', f) : await apiPut('/queues/' + encodeURIComponent(f.name), f);
      toast('Cola ' + (f.label || f.name) + ' guardada', 'ok');
      onSaved && onSaved(r); onClose();
    } catch (e) { toast('No se pudo guardar: ' + e.message, 'bad'); }
    finally { setBusy(false); }
  }

  const sel = (label, key, opts, desc) => (
    <Select label={label} description={desc} value={String(f[key] ?? '')} onChange={v => up(key, v)} data={opts.map(([v, l]) => ({ value: v, label: l }))} allowDeselect={false} />
  );
  const num = (label, key, desc, min = 0) => (
    <NumberInput label={label} description={desc} min={min} value={Number(f[key] ?? 0)} onChange={v => up(key, Number(v) || 0)} />
  );

  return (
    <DrawerNG
      opened={opened} onClose={onClose} ancho={860}
      icono={<IconUsersGroup size={24} />}
      titulo={creating ? 'Nueva cola' : 'Cola ' + (f.label || f.name || '')}
      subtitulo={creating ? 'Un número que reparte las llamadas entre varios agentes' : 'Reparto, anuncios y agente de IA'}
      solapa={solapa} onSolapa={setSolapa}
      pie={
        <Group justify="space-between">
          {/* El <audio> va en el pie y no dentro de una solapa: DrawerNG sólo monta la solapa
              activa, y el «Escuchar» está en Anuncios — con el audio en Básico, `audioRef`
              quedaba en null y la vista previa se sintetizaba pero nunca sonaba. */}
          <audio ref={audioRef} style={{ display: 'none' }} />
          <Button variant="subtle" color="gray" onClick={onClose}>Cancelar</Button>
          <Button leftSection={<IconDeviceFloppy size={16} />} loading={busy} onClick={save}>{creating ? 'Crear cola' : 'Guardar cambios'}</Button>
        </Group>
      }
      solapas={[
        { value: 'basico', label: 'Básico', icon: <IconSettings size={15} />, contenido: (
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
        ) },
        { value: 'anuncios', label: 'Anuncios', icon: <IconSparkles size={15} />, contenido: (
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
        ) },
        { value: 'avanzado', label: 'Avanzado', icon: <IconAdjustments size={15} />, contenido: (
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
        ) },
        { value: 'ia', label: 'Agente IA', icon: <IconRobot size={15} />, contenido: (
          <Stack gap="sm">
            {agentes === null ? <Group gap="xs"><Loader size="xs" /><Text size="sm" c="dimmed">Buscando agentes…</Text></Group>
              : agentes.length === 0 ? (
                <Text size="sm" c="dimmed">
                  Todavía no hay ningún agente de IA. Se crean en <b>Voz</b>, con su voz, su prompt y su proveedor;
                  después volvé acá para ponerlo a atender esta cola.
                </Text>
              ) : (
                <>
                  <Group grow align="flex-start">
                    <Select label="Agente" description="Cuál de los agentes de Voz atiende esta cola"
                      value={f.ia_agente_id ? String(f.ia_agente_id) : ''} onChange={(v) => up('ia_agente_id', v ? Number(v) : null)}
                      data={agentes.map((a) => ({ value: String(a.id), label: a.name + ' (' + a.exten + ')' + (a.enabled ? '' : ' · deshabilitado') }))}
                      placeholder="Ninguno" clearable />
                    <Select label="Modo" description="Cuándo atiende" value={f.ia_modo || 'apagado'}
                      onChange={(v) => up('ia_modo', v)} allowDeselect={false}
                      data={IA_MODOS.map(([v, l]) => ({ value: v, label: l }))} />
                  </Group>
                  <Group grow align="flex-start">
                    <NumberInput label="Llamadas simultáneas" min={1} max={10}
                      description="Cuántas puede atender a la vez. Es también el tope de gasto: cada sesión se paga por minuto."
                      value={Number(f.ia_simultaneas ?? 1)} onChange={(v) => up('ia_simultaneas', Math.max(1, Math.min(10, Number(v) || 1)))} />
                    <TextInput label="Escalar a" description="Interno o cola para cuando pide una persona, el agente duda, o el modelo no contesta. Vacío = a los humanos de esta cola."
                      value={f.ia_escalar_a || ''} onChange={(e) => up('ia_escalar_a', e.target.value)} />
                  </Group>

                  {/* Lo que esta pantalla TIENE que decir, porque decide cómo se usa: */}
                  <Divider my="xs" />
                  <Group gap={8} align="flex-start" wrap="nowrap">
                    <IconAlertTriangle size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                    <Text size="xs" c="dimmed">
                      El agente entra a la cola como <b>un miembro más</b>: se le aplican la estrategia, el timbrado y la
                      capacidad igual que a una persona. En <b>desborde</b> queda con menor prioridad que los humanos, así
                      que sólo se lo timbra cuando ninguno puede atender. Si el agente está deshabilitado en Voz, o el
                      modelo no responde, la cola sigue funcionando con las personas.
                      {' '}Hoy el agente <b>conversa y transfiere</b>: todavía no verifica datos ni abre puertas.
                    </Text>
                  </Group>
                </>
              )}
          </Stack>
        ) },
      ]}
    />
  );
}
