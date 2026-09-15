'use client';
/* BuzonesPanel — Buzones de voz: alta, baja y el PIN.
 *
 * POR QUÉ DEJÓ DE SER UN <CrudPanel>: el PIN del buzón era el número del buzón (o sea,
 * no había PIN) y el formulario genérico lo pedía como un campo más, con el interno de
 * ejemplo en la descripción. Ahora el PIN lo genera la API sola y este panel tiene que
 * hacer tres cosas que el CRUD genérico no sabe: mostrarlo UNA vez al crearlo, mostrarlo
 * bajo pedido (`GET /api/mailboxes/:mailbox`, admin) y rotarlo. Es el mismo camino que
 * ya recorrieron las salas de reunión en 1.10.0 (ver SalasPanel).
 *
 * El listado NO trae el PIN, sólo `pin_debil`: una lista de veinte buzones con el PIN al
 * lado es una lista de veinte buzones abiertos para el que pasa por atrás.
 *
 * Los buzones de una central que ya venía andando siguen con su PIN viejo (= el número):
 * rotárselos de una deja a cada persona afuera de sus propios mensajes sin avisarle. Se
 * los marca acá para que el administrador los rote uno por uno, cuando pueda avisar. */
import { useEffect, useState } from 'react';
import {
  Card, Group, Title, Text, Button, Table, Modal, TextInput, Badge, Stack, ActionIcon,
  ThemeIcon, Tooltip, Alert, CopyButton, Loader, Divider,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconMail, IconPlus, IconTrash, IconKey, IconRefresh, IconCopy, IconCheck,
  IconAlertTriangle, IconInfoCircle, IconUser, IconHash, IconEye,
} from '@tabler/icons-react';
import { toast } from './notify';
import { apiDel, apiGet, apiPost, usePoll } from './api';
import { TableSkeleton } from './Skeletons';

/* PIN con un clic para copiarlo: el operador lo dicta por teléfono o lo pega en un chat.
 * Mismo componente y mismo gesto que en SalasPanel, para que se lea igual en las dos. */
function Pin({ valor }) {
  return (
    <CopyButton value={valor || ''}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copiado' : 'Copiar PIN'}>
          <Badge size="lg" variant="light" color={copied ? 'teal' : 'indigo'} ff="monospace" style={{ cursor: 'pointer' }}
            rightSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />} onClick={copy}>
            {valor || '—'}
          </Badge>
        </Tooltip>
      )}
    </CopyButton>
  );
}

/* «Ver PIN» pide el buzón de a uno al detalle (admin), que es el único lugar donde la API
 * devuelve el PIN en claro. No se pide en el listado a propósito: así el PIN no viaja en
 * cada encuestado de 30 s ni queda en pantalla mientras se mira otra cosa. */
function VerPin({ mailbox, onCerrar }) {
  const [detalle, setDetalle] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let vivo = true;
    apiGet('/mailboxes/' + mailbox)
      .then((d) => { if (vivo) setDetalle(d); })
      .catch((e) => { if (vivo) setError(e.message); });
    return () => { vivo = false; };
  }, [mailbox]);
  return (
    <Stack gap="sm">
      {error
        ? <Alert variant="light" color="red" icon={<IconInfoCircle size={18} />}>{error}</Alert>
        : !detalle
          ? <Group justify="center" py="md"><Loader size="sm" /></Group>
          : (
            <>
              <Group gap={10}>
                <Text fz="sm" w={110}>PIN del buzón</Text>
                <Pin valor={detalle.pin} />
              </Group>
              <Alert variant="light" color={detalle.pin_debil ? 'orange' : 'indigo'} icon={<IconInfoCircle size={18} />}>
                {detalle.pin_debil
                  ? <>Este PIN es el número del buzón, así que <b>no es un PIN</b>: con <b>*98</b> lo escucha cualquier interno. Rotalo y avisale al dueño.</>
                  : <>El dueño escucha sus mensajes marcando <b>*97</b> desde su interno. Con <b>*98</b> se entra a un buzón ajeno, y ahí este PIN es lo único que lo protege.</>}
              </Alert>
            </>
          )}
      <Group justify="flex-end"><Button variant="default" onClick={onCerrar}>Cerrar</Button></Group>
    </Stack>
  );
}

export default function BuzonesPanel() {
  /* Configuración: la cambia una persona desde acá y después se recarga a mano. El poll
   * largo es sólo por si la tocó otro operador (política de encuestado, CONTRATOS §2). */
  const { data, error, cargando, recargar } = usePoll('/mailboxes', 30000);
  const buzones = Array.isArray(data) ? data : [];
  const debiles = buzones.filter((b) => b.pin_debil);

  const [form, { open: abrirForm, close: cerrarForm }] = useDisclosure(false);
  const [nuevo, setNuevo] = useState({ mailbox: '', fullname: '', email: '' });
  const [guardando, setGuardando] = useState(false);
  const [recien, setRecien] = useState(null);     // { mailbox, pin, avisado } recién creado o rotado
  const [verPin, setVerPin] = useState(null);
  const [rotando, setRotando] = useState('');

  useEffect(() => { if (error) toast(error.message, 'bad'); }, [error]);

  async function crear() {
    setGuardando(true);
    try {
      /* Sin campo de PIN: lo genera la API. El formulario ya no puede sugerir el número
       * del interno, que es exactamente lo que había que sacar de acá. */
      const r = await apiPost('/mailboxes', nuevo);
      cerrarForm();
      setNuevo({ mailbox: '', fullname: '', email: '' });
      /* `ya_existia`: el buzón estaba hecho (cada interno nace con el suyo) y la API devuelve
       * el PIN que YA tenía, no uno nuevo. Decirle «creado» al operador sería mentirle. */
      setRecien({ mailbox: r.created, pin: r.pin, nuevo: !r.ya_existia, yaExistia: !!r.ya_existia });
      recargar();
    } catch (e) { toast(e.message, 'bad'); }
    finally { setGuardando(false); }
  }

  async function rotar(b) {
    if (!confirm('¿Generar un PIN nuevo para el buzón ' + b.mailbox + '?\n\nEl PIN anterior deja de servir en la próxima llamada. Si el buzón tiene correo configurado, se le avisa al dueño por mail; si no, avisale vos.')) return;
    setRotando(b.mailbox);
    try {
      const r = await apiPost('/mailboxes/' + b.mailbox + '/pin', {});
      setRecien({ mailbox: r.mailbox, pin: r.pin, avisado: r.avisado });
      recargar();
    } catch (e) { toast(e.message, 'bad'); }
    finally { setRotando(''); }
  }

  async function borrar(b) {
    if (!confirm('¿Borrar el buzón ' + b.mailbox + '? Los mensajes guardados dejan de estar accesibles.')) return;
    try { await apiDel('/mailboxes/' + b.mailbox); toast('Buzón borrado', 'info'); recargar(); }
    catch (e) { toast(e.message, 'bad'); }
  }

  return (
    <Stack gap="lg">
      {debiles.length > 0 && (
        <Alert variant="light" color="orange" icon={<IconAlertTriangle size={18} />}
          title={debiles.length === 1 ? 'Hay un buzón sin PIN de verdad' : 'Hay ' + debiles.length + ' buzones sin PIN de verdad'}>
          El PIN de {debiles.length === 1 ? 'este buzón' : 'estos buzones'} es el propio número,
          así que cualquiera que sepa el interno los escucha marcando <b>*98</b>:{' '}
          <b>{debiles.map((b) => b.mailbox).join(' · ')}</b>.
          {' '}Quedaron como estaban a propósito —rotarles el PIN de golpe deja a cada persona afuera
          de sus propios mensajes sin avisarle—. Rotalos de a uno con <b>PIN nuevo</b> y contale al dueño.
        </Alert>
      )}

      <Card withBorder radius="lg" padding="lg">
        <Group justify="space-between" mb="md">
          <Group gap={10} wrap="nowrap">
            <ThemeIcon size={32} radius="md" variant="light" color="indigo"><IconMail size={18} /></ThemeIcon>
            <div>
              <Title order={4} lh={1.15}>Buzones de voz</Title>
              <Text size="sm" c="dimmed">Marcá *97 desde el interno para escuchar los mensajes; *98 para entrar a otro buzón con su PIN</Text>
            </div>
          </Group>
          <Button leftSection={<IconPlus size={16} />} onClick={abrirForm}>Nuevo buzón</Button>
        </Group>

        {cargando && !data ? <TableSkeleton rows={4} cols={4} /> :
          buzones.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin buzones. Cada interno que se crea ya trae el suyo.</Text> : (
            <Table.ScrollContainer minWidth={640}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Buzón</Table.Th>
                    <Table.Th>Nombre</Table.Th>
                    <Table.Th>Email</Table.Th>
                    <Table.Th>PIN</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {buzones.map((b) => (
                    <Table.Tr key={b.mailbox}>
                      <Table.Td><Badge variant="light" ff="monospace">{b.mailbox}</Badge></Table.Td>
                      <Table.Td>{b.fullname || <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                      <Table.Td>{b.email || <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                      <Table.Td>
                        {b.pin_debil
                          ? <Badge variant="light" color="orange" leftSection={<IconAlertTriangle size={11} />}>Es el número</Badge>
                          : <Badge variant="light" color="teal" leftSection={<IconKey size={11} />}>Propio</Badge>}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} justify="flex-end" wrap="nowrap">
                          <Tooltip label="Ver el PIN"><ActionIcon variant="subtle" onClick={() => setVerPin(b.mailbox)}><IconEye size={16} /></ActionIcon></Tooltip>
                          <Tooltip label="Generar un PIN nuevo"><ActionIcon variant="subtle" color="indigo" loading={rotando === b.mailbox} onClick={() => rotar(b)}><IconRefresh size={16} /></ActionIcon></Tooltip>
                          <Tooltip label="Borrar el buzón"><ActionIcon variant="subtle" color="red" onClick={() => borrar(b)}><IconTrash size={16} /></ActionIcon></Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
      </Card>

      <Modal opened={form} onClose={cerrarForm} title="Nuevo buzón de voz" centered>
        <Stack gap="sm">
          <TextInput label="Buzón (interno)" required leftSection={<IconHash size={15} />} placeholder="1001"
            description="Número del interno dueño del buzón."
            value={nuevo.mailbox} onChange={(e) => setNuevo((s) => ({ ...s, mailbox: e.currentTarget.value }))} />
          <TextInput label="Nombre completo" leftSection={<IconUser size={15} />} placeholder="Juan Pérez"
            value={nuevo.fullname} onChange={(e) => setNuevo((s) => ({ ...s, fullname: e.currentTarget.value }))} />
          <TextInput label="Email" leftSection={<IconMail size={15} />} placeholder="juan@empresa.com"
            description="Para recibir los mensajes por correo (opcional)."
            value={nuevo.email} onChange={(e) => setNuevo((s) => ({ ...s, email: e.currentTarget.value }))} />
          <Alert variant="light" color="indigo" icon={<IconKey size={18} />}>
            El <b>PIN se genera solo</b>, al azar, y se muestra una vez al terminar. Después se
            puede ver o cambiar desde la lista.
          </Alert>
          <Divider />
          <Group justify="flex-end">
            <Button variant="default" onClick={cerrarForm}>Cancelar</Button>
            <Button loading={guardando} disabled={!nuevo.mailbox.trim()} onClick={crear}>Crear buzón</Button>
          </Group>
        </Stack>
      </Modal>

      {/* El PIN recién generado se muestra en un cartel aparte y no en un toast que se va
          solo: es el único momento en que aparece sin tener que ir a buscarlo, y si el
          operador lo pierde tiene que volver a rotarlo. */}
      <Modal opened={!!recien} onClose={() => setRecien(null)} title={recien && recien.nuevo ? 'Buzón creado' : 'PIN nuevo'} centered>
        {recien && (
          <Stack gap="sm">
            <Group gap={10}>
              <Text fz="sm" w={110}>Buzón {recien.mailbox}</Text>
              <Pin valor={recien.pin} />
            </Group>
            {recien.yaExistia && (
              <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />}>
                Ese buzón <b>ya existía</b> (cada interno nace con el suyo): se le actualizó el nombre
                y el correo, y arriba está el PIN que ya tenía. Si querés otro, usá <b>PIN nuevo</b>.
              </Alert>
            )}
            <Alert variant="light" color={recien.avisado ? 'teal' : 'orange'} icon={<IconInfoCircle size={18} />}>
              {recien.avisado
                ? <>Se le mandó el PIN nuevo por correo al dueño del buzón.</>
                : <>Anotalo o copialo ahora y <b>pasáselo al dueño</b>: la central no se lo avisa sola (el buzón no tiene correo configurado, o la central no tiene servidor de correo).</>}
            </Alert>
            <Group justify="flex-end"><Button onClick={() => setRecien(null)}>Listo</Button></Group>
          </Stack>
        )}
      </Modal>

      <Modal opened={!!verPin} onClose={() => setVerPin(null)} title={'PIN del buzón ' + (verPin || '')} centered>
        {verPin && <VerPin mailbox={verPin} onCerrar={() => setVerPin(null)} />}
      </Modal>
    </Stack>
  );
}
