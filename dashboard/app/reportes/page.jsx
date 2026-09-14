'use client';
/* ============================================================================
 *  Reportes de call center.
 *
 *  Es la pantalla que contesta «¿cómo atendimos?»: por cola y por agente, sobre un
 *  rango de fechas. No es el CDR (eso es /cdr, llamada por llamada) ni el wallboard
 *  (eso es ahora mismo): acá se mira un período cerrado y se firma.
 *
 *  Nada se calcula en el navegador. La API devuelve los agregados ya hechos en SQL
 *  para que un trimestre no se convierta en miles de filas viajando por la red; lo
 *  único que hace esta pantalla es pedir, mostrar y ofrecer las exportaciones.
 *
 *  El informe NO se genera solo al abrir la pantalla: hay un botón. Un rango largo
 *  sobre una central con tráfico es trabajo de verdad, y un poll automático lo
 *  repetiría cada vez que alguien deja la pestaña abierta.
 * ==========================================================================*/
import { useEffect, useState } from 'react';
import {
  Stack, Card, Group, Text, Button, TextInput, Select, NumberInput, Badge, Table,
  ThemeIcon, Alert, Tooltip, Switch, ActionIcon, Divider, Title,
} from '@mantine/core';
import {
  IconReportAnalytics, IconDownload, IconPrinter, IconSearch, IconInfoCircle,
  IconHeadset, IconUsers, IconClock, IconPhoneOff, IconTargetArrow, IconMail,
  IconPlus, IconTrash, IconDeviceFloppy, IconSend, IconMoonStars,
} from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { api, apiGet, apiPost, apiPut, apiDel, useApi } from '../api';
import { fmtDur, fmtFecha, fmtPct } from '../fmt';
import { toast, toastPromise } from '../notify';
import { useEsAdmin } from '../auth';

/* Tope del backend (ccreport.js). Se repite acá para poder avisar ANTES de mandar un
 * pedido que ya sabemos que va a volver con 400. */
const MAX_DIAS = 92;
const hoy = () => new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const menos = (n) => { const d = hoy(); d.setDate(d.getDate() - n); return ymd(d); };

const PERIODOS = [
  { value: 'diario', label: 'Todos los días (el día anterior)' },
  { value: 'semanal', label: 'Una vez por semana (los últimos 7 días)' },
  { value: 'mensual', label: 'Una vez por mes (el mes anterior)' },
];
const DIAS_SEM = [
  { value: '1', label: 'Lunes' }, { value: '2', label: 'Martes' }, { value: '3', label: 'Miércoles' },
  { value: '4', label: 'Jueves' }, { value: '5', label: 'Viernes' }, { value: '6', label: 'Sábado' }, { value: '7', label: 'Domingo' },
];

/* Verde a partir del 80 %: es el umbral que usa todo el mundo para «nivel de servicio
 * aceptable». Sin dato (null) no se pinta de rojo: no medido no es incumplido. */
const colorSla = (v) => (v == null ? 'gray' : v >= 80 ? 'teal' : v >= 60 ? 'yellow' : 'red');

function Kpi({ icon: Icon, color, valor, etiqueta, detalle, tip }) {
  return (
    <Tooltip label={tip} withArrow position="bottom" disabled={!tip}>
      <Group gap={9} wrap="nowrap" style={{ cursor: tip ? 'help' : undefined }}>
        <ThemeIcon size={34} radius="md" variant="light" color={color}><Icon size={19} /></ThemeIcon>
        <div>
          <Text fw={800} fz={21} lh={1}>{valor}</Text>
          <Text fz={11} c="dimmed" lh={1.15}>{etiqueta}{detalle ? ` · ${detalle}` : ''}</Text>
        </div>
      </Group>
    </Tooltip>
  );
}

/* ── Envío programado (sólo admin) ─────────────────────────────────────────── */
function Programacion({ p, colas, onCambio }) {
  const [f, setF] = useState({ ...p, dia: p.dia == null ? 1 : p.dia });
  const [guardando, setGuardando] = useState(false);
  useEffect(() => { setF({ ...p, dia: p.dia == null ? 1 : p.dia }); }, [p]);

  const guardar = async () => {
    setGuardando(true);
    try {
      await apiPut('/ccreport/schedules/' + p.id, f);
      toast('Programación guardada');
      onCambio();
    } catch (e) { toast(e.message, 'bad'); } finally { setGuardando(false); }
  };
  const borrar = () => toastPromise(apiDel('/ccreport/schedules/' + p.id).then(onCambio),
    { loading: 'Borrando…', success: 'Programación borrada', error: (e) => e.message });
  const probar = () => toastPromise(apiPost('/ccreport/schedules/' + p.id + '/test'),
    { loading: 'Enviando…', success: 'Informe enviado: revisá la casilla', error: (e) => e.message });

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" wrap="wrap" gap="sm" mb="sm">
        <Group gap="sm" wrap="nowrap">
          <Switch checked={!!f.enabled} onChange={(e) => setF({ ...f, enabled: e.currentTarget.checked })} label={f.enabled ? 'Activa' : 'Pausada'} />
          {p.last_run_at && <Badge variant="light" color="gray">Último envío: {fmtFecha(p.last_run_at)}</Badge>}
        </Group>
        <Group gap="xs">
          <Tooltip label="Mandar ahora el informe que le tocaría, para probar el correo" withArrow>
            <Button size="xs" variant="light" leftSection={<IconSend size={14} />} onClick={probar}>Probar envío</Button>
          </Tooltip>
          <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={guardando} onClick={guardar}>Guardar</Button>
          <ActionIcon variant="light" color="red" onClick={borrar} aria-label="Borrar programación"><IconTrash size={16} /></ActionIcon>
        </Group>
      </Group>
      <Group grow align="flex-start" wrap="wrap">
        <TextInput label="Nombre" value={f.nombre || ''} onChange={(e) => setF({ ...f, nombre: e.target.value })} />
        <Select label="Cola" data={[{ value: '', label: 'Todas las colas' }, ...colas]} value={f.cola || ''} onChange={(v) => setF({ ...f, cola: v || '' })} />
        <Select label="Cada cuánto" data={PERIODOS} value={f.periodo} onChange={(v) => setF({ ...f, periodo: v || 'diario' })} />
      </Group>
      <Group grow align="flex-start" wrap="wrap" mt="sm">
        <NumberInput label="Hora de envío" min={0} max={23} value={f.hora} onChange={(v) => setF({ ...f, hora: Number(v) || 0 })} />
        {f.periodo === 'semanal'
          ? <Select label="Día de la semana" data={DIAS_SEM} value={String(f.dia || 1)} onChange={(v) => setF({ ...f, dia: Number(v) || 1 })} />
          : f.periodo === 'mensual'
            ? <NumberInput label="Día del mes" description="hasta 28: así también sale en febrero" min={1} max={28} value={f.dia || 1} onChange={(v) => setF({ ...f, dia: Number(v) || 1 })} />
            : <TextInput label="Día" value="todos" disabled />}
        <NumberInput label="Nivel de servicio (seg.)" min={1} max={3600} value={f.sla_seg} onChange={(v) => setF({ ...f, sla_seg: Number(v) || 20 })} />
      </Group>
      <TextInput mt="sm" label="Destinatarios" description="Separados por coma. Vacío = el destinatario por defecto de las alertas (Notificaciones)."
        placeholder="gerencia@empresa.com, supervisor@empresa.com"
        value={f.destinatarios || ''} onChange={(e) => setF({ ...f, destinatarios: e.target.value })} />
    </Card>
  );
}

function Envios({ colas }) {
  const { data, cargando, recargar } = useApi('/ccreport/schedules');
  const lista = Array.isArray(data) ? data : [];
  const nueva = () => toastPromise(
    apiPost('/ccreport/schedules', { nombre: 'Informe diario', periodo: 'diario', hora: 8, sla_seg: 20, destinatarios: '', enabled: false }).then(recargar),
    { loading: 'Creando…', success: 'Programación creada (nace pausada: completá los destinatarios y activala)', error: (e) => e.message });

  return (
    <Card withBorder radius="lg" padding="lg" shadow="sm">
      <Group justify="space-between" mb="sm" wrap="wrap">
        <Group gap={8}>
          <ThemeIcon size={30} radius="md" variant="light" color="teal"><IconMail size={17} /></ThemeIcon>
          <div>
            <Title order={4} lh={1.1}>Envío programado por correo</Title>
            <Text fz="xs" c="dimmed">El mismo resumen que ves acá arriba, en la casilla de quien lo firma. Usa el correo configurado en Configuración → Correo.</Text>
          </div>
        </Group>
        <Button variant="light" leftSection={<IconPlus size={16} />} onClick={nueva}>Nueva programación</Button>
      </Group>
      {cargando ? <Text c="dimmed" fz="sm">Cargando…</Text>
        : lista.length === 0 ? <Text c="dimmed" fz="sm" ta="center" py="lg">No hay envíos programados. Con uno diario a las 8 de la mañana alcanza para la mayoría de las operaciones.</Text>
          : <Stack gap="sm">{lista.map((p) => <Programacion key={p.id} p={p} colas={colas} onCambio={recargar} />)}</Stack>}
    </Card>
  );
}

/* ── Pantalla ──────────────────────────────────────────────────────────────── */
export default function ReportesPage() {
  // Programar el envío por correo es configuración (`ccreport/schedules*` es admin en
  // rbac.js); ver y exportar el informe ya lo puede el supervisor.
  const esAdmin = useEsAdmin();
  const [desde, setDesde] = useState(menos(7));
  const [hasta, setHasta] = useState(menos(0));
  const [cola, setCola] = useState('');
  const [sla, setSla] = useState(20);
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [bajando, setBajando] = useState('');

  // Las colas se piden una vez: no cambian mientras se mira un informe.
  const { data: qs } = useApi('/queues');
  const colas = (Array.isArray(qs) ? qs : []).map((q) => ({ value: q.name, label: q.label || q.name }));

  const dias = Math.round((new Date(hasta + 'T00:00:00') - new Date(desde + 'T00:00:00')) / 864e5) + 1;
  const rangoMal = !desde || !hasta || isNaN(dias) || dias < 1 || dias > MAX_DIAS;
  const qsFiltro = () => `?from=${encodeURIComponent(desde)}&to=${encodeURIComponent(hasta)}&sla=${sla}${cola ? '&cola=' + encodeURIComponent(cola) : ''}`;

  const generar = async () => {
    if (rangoMal) { toast(`El rango tiene que ir de 1 a ${MAX_DIAS} días`, 'bad'); return; }
    setCargando(true);
    try { setDatos(await apiGet('/ccreport' + qsFiltro())); }
    catch (e) { toast(e.message, 'bad'); setDatos(null); }
    finally { setCargando(false); }
  };
  // Primer informe al entrar: la última semana, que es lo que se mira nueve de cada diez veces.
  useEffect(() => {
    generar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Las descargas van por `api({raw:true})` y no por un `<a href download>`: ese pedido
   * lo arma el navegador, no pasa por el parche de `window.fetch` de auth.jsx y baja un
   * 401 disfrazado de archivo. Vale igual para el informe A4, que además se abre en una
   * pestaña nueva desde un blob. */
  const bajarCsv = async () => {
    setBajando('csv');
    try {
      const r = await api('/ccreport/csv' + qsFiltro(), { raw: true });
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `callcenter-${desde}_${hasta}${cola ? '-' + cola : ''}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast('No se pudo exportar', 'bad', { description: e.message }); } finally { setBajando(''); }
  };
  const abrirInforme = async () => {
    setBajando('pdf');
    try {
      const r = await api('/ccreport/report' + qsFiltro(), { raw: true });
      const url = URL.createObjectURL(new Blob([await r.text()], { type: 'text/html' }));
      const w = window.open(url, '_blank');
      if (!w) toast('El navegador bloqueó la ventana: permití las ventanas emergentes para este sitio', 'warn');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast('No se pudo generar el informe', 'bad', { description: e.message }); } finally { setBajando(''); }
  };

  const T = datos && datos.totales;
  const f = datos && datos.fuente;

  return (
    <Stack gap="md">
      <PageHeader icon={<IconReportAnalytics size={24} />} color="grape"
        title="Reportes de call center"
        subtitle="Nivel de servicio, abandono y tiempos por cola y por agente"
        right={<Group gap="sm">
          <Tooltip label="Bajar el informe completo como CSV (sin tope de agentes)" withArrow>
            <Button variant="light" leftSection={<IconDownload size={16} />} onClick={bajarCsv} loading={bajando === 'csv'} disabled={!datos}>CSV</Button>
          </Tooltip>
          <Tooltip label="Abre el informe A4 en una pestaña nueva: desde ahí, Imprimir → Guardar como PDF" withArrow>
            <Button variant="light" leftSection={<IconPrinter size={16} />} onClick={abrirInforme} loading={bajando === 'pdf'} disabled={!datos}>Informe PDF</Button>
          </Tooltip>
        </Group>} />

      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group align="flex-end" gap="sm" wrap="wrap">
          <TextInput w={165} type="date" label="Desde" value={desde} onChange={(e) => setDesde(e.target.value)} />
          <TextInput w={165} type="date" label="Hasta" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          <Select w={215} label="Cola" data={[{ value: '', label: 'Todas las colas' }, ...colas]} value={cola} onChange={(v) => setCola(v || '')} />
          <NumberInput w={190} min={1} max={3600} label="Nivel de servicio" description="atendidas antes de N seg." value={sla} onChange={(v) => setSla(Number(v) || 20)} />
          <Button leftSection={<IconSearch size={16} />} onClick={generar} loading={cargando} disabled={rangoMal}>Generar</Button>
        </Group>
        <Text fz="xs" c="dimmed" mt={8}>
          El informe se genera cuando apretás <b>Generar</b>, no solo: un rango largo es trabajo de verdad para la central.
          Máximo <b>{MAX_DIAS} días</b> por informe{rangoMal && desde && hasta ? ` · el rango elegido es de ${isNaN(dias) ? '—' : dias} días` : ''}.
          La tabla por agente muestra hasta {datos ? datos.agentes_tope : 200} agentes; el CSV los trae todos.
        </Text>
      </Card>

      {f && f.sin_datos && (
        <Alert color="yellow" icon={<IconInfoCircle size={18} />} title="Todavía no hay eventos de cola">
          Las métricas de call center se arman con los eventos de cola de Asterisk, que esta central empieza a registrar
          a partir de esta versión. En cuanto entre la primera llamada por una cola vas a ver números acá.
        </Alert>
      )}
      {f && !f.sin_datos && f.rango_incompleto && (
        <Alert color="yellow" icon={<IconInfoCircle size={18} />} title="El período pedido es más viejo que el registro">
          El registro de colas arranca el <b>{fmtFecha(f.primer_evento, { largo: true })}</b>. Lo anterior a esa fecha no está
          medido: no se cuenta en estos números en vez de mostrarse como si nadie hubiera llamado.
        </Alert>
      )}
      {f && f.sin_horario && (
        <Alert color="gray" icon={<IconMoonStars size={18} />} title="Sin horario de atención configurado">
          No se puede decir qué llamadas entraron fuera de hora. Configuralo en <b>Telefonía → Horarios y modo noche</b> y
          este informe va a usar el mismo horario que el modo noche.
        </Alert>
      )}

      {datos && (
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="xl" wrap="wrap">
            <Kpi icon={IconHeadset} color="blue" valor={T.ofrecidas} etiqueta="Ofrecidas" tip="Llamadas que entraron a una cola en el período." />
            <Kpi icon={IconUsers} color="teal" valor={T.atendidas} etiqueta="Atendidas" tip="Llamadas que tomó un agente." />
            <Kpi icon={IconPhoneOff} color="red" valor={T.abandonadas} etiqueta="Abandonadas" detalle={fmtPct(T.abandono_pct)} tip="El que llamaba colgó mientras esperaba." />
            <Kpi icon={IconTargetArrow} color={colorSla(T.sla_pct)} valor={fmtPct(T.sla_pct)} etiqueta="Nivel de servicio" detalle={`< ${datos.sla_seg} s`} tip={`Porcentaje de llamadas atendidas antes de ${datos.sla_seg} segundos sobre las ofrecidas.`} />
            <Kpi icon={IconClock} color="orange" valor={fmtDur(T.espera_media)} etiqueta="Espera media" detalle={`máx. ${fmtDur(T.espera_max)}`} tip="Tiempo en cola hasta que la atendieron o hasta que colgaron." />
            <Kpi icon={IconClock} color="grape" valor={fmtDur(T.habla_media)} etiqueta="Conversación media" detalle={`total ${fmtDur(T.habla_total)}`} tip="Duración media de la conversación con el agente." />
            <Kpi icon={IconMoonStars} color="gray" valor={T.fuera_horario == null ? '—' : T.fuera_horario} etiqueta="Fuera de horario"
              detalle={datos.horario ? datos.horario.nombre : 'sin horario'} tip="Llamadas que entraron a la cola fuera del horario de atención (o en un feriado)." />
          </Group>
        </Card>
      )}

      {datos && (
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Title order={4} mb={4}>Por cola</Title>
          <Text fz="xs" c="dimmed" mb="sm">«Otras salidas» son las llamadas que dejaron la cola sin que el que llamaba colgara: desborde, tiempo máximo de espera o salto a otro destino.</Text>
          <Table.ScrollContainer minWidth={860}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr>
                <Table.Th>Cola</Table.Th><Table.Th>Ofrecidas</Table.Th><Table.Th>Atendidas</Table.Th>
                <Table.Th>Abandonadas</Table.Th><Table.Th>Otras salidas</Table.Th><Table.Th>Nivel de servicio</Table.Th>
                <Table.Th>Espera media</Table.Th><Table.Th>Espera máxima</Table.Th><Table.Th>Conv. media</Table.Th><Table.Th>Fuera de hora</Table.Th>
              </Table.Tr></Table.Thead>
              <Table.Tbody>
                {datos.colas.length === 0
                  ? <Table.Tr><Table.Td colSpan={10}><Text c="dimmed" ta="center" py="md">Sin llamadas de cola en el período.</Text></Table.Td></Table.Tr>
                  : datos.colas.map((c) => (
                    <Table.Tr key={c.cola}>
                      <Table.Td><Text fw={600} fz="sm">{c.label}</Text>{c.label !== c.cola && <Text fz={10} c="dimmed">{c.cola}</Text>}</Table.Td>
                      <Table.Td>{c.ofrecidas}</Table.Td>
                      <Table.Td>{c.atendidas}</Table.Td>
                      <Table.Td><Text fz="sm">{c.abandonadas} <Text span c="dimmed" fz={11}>({fmtPct(c.abandono_pct)})</Text></Text></Table.Td>
                      <Table.Td>{c.otras_salidas}</Table.Td>
                      <Table.Td><Badge variant="light" color={colorSla(c.sla_pct)}>{fmtPct(c.sla_pct)}</Badge></Table.Td>
                      <Table.Td>{fmtDur(c.espera_media)}</Table.Td>
                      <Table.Td>{fmtDur(c.espera_max)}</Table.Td>
                      <Table.Td>{fmtDur(c.habla_media)}</Table.Td>
                      <Table.Td>{c.fuera_horario == null ? '—' : c.fuera_horario}</Table.Td>
                    </Table.Tr>))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}

      {datos && (
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Title order={4} mb={4}>Por agente</Title>
          <Text fz="xs" c="dimmed" mb="sm">
            Ordenado por llamadas atendidas. «No contestó» es cuando la llamada le sonó y no la tomó.
            {datos.agentes_truncado ? ` Se muestran los primeros ${datos.agentes_tope}: bajá el CSV para verlos a todos.` : ''}
          </Text>
          <Table.ScrollContainer minWidth={700}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr>
                <Table.Th>Agente</Table.Th><Table.Th>Atendidas</Table.Th><Table.Th>No contestó</Table.Th>
                <Table.Th>Espera media</Table.Th><Table.Th>Conv. media</Table.Th><Table.Th>Conv. máxima</Table.Th><Table.Th>Conv. total</Table.Th>
              </Table.Tr></Table.Thead>
              <Table.Tbody>
                {datos.agentes.length === 0
                  ? <Table.Tr><Table.Td colSpan={7}><Text c="dimmed" ta="center" py="md">Ningún agente atendió llamadas de cola en el período.</Text></Table.Td></Table.Tr>
                  : datos.agentes.map((a) => (
                    <Table.Tr key={a.agente}>
                      <Table.Td><Text fw={600} fz="sm" ff="monospace">{a.agente}</Text>{a.nombre && <Text fz={10} c="dimmed">{a.nombre}</Text>}</Table.Td>
                      <Table.Td>{a.atendidas}</Table.Td>
                      <Table.Td>{a.sin_respuesta}</Table.Td>
                      <Table.Td>{fmtDur(a.espera_media)}</Table.Td>
                      <Table.Td>{fmtDur(a.habla_media)}</Table.Td>
                      <Table.Td>{fmtDur(a.habla_max)}</Table.Td>
                      <Table.Td>{fmtDur(a.habla_total)}</Table.Td>
                    </Table.Tr>))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Divider my="sm" />
          <Text fz="xs" c="dimmed">
            No se muestra tiempo de pausa ni de sesión del agente porque la central todavía no los registra: preferimos no
            mostrar el dato antes que estimarlo.
          </Text>
        </Card>
      )}

      {esAdmin && <Envios colas={colas} />}
    </Stack>
  );
}
