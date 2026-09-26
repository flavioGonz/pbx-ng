'use client';
/* ============================================================================
 *  IA & Voz › Agentes. La tabla es lo PRIMERO que se ve, a propósito: quien entra acá
 *  viene a contestar «¿qué agentes hay y cuál está atendiendo?», no a configurar el
 *  motor. La clave del proveedor se mudó a la pestaña «Nube» y el estado del contenedor
 *  de voz a «Motor local»: acá no se mezcla la infraestructura con los agentes.
 *
 *  El alta y la edición son un Drawer de tres pasos, no un modal:
 *    · Identidad     quién es y en qué interno atiende
 *    · Cerebro       con qué piensa y habla — y el botón que dice si eso funciona
 *    · Derivaciones  a dónde manda la llamada cuando no puede seguir
 *  Ese orden es el orden en que se rompe: casi todos los problemas viven en «Cerebro»,
 *  y por eso la prueba de conexión está ahí y no escondida al final de un formulario.
 * ==========================================================================*/
import { useEffect, useState, useRef } from 'react';
import { Stack, Card, Group, Divider, Text, Button, Table, Badge, ActionIcon, Drawer, TextInput, Textarea, Select, Switch, ThemeIcon, SimpleGrid, Alert, Tooltip, Autocomplete, Code, Tabs, ScrollArea, Box, NumberInput, Collapse } from '@mantine/core';
import { IconBuildingStore, IconTool, IconDoorEnter, IconShieldLock, IconClockPause, IconPlus, IconEdit, IconTrash, IconHash, IconBolt, IconDeviceFloppy, IconPhoneCall, IconHeadset, IconUsers, IconInfoCircle, IconPlayerPlay, IconCircleCheck, IconPlugConnected, IconAlertTriangle, IconId, IconArrowRampRight, IconSearch, IconRobotOff } from '@tabler/icons-react';
import { IcoAgente, IcoCerebro, IcoNube, IcoOnda } from '../IaIcons';
import { toast } from '../notify';

/* Los proveedores, con la única diferencia que le importa a quien elige: dónde corre. */
const PROVIDERS = [
  { value: 'openai-realtime', label: 'OpenAI voz a voz (GPT-Live / Realtime)', donde: 'nube', pie: 'Una sola sesión con el modelo: la menor latencia' },
  { value: 'openai', label: 'OpenAI en tres pasos (Whisper → GPT → TTS)', donde: 'nube', pie: 'Más lento, pero permite elegir cada pieza' },
  { value: 'demo', label: 'Demo (offline · Vosk + voz local)', donde: 'local', pie: 'Sin clave ni internet, y sin costo. Para probar el recorrido' },
];
const MODELS = [{ value: 'gpt-4o-mini', label: 'gpt-4o-mini (rápido/económico)' }, { value: 'gpt-4o', label: 'gpt-4o (máxima calidad)' }];
const OPENAI_VOICES = [{ value: 'nova', label: 'Nova' }, { value: 'alloy', label: 'Alloy' }, { value: 'shimmer', label: 'Shimmer' }, { value: 'onyx', label: 'Onyx' }, { value: 'echo', label: 'Echo' }, { value: 'fable', label: 'Fable' }];
/* Realtime: modelo y voz son texto LIBRE a propósito. El proveedor los renombra y retira
 * cada pocos meses; una lista cerrada obligaría a actualizar la central para volver a
 * atender. Estas son sugerencias — la lista de verdad la trae «Nube». */
const RT_MODELS = ['gpt-live-1', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini'];
const RT_VOICES = ['marin', 'cedar', 'alloy', 'echo', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'];
const esRT = (p) => p === 'openai-realtime';
const enLaNube = (p) => p === 'openai-realtime' || p === 'openai';
const provMeta = (p) => PROVIDERS.find(x => x.value === p) || PROVIDERS[2];

const empty = { name: '', exten: '', provider: 'openai-realtime', model: 'gpt-live-1', voice: 'marin', greeting_text: '', system_prompt: '', sales_exten: '', support_exten: '', default_exten: '', crm_webhook: '', enabled: true, inact1_s: 0, inact2_s: 0, cierre_s: 0, inact1_text: '', inact2_text: '', despedida_text: '', herramientas: {} };
/* Los tiempos con los que se despliega la primera vez. Dos consultas antes de cortar, y
 * no una, porque la primera se pierde seguido: el visitante se dio vuelta, estaba hablando
 * con alguien, se le cayó el teléfono. */
const INACT_DEF = { inact1_s: 5, inact2_s: 3, cierre_s: 8 };

/* Encabezado de un bloque del drawer: icono + qué se decide acá. */
const Bloque = ({ icon, titulo, ayuda, children }) => (
  <Card withBorder radius="md" padding="md">
    <Group gap="sm" mb={ayuda ? 4 : 'sm'} wrap="nowrap">
      <ThemeIcon variant="light" size={32} radius="md" color="pink">{icon}</ThemeIcon>
      <Text fw={700} fz="sm">{titulo}</Text>
    </Group>
    {ayuda ? <Text size="xs" c="dimmed" mb="sm" ml={44}>{ayuda}</Text> : null}
    {children}
  </Card>
);

export default function AiAgents() {
  const [list, setList] = useState(null);
  const [opened, setOpened] = useState(false);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [paso, setPaso] = useState('identidad');
  const [filtro, setFiltro] = useState('');
  const [vozList, setVozList] = useState([]); const [edgeList, setEdgeList] = useState([]);
  const [prueba, setPrueba] = useState(null); const [probando, setProbando] = useState(false);
  const [rtModelos, setRtModelos] = useState(null);
  const [catalogo, setCatalogo] = useState([]);
  const [pruebaBo, setPruebaBo] = useState(null); const [probandoBo, setProbandoBo] = useState(false);
  /* Una sola fuente de verdad para el catálogo: la central. Una copia en el panel es una
   * lista que se desincroniza, y en esta pantalla eso significa ofrecer una herramienta
   * que el backend no sabe ejecutar. */
  async function cargarCatalogo() {
    try { setCatalogo(await fetch('/backend/api/ai-agents/herramientas').then(r => r.json())); } catch (_) {}
  }
  const previewRef = useRef(null);

  async function load() { try { setList(await fetch('/backend/api/ai-agents').then(r => r.json())); } catch (_) { setList([]); } }
  async function loadVozList() { try { const v = await fetch('/backend/api/voz/voices').then(r => r.json()); setVozList((v.installed || []).map(x => x.key)); setEdgeList(v.edge || []); } catch (_) {} }
  async function cargarModelos() {
    try { setRtModelos(await fetch('/backend/api/ai-agents/modelos').then(r => r.json())); } catch (_) { setRtModelos({ ok: false }); }
  }
  useEffect(() => { load(); loadVozList(); cargarCatalogo(); const t = setInterval(() => { if (!document.hidden) load(); }, 30000); return () => clearInterval(t); }, []);

  const up = (k, v) => setForm(s => ({ ...s, [k]: v }));
  const herr = (id) => (form.herramientas || {})[id] || {};
  const upHerr = (id, campo, valor) => setForm(s => ({
    ...s, herramientas: { ...(s.herramientas || {}), [id]: { ...((s.herramientas || {})[id] || {}), [campo]: valor } },
  }));
  /* Cambiar de proveedor tiene que dejar modelo y voz COHERENTES: un agente de voz a voz
   * con `gpt-4o-mini` y una voz de Piper se guardaba sin error y después no hablaba. */
  function cambiarProveedor(v) {
    setPrueba(null);
    if (esRT(v) && !rtModelos) cargarModelos();
    setForm(s => ({
      ...s, provider: v,
      model: esRT(v) ? (RT_MODELS.includes(s.model) ? s.model : RT_MODELS[0]) : (s.model && /realtime|live/.test(s.model) ? 'gpt-4o-mini' : s.model),
      voice: esRT(v) ? (RT_VOICES.includes(s.voice) ? s.voice : 'marin') : s.voice,
    }));
  }
  function abrir(a) {
    if (!rtModelos) cargarModelos();
    setForm(a ? { ...empty, ...a } : empty);
    setPrueba(null); setPaso('identidad'); setOpened(true);
    if (esRT((a || empty).provider) && !rtModelos) cargarModelos();
  }
  async function save() {
    if (!form.name || !form.exten) { toast('El nombre y el número de acceso son obligatorios', 'bad'); setPaso('identidad'); return; }
    setSaving(true);
    const url = form.id ? '/backend/api/ai-agents/' + form.id : '/backend/api/ai-agents';
    const r = await fetch(url, { method: form.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) toast('Error: ' + r.error, 'bad');
    else { toast(form.id ? 'Agente actualizado' : 'Agente creado · marcá ' + form.exten, 'ok'); setOpened(false); load(); }
  }
  async function del(a) {
    if (!confirm('¿Eliminar el agente ' + a.name + '?')) return;
    await fetch('/backend/api/ai-agents/' + a.id, { method: 'DELETE' });
    toast('Agente eliminado', 'info'); load();
  }
  /* Probar la caja del backoffice sin llamar por teléfono. Lo importante de lo que
   * devuelve no es «anda»: es qué se descartó y por qué. */
  async function probarBackoffice() {
    setProbandoBo(true); setPruebaBo(null);
    const r = await fetch('/backend/api/ai-agents/probar-backoffice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: herr('remoto').url, token: herr('remoto').token, tope_ms: herr('remoto').tope_ms }),
    }).then(x => x.json()).catch(() => ({ ok: false, error: 'no se pudo contactar la central' }));
    setProbandoBo(false); setPruebaBo(r);
    toast(r.ok ? 'El backoffice publicó ' + r.herramientas.length + ' herramienta(s)' : 'El backoffice no publicó nada usable', r.ok ? 'ok' : 'bad');
  }
  async function probarConexion() {
    setProbando(true); setPrueba(null);
    const r = await fetch('/backend/api/ai-agents/probar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: form.model, voice: form.voice }) })
      .then(x => x.json()).catch(() => ({ ok: false, error: 'no se pudo contactar la central' }));
    setProbando(false); setPrueba(r);
    toast(r.ok ? 'El modelo contestó: ya se puede marcar ' + (form.exten || 'el interno') : 'La prueba falló', r.ok ? 'ok' : 'bad');
  }
  async function preview(voice) {
    try {
      const r = await fetch('/backend/api/voz/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: form.greeting_text || 'Hola, esta es la voz del agente.', voice }) });
      if (!r.ok) { toast('No se pudo generar el audio', 'bad'); return; }
      const b = await r.blob();
      if (previewRef.current) { previewRef.current.src = URL.createObjectURL(b); previewRef.current.play().catch(() => {}); }
    } catch (_) {}
  }

  const filtrados = (list || []).filter(a => !filtro
    || a.name.toLowerCase().includes(filtro.toLowerCase())
    || String(a.exten).includes(filtro)
    || String(a.model || '').toLowerCase().includes(filtro.toLowerCase()));
  const activos = (list || []).filter(a => a.enabled !== false).length;
  const enNube = (list || []).filter(a => enLaNube(a.provider)).length;

  return (
    <Stack gap="lg">
      {/* ── La tabla, primero ─────────────────────────────────────────────── */}
      <Card withBorder radius="lg" padding={0} style={{ overflow: 'hidden' }}>
        <Group justify="space-between" wrap="nowrap" p="md" pb="sm">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color="pink" size={42} radius="md"><IcoAgente size={24} activo={activos > 0} /></ThemeIcon>
            <div>
              <Text fw={800} fz="lg" lh={1.15}>Agentes IA</Text>
              <Text size="xs" c="dimmed">
                {list === null ? 'Cargando…' : `${list.length} ${list.length === 1 ? 'agente' : 'agentes'} · ${activos} activo${activos === 1 ? '' : 's'} · ${enNube} en la nube`}
              </Text>
            </div>
          </Group>
          <Group gap="xs" wrap="nowrap">
            {(list || []).length > 4 && <TextInput placeholder="Buscar…" value={filtro} onChange={e => setFiltro(e.currentTarget.value)} leftSection={<IconSearch size={14} />} w={200} size="sm" />}
            <Button leftSection={<IconPlus size={16} />} onClick={() => abrir(null)}>Nuevo agente</Button>
          </Group>
        </Group>

        {list === null ? <Text c="dimmed" ta="center" py="xl" size="sm">Cargando agentes…</Text>
          : !list.length ? (
            <Stack align="center" gap={6} py={48} px="md">
              <ThemeIcon variant="light" color="gray" size={56} radius="xl"><IconRobotOff size={28} /></ThemeIcon>
              <Text fw={600}>Todavía no hay agentes</Text>
              <Text size="sm" c="dimmed" ta="center" maw={420}>Un agente es un interno que atiende y conversa. Creá uno, probá la conexión y marcalo desde cualquier teléfono.</Text>
              <Button mt="sm" leftSection={<IconPlus size={16} />} onClick={() => abrir(null)}>Crear el primero</Button>
            </Stack>
          ) : (
            <Table.ScrollContainer minWidth={720}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Agente</Table.Th>
                    <Table.Th>Acceso</Table.Th>
                    <Table.Th>Dónde corre</Table.Th>
                    <Table.Th>Modelo / voz</Table.Th>
                    <Table.Th>Estado</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>{filtrados.map(a => {
                  const nube = enLaNube(a.provider);
                  const vivo = a.enabled !== false;
                  return (
                    <Table.Tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => abrir(a)}>
                      <Table.Td>
                        <Group gap={10} wrap="nowrap">
                          <ThemeIcon variant="light" size={34} radius="md" color={vivo ? 'pink' : 'gray'}><IcoAgente size={19} activo={vivo} /></ThemeIcon>
                          <Text fw={600} fz="sm">{a.name}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td><Code fz="sm">{a.exten}</Code></Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={nube ? 'violet' : 'teal'}
                          leftSection={nube ? <IcoNube size={12} activo={vivo} /> : <IcoOnda size={12} activo={vivo} />}>
                          {nube ? 'Nube' : 'Local'}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text fz="sm" lh={1.2}>{nube ? a.model : 'Vosk + reglas'}</Text>
                        <Text fz={11} c="dimmed" truncate maw={180}>{a.voice}</Text>
                      </Table.Td>
                      <Table.Td><Badge variant="dot" color={vivo ? 'teal' : 'gray'}>{vivo ? 'Atiende' : 'Apagado'}</Badge></Table.Td>
                      <Table.Td ta="right" onClick={e => e.stopPropagation()}>
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <Tooltip label="Editar"><ActionIcon variant="subtle" onClick={() => abrir(a)}><IconEdit size={17} /></ActionIcon></Tooltip>
                          <Tooltip label="Eliminar"><ActionIcon variant="subtle" color="red" onClick={() => del(a)}><IconTrash size={17} /></ActionIcon></Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
      </Card>

      {(list || []).length ? (
        <Text size="xs" c="dimmed">
          Un agente atiende marcando su número de acceso. Para que atienda una <b>cola</b> —y reemplace a un operario— se enciende en
          la solapa «Agente IA» del editor de colas.
        </Text>
      ) : null}

      {/* ── Alta / edición ────────────────────────────────────────────────── */}
      <Drawer opened={opened} onClose={() => setOpened(false)} position="right" size={620} padding={0}
        overlayProps={{ blur: 2, backgroundOpacity: 0.45 }} withCloseButton={false}
        styles={{ body: { height: '100%', display: 'flex', flexDirection: 'column' } }}>
        <Box p="md" pb={0} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
          <Group justify="space-between" wrap="nowrap" mb="sm">
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon size={46} radius="md" variant="light" color="pink"><IcoAgente size={26} activo={form.enabled !== false} /></ThemeIcon>
              <div>
                <Text fw={800} fz="lg" lh={1.1}>{form.id ? form.name || 'Editar agente' : 'Nuevo agente'}</Text>
                <Text size="xs" c="dimmed">{form.exten ? 'Atiende marcando ' + form.exten : 'Un interno que atiende y conversa'}</Text>
              </div>
            </Group>
            <Switch size="md" onLabel="ON" offLabel="OFF" checked={form.enabled !== false} onChange={e => up('enabled', e.currentTarget.checked)} />
          </Group>
          <Tabs value={paso} onChange={setPaso} variant="default">
            <Tabs.List>
              <Tabs.Tab value="identidad" leftSection={<IconId size={15} />}>Identidad</Tabs.Tab>
              <Tabs.Tab value="cerebro" leftSection={<IcoCerebro size={15} activo={enLaNube(form.provider)} />}>Cerebro</Tabs.Tab>
              <Tabs.Tab value="herramientas" leftSection={<IconTool size={15} />}>Herramientas</Tabs.Tab>
              <Tabs.Tab value="derivaciones" leftSection={<IconArrowRampRight size={15} />}>Derivaciones</Tabs.Tab>
            </Tabs.List>
          </Tabs>
        </Box>

        <ScrollArea style={{ flex: 1 }} p="md">
          <Stack gap="md">
            {paso === 'identidad' && <>
              <Bloque icon={<IconId size={18} />} titulo="Quién es y dónde atiende">
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                  <TextInput label="Nombre" description="Lo ve el supervisor en el tablero" placeholder="Portería" value={form.name} onChange={e => up('name', e.currentTarget.value)} required />
                  <TextInput label="Número de acceso" description="El interno que se marca para hablarle" placeholder="7700" value={form.exten} onChange={e => up('exten', e.currentTarget.value)} required leftSection={<IconHash size={15} />} />
                </SimpleGrid>
              </Bloque>
              <Bloque icon={<IconBolt size={18} />} titulo="Estado"
                ayuda="Un agente apagado no timbra: si está puesto en una cola, esa cola deja de tener quien atienda por ese lado.">
                <Switch label={form.enabled !== false ? 'Atiende llamadas' : 'Apagado'} checked={form.enabled !== false} onChange={e => up('enabled', e.currentTarget.checked)} />
              </Bloque>
              <Group justify="flex-end"><Button variant="light" onClick={() => setPaso('cerebro')}>Siguiente: Cerebro →</Button></Group>
            </>}

            {paso === 'cerebro' && <>
              <Bloque icon={<IcoCerebro size={18} activo={enLaNube(form.provider)} />} titulo="Con qué piensa y habla"
                ayuda={provMeta(form.provider).pie}>
                <Select label="Proveedor" data={PROVIDERS.map(p => ({ value: p.value, label: p.label }))} value={form.provider} onChange={cambiarProveedor} mb="md"
                  renderOption={({ option }) => {
                    const m = provMeta(option.value);
                    return (
                      <Group gap="sm" wrap="nowrap" py={2}>
                        <ThemeIcon variant="light" size={30} radius="md" color={m.donde === 'nube' ? 'violet' : 'teal'}>
                          {m.donde === 'nube' ? <IcoNube size={17} /> : <IcoOnda size={17} />}
                        </ThemeIcon>
                        <div style={{ minWidth: 0 }}><Text fz="sm" fw={600} truncate>{option.label}</Text><Text fz={11} c="dimmed" truncate>{m.pie}</Text></div>
                      </Group>
                    );
                  }} />
                {enLaNube(form.provider)
                  ? <Alert variant="light" color="violet" icon={<IcoNube size={18} activo />} mb="md" p="xs">
                      <Text size="xs">El audio de la llamada <b>sale de la central</b> y se paga por minuto. Si se corta el enlace, este agente deja de atender. La clave se carga en la pestaña <b>Nube</b>.</Text>
                    </Alert>
                  : <Alert variant="light" color="teal" icon={<IcoOnda size={18} activo />} mb="md" p="xs">
                      <Text size="xs">Todo adentro del fierro: sin clave, sin internet y sin costo. Entiende poco, pero sirve para probar el recorrido de la llamada.</Text>
                    </Alert>}

                {form.provider !== 'demo' && (
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    {esRT(form.provider)
                      ? <Autocomplete label="Modelo" placeholder="gpt-live-1"
                          description={rtModelos === null ? 'gpt-live o gpt-realtime'
                            : rtModelos.ok ? (rtModelos.modelos.length ? 'Los ' + rtModelos.modelos.length + ' que sirve tu cuenta' : 'Tu cuenta no sirve ninguno de voz a voz')
                              : 'No se pudo consultar tu cuenta'}
                          data={rtModelos && rtModelos.ok && rtModelos.modelos.length ? rtModelos.modelos : RT_MODELS}
                          value={form.model || ''} onChange={v => { up('model', v); setPrueba(null); }} />
                      : <Select label="Modelo" data={MODELS} value={form.model} onChange={v => up('model', v)} />}
                    {esRT(form.provider)
                      ? <Autocomplete label="Voz" description="Voces del modelo" placeholder="marin" data={RT_VOICES} value={form.voice || ''} onChange={v => { up('voice', v); setPrueba(null); }} />
                      : <Select label="Voz" description="Voces de OpenAI" data={OPENAI_VOICES} value={form.voice} onChange={v => up('voice', v)} searchable />}
                  </SimpleGrid>
                )}
                {form.provider === 'demo' && (
                  <Group gap="xs" align="flex-end" wrap="nowrap">
                    <Select label="Voz" description="Las de tu servidor — se gestionan en «Motor local»" style={{ flex: 1 }} searchable
                      data={[{ group: 'Local · Piper (offline)', items: vozList.map(k => ({ value: k, label: k })) },
                        { group: 'Edge (online)', items: edgeList.map(v => ({ value: v.key, label: v.label })) }]}
                      value={form.voice} onChange={v => up('voice', v)} />
                    <Tooltip label="Escuchar"><ActionIcon variant="light" size={36} onClick={() => preview(form.voice)} disabled={!form.voice}><IconPlayerPlay size={16} /></ActionIcon></Tooltip>
                  </Group>
                )}
              </Bloque>

              {esRT(form.provider) && (
                <Bloque icon={<IconPlugConnected size={18} />} titulo="¿Se puede llamar a este agente?"
                  ayuda="Abre una sesión real y le pide que hable. Comprueba de una vez las tres cosas que hacen que un agente atienda y no diga nada: la clave, el identificador del modelo y la voz.">
                  <Button variant="light" leftSection={<IconPlugConnected size={16} />} loading={probando} onClick={probarConexion} disabled={!form.model}>Probar conexión</Button>
                  {prueba && (prueba.ok
                    ? <Alert variant="light" color="teal" mt="sm" icon={<IconCircleCheck size={18} />}>
                        <Text size="sm" fw={600}>El modelo contestó. Ya se puede marcar {form.exten || 'el interno'}.</Text>
                        <Text size="xs" c="dimmed">Sesión en {prueba.abrio_ms} ms · primer audio en {prueba.primer_audio_ms} ms.{' '}
                          Ese «primer audio» es el silencio que va a escuchar el visitante antes de que el agente hable.</Text>
                        {prueba.texto ? <Text size="xs" mt={4}>Dijo: «{prueba.texto.trim()}»</Text> : null}
                        {prueba.api ? <Text size="xs" c="dimmed" mt={2}>API <Code>{prueba.api}</Code></Text> : null}
                      </Alert>
                    : <Alert variant="light" color="red" mt="sm" icon={<IconAlertTriangle size={18} />}>
                        <Text size="sm">{prueba.error || 'falló sin decir por qué'}</Text>
                        {prueba.intentos && prueba.intentos.length > 1 ? <Text size="xs" c="dimmed" mt={4}>Se probaron {prueba.intentos.length} modos: {prueba.intentos.map(i => i.intento).join(' · ')}</Text> : null}
                        {prueba.eventos && Object.keys(prueba.eventos).length
                          ? <Text size="xs" c="dimmed" mt={4}>El proveedor mandó: {Object.entries(prueba.eventos).map(([k, v]) => k + (v > 1 ? ' ×' + v : '')).join(', ')}</Text> : null}
                        {prueba.endpoint ? <Text size="xs" c="dimmed" mt={4}>Endpoint: <Code>{prueba.endpoint}</Code></Text> : null}
                      </Alert>)}
                </Bloque>
              )}

              <Bloque icon={<IconInfoCircle size={18} />} titulo="Qué dice"
                ayuda="El saludo es lo primero que escucha quien llama. Las instrucciones son la personalidad y los límites.">
                <Textarea label="Saludo inicial" placeholder="Hola, portería de IES. ¿Con quién querés hablar?" autosize minRows={2} mb="md"
                  value={form.greeting_text} onChange={e => up('greeting_text', e.currentTarget.value)} />
                <Textarea label="Instrucciones (system prompt)" autosize minRows={4}
                  description="Los modelos de voz a voz parafrasean: si necesitás una frase palabra por palabra, pedila acá explícitamente."
                  placeholder="Sos el portero de IES. Amable y muy breve. Preguntá a quién viene a ver y el número de unidad. Si dudás, pasá con una persona."
                  value={form.system_prompt} onChange={e => up('system_prompt', e.currentTarget.value)} />
              </Bloque>
              <Bloque icon={<IconClockPause size={18} />} titulo="Silencios y cierre"
                ayuda="Qué hace cuando el visitante deja de hablar. Esto NO se le pide al modelo: un modelo no tiene reloj, no sabe cuánto silencio pasó y no puede colgar. Lo maneja la central.">
                <Switch mb={form.inact1_s > 0 ? 'md' : 0}
                  label={form.inact1_s > 0 ? 'La central consulta y, si no hay nadie, corta' : 'Apagado: la llamada queda abierta hasta que alguien cuelgue'}
                  checked={form.inact1_s > 0}
                  onChange={e => setForm(s2 => ({ ...s2, ...(e.currentTarget.checked ? INACT_DEF : { inact1_s: 0, inact2_s: 0, cierre_s: 0 }) }))} />
                {form.inact1_s > 0 && <>
                  <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" mb="md">
                    <NumberInput label="¿Sigue ahí?" description="Silencio antes de consultar" suffix=" s" min={1} max={120}
                      value={form.inact1_s} onChange={v => up('inact1_s', v)} />
                    <NumberInput label="Segunda consulta" description="Otra frase, no la misma" suffix=" s" min={1} max={120}
                      value={form.inact2_s} onChange={v => up('inact2_s', v)} />
                    <NumberInput label="Despedida y corte" description="Después de esto, cuelga" suffix=" s" min={1} max={120}
                      value={form.cierre_s} onChange={v => up('cierre_s', v)} />
                  </SimpleGrid>
                  <Text size="xs" c="dimmed" mb="md">
                    Cada cuenta arranca cuando el agente <b>termina</b> de hablar, no cuando se le manda el texto: si arrancara antes,
                    una respuesta larga se comería la espera y el agente preguntaría «¿sigue ahí?» encima de su propia frase.
                  </Text>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    <TextInput label="Primera consulta" placeholder="¿Sigue ahí? ¿Hay algo en lo que lo pueda ayudar?" value={form.inact1_text} onChange={e => up('inact1_text', e.currentTarget.value)} />
                    <TextInput label="Segunda consulta" placeholder="¿Hola? ¿Me escucha? Si necesita algo dígame." value={form.inact2_text} onChange={e => up('inact2_text', e.currentTarget.value)} />
                  </SimpleGrid>
                  <TextInput mt="md" label="Despedida" placeholder="Gracias por comunicarse. ¡Que tenga {saludo}!"
                    description="{saludo} se reemplaza por «buenos días», «buenas tardes» o «buenas noches» según la hora real del cliente"
                    value={form.despedida_text} onChange={e => up('despedida_text', e.currentTarget.value)} />
                </>}
              </Bloque>
              <Group justify="space-between">
                <Button variant="subtle" onClick={() => setPaso('identidad')}>← Identidad</Button>
                <Button variant="light" onClick={() => setPaso('herramientas')}>Siguiente: Herramientas →</Button>
              </Group>
            </>}

            {paso === 'herramientas' && <>
              <Alert variant="light" color="blue" icon={<IconTool size={18} />}>
                El modelo <b>no ejecuta nada: pide</b>. La central decide si corresponde, lo hace y le devuelve el resultado.
                Lo que está apagado acá no existe, por más que el agente lo nombre.
              </Alert>

              {catalogo.filter(t => t.riesgo === 'lee').length > 0 && (
                <Bloque icon={<IconSearch size={18} />} titulo="Consultar datos"
                  ayuda="Si se equivocan, el agente dice algo incorrecto. Molesto, no grave. Necesitan el webhook del CRM, en «Derivaciones».">
                  <Stack gap="xs">
                    {catalogo.filter(t => t.riesgo === 'lee').map(t => (
                      <Switch key={t.id} label={t.titulo} description={t.ayuda}
                        checked={!!herr(t.id).on} onChange={e => upHerr(t.id, 'on', e.currentTarget.checked)} />
                    ))}
                  </Stack>
                  {!form.crm_webhook && Object.keys(form.herramientas || {}).some(k => (form.herramientas[k] || {}).on && catalogo.find(t => t.id === k && t.riesgo === 'lee'))
                    ? <Alert variant="light" color="orange" mt="sm" p="xs" icon={<IconAlertTriangle size={15} />}>
                        <Text size="xs">Sin webhook del CRM configurado, estas consultas siempre van a fallar y el agente va a decir que no puede confirmar.</Text>
                      </Alert> : null}
                </Bloque>
              )}

              <Bloque icon={<IconArrowRampRight size={18} />} titulo="Acciones sobre la llamada"
                ayuda="Tienen consecuencia, y todas quedan registradas.">
                <Stack gap="xs">
                  {catalogo.filter(t => t.riesgo === 'actua').map(t => (
                    <Switch key={t.id} label={t.titulo} description={t.ayuda}
                      checked={!!herr(t.id).on} onChange={e => upHerr(t.id, 'on', e.currentTarget.checked)} />
                  ))}
                </Stack>
              </Bloque>

              {catalogo.some(t => t.riesgo === 'abre') && (
                <Card withBorder radius="md" padding="md" style={{ borderColor: herr('abrir_porton').on ? 'var(--mantine-color-red-4)' : undefined }}>
                  <Group gap="sm" mb={4} wrap="nowrap">
                    <ThemeIcon variant="light" size={32} radius="md" color="red"><IconDoorEnter size={18} /></ThemeIcon>
                    <Text fw={700} fz="sm">Abrir el portón</Text>
                  </Group>
                  <Text size="xs" c="dimmed" mb="sm" ml={44}>
                    Un agente de voz escucha un nombre y un número de unidad; no puede confirmar que sean ciertos.
                    Los candados de abajo son lo que separa esto de un portero que se abre diciendo «soy de la 402».
                  </Text>
                  <Switch label={herr('abrir_porton').on ? 'El agente puede abrir' : 'Apagado'}
                    checked={!!herr('abrir_porton').on} onChange={e => upHerr('abrir_porton', 'on', e.currentTarget.checked)} />
                  <Collapse in={!!herr('abrir_porton').on}>
                    <Divider my="md" label="Candados" labelPosition="center" />
                    <Switch mb="md" color="red"
                      label="Exigir verificación previa en la misma llamada"
                      description="Sin esto, el portón se abre con lo que alguien dijo por teléfono. Es una decisión del dueño del edificio."
                      checked={herr('abrir_porton').exigir_verificacion !== false}
                      onChange={e => upHerr('abrir_porton', 'exigir_verificacion', e.currentTarget.checked)} />
                    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" mb="md">
                      <TextInput label="Ventana horaria" placeholder="07:00-22:00" description="Fuera de esta franja no abre. Admite cruzar la medianoche (22:00-06:00)."
                        value={herr('abrir_porton').ventana || ''} onChange={e => upHerr('abrir_porton', 'ventana', e.currentTarget.value)} />
                      <NumberInput label="Tope por hora" min={1} max={50} description="Frena una ráfaga a las 3 de la mañana."
                        value={herr('abrir_porton').max_por_hora ?? 3} onChange={v => upHerr('abrir_porton', 'max_por_hora', v)} />
                    </SimpleGrid>
                    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                      <Select label="Cómo abre" data={[{ value: 'dtmf', label: 'DTMF al portero (en la misma llamada)' }, { value: 'webhook', label: 'URL de un relé' }]}
                        value={herr('abrir_porton').modo || 'dtmf'} onChange={v => upHerr('abrir_porton', 'modo', v)} />
                      {(herr('abrir_porton').modo || 'dtmf') === 'dtmf'
                        ? <TextInput label="Tono" placeholder="#" description="Lo que espera tu portero" value={herr('abrir_porton').dtmf || ''} onChange={e => upHerr('abrir_porton', 'dtmf', e.currentTarget.value)} />
                        : <TextInput label="URL del relé" placeholder="http://portero.local/abrir" value={herr('abrir_porton').url || ''} onChange={e => upHerr('abrir_porton', 'url', e.currentTarget.value)} />}
                    </SimpleGrid>
                    <Group gap={6} mt="md" wrap="nowrap">
                      <IconShieldLock size={14} style={{ opacity: .6, flexShrink: 0 }} />
                      <Text size="xs" c="dimmed">Cada apertura —y cada intento rechazado— queda registrada con la hora, el llamante y el motivo.</Text>
                    </Group>
                  </Collapse>
                </Card>
              )}

              <Card withBorder radius="md" padding="md">
                <Group gap="sm" mb={4} wrap="nowrap">
                  <ThemeIcon variant="light" size={32} radius="md" color="indigo"><IconBuildingStore size={18} /></ThemeIcon>
                  <Text fw={700} fz="sm">Caja del backoffice</Text>
                </Group>
                <Text size="xs" c="dimmed" mb="sm" ml={44}>
                  Lo que el agente sabe de verdad —quién vive en la 402, si hay una visita agendada— vive en el sistema de gestión
                  del cliente. En vez de que la central aprenda cada backoffice, el backoffice <b>publica</b> sus herramientas y
                  la central se las ofrece al modelo. La central sigue decidiendo: pone el tope de tiempo, limpia la respuesta y
                  audita cada consulta.
                </Text>
                <Switch label={herr('remoto').on ? 'El agente usa también las herramientas del backoffice' : 'Apagado'}
                  checked={!!herr('remoto').on} onChange={e => upHerr('remoto', 'on', e.currentTarget.checked)} />
                <Collapse in={!!herr('remoto').on}>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" mt="md">
                    <TextInput label="URL del backoffice" placeholder="https://gestion.cliente/api/ia"
                      description="Se le piden dos rutas: /herramientas y /ejecutar"
                      value={herr('remoto').url || ''} onChange={e => upHerr('remoto', 'url', e.currentTarget.value)} />
                    <TextInput label="Secreto compartido" placeholder="para firmar cada llamada"
                      description="Va en X-PBXNG-Firma (HMAC-SHA256 del cuerpo)"
                      value={herr('remoto').token || ''} onChange={e => upHerr('remoto', 'token', e.currentTarget.value)} />
                  </SimpleGrid>
                  <NumberInput mt="md" w={220} label="Tope de respuesta" suffix=" ms" min={500} max={10000} step={500}
                    description="Pasado esto, el agente sigue sin ese dato"
                    value={herr('remoto').tope_ms ?? 3000} onChange={v => upHerr('remoto', 'tope_ms', v)} />
                  <Group mt="md">
                    <Button size="xs" variant="light" leftSection={<IconPlugConnected size={15} />} loading={probandoBo}
                      onClick={probarBackoffice} disabled={!herr('remoto').url}>Probar el backoffice</Button>
                    {pruebaBo ? <Text size="xs" c="dimmed">{pruebaBo.ms} ms en publicar el catálogo</Text> : null}
                  </Group>
                  {pruebaBo && (pruebaBo.error
                    ? <Alert variant="light" color="red" mt="sm" p="xs"><Text size="xs">{pruebaBo.error}</Text></Alert>
                    : <>
                      {pruebaBo.herramientas.length
                        ? <Alert variant="light" color="teal" mt="sm" p="xs" icon={<IconCircleCheck size={15} />}>
                            <Text size="xs" fw={600} mb={4}>Declaradas al modelo</Text>
                            <Stack gap={2}>{pruebaBo.herramientas.map(x => (
                              <Text key={x.nombre} size="xs"><Code fz={10}>{x.nombre}</Code>{x.parametros.length ? ' (' + x.parametros.join(', ') + ')' : ''}</Text>
                            ))}</Stack>
                          </Alert>
                        : <Alert variant="light" color="orange" mt="sm" p="xs" icon={<IconAlertTriangle size={15} />}>
                            <Text size="xs">El backoffice contestó, pero no quedó ninguna herramienta usable.</Text>
                          </Alert>}
                      {pruebaBo.descartes && pruebaBo.descartes.length
                        ? <Alert variant="light" color="gray" mt="xs" p="xs">
                            <Text size="xs" fw={600} mb={4}>Descartadas ({pruebaBo.descartes.length})</Text>
                            <Stack gap={2}>{pruebaBo.descartes.map((d, i) => (
                              <Text key={i} size="xs"><Code fz={10}>{d.nombre}</Code> — {d.razon}</Text>
                            ))}</Stack>
                          </Alert> : null}
                      {pruebaBo.aviso ? <Alert variant="light" color="yellow" mt="xs" p="xs"><Text size="xs">{pruebaBo.aviso}</Text></Alert> : null}
                    </>)}
                  <Alert variant="light" color="gray" mt="md" p="xs" icon={<IconShieldLock size={15} />}>
                    <Text size="xs">
                      Lo que publique el backoffice se declara con prefijo <Code fz={10}>bo_</Code> y nunca puede pisar una
                      herramienta de la central: si publica una llamada «abrir_porton», se descarta. Accionar sobre la llamada o
                      sobre la puerta es de la central, donde están los candados.
                    </Text>
                  </Alert>
                </Collapse>
              </Card>

              {Object.keys(form.herramientas || {}).some(k => k !== 'remoto' && k !== 'delegacion' && (form.herramientas[k] || {}).on) && (
                <Bloque icon={<IcoCerebro size={18} activo />} titulo="Quién razona detrás de la voz"
                  ayuda="Con herramientas encendidas son DOS modelos: el de voz escucha y habla, y este decide qué herramienta pedir. Es obligatorio: sin él la sesión no abre y la llamada se cae a «no puedo atenderte».">
                  <Select label="Modelo que razona" searchable
                    description={rtModelos && rtModelos.ok && (rtModelos.razonamiento || []).length ? 'Los que sirve tu cuenta' : 'Sugerencias'}
                    data={rtModelos && rtModelos.ok && (rtModelos.razonamiento || []).length ? rtModelos.razonamiento : ['gpt-5.1', 'gpt-5-nano', 'gpt-4.1-nano']}
                    value={(form.herramientas?.delegacion || {}).model || 'gpt-5.1'}
                    onChange={v => upHerr('delegacion', 'model', v)} />
                  <Text size="xs" c="dimmed" mt="xs">
                    Uno más chico contesta más rápido y sale menos; uno más grande entiende mejor cuándo NO usar una herramienta.
                    En una portería, lo segundo importa más de lo que parece.
                  </Text>
                </Bloque>
              )}

              <Text size="xs" c="dimmed">
                Encender cualquier herramienta hace que el modelo <b>delegue el razonamiento</b> en el backend del proveedor:
                agrega algo de latencia y puede cambiarle el tono. Escuchá una llamada después de prenderlas.
              </Text>
              <Group justify="space-between">
                <Button variant="subtle" onClick={() => setPaso('cerebro')}>← Cerebro</Button>
                <Button variant="light" onClick={() => setPaso('derivaciones')}>Siguiente: Derivaciones →</Button>
              </Group>
            </>}

            {paso === 'derivaciones' && <>
              <Bloque icon={<IconArrowRampRight size={18} />} titulo="A dónde manda la llamada"
                ayuda="Que exista una salida a una persona es la condición para prender esto en un cliente real: el agente va a dudar, y cuando dude tiene que tener a dónde ir.">
                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
                  <TextInput label="Ventas" value={form.sales_exten} onChange={e => up('sales_exten', e.currentTarget.value)} placeholder="1001" leftSection={<IconPhoneCall size={14} />} />
                  <TextInput label="Soporte" value={form.support_exten} onChange={e => up('support_exten', e.currentTarget.value)} placeholder="1002" leftSection={<IconHeadset size={14} />} />
                  <TextInput label="Por defecto" value={form.default_exten} onChange={e => up('default_exten', e.currentTarget.value)} placeholder="1001" leftSection={<IconUsers size={14} />} />
                </SimpleGrid>
              </Bloque>
              <Bloque icon={<IconInfoCircle size={18} />} titulo="Consulta de datos (opcional)"
                ayuda="El agente la usa para verificar lo que le dicen. Recibe {query, caller} y devuelve {result}; si tarda, la llamada NO se traba: hay un tope de 2,5 s.">
                <TextInput label="Webhook del CRM" placeholder="https://tu-crm/api/lookup" value={form.crm_webhook} onChange={e => up('crm_webhook', e.currentTarget.value)} />
              </Bloque>
              <Group justify="flex-start"><Button variant="subtle" onClick={() => setPaso('herramientas')}>← Herramientas</Button></Group>
            </>}
          </Stack>
          <audio ref={previewRef} style={{ display: 'none' }} />
        </ScrollArea>

        <Box p="md" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
          <Group justify="space-between" wrap="nowrap">
            <Text size="xs" c="dimmed">{enLaNube(form.provider) ? 'Se paga por minuto de conversación' : 'Sin costo: corre en tu servidor'}</Text>
            <Group gap="sm" wrap="nowrap">
              <Button variant="default" onClick={() => setOpened(false)}>Cancelar</Button>
              <Button onClick={save} loading={saving} leftSection={<IconDeviceFloppy size={16} />}>{form.id ? 'Guardar' : 'Crear agente'}</Button>
            </Group>
          </Group>
        </Box>
      </Drawer>
    </Stack>
  );
}
