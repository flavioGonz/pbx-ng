'use client';
/* ============================================================================
 *  Horarios, feriados y modo noche.
 *
 *  Es la pantalla que contesta «¿qué pasa con una llamada según la hora?».
 *  Un HORARIO es una lista de tramos (días + desde/hasta) que se le asigna a una
 *  ruta entrante en Rutas → Entrantes; fuera de esos tramos la llamada va al
 *  destino de fuera de hora de esa ruta. Los FERIADOS mandan sobre el horario
 *  (ese día está cerrado aunque sea martes) y el MODO NOCHE manda sobre todo,
 *  porque es el botón que aprieta el operador cuando cierra antes.
 *
 *  Acá NO se calcula nada: el estado de ahora lo dice la API, que es la que usa
 *  el mismo reloj y los mismos feriados que el dialplan.
 * ==========================================================================*/
import { useEffect, useMemo, useState } from 'react';
import {
  Stack, Card, Group, Text, Button, TextInput, Select, Switch, Badge, ActionIcon,
  ThemeIcon, Tabs, Alert, Skeleton, Divider, Tooltip, SegmentedControl,
} from '@mantine/core';
import {
  IconClockHour4, IconPlus, IconTrash, IconDeviceFloppy, IconInfoCircle, IconCalendarEvent,
  IconCalendarOff, IconMoonStars, IconCopy,
} from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import NightModeCard from '../NightMode';
import { apiPost, apiPut, apiDel, usePoll } from '../api';
import { fmtFecha } from '../fmt';
import { toast } from '../notify';

/* Los días se guardan como los entiende `GotoIfTime` (mon, tue… y rangos); el
 * panel sólo traduce para mostrarlos. Si mañana hace falta un rango raro
 * (por ejemplo mié-vie) se agrega acá y no hay que tocar nada más. */
const DIAS = [
  { value: 'mon-fri', label: 'Lunes a viernes' },
  { value: 'mon-sat', label: 'Lunes a sábado' },
  { value: 'mon-sun', label: 'Todos los días' },
  { value: 'sat-sun', label: 'Sábado y domingo' },
  { value: 'mon', label: 'Lunes' }, { value: 'tue', label: 'Martes' }, { value: 'wed', label: 'Miércoles' },
  { value: 'thu', label: 'Jueves' }, { value: 'fri', label: 'Viernes' }, { value: 'sat', label: 'Sábado' },
  { value: 'sun', label: 'Domingo' },
];
const ORDEN = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const CORTO = { mon: 'Lun', tue: 'Mar', wed: 'Mié', thu: 'Jue', fri: 'Vie', sat: 'Sáb', sun: 'Dom' };
const etiquetaDias = (d) => (DIAS.find((x) => x.value === d) || {}).label || d;

/* Qué días cubre un tramo: sirve para pintar la semana. Acepta 'mon', 'mon-fri'
 * y la lista separada por coma por si la API la devuelve así. */
function diasDe(dias) {
  const out = new Set();
  String(dias || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((parte) => {
    const [a, b] = parte.split('-');
    const ia = ORDEN.indexOf(a);
    if (ia < 0) return;
    const ib = b ? ORDEN.indexOf(b) : ia;
    if (ib < 0) { out.add(ORDEN[ia]); return; }
    for (let i = ia; ; i = (i + 1) % 7) { out.add(ORDEN[i]); if (i === ib) break; }
  });
  return out;
}

/* Semana de un vistazo: una columna por día con las horas que cubre. Es el
 * «editor visual» que pide el sprint sin inventar una grilla arrastrable: lo que
 * el usuario necesita ver es qué días quedaron sin cubrir. */
function Semana({ tramos }) {
  const porDia = useMemo(() => {
    const m = {}; ORDEN.forEach((d) => { m[d] = []; });
    (tramos || []).forEach((t) => { diasDe(t.dias).forEach((d) => { if (m[d]) m[d].push(t); }); });
    return m;
  }, [tramos]);
  return (
    <Group gap={6} wrap="nowrap" style={{ overflowX: 'auto' }}>
      {ORDEN.map((d) => {
        const ts = porDia[d];
        const abierto = ts.length > 0;
        return (
          <Card key={d} withBorder radius="md" padding={6} style={{ minWidth: 74, flex: 1, textAlign: 'center', background: abierto ? 'rgba(18,184,134,.08)' : 'rgba(120,130,150,.07)' }}>
            <Text fz={11} fw={700} c={abierto ? undefined : 'dimmed'}>{CORTO[d]}</Text>
            {abierto
              ? ts.map((t, i) => <Text key={i} fz={10} ff="monospace" c="dimmed">{t.desde}–{t.hasta}</Text>)
              : <Text fz={10} c="dimmed">cerrado</Text>}
          </Card>
        );
      })}
    </Group>
  );
}

const TRAMO_NUEVO = { dias: 'mon-fri', desde: '09:00', hasta: '18:00' };

function HorarioCard({ h, onRecargar }) {
  const [nombre, setNombre] = useState(h.nombre || '');
  const [activo, setActivo] = useState(h.activo !== false);
  const [tramos, setTramos] = useState(Array.isArray(h.tramos) ? h.tramos : []);
  const [guardando, setGuardando] = useState(false);

  // Si otro operador lo cambió, el poll trae la versión nueva: se toma como base.
  useEffect(() => {
    setNombre(h.nombre || '');
    setActivo(h.activo !== false);
    setTramos(Array.isArray(h.tramos) ? h.tramos : []);
  }, [h]);

  const setTramo = (i, k, v) => setTramos((ts) => ts.map((t, j) => (j === i ? { ...t, [k]: v } : t)));
  const borrarTramo = (i) => setTramos((ts) => ts.filter((_, j) => j !== i));
  const agregar = () => setTramos((ts) => [...ts, { ...TRAMO_NUEVO }]);
  const duplicar = (i) => setTramos((ts) => [...ts.slice(0, i + 1), { ...ts[i] }, ...ts.slice(i + 1)]);

  async function guardar() {
    if (!nombre.trim()) { toast('Poné un nombre al horario', 'bad'); return; }
    for (const t of tramos) {
      if (!t.desde || !t.hasta) { toast('Cada tramo necesita hora de inicio y de fin', 'bad'); return; }
      if (t.desde >= t.hasta) { toast('El tramo ' + t.desde + '–' + t.hasta + ' termina antes de empezar', 'bad', { description: 'Para un horario que cruza la medianoche usá dos tramos.' }); return; }
    }
    setGuardando(true);
    try {
      await apiPut('/horarios/' + h.id, { nombre: nombre.trim(), activo, tramos });
      toast('Horario «' + nombre.trim() + '» guardado', 'ok');
      onRecargar();
    } catch (e) { toast(e.message, 'bad'); }
    setGuardando(false);
  }
  async function borrar() {
    if (!confirm('¿Borrar el horario «' + (h.nombre || h.id) + '»? Las rutas que lo usen quedan sin horario (siempre al destino normal).')) return;
    try { await apiDel('/horarios/' + h.id); toast('Horario borrado', 'info'); onRecargar(); }
    catch (e) { toast(e.message, 'bad'); }
  }

  return (
    <Card withBorder radius="lg" padding="lg">
      <Group justify="space-between" wrap="wrap" gap="sm" mb="sm">
        <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 240 }}>
          <ThemeIcon size={34} radius="md" variant="light" color={activo ? 'indigo' : 'gray'}><IconClockHour4 size={18} /></ThemeIcon>
          <TextInput size="sm" w={260} value={nombre} onChange={(e) => setNombre(e.currentTarget.value)}
            placeholder="Horario de oficina" aria-label="Nombre del horario" />
          <Badge variant="light" color="gray" ff="monospace">#{h.id}</Badge>
        </Group>
        <Group gap="sm">
          <Switch size="sm" label="Activo" checked={activo} onChange={(e) => setActivo(e.currentTarget.checked)} />
          <Button size="compact-sm" loading={guardando} leftSection={<IconDeviceFloppy size={14} />} onClick={guardar}>Guardar</Button>
          <Tooltip label="Borrar horario"><ActionIcon variant="subtle" color="red" onClick={borrar}><IconTrash size={17} /></ActionIcon></Tooltip>
        </Group>
      </Group>

      <Semana tramos={tramos} />

      <Divider my="sm" label="Tramos abiertos" labelPosition="left" />
      <Stack gap={8}>
        {tramos.length === 0 && (
          <Text fz="sm" c="dimmed">Sin tramos: con este horario la central queda SIEMPRE cerrada. Agregá al menos uno.</Text>
        )}
        {tramos.map((t, i) => (
          <Group key={i} gap="sm" wrap="wrap" align="flex-end">
            <Select w={190} size="xs" label={i === 0 ? 'Días' : undefined} data={DIAS} value={t.dias}
              allowDeselect={false} onChange={(v) => setTramo(i, 'dias', v || 'mon-fri')} />
            <TextInput w={120} size="xs" type="time" label={i === 0 ? 'Desde' : undefined}
              value={t.desde || ''} onChange={(e) => setTramo(i, 'desde', e.currentTarget.value)} />
            <TextInput w={120} size="xs" type="time" label={i === 0 ? 'Hasta' : undefined}
              value={t.hasta || ''} onChange={(e) => setTramo(i, 'hasta', e.currentTarget.value)} />
            <Tooltip label="Duplicar tramo"><ActionIcon variant="subtle" color="gray" onClick={() => duplicar(i)}><IconCopy size={16} /></ActionIcon></Tooltip>
            <Tooltip label="Quitar tramo"><ActionIcon variant="subtle" color="red" onClick={() => borrarTramo(i)}><IconTrash size={16} /></ActionIcon></Tooltip>
            <Text fz="xs" c="dimmed" mb={6}>{etiquetaDias(t.dias)} de {t.desde || '—'} a {t.hasta || '—'}</Text>
          </Group>
        ))}
        <Button size="compact-xs" variant="light" w="fit-content" leftSection={<IconPlus size={13} />} onClick={agregar}>
          Agregar tramo
        </Button>
        <Text fz="xs" c="dimmed">
          Para cortar al mediodía se ponen dos tramos el mismo día (por ejemplo 09:00–13:00 y 14:00–18:00).
        </Text>
      </Stack>
    </Card>
  );
}

function Horarios() {
  const { data, error, cargando, recargar } = usePoll('/horarios', 30000);
  const lista = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const [creando, setCreando] = useState(false);
  useEffect(() => { if (error) toast(error.message, 'bad'); }, [error]);

  async function crear() {
    setCreando(true);
    try {
      await apiPost('/horarios', { nombre: 'Horario de oficina', activo: true, tramos: [{ ...TRAMO_NUEVO }] });
      toast('Horario creado: ajustá los tramos y guardá', 'ok');
      recargar();
    } catch (e) { toast(e.message, 'bad'); }
    setCreando(false);
  }

  return (
    <Stack gap="md">
      <Alert variant="light" color="indigo" icon={<IconInfoCircle size={18} />}>
        Un horario dice <b>cuándo la central está abierta</b>. Se le asigna a una ruta entrante en
        <b> Rutas → Entrantes</b>: dentro del horario la llamada va al destino normal (IVR, cola,
        interno) y fuera de él al destino de fuera de hora.
      </Alert>
      <Group justify="flex-end">
        <Button loading={creando} leftSection={<IconPlus size={16} />} onClick={crear}>Nuevo horario</Button>
      </Group>
      {cargando && !lista.length ? <Skeleton h={220} radius="lg" /> :
        lista.length === 0 ? (
          <Card withBorder radius="lg" padding="xl">
            <Text ta="center" c="dimmed" fz="sm">Todavía no hay horarios. Creá uno y asignalo a una ruta entrante.</Text>
          </Card>
        ) : lista.map((h) => <HorarioCard key={h.id} h={h} onRecargar={recargar} />)}
    </Stack>
  );
}

/* ─────────────── Feriados ─────────────── */
function Feriados() {
  const { data, error, cargando, recargar } = usePoll('/feriados', 30000);
  const lista = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const [tipo, setTipo] = useState('anual');
  const [nombre, setNombre] = useState('');
  const [fecha, setFecha] = useState('');
  const [guardando, setGuardando] = useState(false);
  useEffect(() => { if (error) toast(error.message, 'bad'); }, [error]);

  async function crear() {
    if (!fecha) { toast('Elegí la fecha', 'bad'); return; }
    if (!nombre.trim()) { toast('Poné un nombre (por ejemplo «Año Nuevo»)', 'bad'); return; }
    setGuardando(true);
    try {
      /* Anual = se repite todos los años, así que se guarda MM-DD (`md`) y no una
       * fecha con año; puntual = una fecha concreta (un paro, una mudanza). */
      const body = tipo === 'anual'
        ? { anual: true, md: fecha.slice(5), nombre: nombre.trim() }
        : { anual: false, fecha, nombre: nombre.trim() };
      await apiPost('/feriados', body);
      toast('Feriado agregado', 'ok');
      setNombre(''); setFecha(''); recargar();
    } catch (e) { toast(e.message, 'bad'); }
    setGuardando(false);
  }
  async function borrar(f) {
    if (!confirm('¿Borrar «' + (f.nombre || f.md || f.fecha) + '»?')) return;
    try { await apiDel('/feriados/' + f.id); toast('Feriado borrado', 'info'); recargar(); }
    catch (e) { toast(e.message, 'bad'); }
  }

  return (
    <Stack gap="md">
      <Alert variant="light" color="orange" icon={<IconCalendarOff size={18} />}>
        Un feriado cierra la central ese día <b>aunque el horario diga que está abierta</b>.
        Los <b>anuales</b> se repiten todos los años (1 de enero, 25 de diciembre); los
        <b> puntuales</b> valen sólo para esa fecha.
      </Alert>

      <Card withBorder radius="lg" padding="lg">
        <Group gap="sm" align="flex-end" wrap="wrap">
          <SegmentedControl size="sm" value={tipo} onChange={setTipo} data={[
            { value: 'anual', label: 'Se repite todos los años' },
            { value: 'puntual', label: 'Sólo esta fecha' },
          ]} />
          <TextInput w={180} size="sm" type="date" label="Fecha" value={fecha}
            onChange={(e) => setFecha(e.currentTarget.value)}
            description={tipo === 'anual' ? 'Se usa sólo el día y el mes' : 'Fecha exacta'} />
          <TextInput w={240} size="sm" label="Nombre" placeholder="Año Nuevo" value={nombre}
            onChange={(e) => setNombre(e.currentTarget.value)} />
          <Button size="sm" loading={guardando} leftSection={<IconPlus size={16} />} onClick={crear}>Agregar feriado</Button>
        </Group>
      </Card>

      {cargando && !lista.length ? <Skeleton h={160} radius="lg" /> :
        lista.length === 0 ? (
          <Card withBorder radius="lg" padding="xl"><Text ta="center" c="dimmed" fz="sm">Sin feriados cargados.</Text></Card>
        ) : (
          <Card withBorder radius="lg" padding="md">
            <Stack gap={6}>
              {lista.map((f) => (
                <Group key={f.id} justify="space-between" wrap="nowrap"
                  style={{ padding: '6px 8px', borderRadius: 8, background: 'rgba(120,130,150,.06)' }}>
                  <Group gap={10} wrap="nowrap">
                    <ThemeIcon size={28} radius="md" variant="light" color={f.anual !== false ? 'orange' : 'grape'}>
                      <IconCalendarEvent size={15} />
                    </ThemeIcon>
                    <div>
                      <Text fz="sm" fw={600}>{f.nombre || 'Feriado'}</Text>
                      <Text fz="xs" c="dimmed" ff="monospace">
                        {f.anual !== false ? (f.md || '') + ' · todos los años' : fmtFecha(f.fecha)}
                      </Text>
                    </div>
                  </Group>
                  <ActionIcon variant="subtle" color="red" onClick={() => borrar(f)}><IconTrash size={16} /></ActionIcon>
                </Group>
              ))}
            </Stack>
          </Card>
        )}
    </Stack>
  );
}

export default function HorariosPage() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconClockHour4 size={24} />} color="indigo" title="Horarios y modo noche"
        subtitle="Cuándo está abierta la central, qué días son feriado y a dónde entran las llamadas fuera de hora" />
      <NightModeCard />
      <Tabs defaultValue="horarios" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="horarios" leftSection={<IconClockHour4 size={15} />}>Horarios</Tabs.Tab>
          <Tabs.Tab value="feriados" leftSection={<IconCalendarOff size={15} />}>Feriados</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="horarios"><Horarios /></Tabs.Panel>
        <Tabs.Panel value="feriados"><Feriados /></Tabs.Panel>
      </Tabs>
      <Text fz="xs" c="dimmed">
        <IconMoonStars size={12} style={{ verticalAlign: -2 }} /> El modo noche manda sobre el horario
        y sobre los feriados: mientras esté forzado, la central no vuelve sola a automático.
      </Text>
    </Stack>
  );
}
