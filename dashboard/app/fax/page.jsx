'use client';
/* ============================================================================
 *  Fax: las dos bandejas, el formulario de envío y la configuración.
 *
 *  Lo que tiene que contestar esta pantalla, en este orden:
 *    1. ¿me llegó el fax que dicen que me mandaron?  → Recibidos
 *    2. ¿salió el que mandé, y si no, por qué?        → Enviados (cola con estado)
 *    3. mandar uno                                    → Enviar
 *    4. a qué correo va cada número, y el T.38        → Configuración (sólo admin)
 *
 *  Los documentos se bajan con `raw: true` de `app/api.js`: un `<a href download>` lo
 *  arma el navegador, no pasa por el parche de `window.fetch` de `auth.jsx` y bajaría un
 *  401 disfrazado de PDF (la misma trampa que ya nos comimos en Respaldos).
 *
 *  Si falta ghostscript, tiff2pdf o res_fax_spandsp, arriba aparece un aviso con el
 *  nombre exacto de lo que falta: es un problema de la imagen, no algo que el usuario
 *  pueda arreglar desde acá, y enterarse en medio de una llamada es peor.
 * ==========================================================================*/
import { useEffect, useState } from 'react';
import {
  Stack, Card, Group, Text, Button, Tabs, Badge, Table, ActionIcon, Alert, TextInput,
  Select, Switch, NumberInput, FileButton, MultiSelect, Skeleton, Tooltip, Divider, ThemeIcon,
} from '@mantine/core';
import {
  IconPrinter, IconDownload, IconTrash, IconSend, IconRefresh, IconInfoCircle, IconAlertTriangle,
  IconInbox, IconMailForward, IconSettings, IconPlus, IconDeviceFloppy, IconFileTypePdf,
} from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { api, apiGet, apiPost, apiPut, apiDel, usePoll } from '../api';
import { fmtBytes, fmtFechaHora } from '../fmt';
import { toast } from '../notify';
import { useEsAdmin } from '../auth';

const ESTADOS = {
  pendiente: { color: 'yellow', label: 'En cola' },
  enviando: { color: 'blue', label: 'Enviando' },
  ok: { color: 'teal', label: 'Enviado' },
  error: { color: 'red', label: 'Falló' },
  /* `cancelando`: se pidió cancelar pero el canal sigue en el aire. Se muestra distinto de
   * `cancelado` porque hasta que no termine la cola no arranca el siguiente fax, y si no se
   * ve el estado intermedio parece que la cola se colgó. */
  cancelando: { color: 'gray', label: 'Cancelando…' },
  cancelado: { color: 'gray', label: 'Cancelado' },
};
const paginas = (n) => (n === 1 ? '1 página' : (n || 0) + ' páginas');

/* Descarga con el token puesto. Devuelve el nombre para el toast de error. */
async function bajar(ruta, nombre) {
  try {
    const r = await api(ruta, { raw: true });
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast('No se pudo descargar', 'bad', { description: e.message }); }
}

// ── Aviso de lo que le falta a la instalación ──────────────────────────────
function Estado({ estado }) {
  if (!estado) return null;
  const faltan = [];
  if (!estado.herramientas.ghostscript) faltan.push('ghostscript (convertir el PDF que se manda)');
  if (!estado.herramientas.tiff2pdf) faltan.push('libtiff-tools / tiff2pdf (pasar a PDF el fax que llega)');
  if (estado.asterisk.spandsp === false) faltan.push('res_fax_spandsp en Asterisk (hablar con el otro módem)');
  if (!estado.spool.escribible) faltan.push('permiso de escritura en ' + estado.spool.dir);
  if (!faltan.length) return null;
  return (
    <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Al servidor le falta software para el fax">
      <Text size="sm">Hasta que se agregue a la imagen, el fax no va a funcionar completo. Falta:</Text>
      <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>{faltan.map((f) => <li key={f}><Text size="sm">{f}</Text></li>)}</ul>
    </Alert>
  );
}

// ── Recibidos ──────────────────────────────────────────────────────────────
/* `esAdmin` llega desde la página: `DELETE /api/fax/in/:id` es admin (rbac.js, CONTRATOS §2
 * — un fax recibido es un documento, borrarlo no es operación del día a día). Un supervisor
 * entra igual a /fax, así que sin este candado vería un botón que sólo sabe dar 403: un botón
 * que existe para fallar es peor que no tenerlo. */
function Recibidos({ esAdmin }) {
  /* Configuración de cadencia lenta (política de encuestado, CONTRATOS §2): un fax que
   * entra no es un dato que se esté mirando segundo a segundo. */
  const { data, cargando, recargar } = usePoll('/fax/in?limit=200', 30000);
  const filas = data || [];
  const borrar = async (f) => {
    if (!window.confirm('¿Borrar el fax de ' + (f.cid || 'desconocido') + '? También se borra el documento del disco.')) return;
    try { await apiDel('/fax/in/' + f.id); toast('Fax borrado', 'ok'); recargar(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  if (cargando && !data) return <Skeleton height={220} radius="md" />;
  return (
    <Card withBorder radius="md" padding="sm">
      {!filas.length
        ? <Text c="dimmed" size="sm" ta="center" py="lg">Todavía no entró ningún fax. Para que entren, una ruta entrante tiene que tener como destino una caja de fax (Rutas → Entrantes).</Text>
        : (
          <Table.ScrollContainer minWidth={760}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead><Table.Tr>
                <Table.Th>Fecha</Table.Th><Table.Th>De</Table.Th><Table.Th>Caja</Table.Th>
                <Table.Th>Páginas</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Correo</Table.Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {filas.map((f) => (
                  <Table.Tr key={f.id}>
                    <Table.Td><Text size="sm">{fmtFechaHora(f.recibido_at)}</Text></Table.Td>
                    <Table.Td><Text size="sm" ff="monospace">{f.cid || '—'}</Text>{f.remoto && <Text size="xs" c="dimmed">{f.remoto}</Text>}</Table.Td>
                    <Table.Td><Text size="sm">{f.caja || '—'}</Text></Table.Td>
                    <Table.Td><Text size="sm">{f.paginas || 0}</Text><Text size="xs" c="dimmed">{fmtBytes(f.bytes)}</Text></Table.Td>
                    <Table.Td>
                      {f.estado === 'ok'
                        ? <Badge color="teal" variant="light">Completo</Badge>
                        : <Tooltip label={f.detalle || 'la transmisión se cortó'} multiline w={260}><Badge color="red" variant="light">Incompleto</Badge></Tooltip>}
                    </Table.Td>
                    <Table.Td>
                      {f.email_ok === true ? <Badge color="teal" variant="dot">enviado</Badge>
                        : f.email_ok === false ? <Tooltip label={f.email_err || ''} multiline w={260}><Badge color="red" variant="dot">falló</Badge></Tooltip>
                          : <Text size="xs" c="dimmed">sin correo</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label={f.pdf ? 'Descargar PDF' : 'Descargar TIFF (no hay PDF: falta tiff2pdf)'}>
                          <ActionIcon variant="light" onClick={() => bajar('/fax/in/' + f.id + '/pdf', 'fax-' + f.id + (f.pdf ? '.pdf' : '.tif'))}><IconDownload size={16} /></ActionIcon>
                        </Tooltip>
                        {esAdmin && <Tooltip label="Borrar"><ActionIcon variant="light" color="red" onClick={() => borrar(f)}><IconTrash size={16} /></ActionIcon></Tooltip>}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
    </Card>
  );
}

// ── Enviados ───────────────────────────────────────────────────────────────
function Enviados({ refrescar }) {
  /* Mientras hay algo en la cola el estado cambia solo y se lo está mirando: 10 s
   * (política de encuestado, CONTRATOS §2). Sin nada pendiente vuelve a 30 s. */
  const [rapido, setRapido] = useState(false);
  const { data, cargando, recargar } = usePoll('/fax/out?limit=200', rapido ? 10000 : 30000);
  const filas = data || [];
  useEffect(() => { setRapido((data || []).some((f) => f.estado === 'pendiente' || f.estado === 'enviando' || f.estado === 'cancelando')); }, [data]);
  // `refrescar` arranca en 0: el primer render no recarga de más, sólo lo hace al mandar un fax.
  useEffect(() => { if (refrescar) recargar(); }, [refrescar]);   // eslint-disable-line react-hooks/exhaustive-deps

  const reintentar = async (f) => {
    try { await apiPost('/fax/out/' + f.id + '/retry'); toast('Vuelve a la cola', 'ok'); recargar(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  const borrar = async (f) => {
    try { const r = await apiDel('/fax/out/' + f.id); toast(r && r.cancelled ? 'Cancelado: no se reintenta más' : 'Borrado', 'ok'); recargar(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  if (cargando && !data) return <Skeleton height={220} radius="md" />;
  return (
    <Card withBorder radius="md" padding="sm">
      {!filas.length
        ? <Text c="dimmed" size="sm" ta="center" py="lg">No se mandó ningún fax todavía.</Text>
        : (
          <Table.ScrollContainer minWidth={800}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead><Table.Tr>
                <Table.Th>Fecha</Table.Th><Table.Th>Para</Table.Th><Table.Th>Asunto</Table.Th>
                <Table.Th>Páginas</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Intentos</Table.Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {filas.map((f) => {
                  const e = ESTADOS[f.estado] || { color: 'gray', label: f.estado };
                  return (
                    <Table.Tr key={f.id}>
                      <Table.Td><Text size="sm">{fmtFechaHora(f.created_at)}</Text></Table.Td>
                      <Table.Td><Text size="sm" ff="monospace">{f.numero}</Text>{f.nombre && <Text size="xs" c="dimmed">{f.nombre}</Text>}</Table.Td>
                      <Table.Td><Text size="sm">{f.asunto || '—'}</Text></Table.Td>
                      <Table.Td><Text size="sm">{f.paginas || 0}</Text></Table.Td>
                      <Table.Td>
                        <Tooltip label={f.detalle || e.label} multiline w={260} disabled={!f.detalle}>
                          <Badge color={e.color} variant="light">{e.label}</Badge>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td><Text size="sm" c="dimmed">{f.intentos}/{f.max_intentos}</Text></Table.Td>
                      <Table.Td>
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <Tooltip label="Descargar el PDF que se mandó"><ActionIcon variant="light" onClick={() => bajar('/fax/out/' + f.id + '/pdf', 'fax-enviado-' + f.id + '.pdf')}><IconDownload size={16} /></ActionIcon></Tooltip>
                          {(f.estado === 'error' || f.estado === 'cancelado') && (
                            <Tooltip label="Reintentar (no hay que volver a subir el PDF)"><ActionIcon variant="light" color="blue" onClick={() => reintentar(f)}><IconRefresh size={16} /></ActionIcon></Tooltip>
                          )}
                          <Tooltip label={f.estado === 'enviando' ? 'Cancelar' : 'Borrar'}>
                            {/* Mientras se está cancelando no hay nada más que pedir: el canal
                                todavía está vivo y borrar la fila ahí deja a SendFAX leyendo
                                un archivo que ya no está. */}
                            <ActionIcon variant="light" color="red" disabled={f.estado === 'cancelando'} onClick={() => borrar(f)}><IconTrash size={16} /></ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
    </Card>
  );
}

// ── Enviar ─────────────────────────────────────────────────────────────────
function Enviar({ estado, onEnviado }) {
  const [numero, setNumero] = useState('');
  const [nombre, setNombre] = useState('');
  const [asunto, setAsunto] = useState('');
  const [archivo, setArchivo] = useState(null);
  const [mandando, setMandando] = useState(false);
  const topeMb = (estado && estado.limites && estado.limites.max_mb) || 10;

  async function mandar() {
    if (!archivo) { toast('Elegí el PDF que querés mandar', 'bad'); return; }
    if (!/^[0-9\s.()-]{2,32}$/.test(numero)) { toast('Poné el número como lo marcarías desde un teléfono, con el prefijo de salida', 'bad'); return; }
    if (archivo.size > topeMb * 1024 * 1024) { toast('El PDF pesa más de ' + topeMb + ' MB', 'bad'); return; }
    setMandando(true);
    try {
      const qs = '?numero=' + encodeURIComponent(numero) + '&nombre=' + encodeURIComponent(nombre) + '&asunto=' + encodeURIComponent(asunto);
      /* El PDF va como cuerpo crudo: `api()` manda los Blob tal cual y acá se fija el
       * Content-Type, que es lo que la API usa para aceptar el cuerpo. */
      const r = await api('/fax/out' + qs, { method: 'POST', body: archivo, headers: { 'Content-Type': 'application/pdf' } });
      toast('Fax en cola para ' + r.numero + ' (' + paginas(r.paginas) + ')', 'ok', { description: 'Si no entra a la primera se reintenta solo.' });
      setArchivo(null); setAsunto('');
      onEnviado();
    } catch (e) { toast(e.message, 'bad'); }
    setMandando(false);
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="md" maw={560}>
        <Group gap="sm" align="flex-end">
          <TextInput label="Número de fax" description="Como lo marcarías desde un teléfono, con el prefijo de salida"
            placeholder="0 2487 5000" value={numero} onChange={(e) => setNumero(e.currentTarget.value)} style={{ flex: 1 }} />
        </Group>
        <Group grow>
          <TextInput label="Destinatario (opcional)" placeholder="Estudio Pérez" value={nombre} onChange={(e) => setNombre(e.currentTarget.value)} />
          <TextInput label="Asunto (opcional)" placeholder="Factura 1234" value={asunto} onChange={(e) => setAsunto(e.currentTarget.value)} />
        </Group>
        <div>
          <Text size="sm" fw={500}>Documento</Text>
          <Text size="xs" c="dimmed" mb={6}>PDF, hasta {topeMb} MB y {(estado && estado.limites && estado.limites.max_paginas) || 50} páginas. Se convierte a fax en el servidor.</Text>
          <Group gap="sm">
            <FileButton onChange={setArchivo} accept="application/pdf,.pdf">
              {(props) => <Button {...props} variant="light" leftSection={<IconFileTypePdf size={16} />}>Elegir PDF</Button>}
            </FileButton>
            {archivo && <Badge variant="light" color="teal">{archivo.name} · {fmtBytes(archivo.size)}</Badge>}
          </Group>
        </div>
        <Group>
          <Button leftSection={<IconSend size={16} />} loading={mandando} onClick={mandar}>Mandar el fax</Button>
        </Group>
        <Text size="xs" c="dimmed">
          El fax sale por la misma ruta saliente que una llamada normal (con su troncal, su prefijo y su failover). Queda en la cola
          hasta que entre: un fax que no entra a la primera es lo habitual.
        </Text>
      </Stack>
    </Card>
  );
}

// ── Configuración (cajas + T.38) ───────────────────────────────────────────
function Caja({ c, onCambio }) {
  const [v, setV] = useState(c);
  useEffect(() => { setV(c); }, [c]);
  const [guardando, setGuardando] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const guardar = async () => {
    setGuardando(true);
    try { await apiPut('/fax/boxes/' + c.id, v); toast('Caja «' + v.nombre + '» guardada', 'ok'); onCambio(); }
    catch (e) { toast(e.message, 'bad'); }
    setGuardando(false);
  };
  const borrar = async () => {
    if (!window.confirm('¿Borrar la caja «' + c.nombre + '»?')) return;
    try { await apiDel('/fax/boxes/' + c.id); toast('Caja borrada', 'ok'); onCambio(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <ThemeIcon variant="light" radius="md"><IconPrinter size={16} /></ThemeIcon>
          <Text fw={600}>{c.nombre}</Text>
          <Badge variant="light" color="gray">{c.recibidos} recibidos</Badge>
          {c.rutas > 0 && <Badge variant="light" color="teal">{c.rutas === 1 ? '1 DID' : c.rutas + ' DID'}</Badge>}
        </Group>
        <Group gap="xs">
          <Switch checked={v.enabled !== false} onChange={(e) => set('enabled', e.currentTarget.checked)} label="Activa" size="sm" />
          <ActionIcon variant="light" color="red" onClick={borrar}><IconTrash size={16} /></ActionIcon>
        </Group>
      </Group>
      <Stack gap="sm">
        <Group grow>
          <TextInput label="Nombre" value={v.nombre || ''} onChange={(e) => set('nombre', e.currentTarget.value)} />
          <TextInput label="Mandar por correo a" description="Uno o varios, separados por coma" placeholder="fax@empresa.com"
            value={v.email || ''} onChange={(e) => set('email', e.currentTarget.value)} />
        </Group>
        <Group grow>
          <TextInput label="Identificación que se anuncia (CSID)" description="Sale impreso en el fax del que recibe"
            placeholder="24875000" value={v.station_id || ''} onChange={(e) => set('station_id', e.currentTarget.value)} />
          <TextInput label="Cabecera" placeholder="Estudio Pérez" value={v.header || ''} onChange={(e) => set('header', e.currentTarget.value)} />
        </Group>
        <Group justify="space-between">
          <Switch checked={!!v.adjuntar_tiff} onChange={(e) => set('adjuntar_tiff', e.currentTarget.checked)}
            label="Adjuntar también el TIFF original" size="sm" />
          <Button size="xs" leftSection={<IconDeviceFloppy size={15} />} loading={guardando} onClick={guardar}>Guardar</Button>
        </Group>
      </Stack>
    </Card>
  );
}

function Config({ onCambio }) {
  const { data: cajas, cargando, recargar } = usePoll('/fax/boxes', 60000);
  const { data: conf, recargar: recargarConf } = usePoll('/fax/config', 60000);
  const [troncales, setTroncales] = useState([]);
  const [v, setV] = useState(null);
  const [guardando, setGuardando] = useState(false);
  useEffect(() => { if (conf) setV(conf); }, [conf]);
  useEffect(() => { apiGet('/trunks').then((t) => setTroncales((t || []).map((x) => x.name))).catch(() => {}); }, []);

  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const nueva = async () => {
    try { await apiPost('/fax/boxes', { nombre: 'Fax ' + ((cajas || []).length + 1) }); recargar(); onCambio(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  const guardar = async () => {
    setGuardando(true);
    try { await apiPut('/fax/config', v); toast('Configuración guardada', 'ok'); recargarConf(); onCambio(); }
    catch (e) { toast(e.message, 'bad'); }
    setGuardando(false);
  };

  if (cargando && !cajas) return <Skeleton height={260} radius="md" />;
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text fw={600}>Cajas de fax</Text>
        <Button size="xs" variant="light" leftSection={<IconPlus size={15} />} onClick={nueva}>Nueva caja</Button>
      </Group>
      <Alert color="blue" icon={<IconInfoCircle size={18} />}>
        Una caja es «a dónde va lo que entra por un número». Para que un DID entre acá, en <b>Rutas → Entrantes</b> elegí
        el destino <b>Fax</b> y esta caja.
      </Alert>
      {(cajas || []).map((c) => <Caja key={c.id} c={c} onCambio={() => { recargar(); onCambio(); }} />)}
      {!(cajas || []).length && <Card withBorder radius="md" padding="lg"><Text c="dimmed" size="sm" ta="center">Todavía no hay ninguna caja de fax.</Text></Card>}

      <Divider my="xs" label="T.38 y detección de tono" labelPosition="center" />
      {v && (
        <Card withBorder radius="md" padding="md">
          <Stack gap="sm">
            <Group grow>
              <TextInput label="Identificación por defecto (CSID)" value={v.station_id || ''} onChange={(e) => set('station_id', e.currentTarget.value)} />
              <TextInput label="Cabecera por defecto" value={v.header || ''} onChange={(e) => set('header', e.currentTarget.value)} />
            </Group>
            <MultiSelect label="Troncales con T.38" data={troncales} value={v.trunks || []} onChange={(t) => set('trunks', t)}
              description="Se le pide T.38 al operador en esas troncales. Si no lo acepta —o hay un SBC en el medio que no lo pasa— el fax sale igual en audio." />
            <Group grow>
              <Select label="Corrección de errores T.38" data={[{ value: 'redundancy', label: 'Redundancia (recomendado)' }, { value: 'fec', label: 'FEC' }, { value: 'none', label: 'Ninguna' }]}
                value={v.t38_ec} onChange={(x) => set('t38_ec', x || 'redundancy')} />
              <Select label="Detectar tono de fax en llamadas de voz" description="Deriva la llamada a una caja al escuchar el CNG"
                data={[{ value: '', label: 'No detectar' }, ...(cajas || []).map((c) => ({ value: String(c.id), label: c.nombre }))]}
                value={v.detect && v.detect_box ? String(v.detect_box) : ''}
                onChange={(x) => { set('detect', !!x); set('detect_box', x ? parseInt(x, 10) : null); }} />
            </Group>
            <Group grow>
              <Switch checked={!!v.t38} onChange={(e) => set('t38', e.currentTarget.checked)} label="Usar T.38 cuando se pueda" />
              <Switch checked={!!v.ecm} onChange={(e) => set('ecm', e.currentTarget.checked)} label="Corrección de errores (ECM)" />
            </Group>
            <Group grow>
              <NumberInput label="Reintentos de envío" min={0} max={10} value={v.reintentos} onChange={(x) => set('reintentos', x)} />
              <NumberInput label="Minutos entre reintentos" min={1} max={180} value={v.reintento_min} onChange={(x) => set('reintento_min', x)} />
              <NumberInput label="Máximo de páginas" min={1} max={500} value={v.max_paginas} onChange={(x) => set('max_paginas', x)} />
              <NumberInput label="Máximo MB por PDF" min={1} max={64} value={v.max_mb} onChange={(x) => set('max_mb', x)} />
            </Group>
            <Group justify="flex-end"><Button leftSection={<IconDeviceFloppy size={16} />} loading={guardando} onClick={guardar}>Guardar</Button></Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

export default function Page() {
  /* La solapa Configuración (cajas y T.38) y el borrado de un recibido son admin en
   * rbac.js: un botón que sólo sabe dar 403 es peor que no tenerlo. Mientras todavía no
   * se sabe quién entró, `useEsAdmin()` dice que no (ver el porqué en `app/auth.jsx`). */
  const esAdmin = useEsAdmin();
  const [tab, setTab] = useState('in');
  const [refrescar, setRefrescar] = useState(0);
  const { data: estado } = usePoll('/fax/estado', 60000);

  return (
    <Stack gap="md">
      <PageHeader icon={<IconPrinter size={24} />} title="Fax"
        subtitle="Recibir por correo, mandar desde el panel y ver en qué anda cada uno."
        right={estado ? <Badge variant="light" color={estado.en_cola ? 'yellow' : 'gray'}>{estado.en_cola ? estado.en_cola + ' en cola' : 'cola vacía'}</Badge> : null} />
      <Estado estado={estado} />
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="in" leftSection={<IconInbox size={16} />}>Recibidos</Tabs.Tab>
          <Tabs.Tab value="out" leftSection={<IconMailForward size={16} />}>Enviados</Tabs.Tab>
          <Tabs.Tab value="send" leftSection={<IconSend size={16} />}>Enviar</Tabs.Tab>
          {esAdmin && <Tabs.Tab value="cfg" leftSection={<IconSettings size={16} />}>Configuración</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="in" pt="md"><Recibidos esAdmin={esAdmin} /></Tabs.Panel>
        <Tabs.Panel value="out" pt="md"><Enviados refrescar={refrescar} /></Tabs.Panel>
        <Tabs.Panel value="send" pt="md"><Enviar estado={estado} onEnviado={() => { setRefrescar((n) => n + 1); setTab('out'); }} /></Tabs.Panel>
        {esAdmin && <Tabs.Panel value="cfg" pt="md"><Config onCambio={() => setRefrescar((n) => n + 1)} /></Tabs.Panel>}
      </Tabs>
    </Stack>
  );
}
