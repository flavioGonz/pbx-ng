'use client';
/* ============================================================================
 *  Respaldo y restauración de PBX-NG.
 *
 *  Dos operaciones con pesos MUY distintos: crear un respaldo es inofensivo,
 *  restaurar pisa la central entera. La pantalla lo refleja: crear es un botón
 *  normal, restaurar exige leer qué trae el archivo y escribir RESTAURAR.
 * ==========================================================================*/
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Stack, Card, Group, Text, Button, Badge, Table, ThemeIcon, Alert, Modal,
  Checkbox, TextInput, ActionIcon, Tooltip, Divider, Code, List, Loader, FileButton,
  Switch, NumberInput,
} from '@mantine/core';
import {
  IconDatabaseExport, IconDownload, IconTrash, IconUpload, IconAlertTriangle,
  IconRestore, IconShieldLock, IconClock, IconFileZip, IconCheck, IconInfoCircle,
  IconCalendarClock, IconX,
} from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast, toastPromise } from '../notify';
import { api } from '../api';
import { fmtBytes } from '../fmt';

/* El tamaño de un respaldo se escribe igual que en cualquier otra pantalla (fmt.js);
 * esta página tenía su propia copia de la conversión. La fecha, en cambio, se queda
 * acá: es la única que lleva año y hora juntos (un respaldo se elige por eso). */
const peso = fmtBytes;
const fecha = (s) => { try { return new Date(s).toLocaleString('es-UY', { dateStyle: 'short', timeStyle: 'short' }); } catch (_) { return s; } };

/* Respaldo programado. Lee y escribe GET/POST /api/backup/schedule
 * ({enabled, hour, keep, last_run, last_ok}; el POST lleva {enabled, hour, keep}).
 * Una API anterior a ese endpoint responde 404: en vez de un toast rojo en cada
 * carga de la página, se muestra que la función no existe en esta versión. */
function RespaldoProgramado() {
  const [estado, setEstado] = useState('cargando');   // cargando | ok | noDisponible | error
  const [remoto, setRemoto] = useState(null);           // lo que dijo la API (para last_run/last_ok)
  const [form, setForm] = useState({ enabled: false, hour: 3, keep: 14 });
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const j = await api('/backup/schedule');
      setRemoto(j || {});
      setForm({
        enabled: !!(j && j.enabled),
        hour: Number.isInteger(j && j.hour) ? j.hour : 3,
        keep: Number.isInteger(j && j.keep) ? j.keep : 14,
      });
      setEstado('ok');
    } catch (e) {
      // Una API anterior al planificador contesta 404: no es un error para el operador.
      if (e.status === 404) { setEstado('noDisponible'); return; }
      setEstado('error'); toast(e.message, 'bad');
    }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async () => {
    setGuardando(true);
    try {
      await toastPromise(
        api('/backup/schedule', { method: 'POST', body: { enabled: form.enabled, hour: form.hour, keep: form.keep } })
          .then((r) => { cargar(); return r; }),
        { loading: 'Guardando programación…',
          success: form.enabled ? `Respaldo programado todos los días a las ${String(form.hour).padStart(2, '0')}:00` : 'Respaldo programado desactivado',
          error: (e) => e.message || 'No se pudo guardar' });
    } catch (_) {} finally { setGuardando(false); }
  };

  const cambiado = remoto && (form.enabled !== !!remoto.enabled || form.hour !== remoto.hour || form.keep !== remoto.keep);
  const ultimo = remoto && remoto.last_run;

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Stack gap={8} style={{ flex: 1, minWidth: 280 }}>
          <Group gap={8}>
            <ThemeIcon size={26} radius="sm" variant="light" color="pbx"><IconCalendarClock size={15} /></ThemeIcon>
            <Text fw={600} fz="sm">Respaldo programado</Text>
            {estado === 'ok' && <Badge size="sm" variant="light" color={form.enabled ? 'teal' : 'gray'}>{form.enabled ? 'Activo' : 'Apagado'}</Badge>}
          </Group>
          {estado === 'cargando' && <Group gap={8}><Loader size="xs" /><Text fz="xs" c="dimmed">Consultando…</Text></Group>}
          {estado === 'noDisponible' && <Text fz="xs" c="dimmed">No disponible en esta versión.</Text>}
          {estado === 'error' && <Text fz="xs" c="red">No se pudo leer la programación. <Text span fz="xs" c="pbx" style={{ cursor: 'pointer' }} onClick={cargar}>Reintentar</Text></Text>}
          {estado === 'ok' && (
            <>
              <Text fz="xs" c="dimmed">
                Un respaldo automático por día, sin grabaciones, guardado en este mismo servidor.
                Igual conviene bajar uno cada tanto y guardarlo afuera.
              </Text>
              <Switch size="xs" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.currentTarget.checked })}
                label="Hacer un respaldo todos los días" />
              <Group gap="md" align="flex-end">
                <NumberInput size="xs" label="Hora" description="Hora local del servidor (0–23)" w={150}
                  min={0} max={23} step={1} allowDecimal={false} clampBehavior="strict" suffix=":00"
                  value={form.hour} onChange={(v) => setForm({ ...form, hour: Number.isInteger(v) ? v : form.hour })} disabled={!form.enabled} />
                <NumberInput size="xs" label="Conservar" description="Cuántos respaldos programados quedan" w={150}
                  min={1} max={365} step={1} allowDecimal={false} clampBehavior="strict"
                  value={form.keep} onChange={(v) => setForm({ ...form, keep: Number.isInteger(v) ? v : form.keep })} />
              </Group>
              <Group gap={6}>
                <IconClock size={13} opacity={0.5} />
                {ultimo ? (
                  <Text fz="xs" c="dimmed">
                    Última corrida: {fecha(ultimo)} ·{' '}
                    {remoto.last_ok === false
                      ? <Text span fz="xs" c="red"><IconX size={11} style={{ verticalAlign: -1 }} /> falló</Text>
                      : remoto.last_ok === true
                        ? <Text span fz="xs" c="teal"><IconCheck size={11} style={{ verticalAlign: -1 }} /> correcta</Text>
                        : <Text span fz="xs" c="dimmed">sin resultado</Text>}
                  </Text>
                ) : <Text fz="xs" c="dimmed">Todavía no corrió ninguno.</Text>}
              </Group>
            </>
          )}
        </Stack>
        {estado === 'ok' && (
          <Button leftSection={<IconCalendarClock size={16} />} loading={guardando} disabled={!cambiado} onClick={guardar}>
            Guardar programación
          </Button>
        )}
      </Group>
    </Card>
  );
}

export default function Respaldos() {
  const [data, setData] = useState(null);
  const [creando, setCreando] = useState(false);
  const [conGrab, setConGrab] = useState(false);
  const [nota, setNota] = useState('');
  const [subiendo, setSubiendo] = useState(false);
  const [rest, setRest] = useState(null);      // { nombre, manifiesto } — modal de restauración
  const [palabra, setPalabra] = useState('');
  const [restaurando, setRestaurando] = useState(false);
  const resetFile = useRef(null);

  const cargar = useCallback(() => api('/backup').then(setData).catch((e) => toast(e.message, 'bad')), []);
  useEffect(() => { cargar(); }, [cargar]);

  const lista = (data && data.respaldos) || [];

  const crear = async () => {
    setCreando(true);
    try {
      await toastPromise(
        api('/backup', { method: 'POST', body: { grabaciones: conGrab, nota } }).then((r) => { cargar(); return r; }),
        { loading: conGrab ? 'Creando respaldo con grabaciones (puede tardar)…' : 'Creando respaldo…',
          success: (r) => `Respaldo creado · ${peso(r.bytes)}`,
          error: (e) => e.message || 'No se pudo crear' });
      setNota('');
    } catch (_) {} finally { setCreando(false); }
  };

  const subir = async (file) => {
    if (!file) return;
    if (!file.name.endsWith('.tar.gz')) { toast('Tiene que ser un .tar.gz de PBX-NG', 'bad'); return; }
    setSubiendo(true);
    try {
      await toastPromise(
        api('/backup/subir/' + encodeURIComponent(file.name), {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        }).then((j) => { cargar(); return j; }),
        { loading: `Subiendo ${file.name}…`, success: 'Respaldo subido y verificado',
          error: (e) => e.message || 'No se pudo subir' });
    } catch (_) {} finally { setSubiendo(false); resetFile.current && resetFile.current(); }
  };

  const abrirRestaurar = async (nombre) => {
    try {
      const m = await api(`/backup/${encodeURIComponent(nombre)}/inspeccionar`);
      setRest({ nombre, m }); setPalabra('');
    } catch (e) { toast(e.message, 'bad'); }
  };

  const restaurar = async () => {
    if (palabra !== 'RESTAURAR' || !rest) return;
    setRestaurando(true);
    try {
      await toastPromise(
        api(`/backup/${encodeURIComponent(rest.nombre)}/restaurar`, { method: 'POST', body: { confirmar: true } })
          .then((r) => { cargar(); return r; }),
        { loading: 'Restaurando…',
          success: (r) => `Restaurado: ${r.restauradas.join(', ')}. Reiniciá los servicios.`,
          error: (e) => e.message || 'No se pudo restaurar' });
      setRest(null);
    } catch (_) {} finally { setRestaurando(false); }
  };

  /* Era un `<a href download>`: ese pedido lo arma el navegador, no pasa por el parche de
   * `window.fetch` de auth.jsx y bajaba un 401 disfrazado de archivo. Con `raw: true` va
   * con el token y, si falla, se ve el motivo. */
  const descargar = async (nombre) => {
    try {
      const resp = await api(`/backup/${encodeURIComponent(nombre)}/archivo`, { raw: true });
      const url = URL.createObjectURL(await resp.blob());
      const a = document.createElement('a');
      a.href = url; a.download = nombre;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast('No se pudo descargar', 'bad', { description: e.message }); }
  };

  const borrar = (n) => toastPromise(
    api('/backup/' + encodeURIComponent(n), { method: 'DELETE' }).then(cargar),
    { loading: 'Borrando…', success: `${n} borrado`, error: (e) => e.message || 'No se pudo borrar' });

  const compat = rest && rest.m && rest.m.compatible;

  return (
    <Stack gap="md">
      <PageHeader icon={<IconDatabaseExport size={24} />} title="Respaldo y restauración"
        subtitle="Guardá la central entera en un archivo, y volvé a levantarla desde él." />

      <Alert color="orange" variant="light" icon={<IconShieldLock size={18} />} title="Tratá el archivo como material sensible">
        <b>Incluye los certificados TLS con sus claves privadas</b> — sin ellas el respaldo no
        serviría para volver a levantar la central. Guardalo como guardarías una llave: no lo
        mandes por correo ni lo dejes en una carpeta compartida.
        <br />
        No incluye, en cambio, las credenciales del entorno (base de datos, secreto de sesiones,
        AMI/ARI): la instalación donde lo restaures usa <b>las suyas</b>.
      </Alert>

      <Card withBorder radius="md" p="md">
        <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
          <Stack gap={8} style={{ flex: 1, minWidth: 280 }}>
            <Text fw={600} fz="sm">Crear un respaldo nuevo</Text>
            <TextInput size="xs" placeholder="Nota (opcional): 'antes de cambiar el operador'"
              value={nota} onChange={(e) => setNota(e.currentTarget.value)} maxLength={300} />
            <Checkbox size="xs" checked={conGrab} onChange={(e) => setConGrab(e.currentTarget.checked)}
              label="Incluir las grabaciones de llamadas"
              description="Las grabaciones crecen sin techo. Sin ellas el respaldo pesa poco y se puede hacer seguido; conviene archivarlas por separado." />
          </Stack>
          <Group gap="sm">
            <FileButton onChange={subir} accept=".gz" resetRef={resetFile}>
              {(props) => <Button {...props} variant="default" leftSection={<IconUpload size={16} />} loading={subiendo}>Subir uno</Button>}
            </FileButton>
            <Button leftSection={<IconDatabaseExport size={16} />} loading={creando} onClick={crear}>Crear respaldo</Button>
          </Group>
        </Group>
      </Card>

      <RespaldoProgramado />

      <Card withBorder radius="md" p={0}>
        {!data ? <Group justify="center" p="xl"><Loader size="sm" /></Group>
          : lista.length === 0 ? (
            <Stack align="center" gap={6} p="xl">
              <ThemeIcon size={46} radius="md" variant="light" color="gray"><IconFileZip size={24} /></ThemeIcon>
              <Text fw={600} fz="sm">Todavía no hay respaldos</Text>
              <Text fz="xs" c="dimmed" ta="center" maw={420}>
                Conviene crear uno ahora y otro antes de cada cambio grande. Un respaldo que nunca
                se probó no es un respaldo: bajalo y guardalo fuera de este servidor.
              </Text>
            </Stack>
          ) : (
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Archivo</Table.Th><Table.Th>Creado</Table.Th>
                  <Table.Th>Tamaño</Table.Th><Table.Th style={{ width: 170 }}></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {lista.map((b) => (
                  <Table.Tr key={b.nombre}>
                    <Table.Td><Group gap={8}><ThemeIcon size={26} radius="sm" variant="light" color="pbx"><IconFileZip size={14} /></ThemeIcon>
                      <Code>{b.nombre}</Code></Group></Table.Td>
                    <Table.Td><Group gap={6}><IconClock size={13} opacity={0.5} /><Text fz="sm">{fecha(b.creado)}</Text></Group></Table.Td>
                    <Table.Td><Badge variant="light" color="gray">{peso(b.bytes)}</Badge></Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label="Descargar"><ActionIcon variant="subtle"
                          onClick={() => descargar(b.nombre)}><IconDownload size={16} /></ActionIcon></Tooltip>
                        <Tooltip label="Restaurar desde este respaldo"><ActionIcon variant="subtle" color="orange"
                          onClick={() => abrirRestaurar(b.nombre)}><IconRestore size={16} /></ActionIcon></Tooltip>
                        <Tooltip label="Borrar"><ActionIcon variant="subtle" color="red"
                          onClick={() => borrar(b.nombre)}><IconTrash size={16} /></ActionIcon></Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
      </Card>

      {/* Restaurar: la operación destructiva. Primero se muestra QUÉ trae el archivo. */}
      <Modal opened={!!rest} onClose={() => setRest(null)} size="lg" radius="md" centered
        title={<Group gap={8}><ThemeIcon size={30} radius="md" variant="light" color="orange"><IconRestore size={17} /></ThemeIcon>
          <div><Text fw={700}>Restaurar la central</Text><Text fz="xs" c="dimmed">{rest && rest.nombre}</Text></div></Group>}>
        {rest && (
          <Stack gap="sm">
            {compat && !compat.ok ? (
              <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Este respaldo no se puede restaurar acá">
                {compat.motivo}
              </Alert>
            ) : (
              <>
                <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Esto pisa la configuración actual">
                  Se reemplazan la base de datos y los archivos de la central por los del respaldo.
                  Las llamadas en curso se cortan cuando reinicies los servicios.
                  <b> Antes de tocar nada se crea un respaldo automático</b>, así que se puede volver.
                </Alert>

                <Card withBorder radius="sm" p="sm">
                  <Text fz="xs" fw={700} c="dimmed" mb={6}>QUÉ TRAE ESTE ARCHIVO</Text>
                  <Group gap="lg" mb={8}>
                    <div><Text fz="xs" c="dimmed">Creado</Text><Text fz="sm" fw={600}>{fecha(rest.m.creado)}</Text></div>
                    <div><Text fz="xs" c="dimmed">Origen</Text><Text fz="sm" fw={600}>{rest.m.host || '—'}</Text></div>
                    <div><Text fz="xs" c="dimmed">PostgreSQL</Text><Text fz="sm" fw={600}>{rest.m.postgres || '—'}</Text></div>
                  </Group>
                  {rest.m.nota && <Text fz="sm" fs="italic" c="dimmed" mb={8}>“{rest.m.nota}”</Text>}
                  <List spacing={2} size="xs" center>
                    {(rest.m.partes || []).map((p) => (
                      <List.Item key={p.id}
                        icon={<ThemeIcon size={16} radius="xl" variant="light" color={p.archivo ? 'teal' : 'gray'}>
                          {p.archivo ? <IconCheck size={10} /> : <IconInfoCircle size={10} />}</ThemeIcon>}>
                        <b>{p.id}</b> — {p.desc}{' '}
                        {p.archivo ? <Text span c="dimmed">({peso(p.bytes)})</Text>
                          : <Text span c="dimmed">({p.omitida || (p.ausente ? 'no estaba en el origen' : 'sin datos')})</Text>}
                      </List.Item>
                    ))}
                  </List>
                </Card>

                <Divider />
                <Text fz="sm">Para confirmar, escribí <Code>RESTAURAR</Code>:</Text>
                <TextInput value={palabra} onChange={(e) => setPalabra(e.currentTarget.value)}
                  placeholder="RESTAURAR" autoComplete="off" />
                <Group justify="flex-end" gap="sm">
                  <Button variant="default" onClick={() => setRest(null)}>Cancelar</Button>
                  <Button color="orange" leftSection={<IconRestore size={16} />} loading={restaurando}
                    disabled={palabra !== 'RESTAURAR'} onClick={restaurar}>Restaurar ahora</Button>
                </Group>
              </>
            )}
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
