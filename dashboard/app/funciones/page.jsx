'use client';
/* ============================================================================
 *  Funciones de telefonía: aparcado, captura de llamada y música en espera.
 *
 *  Las tres viven en ARCHIVOS de Asterisk (no en la base), así que el panel las
 *  genera en un directorio compartido y recarga el módulo correspondiente. Por eso
 *  cada bloque tiene su botón de "Aplicar": guardar no alcanza, hay que recargar.
 * ==========================================================================*/
import { useEffect, useRef, useState } from 'react';
import {
  Card, Group, Text, Badge, Table, Stack, Button, TextInput, NumberInput, Select,
  ThemeIcon, Tooltip, ActionIcon, Alert, Tabs, Switch, Code, FileButton, Skeleton,
} from '@mantine/core';
import {
  IconParking, IconHandGrab, IconMusic, IconPlayerPlay, IconTrash, IconUpload,
  IconInfoCircle, IconPlus, IconDeviceFloppy, IconRefresh, IconPhonePause, IconClock,
} from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast, toastPromise } from '../notify';

/* El panel del PBX habla con su API por /backend/api (sin helper global): este
   envoltorio hace lo mismo que el resto de las pantallas, con manejo de error. */
async function api(path, opts = {}) {
  const r = await fetch('/backend/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}


/* ─────────────── Aparcado de llamadas ─────────────── */
function Parking() {
  const [cfg, setCfg] = useState(null);
  const [lots, setLots] = useState('');
  const cargar = () => api('/parking').then(setCfg).catch((e) => toast(e.message, 'bad'));
  useEffect(() => { cargar(); }, []);

  const guardar = () => toastPromise(
    api('/parking', { method: 'PUT', body: cfg }),
    { loading: 'Guardando…', success: 'Guardado (aplicá para que Asterisk lo tome)', error: (e) => e.message });

  const aplicar = () => toastPromise(
    api('/parking/apply', { method: 'POST' }).then((r) => { if (r && r.error) throw new Error(r.error); return r; }),
    { loading: 'Aplicando en Asterisk…', success: 'Aparcado activo', error: (e) => e.message });

  const verPlazas = () => api('/parking/lots').then(setLots).catch((e) => toast(e.message, 'bad'));
  // Refresco automático mientras el panel de plazas está abierto: una llamada aparcada
  // es algo que cambia solo, y mirar una foto vieja no sirve.
  useEffect(() => {
    if (!lots) return;
    const t = setInterval(() => api('/parking/lots').then(setLots).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [!!lots]);

  if (!cfg) return <Skeleton h={220} radius="lg" />;
  const plazas = Math.max(0, (cfg.hasta || 0) - (cfg.desde || 0) + 1);

  return (
    <Stack gap="md">
      <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />}>
        Transferí una llamada al <b>{cfg.parkext}</b> y Asterisk dice en qué plaza quedó
        (por ejemplo la <b>{cfg.desde}</b>). Desde cualquier interno se marca esa plaza para
        recuperarla. Si nadie la atiende en {cfg.parkingtime} s, vuelve a timbrar donde estaba.
      </Alert>

      <Card withBorder p="lg" radius="md">
        <Group align="flex-end" gap="md" wrap="wrap">
          <TextInput label="Número para aparcar" description="A dónde se transfiere la llamada"
            w={170} value={cfg.parkext} onChange={(e) => setCfg({ ...cfg, parkext: e.currentTarget.value })} />
          <NumberInput label="Primera plaza" w={140} value={cfg.desde} onChange={(v) => setCfg({ ...cfg, desde: v })} />
          <NumberInput label="Última plaza" w={140} value={cfg.hasta} onChange={(v) => setCfg({ ...cfg, hasta: v })} />
          <NumberInput label="Tiempo de espera (s)" description="Antes de volver a timbrar" w={180}
            value={cfg.parkingtime} onChange={(v) => setCfg({ ...cfg, parkingtime: v })} />
          <Switch label="Vuelve a quien la aparcó" checked={!!cfg.comebacktoorigin} mb={6}
            onChange={(e) => setCfg({ ...cfg, comebacktoorigin: e.currentTarget.checked })} />
        </Group>
        <Group mt="md" gap="sm">
          <Badge variant="light" color="blue">{plazas} plaza(s): {cfg.desde}–{cfg.hasta}</Badge>
          <Button variant="default" leftSection={<IconDeviceFloppy size={16} />} onClick={guardar}>Guardar</Button>
          <Button leftSection={<IconPlayerPlay size={16} />} onClick={aplicar}>Aplicar en Asterisk</Button>
          <Button variant={lots ? 'light' : 'subtle'} leftSection={<IconRefresh size={16} />} onClick={verPlazas}>
            {lots ? 'Actualizar plazas' : 'Ver plazas ocupadas'}
          </Button>
          {lots && <Button variant="subtle" color="gray" onClick={() => setLots(null)}>Ocultar</Button>}
        </Group>

        {lots && (
          <Card withBorder radius="md" p={0} mt="md">
            <Group justify="space-between" p="sm" px="md" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
              <Group gap={9}>
                <ThemeIcon size={28} radius="md" variant="light" color={lots.ocupadas ? 'orange' : 'teal'}><IconParking size={16} /></ThemeIcon>
                <div>
                  <Text fw={700} size="sm">Plazas del aparcado</Text>
                  <Text size="10px" c="dimmed">se actualiza solo cada 5 s</Text>
                </div>
              </Group>
              <Group gap={6}>
                <Badge variant="light" color="orange">{lots.ocupadas} ocupada(s)</Badge>
                <Badge variant="light" color="teal">{lots.total - lots.ocupadas} libre(s)</Badge>
              </Group>
            </Group>
            <Table highlightOnHover verticalSpacing="xs" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={90}>Plaza</Table.Th><Table.Th>Estado</Table.Th>
                  <Table.Th>Quién está esperando</Table.Th><Table.Th>Aparcada por</Table.Th><Table.Th w={110}>Vuelve en</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(lots.plazas || []).map((p) => (
                  <Table.Tr key={p.plaza} style={p.libre ? undefined : { background: 'light-dark(rgba(251,146,60,.07), rgba(251,146,60,.10))' }}>
                    <Table.Td>
                      <Group gap={7} wrap="nowrap">
                        <ThemeIcon size={24} radius="md" variant={p.libre ? 'light' : 'filled'} color={p.libre ? 'gray' : 'orange'}>
                          {p.libre ? <IconParking size={13} /> : <IconPhonePause size={13} />}
                        </ThemeIcon>
                        <Text ff="monospace" fw={700}>{p.plaza}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant={p.libre ? 'light' : 'filled'} color={p.libre ? 'gray' : 'orange'}>
                        {p.libre ? 'libre' : 'ocupada'}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {p.libre ? <Text size="xs" c="dimmed">—</Text> : (
                        <div>
                          <Text size="sm" fw={600}>{p.nombre || p.numero || 'desconocido'}</Text>
                          {p.numero && p.nombre && <Text size="10px" c="dimmed" ff="monospace">{p.numero}</Text>}
                        </div>
                      )}
                    </Table.Td>
                    <Table.Td fz="xs" c="dimmed">{p.libre ? '—' : (p.aparcada_por || '—')}</Table.Td>
                    <Table.Td>
                      {p.libre ? <Text size="xs" c="dimmed">—</Text> : (
                        <Group gap={5} wrap="nowrap">
                          <IconClock size={13} style={{ opacity: .5 }} />
                          <Text size="xs" fw={600}>{p.restante != null ? `${p.restante} s` : '—'}</Text>
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {lots.ocupadas === 0 && (
              <Text size="xs" c="dimmed" ta="center" py="sm">
                Ninguna llamada aparcada ahora. Transferí una al {cfg.parkext} y va a aparecer acá.
              </Text>
            )}
          </Card>
        )}
      </Card>
    </Stack>
  );
}

/* ─────────────── Captura de llamada ─────────────── */
function Pickup() {
  const [rows, setRows] = useState(null);
  const cargar = () => api('/pickup-groups').then(setRows).catch(() => setRows([]));
  useEffect(() => { cargar(); }, []);

  const set = (ext, grupo) => toastPromise(
    api(`/pickup-groups/${ext}`, { method: 'PUT', body: { grupo } }).then(cargar),
    { loading: 'Guardando…', success: `${ext}: grupo "${grupo || 'sin grupo'}"`, error: (e) => e.message });

  return (
    <Stack gap="md">
      <Alert variant="light" color="teal" icon={<IconInfoCircle size={18} />}>
        <b>*8</b> atiende el teléfono que está sonando en <b>tu mismo grupo</b>.
        <b> **&lt;interno&gt;</b> atiende el de ese interno en concreto (por ejemplo <Code>**1001</Code>),
        sin importar el grupo. Poné el mismo nombre de grupo a los internos que se cubren entre sí
        (por ejemplo <Code>ventas</Code> o <Code>recepcion</Code>).
      </Alert>

      <Card withBorder p={0} radius="md">
        {!rows ? <Skeleton h={200} radius="lg" /> : (
          <Table highlightOnHover verticalSpacing="sm" fz="sm">
            <Table.Thead>
              <Table.Tr><Table.Th>Interno</Table.Th><Table.Th>Grupo de captura</Table.Th><Table.Th w={120} /></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => <FilaPickup key={r.ext} r={r} onSave={set} />)}
              {rows.length === 0 && (
                <Table.Tr><Table.Td colSpan={3}><Text size="sm" c="dimmed" ta="center" py="lg">No hay internos todavía.</Text></Table.Td></Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
function FilaPickup({ r, onSave }) {
  const [v, setV] = useState(r.named_pickup_group || '');
  const cambiado = (v || '') !== (r.named_pickup_group || '');
  return (
    <Table.Tr>
      <Table.Td ff="monospace" fw={650}>{r.ext}</Table.Td>
      <Table.Td>
        <TextInput size="xs" w={220} placeholder="sin grupo" value={v} onChange={(e) => setV(e.currentTarget.value)} />
      </Table.Td>
      <Table.Td>
        <Button size="compact-sm" variant={cambiado ? 'filled' : 'default'} disabled={!cambiado} onClick={() => onSave(r.ext, v)}>Guardar</Button>
      </Table.Td>
    </Table.Tr>
  );
}

/* ─────────────── Música en espera ─────────────── */
function Moh() {
  const [clases, setClases] = useState(null);
  const [nueva, setNueva] = useState('');
  const resetRef = useRef(null);
  const cargar = () => api('/moh').then(setClases).catch(() => setClases([]));
  useEffect(() => { cargar(); }, []);

  const crear = () => {
    if (!nueva.trim()) return;
    toastPromise(api('/moh', { method: 'POST', body: { nombre: nueva.trim() } }).then(() => { setNueva(''); cargar(); }),
      { loading: 'Creando…', success: 'Clase creada: ahora subile audios', error: (e) => e.message });
  };
  const borrar = (n) => {
    if (!confirm(`¿Borrar la clase "${n}" y sus audios?`)) return;
    toastPromise(api(`/moh/${n}`, { method: 'DELETE' }).then(cargar), { loading: 'Borrando…', success: 'Clase borrada', error: (e) => e.message });
  };
  const subir = async (clase, file) => {
    if (!file) return;
    const data = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(file); });
    toastPromise(api(`/moh/${clase}/audio`, { method: 'POST', body: { filename: file.name, data } }).then(cargar),
      { loading: `Subiendo ${file.name}…`, success: 'Audio subido (aplicá para que suene)', error: (e) => e.message });
  };
  const borrarAudio = (clase, f) => toastPromise(
    api(`/moh/${clase}/audio/${f}`, { method: 'DELETE' }).then(cargar),
    { loading: 'Borrando…', success: 'Audio borrado', error: (e) => e.message });
  const aplicar = () => toastPromise(
    api('/moh/apply', { method: 'POST' }).then((r) => { if (r && r.error) throw new Error(r.error); return r; }),
    { loading: 'Recargando música en espera…', success: (r) => `Aplicado: ${(r && r.clases) || 0} clase(s)`, error: (e) => e.message });

  return (
    <Stack gap="md">
      <Alert variant="light" color="grape" icon={<IconInfoCircle size={18} />}>
        Una <b>clase</b> es una carpeta de audios. Creá la clase, subile los archivos y tocá
        <b> Aplicar</b>. Después se elige por cola (o como música del sistema). Formatos:
        <Code>wav</Code>, <Code>gsm</Code>, <Code>ulaw</Code>, <Code>alaw</Code>, <Code>sln</Code>, <Code>g722</Code>.
        La clase <Code>default</Code> es la de fábrica y no se toca desde acá.
      </Alert>

      <Group gap="sm">
        <TextInput placeholder="Nombre de la clase (ej: ventas)" value={nueva} w={280}
          onChange={(e) => setNueva(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') crear(); }} />
        <Button leftSection={<IconPlus size={16} />} onClick={crear}>Nueva clase</Button>
        <Button ml="auto" leftSection={<IconPlayerPlay size={16} />} onClick={aplicar}>Aplicar en Asterisk</Button>
      </Group>

      {!clases ? <Skeleton h={200} radius="lg" /> : clases.length === 0 ? (
        <Card withBorder p="xl" radius="md"><Text size="sm" c="dimmed" ta="center">Sin clases propias. Creá una para subir tu música.</Text></Card>
      ) : clases.map((c) => (
        <Card key={c.nombre} withBorder p="md" radius="md">
          <Group justify="space-between" mb="sm">
            <Group gap={9}>
              <ThemeIcon size={30} radius="md" variant="light" color="grape"><IconMusic size={17} /></ThemeIcon>
              <div>
                <Text fw={700}>{c.nombre}</Text>
                <Text size="xs" c="dimmed">{(c.archivos || []).length} audio(s) · orden: {c.sort}</Text>
              </div>
            </Group>
            <Group gap="xs">
              <FileButton resetRef={resetRef} onChange={(f) => subir(c.nombre, f)} accept="audio/*">
                {(props) => <Button {...props} size="compact-sm" variant="light" leftSection={<IconUpload size={14} />}>Subir audio</Button>}
              </FileButton>
              <Tooltip label="Borrar la clase y sus audios">
                <ActionIcon variant="subtle" color="red" onClick={() => borrar(c.nombre)}><IconTrash size={16} /></ActionIcon>
              </Tooltip>
            </Group>
          </Group>
          {(c.archivos || []).length === 0
            ? <Text size="sm" c="dimmed">Sin audios todavía.</Text>
            : <Group gap={7} wrap="wrap">
                {c.archivos.map((f) => (
                  <Badge key={f} size="lg" variant="light" color="grape" pr={3}
                    rightSection={<ActionIcon size="xs" variant="transparent" color="red" onClick={() => borrarAudio(c.nombre, f)}><IconTrash size={11} /></ActionIcon>}>
                    {f}
                  </Badge>
                ))}
              </Group>}
        </Card>
      ))}
    </Stack>
  );
}

export default function Funciones() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconParking size={24} />} title="Funciones de telefonía"
        subtitle="Aparcado de llamadas, captura entre compañeros y música en espera" />
      <Tabs defaultValue="parking" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="parking" leftSection={<IconParking size={15} />}>Aparcado</Tabs.Tab>
          <Tabs.Tab value="pickup" leftSection={<IconHandGrab size={15} />}>Captura</Tabs.Tab>
          <Tabs.Tab value="moh" leftSection={<IconMusic size={15} />}>Música en espera</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="parking"><Parking /></Tabs.Panel>
        <Tabs.Panel value="pickup"><Pickup /></Tabs.Panel>
        <Tabs.Panel value="moh"><Moh /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
