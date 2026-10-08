'use client';
/* ============================================================================
 *  Salas de reunión (ítem 9 de docs/BRECHA-UCM-XORCOM.md).
 *
 *  Una sala es un número que se marca, dos PIN (el de participante y el del
 *  moderador) y, si la reunión está agendada, una franja en la que la sala abre.
 *  Esta pantalla hace tres cosas: administrarlas, invitar por correo y mirar (y
 *  moderar) la reunión que está pasando ahora.
 *
 *  Decisiones que se ven acá:
 *   - Los PIN se generan solos en la API. El formulario los muestra vacíos con
 *     «se genera uno al azar» en vez de proponer el número de la sala: con los
 *     buzones ya aprendimos que un PIN sugerido es el PIN que queda para siempre.
 *   - La vista en vivo se encuesta cada 4 s y SÓLO mientras el panel está abierto
 *     (`usePoll` se desmonta con el Drawer): es la única pantalla que le pide a
 *     Asterisk la lista de una conferencia, y no hace falta que corra de fondo.
 *   - Silenciar y expulsar los puede hacer un supervisor; crear, editar, borrar e
 *     invitar son de admin (rbac.js). Un 403 ya llega como toast desde api.js, pero
 *     igual se esconden los botones que el supervisor no puede usar: ofrecer algo
 *     que siempre falla es peor que no ofrecerlo.
 *   - El LISTADO ya no trae los PIN (`GET /api/salas` devuelve sólo `tiene_pin`): con
 *     el PIN de moderador cualquiera entra, silencia y expulsa, así que en una lista
 *     visible para el supervisor no van. La tabla muestra si están configurados y el
 *     admin los ve pidiéndolos de a uno por `GET /api/salas/:name`, que es el único
 *     lugar de lectura donde salen (CONTRATOS §2, salas de reunión).
 * ==========================================================================*/
import { useEffect, useState } from 'react';
import {
  Card, Group, Text, Title, Button, Table, TextInput, NumberInput, Switch,
  Stack, ActionIcon, ThemeIcon, Badge, Tooltip, Divider, Alert, Textarea, CopyButton, Loader, Paper, Accordion,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconUsers, IconPlus, IconTrash, IconPencil, IconEye, IconMail, IconLock, IconHash,
  IconTag, IconMicrophoneOff, IconMicrophone, IconDoorExit, IconInfoCircle, IconDice,
  IconCalendarEvent, IconPlayerRecord, IconCopy, IconCheck, IconRefresh, IconKey,
  IconAlertTriangle, IconUsersGroup, IconUserPlus, IconWorldShare, IconLink, IconVideo, IconPhoneOutgoing, IconDoorEnter, IconHistory,
} from '@tabler/icons-react';
import PageHeader from './PageHeader';
import { TableSkeleton } from './Skeletons';
import { apiDel, apiGet, apiPost, apiPut, usePoll } from './api';
import { useEsAdmin } from './auth';
import { fmtFechaHora, fmtInputFechaHora } from './fmt';
import { toast } from './notify';
import DrawerNG from './DrawerNG';
import { QRCodeSVG } from 'qrcode.react';

const VACIA = {
  name: '', label: '', access_exten: '', pin: '', pin_mod: '', max_part: 0,
  moh_hasta_moderador: true, anunciar: true, grabar: false, video: false, agenda_inicio: '', agenda_min: 60,
};

/* Un PIN sugerido desde el panel para que el operador pueda verlo antes de guardar.
 * El que manda igual es el de la API cuando el campo va vacío; esto es comodidad,
 * no seguridad. */
const pinAzar = () => String(Math.floor(Math.random() * 1000000)).padStart(6, '0');

/* `onEstado` le pasa al cajón lo que necesita para dibujar el pie fijo (guardando, y la
 * función de guardar): el botón de guardar de un formulario largo no puede vivir al final
 * del scroll —hay que bajar hasta el fondo cada vez para apretarlo—. */
function SalaForm({ sala, onListo, onEstado }) {
  const editando = !!sala;
  const [f, setF] = useState(() => (sala
    ? { ...VACIA, ...sala, agenda_inicio: fmtInputFechaHora(sala.agenda_inicio), agenda_min: sala.agenda_min || 60 }
    : { ...VACIA }));
  const [guardando, setGuardando] = useState(false);
  const up = (k, v) => setF((s) => ({ ...s, [k]: v }));
  useEffect(() => { if (onEstado) onEstado({ guardando, guardar, editando }); }, [guardando, f]); // eslint-disable-line

  async function guardar() {
    const cuerpo = {
      ...f,
      // El input da hora local; la API guarda timestamptz, así que se manda ISO.
      agenda_inicio: f.agenda_inicio ? new Date(f.agenda_inicio).toISOString() : null,
      agenda_min: f.agenda_inicio ? Number(f.agenda_min) || 60 : null,
      max_part: Number(f.max_part) || 0,
    };
    setGuardando(true);
    try {
      const r = editando ? await apiPut('/salas/' + sala.name, cuerpo) : await apiPost('/salas', cuerpo);
      /* `aviso`: la sala quedó guardada en la base pero Asterisk no tomó los PIN (AMI caído).
       * Sin esto, cambiar un PIN filtrado se veía como un guardado perfecto y la reunión
       * seguía abriéndose con el PIN viejo. */
      if (r.aviso) toast(r.aviso, 'bad', { description: 'La sala sigue pidiendo el PIN anterior hasta que la central vuelva.' });
      else toast('Sala «' + (r.label || r.name) + '» guardada', 'ok', {
        description: 'PIN participante ' + r.pin + ' · PIN moderador ' + r.pin_mod,
      });
      onListo();
    } catch (e) { toast(e.message, 'bad'); }
    setGuardando(false);
  }

  return (
    <Stack gap="sm">
      <Group grow align="flex-start">
        <TextInput label="Nombre" required leftSection={<IconTag size={15} />} placeholder="directorio"
          description="Identificador de la sala: letras, números, guion y guion bajo."
          value={f.name} onChange={(e) => up('name', e.currentTarget.value)} />
        <TextInput label="Etiqueta" leftSection={<IconTag size={15} />} placeholder="Reunión de directorio"
          description="Cómo se llama la sala para las personas."
          value={f.label} onChange={(e) => up('label', e.currentTarget.value)} />
      </Group>
      <Group grow align="flex-start">
        <TextInput label="Número de la sala" required leftSection={<IconHash size={15} />} placeholder="9001"
          description="Lo que se marca para entrar."
          value={f.access_exten} onChange={(e) => up('access_exten', e.currentTarget.value)} />
        <NumberInput label="Máximo de participantes" min={0} max={500} allowDecimal={false}
          description="0 = sin tope."
          value={f.max_part} onChange={(v) => up('max_part', v)} />
      </Group>

      <Divider label="PIN de entrada" labelPosition="left" />
      <Group grow align="flex-start">
        <TextInput label="PIN de participantes" leftSection={<IconLock size={15} />}
          description={editando ? 'Cambialo cuando quieras: no corta la reunión en curso.' : 'Vacío = se genera uno al azar.'}
          value={f.pin} onChange={(e) => up('pin', e.currentTarget.value)}
          rightSection={<Tooltip label="Generar uno al azar"><ActionIcon variant="subtle" onClick={() => up('pin', pinAzar())}><IconDice size={16} /></ActionIcon></Tooltip>} />
        <TextInput label="PIN del moderador" leftSection={<IconLock size={15} />}
          description="Tiene que ser distinto al de los participantes."
          value={f.pin_mod} onChange={(e) => up('pin_mod', e.currentTarget.value)}
          rightSection={<Tooltip label="Generar uno al azar"><ActionIcon variant="subtle" onClick={() => up('pin_mod', pinAzar())}><IconDice size={16} /></ActionIcon></Tooltip>} />
      </Group>

      <Divider label="Cómo se comporta la sala" labelPosition="left" />
      <Switch label="Música en espera hasta que entre el moderador"
        description="El que llega primero escucha música en vez de silencio."
        checked={f.moh_hasta_moderador !== false} onChange={(e) => up('moh_hasta_moderador', e.currentTarget.checked)} />
      <Switch label="Anunciar entradas y salidas"
        description="ConfBridge le pide el nombre al que entra y lo anuncia a la sala."
        checked={f.anunciar !== false} onChange={(e) => up('anunciar', e.currentTarget.checked)} />
      <Switch label="Grabar la reunión"
        description="La grabación queda en Grabaciones, como cualquier llamada."
        checked={f.grabar === true} onChange={(e) => up('grabar', e.currentTarget.checked)} />
      <Switch label="Video en la sala"
        description="Los que entran con cámara se ven entre todos. El que entra por teléfono sigue escuchando el audio igual. Encendelo sólo si hace falta: una reunión con cámaras mueve varias veces el tráfico de una de audio."
        checked={f.video === true} onChange={(e) => up('video', e.currentTarget.checked)} />

      <Divider label="Agenda (opcional)" labelPosition="left" />
      <Text fz="xs" c="dimmed">
        Con una reunión agendada la sala <b>sólo abre en esa franja</b>; fuera de ella, el que
        marca escucha un aviso. Sin agenda, la sala está siempre disponible.
      </Text>
      <Group grow align="flex-start">
        <TextInput type="datetime-local" label="Cuándo empieza" leftSection={<IconCalendarEvent size={15} />}
          value={f.agenda_inicio} onChange={(e) => up('agenda_inicio', e.currentTarget.value)} />
        <NumberInput label="Duración (minutos)" min={5} max={1440} allowDecimal={false} disabled={!f.agenda_inicio}
          value={f.agenda_min} onChange={(v) => up('agenda_min', v)} />
      </Group>
      {f.agenda_inicio && (
        <Button variant="subtle" size="compact-xs" w="fit-content" onClick={() => up('agenda_inicio', '')}>
          Quitar la agenda (sala siempre disponible)
        </Button>
      )}

    </Stack>
  );
}

function Invitar({ sala, onCerrar }) {
  const [destinatarios, setDestinatarios] = useState('');
  const [moderador, setModerador] = useState(false);
  const [mensaje, setMensaje] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function enviar() {
    const lista = destinatarios.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!lista.length) { toast('Poné al menos una dirección', 'bad'); return; }
    setEnviando(true);
    try {
      const r = await apiPost('/salas/' + sala.name + '/invitar', { destinatarios: lista, moderador, mensaje });
      const n = (r.enviados || []).length;
      // El plural pierde la tilde: «invitaciones», no «invitaciónes» (así salía en el aviso).
      toast(n + (n === 1 ? ' invitación enviada' : ' invitaciones enviadas'), n ? 'ok' : 'bad',
        (r.fallados || []).length ? { description: 'No salieron: ' + r.fallados.map((x) => x.destino).join(', ') } : undefined);
      if (n) onCerrar();
    } catch (e) { toast(e.message, 'bad'); }
    setEnviando(false);
  }

  /* El correo no es el único camino: la mitad de las invitaciones de verdad se mandan por
   * WhatsApp. Se arma el mismo texto que va en el correo y se copia de un botón, en vez de
   * obligar a abrir la sala, anotar el número, el PIN y el enlace, y rearmarlo a mano. */
  const [detalle, setDetalle] = useState(null);
  const [externo, setExterno] = useState('');
  useEffect(() => {
    let vivo = true;
    apiGet('/salas/' + sala.name).then((d) => { if (vivo) setDetalle(d); }).catch(() => {});
    apiGet('/settings').then((d) => { if (vivo) setExterno((d && d.sala_numero_externo) || ''); }).catch(() => {});
    return () => { vivo = false; };
  }, [sala.name]);
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  const cuando = sala.agenda_inicio
    ? fmtFechaHora(sala.agenda_inicio) + (sala.agenda_min ? ' · ' + sala.agenda_min + ' min' : '')
    : '';
  const texto = detalle ? [
    'Te invito a la reunión «' + (sala.label || sala.name) + '».',
    detalle.web_token ? 'Entrá desde el navegador: ' + base + '/sala/' + detalle.web_token : '',
    'O marcá ' + sala.access_exten + (externo ? ' (desde afuera: ' + externo + ')' : '') + (detalle.pin ? ' y el PIN ' + detalle.pin : ''),
    cuando ? 'Cuándo: ' + cuando : 'La sala está disponible en cualquier momento.',
  ].filter(Boolean).join('\n') : '';

  return (
    <Stack gap="sm">
      <Alert variant="light" color="cyan" icon={<IconInfoCircle size={18} />}>
        A cada invitado le llega el enlace de la sala (si lo tiene), el número a marcar, su PIN
        y la hora de la reunión. Se manda <b>un correo por persona</b>: nadie ve la lista de los
        demás.
      </Alert>
      <Textarea label="Direcciones" required autosize minRows={3}
        description="Separadas por coma, punto y coma o espacios."
        placeholder="ana@empresa.com, juan@empresa.com"
        value={destinatarios} onChange={(e) => setDestinatarios(e.currentTarget.value)} />
      <Textarea label="Mensaje (opcional)" autosize minRows={2}
        description="Una línea con el motivo de la reunión."
        value={mensaje} onChange={(e) => setMensaje(e.currentTarget.value)} />
      <Switch color="orange" label="Invitar como moderador"
        description="Le manda el PIN de moderador, que silencia, expulsa y abre la sala. Mandáselo sólo a quien la dirige."
        checked={moderador} onChange={(e) => setModerador(e.currentTarget.checked)} />
      <Divider label="O mandala vos" labelPosition="left" mt="xs" />
      <Text fz="xs" c="dimmed">
        El mismo texto, para pegar en WhatsApp o donde quieras. Ojo: lleva el PIN de
        participante, así que no lo pegues en un grupo que no sea el de la reunión.
      </Text>
      <Paper withBorder radius="md" p="xs" style={{ background: 'var(--mantine-color-default-hover)' }}>
        <Text fz="xs" ff="monospace" style={{ whiteSpace: 'pre-wrap' }}>{texto || 'Buscando los datos de la sala…'}</Text>
      </Paper>
      <CopyButton value={texto}>{({ copied, copy }) => (
        <Button variant="light" color={copied ? 'teal' : 'blue'} disabled={!texto} onClick={copy} w="fit-content"
          leftSection={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}>
          {copied ? 'Copiado' : 'Copiar la invitación'}
        </Button>
      )}</CopyButton>

      <Group justify="flex-end" mt="sm">
        <Button variant="default" onClick={onCerrar}>Cancelar</Button>
        <Button color={moderador ? 'orange' : undefined} loading={enviando} leftSection={<IconMail size={16} />} onClick={enviar}>
          Enviar invitación
        </Button>
      </Group>
    </Stack>
  );
}

/* ── El enlace público de la sala ───────────────────────────────────────────
 * El token ES la llave: quien lo tiene entra sin PIN, siempre como participante. Por eso
 * el cajón deja rotarlo y revocarlo de un clic — es lo que un PIN de cuatro dígitos nunca
 * pudo darte— y lo dice con todas las letras en vez de dejarlo a la intuición. */
function EnlaceWeb({ sala, onCambio }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [cargando, setCargando] = useState(true);
  const [esperaMod, setEsperaMod] = useState(false);
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  /* El token no viaja en el listado (es una credencial): se pide al detalle, que es admin. */
  useEffect(() => {
    let vivo = true;
    apiGet('/salas/' + sala.name)
      .then((d) => { if (vivo) { setUrl(d && d.web_token ? base + '/sala/' + d.web_token : ''); setEsperaMod(!!(d && d.moh_hasta_moderador)); setCargando(false); } })
      .catch(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [sala.name, base]);
  const completo = url ? (url.startsWith('http') ? url : base + url) : '';

  async function generar() {
    setBusy(true);
    try {
      const r = await apiPost('/salas/' + sala.name + '/enlace', {});
      setUrl(r.url && r.url.startsWith('http') ? r.url : (base + '/sala/' + r.token));
      toast(url ? 'Enlace nuevo: el anterior dejó de servir' : 'Enlace creado', 'ok');
      onCambio && onCambio();
    } catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  }
  async function revocar() {
    if (!confirm('¿Revocar el enlace? Quien lo tenga deja de poder entrar por la web.')) return;
    setBusy(true);
    try { await apiDel('/salas/' + sala.name + '/enlace'); setUrl(''); toast('Enlace revocado', 'info'); onCambio && onCambio(); }
    catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  }

  if (cargando) return <Group gap={8}><Loader size="xs" /><Text fz="sm" c="dimmed">Buscando el enlace…</Text></Group>;
  return (
    <Stack gap="md">
      {!completo ? (
        <>
          <Alert variant="light" color="cyan" icon={<IconInfoCircle size={18} />}>
            Esta sala todavía <b>no se puede abrir desde el navegador</b>: sólo se entra marcando
            su número desde un interno de la central.
          </Alert>
          <Text fz="sm" c="dimmed">
            Con un enlace, cualquiera lo abre en el navegador —sin instalar nada, sin ser interno
            y sin marcar el PIN— y entra a la reunión como participante. El enlace se puede
            revocar o cambiar cuando quieras, cosa que un PIN de cuatro dígitos no permite.
          </Text>
          <Button loading={busy} onClick={generar} leftSection={<IconWorldShare size={16} />}>Crear el enlace</Button>
        </>
      ) : (
        <>
          <Stack align="center" gap="sm">
            <div style={{ background: '#fff', padding: 14, borderRadius: 16, border: '1px solid #e5eaf3' }}>
              <QRCodeSVG value={completo} size={188} level="M" />
            </div>
            <Text fz="xs" c="dimmed" ta="center">Escanealo con el celular o mandá el enlace de abajo.</Text>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <TextInput readOnly value={completo} style={{ flex: 1 }} ff="monospace" size="xs" />
            <CopyButton value={completo}>{({ copied, copy }) => (
              <Button size="xs" variant="light" color={copied ? 'teal' : 'blue'} onClick={copy}
                leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}>{copied ? 'Copiado' : 'Copiar'}</Button>
            )}</CopyButton>
          </Group>
          <Alert variant="light" color="orange" icon={<IconAlertTriangle size={18} />}>
            Quien tenga este enlace entra a la reunión <b>sin PIN</b>, siempre como participante.
            Nunca como moderador: abrir la sala, silenciar y expulsar sigue pidiendo el PIN de
            moderador, que no viaja en ningún enlace.
          </Alert>
          <Text fz="xs" c="dimmed">
            La invitación por correo manda este enlace a los participantes. Al moderador se le
            sigue mandando su PIN, no el enlace.
          </Text>
          {esperaMod && (
            <Alert variant="light" color="orange" icon={<IconAlertTriangle size={18} />}>
              <Text fz="sm">
                Esta sala tiene <b>«música en espera hasta que entre el moderador»</b>. Los que
                entren por el enlace van a escuchar música —sin oírse entre ellos— hasta que
                alguien entre marcando el <b>PIN de moderador</b> desde un teléfono o el softphone.
                Si esta reunión es sólo de invitados por enlace, apagá esa opción al editar la
                sala o la reunión no arranca nunca.
              </Text>
            </Alert>
          )}
          <Group justify="space-between">
            <Button variant="subtle" color="red" loading={busy} onClick={revocar} leftSection={<IconTrash size={15} />}>Revocar</Button>
            <Button variant="light" loading={busy} onClick={generar} leftSection={<IconRefresh size={15} />}>Cambiarlo por uno nuevo</Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

/* El número por el que se entra a las salas DESDE AFUERA (un DID del operador ruteado a
 * la sala). La API ya lo usaba —lo anuncia en cada invitación— pero no había dónde
 * cargarlo: vivía sólo en `pbxng_settings`, invisible, y por eso el correo nunca lo
 * nombraba. Un ajuste que la central usa y el panel no muestra es un ajuste que no existe.
 */
function NumeroExterno() {
  const [valor, setValor] = useState('');
  const [inicial, setInicial] = useState('');
  const [listo, setListo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  useEffect(() => {
    let vivo = true;
    apiGet('/settings')
      .then((d) => { if (vivo) { const v = (d && d.sala_numero_externo) || ''; setValor(v); setInicial(v); setListo(true); } })
      .catch(() => { if (vivo) setListo(true); });
    return () => { vivo = false; };
  }, []);
  async function guardar() {
    setGuardando(true);
    try { await apiPost('/settings', { sala_numero_externo: valor.trim() }); setInicial(valor.trim()); toast('Guardado', 'ok'); }
    catch (e) { toast(e.message, 'bad'); }
    setGuardando(false);
  }
  if (!listo) return null;
  return (
    <Card withBorder radius="lg" padding="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon size={32} radius="md" variant="light" color="blue"><IconPhoneOutgoing size={18} /></ThemeIcon>
          <div style={{ minWidth: 0 }}>
            <Text fw={600} fz="sm">Número para entrar desde afuera</Text>
            <Text fz="xs" c="dimmed">
              El número público (un DID tuyo ruteado a la sala) que se le anuncia al invitado en la
              invitación, para el que va a llamar desde un teléfono que no es interno de la central.
              Vacío = la invitación sólo nombra el interno.
            </Text>
          </div>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <TextInput value={valor} onChange={(e) => setValor(e.currentTarget.value)} placeholder="099 123 456" w={190} ff="monospace" />
          <Button variant="light" loading={guardando} disabled={valor.trim() === inicial} onClick={guardar}>Guardar</Button>
        </Group>
      </Group>
    </Card>
  );
}

/* ── El historial de la sala ─────────────────────────────────────────────────
 * La vista en vivo contesta «quién está ahora»; esta contesta «qué pasó». Son las dos
 * preguntas que se hacen sobre una sala y hasta ahora sólo existía la primera: terminada
 * la reunión no quedaba rastro de quién participó ni de cuánto duró.
 *
 * Cada reunión se muestra cerrada y se abre para ver la gente: en una sala que se usa
 * todos los días, la lista importa más que el detalle, y el detalle importa de a una. */
const durTexto = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  if (n < 60) return n + ' s';
  const m = Math.floor(n / 60), h = Math.floor(m / 60);
  return h ? h + ' h ' + (m % 60) + ' min' : m + ' min';
};

function Historial({ sala }) {
  const { data, error, cargando } = usePoll('/salas/' + sala.name + '/historial?limite=30', 60000);
  const reuniones = Array.isArray(data) ? data : [];
  useEffect(() => { if (error) toast(error.message, 'bad'); }, [error]);

  if (cargando && !data) return <TableSkeleton rows={4} cols={3} />;
  if (!reuniones.length) {
    return (
      <Alert variant="light" color="gray" icon={<IconInfoCircle size={18} />}>
        Todavía no hay reuniones registradas en esta sala. El historial se escribe a medida que
        la gente entra y sale, así que las reuniones anteriores a esta versión no aparecen.
      </Alert>
    );
  }
  return (
    <Stack gap="sm">
      <Text fz="xs" c="dimmed">
        Las últimas {reuniones.length} reuniones. La duración de cada persona es el tiempo que
        estuvo en la sala, no el de su llamada: el que esperó al moderador con música cuenta
        desde que entró al mezclador.
      </Text>
      <Accordion variant="separated" radius="md">
        {reuniones.map((r) => (
          <Accordion.Item key={r.id} value={String(r.id)}>
            <Accordion.Control>
              <Group justify="space-between" wrap="nowrap" pr="sm">
                <div style={{ minWidth: 0 }}>
                  <Text fw={600} fz="sm">{fmtFechaHora(r.inicio)}</Text>
                  <Text fz="xs" c="dimmed">
                    {durTexto(r.segundos)}
                    {r.fin_estimado ? ' · fin estimado' : ''}
                    {' · '}{(r.participantes || []).length === 1 ? '1 participante' : (r.participantes || []).length + ' participantes'}
                  </Text>
                </div>
                <Group gap={6} wrap="nowrap">
                  {r.grabada && <Tooltip label="La reunión se grabó: está en Grabaciones"><ThemeIcon size={20} radius="xl" variant="light" color="red"><IconPlayerRecord size={12} /></ThemeIcon></Tooltip>}
                  {!r.fin && <Badge variant="light" color="teal">En curso</Badge>}
                  {r.pico > 0 && <Badge variant="light" color="gray">{r.pico} a la vez</Badge>}
                </Group>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              {/* `fin_estimado` no se esconde: si la central se reinició en el medio, la hora
                  de salida es una suposición y decirlo cuesta una palabra. */}
              {r.fin_estimado && (
                <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />} mb="xs" py={6}>
                  <Text fz="xs">La central se reinició con esta reunión abierta: la hora de fin es estimada.</Text>
                </Alert>
              )}
              <Table verticalSpacing={6} fz="sm">
                <Table.Thead><Table.Tr><Table.Th>Quién</Table.Th><Table.Th>Entró</Table.Th><Table.Th>Estuvo</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {(r.participantes || []).map((p, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Text fz="sm">{p.quien || p.numero || '—'}</Text>
                          {p.moderador && <Badge size="xs" variant="light" color="orange">Moderador</Badge>}
                          {p.web && <Tooltip label="Entró desde el navegador con el enlace de la sala"><Badge size="xs" variant="light" color="blue">Web</Badge></Tooltip>}
                        </Group>
                        {p.numero && p.numero !== p.quien && <Text fz={11} c="dimmed" ff="monospace">{p.numero}</Text>}
                      </Table.Td>
                      <Table.Td><Text fz="xs">{fmtFechaHora(p.entro)}</Text></Table.Td>
                      <Table.Td><Text fz="xs">{durTexto(p.segundos)}{p.fin_estimado ? ' (est.)' : ''}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </Stack>
  );
}

function EnVivo({ sala, onCerrar }) {
  const { data, error, cargando, recargar } = usePoll('/salas/' + sala.name + '/live', 4000);
  const gente = (data && data.participantes) || [];
  useEffect(() => { if (error) toast(error.message, 'bad'); }, [error]);

  async function accion(p, que) {
    try {
      if (que === 'kick') {
        if (!confirm('¿Sacar a ' + (p.numero || p.canal) + ' de la reunión?')) return;
        await apiPost('/salas/' + sala.name + '/kick', { canal: p.canal });
        toast('Se fue de la sala', 'info');
      } else {
        await apiPost('/salas/' + sala.name + '/mute', { canal: p.canal, mudo: !p.mudo });
        toast(p.mudo ? 'Micrófono abierto' : 'Micrófono silenciado', 'ok');
      }
      recargar();
    } catch (e) { toast(e.message, 'bad'); }
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group gap={8}>
          <Badge variant="light" ff="monospace">{sala.access_exten}</Badge>
          <Badge variant="light" color={gente.length ? 'teal' : 'gray'}>{gente.length} adentro</Badge>
          {data && data.grabando && <Badge variant="light" color="red" leftSection={<IconPlayerRecord size={12} />}>Grabando</Badge>}
        </Group>
        <Tooltip label="Actualizar ahora"><ActionIcon variant="subtle" onClick={recargar}><IconRefresh size={17} /></ActionIcon></Tooltip>
      </Group>

      {/* Todos esperando y ningún moderador: la reunión NO arrancó, por más que el contador
          diga que hay gente adentro. Es el caso que más confunde —se ve gente, nadie se
          escucha— y hasta ahora no lo decía nada. */}
      {gente.length > 0 && gente.every((p) => p.esperando) && (
        <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={18} />}>
          {gente.length === 1 ? 'La persona que está adentro escucha música' : 'Los ' + gente.length + ' que están adentro escuchan música'} y
          no se oyen entre {gente.length === 1 ? 'nadie' : 'ellos'}: la sala espera al moderador.
          Tiene que entrar alguien marcando <b>{sala.access_exten}</b> con el <b>PIN de moderador</b>,
          o hay que apagar «música en espera hasta que entre el moderador» al editar la sala.
          {' '}Desde la lista, el botón <b>entrar como moderador</b> hace justo eso desde este navegador.
        </Alert>
      )}

      {data && data.ami === false && (
        <Alert variant="light" color="orange" icon={<IconInfoCircle size={18} />}>
          No hay conexión con Asterisk, así que no se puede saber quién está en la sala
          (ni silenciar ni expulsar). Se reintenta solo.
        </Alert>
      )}

      {cargando && !data ? <TableSkeleton rows={3} cols={3} /> :
        gente.length === 0 ? <Text c="dimmed" ta="center" py="xl">No hay nadie en la sala todavía.</Text> : (
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead><Table.Tr><Table.Th>Quién</Table.Th><Table.Th>Rol</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {gente.map((p) => (
                <Table.Tr key={p.canal}>
                  <Table.Td>
                    <Text fw={600} fz="sm">{p.nombre || p.numero || '—'}</Text>
                    <Text fz="xs" c="dimmed" ff="monospace">{p.numero}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6}>
                      {p.moderador && <Badge variant="light" color="orange">Moderador</Badge>}
                      {p.esperando && (
                        <Tooltip label="Está en la sala pero fuera de la conversación: escucha música hasta que entre el moderador">
                          <Badge variant="light" color="yellow">Esperando al moderador</Badge>
                        </Tooltip>
                      )}
                      {p.mudo && <Badge variant="light" color="gray">Silenciado</Badge>}
                    </Group>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Tooltip label={p.mudo ? 'Abrirle el micrófono' : 'Silenciar'}>
                        <ActionIcon variant="subtle" color={p.mudo ? 'teal' : 'gray'} onClick={() => accion(p, 'mute')}>
                          {p.mudo ? <IconMicrophone size={17} /> : <IconMicrophoneOff size={17} />}
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Expulsar de la sala">
                        <ActionIcon variant="subtle" color="red" onClick={() => accion(p, 'kick')}><IconDoorExit size={17} /></ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      <Group justify="flex-end"><Button variant="default" onClick={onCerrar}>Cerrar</Button></Group>
    </Stack>
  );
}

/* PIN visible con un botón para copiarlo: el operador lo dicta por teléfono o lo pega
 * en un chat. Ya no se dibuja en la tabla (el listado no trae los PIN): sale en el
 * detalle de «Ver PIN» y ahí sí conviene copiarlo de un clic. */
function Pin({ valor, color }) {
  return (
    <CopyButton value={valor || ''}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copiado' : 'Copiar PIN'}>
          <Badge variant="light" color={copied ? 'teal' : color} ff="monospace" style={{ cursor: 'pointer' }}
            rightSection={copied ? <IconCheck size={11} /> : <IconCopy size={11} />} onClick={copy}>
            {valor || '—'}
          </Badge>
        </Tooltip>
      )}
    </CopyButton>
  );
}

/* «Ver PIN» pide la sala de a una a `GET /api/salas/:name` (admin), que es el único
 * lugar de lectura donde la API devuelve `pin` y `pin_mod`. Se piden acá, con la sala
 * abierta a propósito, y no en el listado: así el PIN de moderador no viaja en cada
 * encuestado ni queda a la vista de quien sólo entró a moderar. */
function VerPin({ sala, onCerrar }) {
  const [detalle, setDetalle] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let vivo = true;
    apiGet('/salas/' + sala.name)
      .then((d) => { if (vivo) setDetalle(d); })
      .catch((e) => { if (vivo) setError(e.message); });
    return () => { vivo = false; };
  }, [sala.name]);

  return (
    <Stack gap="sm">
      {error
        ? <Alert variant="light" color="red" icon={<IconInfoCircle size={18} />}>{error}</Alert>
        : !detalle
          ? <Group justify="center" py="md"><Loader size="sm" /></Group>
          : (
            <>
              <Group gap={10}>
                <Text fz="sm" w={150}>PIN de participantes</Text>
                <Pin valor={detalle.pin} color="gray" />
              </Group>
              <Group gap={10}>
                <Text fz="sm" w={150}>PIN del moderador</Text>
                <Pin valor={detalle.pin_mod} color="orange" />
              </Group>
              <Alert variant="light" color="orange" icon={<IconInfoCircle size={18} />}>
                Con el <b>PIN del moderador</b> se entra a la reunión, se silencia y se expulsa.
                Mandáselo sólo a quien la dirige; para el resto está la invitación por correo,
                que además deja registro de a quién se le mandó.
              </Alert>
            </>
          )}
      <Group justify="flex-end"><Button variant="default" onClick={onCerrar}>Cerrar</Button></Group>
    </Stack>
  );
}

export default function SalasPanel({ conEncabezado = true }) {
  /* Configuración: la cambia una persona desde acá y después se recarga a mano. El poll
   * largo es sólo por si la tocó otro operador (política de encuestado, CONTRATOS §2);
   * el conteo de gente adentro viene en la misma respuesta, así que la lista también
   * muestra quién está reunido sin una pantalla aparte. */
  const { data, error, cargando, recargar } = usePoll('/salas', 30000);
  const salas = Array.isArray(data) ? data : [];
  /* Salas que no piden NADA para entrar (las que venían de antes de 1.10.0 y no se editaron).
   * Se calcula acá y no en el render para nombrarlas en el aviso y en la tabla con el mismo
   * criterio que usa la API (`tiene_pin` / `tiene_pin_mod`, que es lo único que trae el listado). */
  const sinNingunPin = salas.filter((s) => !s.tiene_pin && !s.tiene_pin_mod);
  const [editar, setEditar] = useState(null);       // sala | 'nueva' | null
  const [enVivo, setEnVivo] = useState(null);
  const [invitar, setInvitar] = useState(null);
  const [verPin, setVerPin] = useState(null);
  const [enlace, setEnlace] = useState(null);
  const [historial, setHistorial] = useState(null);
  const [abriendo, setAbriendo] = useState('');     // nombre de la sala que se está trayendo
  const [formEstado, setFormEstado] = useState(null);
  const [form, { open: abrirForm, close: cerrarForm }] = useDisclosure(false);
  useEffect(() => { if (error) toast(error.message, 'bad'); }, [error]);

  /* El supervisor entra a esta pantalla para MODERAR (rbac.js le da la lista, la vista en
   * vivo y mute/kick); alta, baja, edición e invitar son de admin, así que esos botones ni
   * se dibujan. Mientras todavía no se sabe quién entró se asume que NO es admin (ver el
   * porqué en `app/auth.jsx`): esconder de más es barato, mostrarle a un supervisor un
   * botón que sólo sabe dar 403 no. */
  const esAdmin = useEsAdmin();

  function nueva() { setEditar('nueva'); abrirForm(); }
  /* Editar necesita los PIN de verdad y el listado ya no los trae: se pide el detalle
   * (admin) ANTES de abrir el formulario. Si se abriera con la fila del listado, los dos
   * campos de PIN saldrían vacíos y parecería que la sala no tiene ninguno. */
  async function editarSala(s) {
    setAbriendo(s.name);
    try { setEditar(await apiGet('/salas/' + s.name)); abrirForm(); }
    catch (e) { toast(e.message, 'bad'); }
    setAbriendo('');
  }
  function listo() { cerrarForm(); setEditar(null); recargar(); }

  /* Entrar a la reunión desde el panel, como moderador. Es lo que faltaba para que una
   * reunión de puros invitados por enlace pueda arrancar: alguien tiene que entrar
   * `marked`, y hasta ahora eso pedía un teléfono y el PIN de moderador a mano. Abre una
   * pestaña nueva —la misma página del invitado, con una entrada de un solo uso— para no
   * tirarte abajo el panel ni el softphone que puedas tener abierto acá. */
  async function moderar(s) {
    setAbriendo(s.name);
    try {
      const r = await apiPost('/salas/' + s.name + '/moderar', {});
      /* Sin 'noopener' en las opciones: con él, window.open devuelve SIEMPRE null (así lo
       * define el estándar) y el panel avisaba «el navegador bloqueó la ventana» aunque la
       * sala se hubiera abierto. Se corta el `opener` a mano, que es lo que 'noopener' hacía. */
      const w = window.open(r.url, '_blank');
      if (!w) toast('El navegador bloqueó la ventana nueva. Permitila y probá otra vez.', 'bad');
      else { w.opener = null; toast('Abriendo la sala como moderador', 'ok'); }
      recargar();
    } catch (e) { toast(e.message, 'bad'); }
    setAbriendo('');
  }

  async function borrar(s) {
    if (!confirm('¿Borrar la sala «' + (s.label || s.name) + '»? El número ' + s.access_exten + ' deja de entrar a la reunión.')) return;
    try { await apiDel('/salas/' + s.name); toast('Sala borrada', 'info'); recargar(); }
    catch (e) { toast(e.message, 'bad'); }
  }

  return (
    <Stack gap="lg">
      {conEncabezado && (
        <PageHeader icon={<IconUsers size={24} />} color="grape" title="Salas de reunión"
          subtitle="Número, PIN de participante y de moderador, agenda, invitación por correo y quién está adentro"
          right={esAdmin ? <Button leftSection={<IconPlus size={16} />} onClick={nueva}>Nueva sala</Button> : null} />
      )}

      <Alert variant="light" color="grape" icon={<IconInfoCircle size={18} />}>
        Cada sala tiene <b>dos PIN</b>: el de los participantes y el del moderador, que además
        puede silenciar y expulsar. Si la reunión está agendada, la sala <b>sólo abre en esa
        franja</b>; el resto del tiempo el que marca escucha un aviso.
      </Alert>

      {esAdmin && <NumeroExterno />}

      {/* Las salas que venían de antes de la actualización se dejan COMO ESTABAN: si alguien
          decidió que la sala de recepción no pide PIN, no se lo pone una migración a sus
          espaldas. Lo que sí hace falta es que el administrador las vea de una, con nombre y
          número, para decidir él. */}
      {sinNingunPin.length > 0 && (
        <Alert variant="light" color="orange" icon={<IconAlertTriangle size={18} />}
          title={sinNingunPin.length === 1 ? 'Hay una sala sin PIN' : 'Hay ' + sinNingunPin.length + ' salas sin PIN'}>
          A {sinNingunPin.length === 1 ? 'esta sala' : 'estas salas'} se entra <b>sin marcar nada</b>,
          como venían funcionando: {sinNingunPin.map((s) => (s.label || s.name) + ' (' + s.access_exten + ')').join(' · ')}.
          {esAdmin
            ? ' Si querés que pidan PIN, editalas y guardá: la API genera los dos PIN y reescribe el plan de marcado en el mismo movimiento.'
            : ' Un administrador puede ponerles PIN desde esta misma pantalla.'}
        </Alert>
      )}

      <Card withBorder radius="lg" padding="lg">
        <Group justify="space-between" mb="md">
          <Group gap={10} wrap="nowrap">
            <ThemeIcon size={32} radius="md" variant="light" color="grape"><IconUsers size={18} /></ThemeIcon>
            <div><Title order={4} lh={1.15}>Salas</Title><Text size="sm" c="dimmed">ConfBridge · moderador, agenda y grabación</Text></div>
          </Group>
          {!conEncabezado && esAdmin && <Button leftSection={<IconPlus size={16} />} onClick={nueva}>Nueva sala</Button>}
        </Group>

        {cargando && !data ? <TableSkeleton rows={4} cols={6} /> :
          salas.length === 0 ? <Text c="dimmed" ta="center" py="xl">{esAdmin ? 'Todavía no hay salas de reunión. Creá una y mandá la invitación.' : 'Todavía no hay salas de reunión.'}</Text> : (
            <Table.ScrollContainer minWidth={720}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr>
                  <Table.Th>Sala</Table.Th><Table.Th>Cómo se entra</Table.Th><Table.Th>PIN</Table.Th>
                  <Table.Th>Agenda</Table.Th><Table.Th>Estado</Table.Th><Table.Th />
                </Table.Tr></Table.Thead>
                <Table.Tbody>
                  {salas.map((s) => (
                    <Table.Tr key={s.name}>
                      <Table.Td>
                        <Text fw={600} fz="sm">{s.label || s.name}</Text>
                        <Text fz="xs" c="dimmed" ff="monospace">{s.name}</Text>
                      </Table.Td>
                      <Table.Td>
                        {/* Las tres puertas de la sala, juntas: el número que se marca, si hay
                            enlace web y si la reunión tiene video. Antes había que abrir la sala
                            para saber si se podía entrar desde el navegador. */}
                        <Group gap={5} wrap="nowrap">
                          <Badge variant="light" color="grape" ff="monospace">{s.access_exten}</Badge>
                          {s.web && <Tooltip label="Se puede entrar desde el navegador con un enlace"><Badge variant="light" color="blue" leftSection={<IconWorldShare size={11} />}>Enlace</Badge></Tooltip>}
                          {s.video && <Tooltip label="Los que entren con cámara se ven entre todos"><Badge variant="light" color="teal" leftSection={<IconVideo size={11} />}>Video</Badge></Tooltip>}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        {/* El listado sólo sabe SI hay PIN; verlos es pedir el detalle (admin).
                            Tres estados y no dos: una sala heredada puede tener PIN de
                            participante y no de moderador, y llamarla «Sin PIN» sería mentir. */}
                        <Group gap={6} wrap="nowrap">
                          {!s.tiene_pin && !s.tiene_pin_mod ? (
                            <Tooltip label="Se entra sin marcar nada, como estaba antes de la actualización. Editala para ponerle PIN.">
                              <Badge variant="light" color="red">Sin PIN</Badge>
                            </Tooltip>
                          ) : !s.tiene_pin_mod ? (
                            <Tooltip label="Tiene PIN de participante pero no de moderador: nadie puede silenciar ni expulsar.">
                              <Badge variant="light" color="orange">Sin moderador</Badge>
                            </Tooltip>
                          ) : (
                            <Badge variant="light" color="teal">Configurado</Badge>
                          )}
                          {esAdmin && (s.tiene_pin || s.tiene_pin_mod) && (
                            <Tooltip label="Ver los PIN de esta sala">
                              <ActionIcon variant="subtle" color="grape" onClick={() => setVerPin(s)}><IconKey size={16} /></ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        {s.agenda_inicio
                          ? <Text fz="xs">{fmtFechaHora(s.agenda_inicio)} · {s.agenda_min} min</Text>
                          : <Text fz="xs" c="dimmed">siempre disponible</Text>}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Badge variant="light" color={s.abierta ? 'teal' : 'gray'}>{s.abierta ? 'Abierta' : 'Cerrada'}</Badge>
                          {s.participantes > 0 && <Badge variant="filled" color="teal">{s.participantes} adentro</Badge>}
                          {s.grabar && <Tooltip label="Se graba la reunión"><ThemeIcon size={20} radius="xl" variant="light" color="red"><IconPlayerRecord size={12} /></ThemeIcon></Tooltip>}
                        </Group>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          {esAdmin && (
                            <Tooltip label="Entrar a la reunión como moderador, desde este navegador">
                              <ActionIcon variant="subtle" color="grape" loading={abriendo === s.name} onClick={() => moderar(s)}><IconDoorEnter size={17} /></ActionIcon>
                            </Tooltip>
                          )}
                          <Tooltip label="Ver quién está adentro"><ActionIcon variant="subtle" color="teal" onClick={() => setEnVivo(s)}><IconEye size={17} /></ActionIcon></Tooltip>
                          <Tooltip label="Historial: reuniones anteriores y quién participó">
                            <ActionIcon variant="subtle" color="gray" onClick={() => setHistorial(s)}><IconHistory size={17} /></ActionIcon>
                          </Tooltip>
                          {esAdmin && <Tooltip label="Invitar por correo"><ActionIcon variant="subtle" color="cyan" onClick={() => setInvitar(s)}><IconMail size={17} /></ActionIcon></Tooltip>}
                          {esAdmin && (
                            <Tooltip label={s.web ? 'Enlace para entrar desde el navegador' : 'Todavía no se puede entrar desde el navegador'}>
                              <ActionIcon variant="subtle" color={s.web ? 'blue' : 'gray'} onClick={() => setEnlace(s)}><IconLink size={17} /></ActionIcon>
                            </Tooltip>
                          )}
                          {esAdmin && <Tooltip label="Editar"><ActionIcon variant="subtle" loading={abriendo === s.name} onClick={() => editarSala(s)}><IconPencil size={17} /></ActionIcon></Tooltip>}
                          {esAdmin && <Tooltip label="Borrar"><ActionIcon variant="subtle" color="red" onClick={() => borrar(s)}><IconTrash size={17} /></ActionIcon></Tooltip>}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
      </Card>

      {/* Tres cajones y no tres modales: la sala que se está editando, invitando o mirando
          es una fila de la tabla de atrás, y taparla entera obliga a cerrar para volver a
          ver cuál era. */}
      <DrawerNG
        opened={!!form} onClose={() => { cerrarForm(); setEditar(null); }} ancho={640}
        icono={<IconUsersGroup size={24} />}
        titulo={editar === 'nueva' ? 'Nueva sala de reunión' : 'Editar sala'}
        subtitulo="Un número al que entran varios y se escuchan entre todos"
        solapas={[{ value: 'sala', label: 'Sala', contenido: (
          form ? <SalaForm sala={editar === 'nueva' ? null : editar} onListo={listo}
            onEstado={setFormEstado} /> : null
        ) }]}
        pie={
          <Group justify="space-between">
            <Button variant="subtle" color="gray" onClick={() => { cerrarForm(); setEditar(null); }}>Cancelar</Button>
            <Button loading={!!(formEstado && formEstado.guardando)} onClick={() => formEstado && formEstado.guardar()}>
              {editar === 'nueva' ? 'Crear sala' : 'Guardar'}
            </Button>
          </Group>
        }
      />

      <DrawerNG
        opened={!!invitar} onClose={() => setInvitar(null)} ancho={600} color="teal"
        icono={<IconUserPlus size={24} />}
        titulo={invitar ? 'Invitar a «' + (invitar.label || invitar.name) + '»' : ''}
        subtitulo="El enlace y el PIN que se le pasan a quien va a entrar"
        solapas={[{ value: 'invitar', label: 'Invitación', contenido: (
          invitar ? <Invitar sala={invitar} onCerrar={() => setInvitar(null)} /> : null
        ) }]}
      />

      <DrawerNG
        opened={!!enlace} onClose={() => setEnlace(null)} ancho={480} color="blue"
        icono={<IconWorldShare size={24} />}
        titulo={enlace ? 'Enlace de «' + (enlace.label || enlace.name) + '»' : ''}
        subtitulo="Para entrar a la reunión desde el navegador, sin ser interno"
        solapas={[{ value: 'enlace', label: 'Enlace', contenido: (
          enlace ? <EnlaceWeb sala={enlace} onCambio={recargar} /> : null
        ) }]}
      />

      <DrawerNG
        opened={!!verPin} onClose={() => setVerPin(null)} ancho={440} color="gray"
        icono={<IconKey size={24} />}
        titulo={verPin ? 'PIN de «' + (verPin.label || verPin.name) + '»' : ''}
        subtitulo="Se muestra sólo mientras este cajón está abierto"
        solapas={[{ value: 'pin', label: 'PIN', contenido: (
          verPin ? <VerPin sala={verPin} onCerrar={() => setVerPin(null)} /> : null
        ) }]}
      />

      <DrawerNG
        opened={!!historial} onClose={() => setHistorial(null)} ancho={620} color="gray"
        icono={<IconHistory size={24} />}
        titulo={historial ? 'Historial de «' + (historial.label || historial.name) + '»' : ''}
        subtitulo="Reuniones anteriores, con quién participó y cuánto estuvo"
        solapas={[{ value: 'hist', label: 'Reuniones', contenido: (
          historial ? <Historial sala={historial} /> : null
        ) }]}
      />

      {/* La vista en vivo tambien en cajon NG: mismo encabezado, mismo pie, misma familia
          que el resto de la pantalla. */}
      <DrawerNG
        opened={!!enVivo} onClose={() => setEnVivo(null)} ancho={520} color="teal"
        icono={<IconEye size={24} />}
        titulo={enVivo ? 'En la sala «' + (enVivo.label || enVivo.name) + '»' : ''}
        subtitulo="Quien esta adentro, en vivo: silenciar y sacar de la reunion"
        solapas={[{ value: 'vivo', label: 'En vivo', contenido: (
          enVivo ? <EnVivo sala={enVivo} onCerrar={() => setEnVivo(null)} /> : null
        ) }]}
      />
    </Stack>
  );
}
