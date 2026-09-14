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
  Card, Group, Text, Title, Button, Table, Modal, Drawer, TextInput, NumberInput, Switch,
  Stack, ActionIcon, ThemeIcon, Badge, Tooltip, Divider, Alert, Textarea, CopyButton, Loader,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconUsers, IconPlus, IconTrash, IconPencil, IconEye, IconMail, IconLock, IconHash,
  IconTag, IconMicrophoneOff, IconMicrophone, IconDoorExit, IconInfoCircle, IconDice,
  IconCalendarEvent, IconPlayerRecord, IconCopy, IconCheck, IconRefresh, IconKey,
  IconAlertTriangle,
} from '@tabler/icons-react';
import PageHeader from './PageHeader';
import { TableSkeleton } from './Skeletons';
import { apiDel, apiGet, apiPost, apiPut, usePoll } from './api';
import { useEsAdmin } from './auth';
import { fmtFechaHora, fmtInputFechaHora } from './fmt';
import { toast } from './notify';

const VACIA = {
  name: '', label: '', access_exten: '', pin: '', pin_mod: '', max_part: 0,
  moh_hasta_moderador: true, anunciar: true, grabar: false, agenda_inicio: '', agenda_min: 60,
};

/* Un PIN sugerido desde el panel para que el operador pueda verlo antes de guardar.
 * El que manda igual es el de la API cuando el campo va vacío; esto es comodidad,
 * no seguridad. */
const pinAzar = () => String(Math.floor(Math.random() * 1000000)).padStart(6, '0');

function SalaForm({ sala, onListo, onCancelar }) {
  const editando = !!sala;
  const [f, setF] = useState(() => (sala
    ? { ...VACIA, ...sala, agenda_inicio: fmtInputFechaHora(sala.agenda_inicio), agenda_min: sala.agenda_min || 60 }
    : { ...VACIA }));
  const [guardando, setGuardando] = useState(false);
  const up = (k, v) => setF((s) => ({ ...s, [k]: v }));

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
      toast('Sala «' + (r.label || r.name) + '» guardada', 'ok', {
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

      <Group justify="flex-end" mt="sm">
        <Button variant="default" onClick={onCancelar}>Cancelar</Button>
        <Button loading={guardando} onClick={guardar}>{editando ? 'Guardar' : 'Crear sala'}</Button>
      </Group>
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
      toast(n + ' invitación' + (n === 1 ? '' : 'es') + ' enviada' + (n === 1 ? '' : 's'), n ? 'ok' : 'bad',
        (r.fallados || []).length ? { description: 'No salieron: ' + r.fallados.map((x) => x.destino).join(', ') } : undefined);
      if (n) onCerrar();
    } catch (e) { toast(e.message, 'bad'); }
    setEnviando(false);
  }

  return (
    <Stack gap="sm">
      <Alert variant="light" color="cyan" icon={<IconInfoCircle size={18} />}>
        A cada invitado le llega el número a marcar, su PIN y la hora de la reunión. Se manda
        <b> un correo por persona</b>: nadie ve la lista de los demás.
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
      <Group justify="flex-end" mt="sm">
        <Button variant="default" onClick={onCerrar}>Cancelar</Button>
        <Button color={moderador ? 'orange' : undefined} loading={enviando} leftSection={<IconMail size={16} />} onClick={enviar}>
          Enviar invitación
        </Button>
      </Group>
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
  const [abriendo, setAbriendo] = useState('');     // nombre de la sala que se está trayendo
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
                  <Table.Th>Sala</Table.Th><Table.Th>Número</Table.Th><Table.Th>PIN</Table.Th>
                  <Table.Th>Agenda</Table.Th><Table.Th>Estado</Table.Th><Table.Th />
                </Table.Tr></Table.Thead>
                <Table.Tbody>
                  {salas.map((s) => (
                    <Table.Tr key={s.name}>
                      <Table.Td>
                        <Text fw={600} fz="sm">{s.label || s.name}</Text>
                        <Text fz="xs" c="dimmed" ff="monospace">{s.name}</Text>
                      </Table.Td>
                      <Table.Td><Badge variant="light" color="grape" ff="monospace">{s.access_exten}</Badge></Table.Td>
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
                          <Tooltip label="Ver quién está adentro"><ActionIcon variant="subtle" color="teal" onClick={() => setEnVivo(s)}><IconEye size={17} /></ActionIcon></Tooltip>
                          {esAdmin && <Tooltip label="Invitar por correo"><ActionIcon variant="subtle" color="cyan" onClick={() => setInvitar(s)}><IconMail size={17} /></ActionIcon></Tooltip>}
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

      <Modal opened={form} onClose={() => { cerrarForm(); setEditar(null); }} centered radius="lg" size="lg"
        title={editar === 'nueva' ? 'Nueva sala de reunión' : 'Editar sala'}>
        {form && <SalaForm sala={editar === 'nueva' ? null : editar} onListo={listo} onCancelar={() => { cerrarForm(); setEditar(null); }} />}
      </Modal>

      <Modal opened={!!invitar} onClose={() => setInvitar(null)} centered radius="lg" size="lg"
        title={invitar ? 'Invitar a «' + (invitar.label || invitar.name) + '»' : ''}>
        {invitar && <Invitar sala={invitar} onCerrar={() => setInvitar(null)} />}
      </Modal>

      <Modal opened={!!verPin} onClose={() => setVerPin(null)} centered radius="lg"
        title={verPin ? 'PIN de «' + (verPin.label || verPin.name) + '»' : ''}>
        {verPin && <VerPin sala={verPin} onCerrar={() => setVerPin(null)} />}
      </Modal>

      <Drawer opened={!!enVivo} onClose={() => setEnVivo(null)} position="right" size="md"
        title={enVivo ? 'En la sala «' + (enVivo.label || enVivo.name) + '»' : ''}>
        {enVivo && <EnVivo sala={enVivo} onCerrar={() => setEnVivo(null)} />}
      </Drawer>
    </Stack>
  );
}
