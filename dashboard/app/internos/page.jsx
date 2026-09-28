'use client';
import { useState, useEffect, useMemo } from 'react';
import { Stack, Title, Text, Card, Group, Button, Table, Badge, Modal, TextInput, PasswordInput, Switch, SegmentedControl, ActionIcon, ThemeIcon, NumberInput, Divider, Tooltip, CopyButton, Code, Skeleton, SimpleGrid, Loader, Alert, Select, Tabs } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconInfoCircle, IconPlus, IconTrash, IconArrowForward, IconVideo, IconWorld, IconDeviceLandlinePhone, IconPencil, IconUserPlus, IconQrcode, IconSearch, IconCopy, IconCheck, IconMail, IconSend, IconUsers, IconActivity, IconPhoneCall, IconHash, IconUser, IconClock, IconMicrophone2, IconRouteAltLeft, IconServer, IconShieldHalf, IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { QRCodeSVG } from 'qrcode.react';
import { useLive } from '../useLive';
import { apiGet, apiPost, apiPut, apiDel, usePoll, useApi } from '../api';
import { fmtFechaHora } from '../fmt';
import { toast } from '../notify';
import { TableSkeleton } from '../Skeletons';
import PageHeader from '../PageHeader';
import Slot from '../Slot';
/* Los desvíos son los mismos campos que ve el agente en su propio panel, así que
 * viven en un componente compartido (app/DesviosPanel.jsx) y no acá adentro. */
import DesviosPanel from '../DesviosPanel';
import DrawerNG, { BloqueNG } from '../DrawerNG';
import { IcoPersona, IcoConexion, IcoGrabar, IcoQr, IcoDesvio, IcoLlave, IcoRegistro, IcoLatencia } from '../IconosNG';

const VIA = {
  direct: { label: 'Directo', color: 'blue', icon: <IconServer size={12} /> },
  sbc: { label: 'SBC', color: 'grape', icon: <IconShieldHalf size={12} /> },
  webrtc: { label: 'WebRTC', color: 'teal', icon: <IconWorld size={12} /> },
};
const ViaBadge = ({ v, origin }) => { const i = VIA[v]; if (!i) return <Text c="dimmed" size="sm">—</Text>; return <Tooltip label={origin ? ('Origen real: ' + origin) : i.label} disabled={!origin}><Badge variant="light" color={i.color} leftSection={i.icon}>{i.label}</Badge></Tooltip>; };
const EMPTY = { id: '', name: '', pass: '', video: false, record: false, type: 'webrtc', max_contacts: 2, tenant_id: 1, dtmf_mode: 'rfc4733' };

/* Cómo viaja el dígito que marca el usuario. Es el ajuste que más rompe porteros y
 * frentes de calle: casi todos los Dahua/Hikvision mandan la clave de apertura por
 * SIP INFO (RFC 2976) y no por RTP (RFC 4733). Si no coincide, la puerta no abre. */
const DTMF_OPCIONES = [
  { value: 'rfc4733', label: 'RFC 4733 — por RTP (recomendado)' },
  { value: 'auto_info', label: 'Automático con INFO — ideal para porteros' },
  { value: 'info', label: 'SIP INFO (RFC 2976)' },
  { value: 'auto', label: 'Automático (RTP, si no inband)' },
  { value: 'inband', label: 'Inband — tonos en el audio' },
];
const DTMF_HELP = {
  rfc4733: 'El estándar. Sirve para teléfonos IP y softphones.',
  auto_info: 'Usa RFC 4733 si el equipo lo ofrece; si no, cae a SIP INFO. La opción más compatible con porteros y frentes de calle.',
  info: 'Fuerza SIP INFO. Elegilo si el portero no abre la puerta con las otras opciones.',
  auto: 'Usa RFC 4733 si el equipo lo ofrece; si no, manda los tonos dentro del audio.',
  inband: 'Último recurso: se degrada con G.729 y con pérdida de paquetes.',
};
const rttColor = (r) => r == null ? 'gray' : r < 80 ? 'teal' : r < 200 ? 'yellow' : 'red';
/* El encabezado del cajón dice si el interno está REGISTRADO y con qué latencia, no si
 * existe en la base. Es la primera pregunta de cualquiera que abre a editar un interno
 * —«¿este aparato está vivo?»— y hasta ahora había que cerrarlo y buscarlo en la tabla.
 *
 * La latencia es la que mide Asterisk con su propio OPTIONS contra el aparato (el RTT de
 * `pjsip show contacts`): no es una prueba de llamada, es el ida y vuelta de la
 * señalización. Sirve para ver un enlace que se degradó; no dice nada del audio. */
function EstadoInterno({ e }) {
  if (!e) return null;
  const reg = e.status === 'online' || e.status === 'in_call';
  const rtt = e.rtt;
  const nivel = rtt == null ? 0 : rtt < 80 ? 3 : rtt < 200 ? 2 : 1;
  return (
    <Group gap={8} wrap="nowrap" style={{ flex: 'none' }}>
      {rtt != null && (
        <Tooltip withArrow multiline w={250}
          label={'Ida y vuelta de la señalización que mide la central contra el aparato (OPTIONS). Por debajo de 80 ms es sano; por encima de 200 ms el enlace está sufriendo. No mide el audio.'}>
          <Badge variant="light" color={rttColor(rtt)} style={{ cursor: 'help' }}
            leftSection={<IcoLatencia s={12} nivel={nivel} />}>
            {Math.round(rtt)} ms
          </Badge>
        </Tooltip>
      )}
      <Tooltip withArrow label={reg ? (e.origin ? 'Registrado desde ' + e.origin : 'Registrado') : 'El aparato no está registrado en la central'}>
        <Badge variant={reg ? 'light' : 'outline'} color={e.status === 'in_call' ? 'orange' : reg ? 'teal' : 'gray'} style={{ cursor: 'help' }}
          leftSection={<IcoRegistro s={12} vivo={reg} />}>
          {e.status === 'in_call' ? 'En llamada' : reg ? 'Registrado' : 'Sin registrar'}
        </Badge>
      </Tooltip>
    </Group>
  );
}
// Estado del acceso (QR / enlace) que se le mando a la persona: si lo activo, cuando y con que.
function AccesoBadge({ a }) {
  if (!a) return <Text c="dimmed" size="sm">—</Text>;
  if (a.estado === 'activado') {
    const cuando = fmtFechaHora(a.activated_at);
    return (
      <Tooltip multiline w={260} label={
        <div>
          <div><b>Activado</b> el {cuando}</div>
          <div>Aparato: {a.device || '—'}{a.platform ? ' · ' + a.platform : ''}</div>
          <div>Desde la IP {a.ip || '—'}</div>
          <div>Canjes del enlace: {a.uses || 1}</div>
        </div>}>
        <Badge variant="light" color="teal" leftSection={<IconCheck size={11} />} style={{ cursor: 'help' }}>
          {a.device || 'Activado'}
        </Badge>
      </Tooltip>
    );
  }
  if (a.estado === 'vencido') return <Badge variant="light" color="gray" leftSection={<IconClock size={11} />}>Enlace vencido</Badge>;
  return <Badge variant="light" color="orange" leftSection={<IconMail size={11} />}>Enviado, sin activar</Badge>;
}

const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;

export default function Extensiones() {
  const { snap } = useLive(); const list = snap?.extensions || [];
  const [opened, { open, close }] = useDisclosure(false);
  const [solapa, setSolapa] = useState('identidad');
  const [qrOpen, { open: openQr, close: closeQr }] = useDisclosure(false);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const [qrExt, setQrExt] = useState(''); const [enroll, setEnroll] = useState(null); const [gen, setGen] = useState(false);
  const [emailTo, setEmailTo] = useState(''); const [sending, setSending] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  /* El interno tal como lo ve la central AHORA mismo (registrado, latencia, por dónde
   * entra). Sale del estado en vivo que ya alimenta la tabla, así que no cuesta nada. */
  const vivo = editing ? list.find(x => String(x.id) === String(form.id)) : null;
  /* Pasar de WebRTC a SIP (o al revés) no es cambiar un campo: son dos endpoints distintos
   * en Asterisk. Así que se abre el alta con el otro tipo ya elegido. */
  function nuevoTipo(tipo) { setForm({ ...EMPTY, type: tipo }); setEditing(false); setSolapa('identidad'); open(); }
  // Bitacora del acceso enviado: si lo activaron, cuando y con que aparato.
  const { data: enrollments } = usePoll('/enrollments', 30000);
  const acc = useMemo(() => { const m = {}; (Array.isArray(enrollments) ? enrollments : []).forEach(x => { m[String(x.ext)] = x; }); return m; }, [enrollments]);
  const { data: recAllData } = useApi('/extensions/record-all');
  /* Códigos reales de esta central para mostrarlos al lado de cada desvío: acá sí se
   * pueden leer (pantalla de admin), en el panel del agente no. */
  const { data: fcData } = useApi('/featurecodes');
  const codigosFeat = useMemo(() => {
    const m = {};
    (Array.isArray(fcData) ? fcData : []).forEach((f) => { if (f && f.accion) m[f.accion] = f.code; });
    return m;
  }, [fcData]);
  const recAll = !!(recAllData && recAllData.enabled);
  // La grabación global se administra en Configuración → SIP; acá sólo se lee para avisar en el editor.

  // Plan de numeracion: el backend sabe que numeros estan ocupados (y por quien) y cual es el
  // proximo libre dentro del rango que ya se usa. Sugerimos ese, no "el ultimo + 1" a ciegas.
  const { data: plan, recargar: loadPlan } = useApi('/numbering/plan');
  const [numChk, setNumChk] = useState(null);   // { ok, mensaje, motivo, aviso }
  const [numBusy, setNumBusy] = useState(false);

  function suggestExt() {
    if (plan && plan.next) return plan.next;
    const nums = list.map(e => parseInt(e.id, 10)).filter(n => !isNaN(n));
    const base = nums.length ? Math.max(...nums) : 1000;
    return String(base + 1);
  }

  // Validacion mientras se escribe (con freno, para no pegarle a la API en cada tecla).
  useEffect(() => {
    if (editing || !opened) { setNumChk(null); return; }
    const n = (form.id || '').trim();
    if (!n) { setNumChk(null); return; }
    setNumBusy(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try { setNumChk(await apiGet('/numbering/check?ext=' + encodeURIComponent(n), { signal: ctrl.signal })); }
      catch (_) { setNumChk(null); }
      setNumBusy(false);
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); setNumBusy(false); };
  }, [form.id, editing, opened]);

  function openNew() { loadPlan(); setForm(EMPTY); setEditing(false); setEnroll(null); setEmailTo(''); setNumChk(null); setSolapa('identidad'); open(); }
  function openEdit(e) { setForm({ id: e.id, name: e.name || '', pass: '', video: !!e.video, record: !!e.record, type: e.webrtc ? 'webrtc' : 'sip', max_contacts: 2, tenant_id: e.tenant_id || 1, dtmf_mode: e.dtmf_mode || 'rfc4733' }); setEditing(true); setEnroll(null); setEmailTo(''); setSolapa('identidad'); open(); generate(e.id); }
  function openQrModal() { setEnroll(null); setQrExt(suggestExt()); openQr(); }

  async function save() {
    if (!form.id || (!editing && !form.pass)) { toast('Completá extensión y contraseña', 'bad'); return; }
    if (!editing && numChk && !numChk.ok) { toast('Ese número no se puede usar', 'bad', { description: numChk.mensaje }); return; }
    setSaving(true);
    const body = { id: form.id, name: form.name || '', password: form.pass || undefined, video: form.video, record: form.record, webrtc: form.type === 'webrtc', max_contacts: form.max_contacts, dtmf_mode: form.dtmf_mode };
    try {
      const r = editing ? await apiPut('/endpoints/' + form.id, body) : await apiPost('/endpoints', body);
      toast(editing ? 'Extensión ' + form.id + ' actualizada' : 'Extensión ' + ((r && r.created) || form.id) + ' creada', 'ok');
      close(); loadPlan();
    } catch (e) { toast('Error: ' + e.message, 'bad'); }
    setSaving(false);
  }
  async function generate(extArg) {
    const ex = extArg || qrExt; if (!ex) return; setGen(true); setEnroll(null);
    try {
      const r = await apiPost('/enroll', { ext: ex });
      setEnroll({ ...r, url: location.origin + '/enroll?token=' + r.token });
    } catch (e) { toast('Error: ' + e.message, 'bad'); }
    setGen(false);
  }
  async function sendEmail() {
    if (!emailTo) return; setSending(true);
    try {
      await apiPost('/enroll/email', { ext: form.id, to: emailTo, tenant_id: form.tenant_id || 1 });
      toast('QR enviado a ' + emailTo, 'ok'); setEmailTo('');
    } catch (e) { toast('Error: ' + e.message, 'bad'); }
    setSending(false);
  }
  async function del(epid) {
    if (!confirm('¿Eliminar la extensión ' + epid + '?')) return;
    // La lista sale del snapshot del socket, así que se refresca sola al borrar.
    try { await apiDel('/endpoints/' + epid); toast('Extensión ' + epid + ' eliminado', 'info'); }
    catch (e) { toast('Error: ' + e.message, 'bad'); }
  }

  const online = list.filter(e => e.status === 'online').length;
  const inCall = list.filter(e => e.channels > 0).length;
  const wrtc = list.filter(e => e.webrtc).length;
  const sip = list.length - wrtc;
  const kpis = [{ k: 'Total', v: list.length, icon: IconUsers, c: 'pbx' }, { k: 'En línea', v: online, icon: IconActivity, c: 'teal' }, { k: 'En llamada', v: inCall, icon: IconPhoneCall, c: 'orange' }, { k: 'WebRTC', v: wrtc, icon: IconWorld, c: 'grape' }, { k: 'SIP físico', v: sip, icon: IconDeviceLandlinePhone, c: 'gray' }];
  const fl = list.filter(e => !q || e.id.includes(q) || (e.name || '').toLowerCase().includes(q.toLowerCase()) || (e.ip || '').includes(q));

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconUsers size={24} />} title="Extensiones" subtitle="Aprovisionamiento y estado de registro en tiempo real" color="pbx" />
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="md">
        {kpis.map(x => (
          <Card key={x.k} withBorder radius="lg" padding="md" shadow="sm">
            <Group gap="sm" wrap="nowrap"><ThemeIcon size={40} radius="md" variant="light" color={x.c}><x.icon size={20} /></ThemeIcon><div><Text fw={800} fz={24} lh={1}><Slot value={x.v} /></Text><Text size="xs" c="dimmed">{x.k}</Text></div></Group>
          </Card>
        ))}
      </SimpleGrid>
      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md">
          <Group gap="xs"><Text fw={600}>{list.length} extensiones</Text><Badge variant="light" color="teal">{online} en línea</Badge></Group>
          <Group gap="sm">
            <TextInput placeholder="Buscar extensión, nombre o IP" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={230} />
            <Button variant="light" leftSection={<IconQrcode size={16} />} onClick={openQrModal}>Acceso QR</Button>
            <Button leftSection={<IconPlus size={16} />} onClick={openNew}>Nuevo extensión</Button>
          </Group>
        </Group>
        {!snap ? <Group justify="center" py={48}><Loader size="sm" color="pbx" /></Group> :
          list.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin extensiones.</Text> :
            <Table.ScrollContainer minWidth={760}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr><Th icon={<IconHash size={13} />}>Extensión</Th><Th icon={<IconUser size={13} />}>Nombre</Th><Th icon={<IconActivity size={13} />}>Estado</Th><Th icon={<IconRouteAltLeft size={13} />}>Vía</Th><Th icon={<IconWorld size={13} />}>IP</Th><Th icon={<IconClock size={13} />}>RTT</Th><Th icon={<IconDeviceLandlinePhone size={13} />}>Tipo</Th><Th icon={<IconVideo size={13} />}>Video</Th><Th icon={<IconQrcode size={13} />}>Acceso</Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>{fl.map(e => (
                  <Table.Tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => openEdit(e)}>
                    <Table.Td ff="monospace" fw={600}>{e.id}</Table.Td>
                    <Table.Td>{e.name || <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                    <Table.Td><Badge variant="light" color={e.channels > 0 ? 'orange' : e.status === 'online' ? 'teal' : 'gray'} leftSection={<span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: e.channels > 0 ? '#f59e0b' : e.status === 'online' ? '#22c55e' : '#9aa3b2' }} />}>{e.channels > 0 ? 'En llamada' : e.status === 'online' ? 'Registrado' : 'Desconectado'}</Badge></Table.Td><Table.Td><ViaBadge v={e.via} origin={e.origin} /></Table.Td>
                    <Table.Td>{(e.origin || e.ip) ? <Text ff="monospace" size="xs">{e.origin || e.ip}</Text> : <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                    <Table.Td>{e.rtt != null ? <Badge size="sm" variant="dot" color={rttColor(e.rtt)}><Slot value={e.rtt.toFixed(0)} /> ms</Badge> : <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                    <Table.Td><Badge variant="dot" color={e.webrtc ? 'pbx' : 'gray'}>{e.webrtc ? 'WebRTC' : 'SIP'}</Badge></Table.Td>
                    <Table.Td>{e.video ? <Badge color="violet" variant="light" leftSection={<IconVideo size={12} />}>Sí</Badge> : <Text c="dimmed">—</Text>}</Table.Td>
                    <Table.Td><AccesoBadge a={acc[String(e.id)]} /></Table.Td>
                    <Table.Td ta="right" onClick={ev => ev.stopPropagation()}>
                      <Group gap={4} justify="flex-end">
                        <Tooltip label="Editar"><ActionIcon variant="subtle" color="blue" onClick={() => openEdit(e)}><IconPencil size={17} /></ActionIcon></Tooltip>
                        <Tooltip label="Eliminar"><ActionIcon variant="subtle" color="red" onClick={() => del(e.id)}><IconTrash size={17} /></ActionIcon></Tooltip>
                      </Group>
                    </Table.Td></Table.Tr>
                ))}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
      </Card>

      {/* ── Alta y edición del interno ────────────────────────────────────
          Un cajón lateral, no un modal: la lista queda a la izquierda mientras se edita, y
          el botón de guardar no se va con el scroll. */}
      <DrawerNG
        opened={opened} onClose={close} ancho={660}
        color={form.type === 'webrtc' ? 'pbx' : 'gray'}
        icono={editing ? <IcoPersona s={24} /> : <IconUserPlus size={24} />}
        titulo={editing ? 'Interno ' + form.id : 'Nuevo interno'}
        subtitulo={editing ? (vivo && vivo.name ? vivo.name : (form.type === 'webrtc' ? 'Navegador / app' : 'Teléfono físico'))
          : 'Un número que suena en un aparato o en un navegador'}
        estado={editing ? <EstadoInterno e={vivo} /> : null}
        solapa={solapa} onSolapa={setSolapa}
        solapas={[
          {
            value: 'identidad', label: 'Identidad', icon: <IcoPersona s={15} />,
            contenido: (
              <>
                <BloqueNG icon={<IconHash size={16} />} titulo="Quién es"
                  ayuda="El número que se marca y el nombre con el que aparece en la libreta y en el identificador de llamadas.">
                  <TextInput label="Número de interno" placeholder={plan && plan.next ? plan.next : '1006'}
                    value={form.id} onChange={e => set('id', e.target.value.replace(/[^0-9*]/g, ''))} required disabled={editing}
                    description={!editing && plan && plan.principal
                      ? `Estás usando el rango ${plan.principal.desde}–${plan.principal.hasta}. El próximo libre es ${plan.next || '—'}.`
                      : (editing ? 'El número no se cambia: es la identidad del interno en toda la central.' : undefined)}
                    error={numChk && !numChk.ok ? numChk.mensaje : undefined}
                    rightSection={numBusy ? <Loader size={14} />
                      : numChk && numChk.ok && !numChk.aviso ? <IconCircleCheck size={16} color="var(--mantine-color-teal-6)" />
                        : numChk && numChk.aviso ? <IconAlertTriangle size={16} color="var(--mantine-color-orange-6)" />
                          : null}
                    rightSectionPointerEvents="none" />
                  {!editing && plan && plan.next && !form.id && (
                    <Button size="compact-xs" variant="light" w="fit-content"
                      leftSection={<IconHash size={13} />} onClick={() => set('id', plan.next)}>
                      Usar el siguiente libre: {plan.next}
                    </Button>
                  )}
                  {!editing && numChk && numChk.ok && numChk.aviso && (
                    <Alert variant="light" color="orange" icon={<IconAlertTriangle size={15} />} py={6}>
                      <Text size="xs">{numChk.mensaje}</Text>
                    </Alert>
                  )}
                  <TextInput label="Nombre" placeholder="Ej: Recepción, Juan Pérez" value={form.name} onChange={e => set('name', e.target.value)}
                    description="Lo ve quien recibe la llamada y quien busca en la libreta" />
                </BloqueNG>

                <BloqueNG icon={<IcoLlave s={16} />} titulo="Contraseña SIP"
                  ayuda={editing ? 'Se deja vacía para no cambiarla. Si la cambiás, el aparato va a dejar de registrarse hasta que se la vuelvas a cargar.'
                    : 'La que se carga en el teléfono o en la app. No se vuelve a mostrar.'}>
                  <PasswordInput value={form.pass} onChange={e => set('pass', e.target.value)} required={!editing}
                    placeholder={editing ? 'Sin cambios' : 'Obligatoria'} />
                </BloqueNG>
              </>
            ),
          },
          {
            value: 'conexion', label: 'Conexión', icon: <IcoConexion s={15} />,
            contenido: (
              <>
                <BloqueNG icon={<IcoConexion s={16} />} titulo="Cómo se conecta"
                  ayuda={editing
                    ? 'Esto no se cambia editando: WebRTC y SIP no son una opción del mismo interno, son dos endpoints distintos en Asterisk (transporte, cifrado y medios diferentes). Para pasar de uno a otro se crea uno nuevo.'
                    : 'WebRTC para navegador y app; SIP para un teléfono de escritorio.'}>
                  <SegmentedControl fullWidth value={form.type} onChange={v => set('type', v)} disabled={editing} data={[
                    { value: 'webrtc', label: (<Group gap={6} justify="center"><IconWorld size={15} /> WebRTC</Group>) },
                    { value: 'sip', label: (<Group gap={6} justify="center"><IconDeviceLandlinePhone size={15} /> SIP físico</Group>) },
                  ]} />
                  {editing
                    ? (
                      <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />} py={8}>
                        <Text size="xs" mb={8}>
                          Este interno es <b>{form.type === 'webrtc' ? 'WebRTC' : 'SIP físico'}</b>. Si necesitás el otro tipo, creá uno nuevo:
                          los dos pueden convivir y el aparato viejo sigue andando hasta que lo apagues.
                        </Text>
                        <Button size="compact-xs" variant="light"
                          leftSection={<IconPlus size={13} />}
                          onClick={() => { close(); setTimeout(() => nuevoTipo(form.type === 'webrtc' ? 'sip' : 'webrtc'), 220); }}>
                          Crear uno nuevo {form.type === 'webrtc' ? 'SIP físico' : 'WebRTC'}
                        </Button>
                      </Alert>
                    )
                    : <Text size="xs" c="dimmed">{form.type === 'webrtc' ? 'DTLS-SRTP, ICE, ulaw/g722. Se aprovisiona con el QR.' : 'Yealink, Grandstream, Fanvil, porteros SIP.'}</Text>}
                </BloqueNG>

                <BloqueNG icon={<IconVideo size={16} />} titulo="Qué puede hacer"
                  ayuda="El video agrega VP8/H264 al interno. Los dispositivos son cuántos aparatos pueden registrarse a la vez con este mismo número.">
                  <Group grow align="flex-start">
                    <Switch label="Video (VP8/H264)" mt={6} checked={form.video} onChange={e => set('video', e.currentTarget.checked)} />
                    <NumberInput label="Dispositivos" description="Registros simultáneos" min={1} max={10} value={form.max_contacts} onChange={v => set('max_contacts', v || 1)} />
                  </Group>
                </BloqueNG>

                <BloqueNG icon={<IconHash size={16} />} titulo="Envío de tonos (DTMF)"
                  ayuda="Es el ajuste que más rompe porteros: casi todos los Dahua y Hikvision mandan la clave de apertura por SIP INFO y no por RTP. Si no coincide, la puerta no abre.">
                  <Select description={DTMF_HELP[form.dtmf_mode] || ''} value={form.dtmf_mode}
                    onChange={v => set('dtmf_mode', v || 'rfc4733')} allowDeselect={false} data={DTMF_OPCIONES} />
                </BloqueNG>

                <BloqueNG icon={<IcoGrabar s={16} vivo={form.record && !recAll} />} titulo="Grabación"
                  ayuda="Las grabaciones se guardan en Grabaciones y quedan enlazadas en el Historial de cada llamada.">
                  <Card withBorder radius="md" padding="sm" style={{ background: form.record ? 'rgba(225,29,72,.05)' : undefined }}>
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap={10} wrap="nowrap">
                        <ThemeIcon size={32} radius="md" variant="light" color={form.record ? 'red' : 'gray'}><IcoGrabar s={18} vivo={form.record && !recAll} /></ThemeIcon>
                        <Text fw={600} fz="sm">Grabar las llamadas de este interno</Text>
                      </Group>
                      <Switch checked={form.record} onChange={e => set('record', e.currentTarget.checked)} color="red" disabled={recAll} />
                    </Group>
                    {recAll && <Text fz="xs" c="dimmed" mt={6}>La grabación global está activa (Configuración → SIP): se graban <b>todas</b> las llamadas, sin importar este interruptor.</Text>}
                  </Card>
                </BloqueNG>
              </>
            ),
          },
          ...(editing ? [{
            value: 'acceso', label: 'Acceso QR', icon: <IcoQr s={15} vivo={gen} />,
            contenido: (
              <BloqueNG icon={<IcoQr s={16} vivo={gen} />} titulo="Configurar el teléfono con el QR"
                ayuda="Se escanea con el celular y el softphone queda configurado solo. El enlace vence en 24 horas.">
                <Group align="flex-start" wrap="nowrap" gap="lg">
                  <Stack gap={8} align="center" style={{ flex: 'none', width: 172 }}>
                    <div style={{ background: '#fff', padding: 12, borderRadius: 14, border: '1px solid rgba(120,130,150,.25)', lineHeight: 0 }}>
                      {gen || !enroll ? <Skeleton height={148} width={148} /> : <QRCodeSVG value={enroll.url} size={148} level="M" />}
                    </div>
                    <Badge variant="light" color="pbx" leftSection={<IconQrcode size={12} />}>Interno {form.id}</Badge>
                  </Stack>
                  <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
                    {enroll &&
                      <Group gap={8} wrap="nowrap">
                        <Text size="xs" c="dimmed">Clave:</Text><Code>{enroll.password}</Code>
                        <CopyButton value={enroll.url}>{({ copied, copy }) => <Button size="compact-xs" variant="light" color={copied ? 'teal' : 'pbx'} leftSection={copied ? <IconCheck size={13} /> : <IconCopy size={13} />} onClick={copy}>{copied ? 'Copiado' : 'Copiar enlace'}</Button>}</CopyButton>
                      </Group>}
                    <Divider label="Enviar por correo" labelPosition="left" />
                    <Group gap={8} wrap="nowrap" align="flex-end">
                      <TextInput style={{ flex: 1 }} size="sm" placeholder="usuario@empresa.com" leftSection={<IconMail size={15} />} value={emailTo} onChange={e => setEmailTo(e.target.value)} />
                      <Button size="sm" loading={sending} disabled={!emailTo} onClick={sendEmail} leftSection={<IconSend size={15} />}>Enviar</Button>
                    </Group>
                  </Stack>
                </Group>
              </BloqueNG>
            ),
          }] : []),
          ...(editing ? [{
            value: 'desvios', label: 'Desvíos', icon: <IcoDesvio s={15} />,
            contenido: <DesviosPanel ext={form.id} codigos={codigosFeat} />,
          }] : []),
        ]}
        pie={
          <Group justify="space-between">
            <Button variant="subtle" color="gray" onClick={close}>Cancelar</Button>
            <Button onClick={save} loading={saving} leftSection={editing ? <IconPencil size={16} /> : <IconPlus size={16} />}>
              {editing ? 'Guardar cambios' : 'Crear interno'}
            </Button>
          </Group>
        }
      />

      {/* ── Acceso rápido por QR, sin pasar por el alta ───────────────────── */}
      <DrawerNG
        opened={qrOpen} onClose={closeQr} ancho={460}
        icono={<IcoQr s={24} vivo={gen} />}
        titulo="Acceso rápido WebRTC"
        subtitulo="Crea el interno y el enlace que configura el teléfono solo"
        solapas={[{
          value: 'qr', label: 'QR', icon: <IcoQr s={15} />,
          contenido: !enroll ? (
            <BloqueNG icon={<IcoQr s={16} />} titulo="Generar el acceso"
              ayuda="Se crea un interno WebRTC nuevo y un enlace con QR que auto-configura el teléfono. Vale 24 horas.">
              <TextInput label="Número de interno" value={qrExt} onChange={e => setQrExt(e.target.value)}
                placeholder={plan && plan.next ? plan.next : '1006'} />
              <Button onClick={() => generate()} loading={gen} leftSection={<IconQrcode size={16} />}>Generar acceso</Button>
            </BloqueNG>
          ) : (
            <Stack align="center" gap="sm">
              <div style={{ background: '#fff', padding: 14, borderRadius: 16, border: '1px solid #e5eaf3', lineHeight: 0 }}><QRCodeSVG value={enroll.url} size={196} level="M" /></div>
              <Text fw={700} size="lg">Interno {enroll.ext}</Text>
              <Group gap={6}><Text size="sm" c="dimmed">Contraseña:</Text><Code>{enroll.password}</Code></Group>
              <CopyButton value={enroll.url}>{({ copied, copy }) => <Button fullWidth variant="light" color={copied ? 'teal' : 'pbx'} leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy}>{copied ? 'Copiado' : 'Copiar enlace'}</Button>}</CopyButton>
              <Button variant="subtle" onClick={() => setEnroll(null)}>Generar otro</Button>
            </Stack>
          ),
        }]}
      />
    </Stack>
  );
}
