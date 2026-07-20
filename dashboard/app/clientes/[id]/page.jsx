'use client';
/* Ficha de cliente — todo lo que sabemos de un cliente, en una sola pantalla:
   sus datos, quién está autorizado, sus espacios, el video en vivo de sus porteros y
   cámaras, su historial de llamadas con las grabaciones, las intervenciones que dejó
   el agente y dónde queda en el mapa. */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Card, Text, Group, Badge, Button, TextInput, Textarea, Select, Stack, ThemeIcon, Tabs,
  ActionIcon, Tooltip, Avatar, Loader, Anchor, SimpleGrid, Table, Divider, Transition, Timeline, Rating,
} from '@mantine/core';
import {
  IconArrowLeft, IconUserCheck, IconBuilding, IconDeviceCctv, IconTrash, IconDeviceFloppy,
  IconId, IconMapPin, IconPhone, IconBell, IconAddressBook, IconVideo, IconHistory,
  IconClipboardList, IconMap2, IconPhoneCheck, IconPhoneX, IconClock, IconPlayerPlay,
  IconPlayerPause, IconMoodSmile, IconRefresh, IconInfoCircle, IconCircleFilled,
} from '@tabler/icons-react';
import { toast } from '../../notify';
import Slot from '../../Slot';
import Intercom from '../../Intercom';
import RecordingPlayer from '../../RecordingPlayer';

const API = '/backend/api';
const j = (u, o) => fetch(u, o).then(r => (r.ok ? r.json() : Promise.reject(r))).catch(() => null);
const initials = (n) => (n || '?').split(/[\s.]+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const fmtDur = (s) => { s = s || 0; const m = Math.floor(s / 60), ss = s % 60; return m ? `${m}m ${ss}s` : `${ss}s`; };
const fmtDate = (d) => (d ? new Date(d).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

/* ── Mapa (Leaflet por CDN, igual que /mapa) ───────────────────────────────── */
let leafletP;
function loadLeaflet() {
  if (leafletP) return leafletP;
  leafletP = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject();
    if (window.L) return resolve(window.L);
    const css = document.createElement('link'); css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = () => resolve(window.L); s.onerror = reject; document.head.appendChild(s);
  });
  return leafletP;
}

function MapaCliente({ cliente, onGeocode }) {
  const ref = useRef(null); const mapRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const lat = cliente.lat, lon = cliente.lon;

  useEffect(() => {
    if (lat == null || lon == null) return;
    let dead = false;
    loadLeaflet().then((L) => {
      if (dead || !ref.current) return;
      if (!mapRef.current) {
        mapRef.current = L.map(ref.current, { scrollWheelZoom: false }).setView([lat, lon], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapRef.current);
      } else {
        mapRef.current.setView([lat, lon], 16);
      }
      L.marker([lat, lon]).addTo(mapRef.current).bindPopup(cliente.name || 'Cliente').openPopup();
      setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 150);
    }).catch(() => {});
    return () => { dead = true; };
  }, [lat, lon, cliente.name]);

  async function geocode() {
    setBusy(true);
    const r = await j(API + '/clients/' + cliente.id + '/geocode', { method: 'POST' });
    setBusy(false);
    if (r && r.lat) { toast('Ubicación encontrada', 'ok', { description: r.display }); onGeocode(); }
    else toast('No se pudo ubicar la dirección', 'bad', { description: 'Probá con una dirección más precisa (calle, número, ciudad).' });
  }

  return (
    <Card withBorder radius="lg" p="md" shadow="sm">
      <Group justify="space-between" mb="sm">
        <Group gap={8}>
          <ThemeIcon size={30} radius="md" variant="light" color="red"><IconMapPin size={16} /></ThemeIcon>
          <div>
            <Text fw={700} fz="sm">Ubicación</Text>
            <Text fz="xs" c="dimmed">{cliente.address || 'Sin dirección cargada'}</Text>
          </div>
        </Group>
        <Button size="xs" variant="light" loading={busy} leftSection={<IconRefresh size={14} />} onClick={geocode} disabled={!cliente.address}>
          {lat == null ? 'Ubicar en el mapa' : 'Volver a ubicar'}
        </Button>
      </Group>
      {lat == null ? (
        <Stack align="center" py={48} gap={6}>
          <ThemeIcon size={54} radius="xl" variant="light" color="gray"><IconMap2 size={26} /></ThemeIcon>
          <Text c="dimmed" size="sm">{cliente.address ? 'Todavía no ubicamos este cliente en el mapa.' : 'Cargá la dirección en la pestaña Datos para poder ubicarlo.'}</Text>
        </Stack>
      ) : (
        <div ref={ref} style={{ height: 420, borderRadius: 12, overflow: 'hidden' }} />
      )}
    </Card>
  );
}

/* ── Página ────────────────────────────────────────────────────────────────── */
export default function ClienteFicha() {
  const { id } = useParams();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('datos');
  const [form, setForm] = useState({ name: '', doc: '', address: '', phones: '', notes: '' });
  const [np, setNp] = useState({ name: '', doc: '', relation: '', valid_until: '' });
  const [nsp, setNsp] = useState({ name: '', kind: '' });
  const [nd, setNd] = useState({ label: '', type: 'intercom', rtsp_url: '' });
  const [streams, setStreams] = useState([]);
  const [calls, setCalls] = useState([]);
  const [recs, setRecs] = useState([]);
  const [playId, setPlayId] = useState(null);
  const [inter, setInter] = useState({ items: [], fields: [] });

  async function reload() {
    const c = await j(API + '/clients/' + id); setLoading(false);
    if (!c) return; setSel(c);
    setForm({ name: c.name || '', doc: c.doc || '', address: c.address || '', phones: (c.phones || []).join(', '), notes: c.notes || '' });
  }
  useEffect(() => { reload(); }, [id]);
  useEffect(() => {
    j(API + '/intercom/streams?client=' + id).then(d => setStreams(Array.isArray(d) ? d : (d && d.streams) || []));
    j(API + '/clients/' + id + '/calls').then(d => setCalls(Array.isArray(d) ? d : []));
    j(API + '/clients/' + id + '/interventions').then(d => d && setInter(d));
    j(API + '/recordings').then(d => setRecs(Array.isArray(d) ? d : []));
  }, [id]);

  // Grabación que corresponde a cada llamada: se cruza por extensión y proximidad de tiempo.
  const recFor = (r) => {
    const start = r.start ? new Date(r.start).getTime() : 0; if (!start) return null;
    const end = start + ((r.duration || 0) + 15) * 1000;
    return recs.find(x => x.started_at && new Date(x.started_at).getTime() >= start - 5000 && new Date(x.started_at).getTime() <= end
      && (String(x.ext) === String(r.src) || String(x.ext) === String(r.dst))) || null;
  };

  const kpis = useMemo(() => {
    const at = calls.filter(c => c.disposition === 'ANSWERED').length;
    const min = Math.round(calls.reduce((a, c) => a + (c.billsec || 0), 0) / 60);
    return [
      { k: 'Llamadas', v: calls.length, icon: IconPhone, c: 'cyan' },
      { k: 'Atendidas', v: at, icon: IconPhoneCheck, c: 'teal' },
      { k: 'Perdidas', v: calls.length - at, icon: IconPhoneX, c: 'orange' },
      { k: 'Minutos', v: min, icon: IconClock, c: 'grape' },
      { k: 'Dispositivos', v: (sel && sel.devices || []).length, icon: IconDeviceCctv, c: 'violet' },
      { k: 'Intervenciones', v: (inter.items || []).length, icon: IconClipboardList, c: 'blue' },
    ];
  }, [calls, sel, inter]);

  async function save() { const c = await j(API + '/clients/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, phones: form.phones }) }); if (c) { toast('Ficha guardada', 'ok'); reload(); } else toast('No se pudo guardar', 'bad'); }
  async function del() { if (!confirm('¿Eliminar cliente y todos sus datos?')) return; await j(API + '/clients/' + id, { method: 'DELETE' }); toast('Cliente eliminado', 'info'); router.push('/clientes'); }
  async function addPerson() { if (!np.name) return; await j(API + '/clients/' + id + '/persons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(np) }); setNp({ name: '', doc: '', relation: '', valid_until: '' }); toast('Persona autorizada', 'ok'); reload(); }
  async function delPerson(pid) { await j(API + '/persons/' + pid, { method: 'DELETE' }); reload(); }
  async function addSpace() { if (!nsp.name) return; await j(API + '/clients/' + id + '/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nsp) }); setNsp({ name: '', kind: '' }); toast('Espacio agregado', 'ok'); reload(); }
  async function delSpace(sid) { await j(API + '/spaces/' + sid, { method: 'DELETE' }); reload(); }
  async function addDevice() { if (!nd.label) return; await j(API + '/clients/' + id + '/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nd) }); setNd({ label: '', type: 'intercom', rtsp_url: '' }); toast('Dispositivo agregado', 'ok', { description: 'Tarda unos segundos en aparecer el video.' }); reload(); }
  async function delDevice(did) { await j(API + '/devices/' + did, { method: 'DELETE' }); reload(); }

  if (loading && !sel) return <Group justify="center" py={80}><Loader /></Group>;
  if (!sel) return <Card withBorder radius="lg" p="xl"><Text c="dimmed" ta="center">Cliente no encontrado. <Anchor onClick={() => router.push('/clientes')}>Volver</Anchor></Text></Card>;

  const T = ({ value, icon, children, count }) => (
    <Tabs.Tab value={value} leftSection={icon}
      rightSection={count ? <Badge size="xs" variant="light" circle>{count}</Badge> : null}>{children}</Tabs.Tab>
  );

  return (
    <Stack gap="md" className="pbx-fade-in">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ActionIcon variant="light" size={38} radius="md" onClick={() => router.push('/clientes')}><IconArrowLeft size={20} /></ActionIcon>
          <Avatar size={48} radius="xl" color="grape">{initials(form.name)}</Avatar>
          <div style={{ minWidth: 0 }}>
            <Text fw={800} fz="xl" lh={1.05} truncate>{form.name || 'Cliente'}</Text>
            <Group gap={6}>
              <Text fz="xs" c="dimmed"><IconAddressBook size={11} style={{ verticalAlign: -1 }} /> Ficha de cliente</Text>
              {(sel.phones || []).slice(0, 3).map(p => <Badge key={p} size="xs" variant="light" ff="monospace">{p}</Badge>)}
              {streams.length > 0 && <Badge size="xs" variant="light" color="teal" leftSection={<IconCircleFilled size={7} className="pbx-pulse" />}>{streams.length} en vivo</Badge>}
            </Group>
          </div>
        </Group>
        <Group gap={6}>
          <Button variant="light" color="teal" leftSection={<IconDeviceFloppy size={16} />} onClick={save}>Guardar</Button>
          <Tooltip label="Eliminar cliente"><ActionIcon variant="light" color="red" size={36} onClick={del}><IconTrash size={17} /></ActionIcon></Tooltip>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 3, md: 6 }} spacing="sm">
        {kpis.map(x => (
          <Card key={x.k} withBorder radius="lg" padding="sm" shadow="xs">
            <Group gap={8} wrap="nowrap">
              <ThemeIcon size={34} radius="md" variant="light" color={x.c}><x.icon size={17} /></ThemeIcon>
              <div><Text fw={800} fz={20} lh={1}><Slot value={x.v} /></Text><Text size="10px" c="dimmed">{x.k}</Text></div>
            </Group>
          </Card>
        ))}
      </SimpleGrid>

      <Tabs value={tab} onChange={setTab} variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <T value="datos" icon={<IconId size={15} />}>Datos</T>
          <T value="personas" icon={<IconUserCheck size={15} />} count={(sel.persons || []).length}>Personas y espacios</T>
          <T value="video" icon={<IconVideo size={15} />} count={(sel.devices || []).length}>Dispositivos en vivo</T>
          <T value="historial" icon={<IconHistory size={15} />} count={calls.length}>Historial</T>
          <T value="intervenciones" icon={<IconClipboardList size={15} />} count={(inter.items || []).length}>Intervenciones</T>
          <T value="mapa" icon={<IconMap2 size={15} />}>Mapa</T>
        </Tabs.List>

        {/* ── Datos ── */}
        <Tabs.Panel value="datos">
          <div className="pbx-tabin">
            <Card withBorder radius="lg" p="lg" shadow="sm">
              <Stack gap={10}>
                <Group grow>
                  <TextInput label="Nombre" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.currentTarget.value }))} />
                  <TextInput label="Documento" leftSection={<IconId size={14} />} value={form.doc} onChange={e => setForm(f => ({ ...f, doc: e.currentTarget.value }))} />
                </Group>
                <TextInput label="Teléfonos (separados por coma)" description="Con esto la central reconoce al que llama y le abre la ficha al agente" leftSection={<IconPhone size={14} />} value={form.phones} onChange={e => setForm(f => ({ ...f, phones: e.currentTarget.value }))} />
                <TextInput label="Dirección" description="Se usa para ubicarlo en el mapa" leftSection={<IconMapPin size={14} />} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.currentTarget.value }))} />
                <Textarea label="Notas" autosize minRows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.currentTarget.value }))} />
              </Stack>
            </Card>
          </div>
        </Tabs.Panel>

        {/* ── Personas y espacios ── */}
        <Tabs.Panel value="personas">
          <div className="pbx-tabin">
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <Card withBorder radius="lg" p="md" shadow="sm">
                <Group gap={8} mb="sm"><ThemeIcon size={30} radius="md" variant="light" color="blue"><IconUserCheck size={16} /></ThemeIcon><Text fw={700} fz="sm">Personas autorizadas</Text><Badge size="sm" variant="light">{(sel.persons || []).length}</Badge></Group>
                <Stack gap={6}>
                  {(sel.persons || []).length === 0 && <Text c="dimmed" size="sm" ta="center" py="sm">Nadie autorizado todavía.</Text>}
                  {(sel.persons || []).map(p => (
                    <Group key={p.id} justify="space-between" wrap="nowrap" className="pbx-row">
                      <Text fz="sm"><b>{p.name}</b>{p.relation ? ' · ' + p.relation : ''}{p.doc ? ' · ' + p.doc : ''}{p.valid_until ? ' · vence ' + p.valid_until : ''}</Text>
                      <ActionIcon size="sm" variant="subtle" color="red" onClick={() => delPerson(p.id)}><IconTrash size={14} /></ActionIcon>
                    </Group>
                  ))}
                  <Divider my={4} />
                  <Group gap={6} align="flex-end">
                    <TextInput style={{ flex: 1 }} size="xs" placeholder="Nombre" value={np.name} onChange={e => setNp(v => ({ ...v, name: e.currentTarget.value }))} />
                    <TextInput size="xs" w={100} placeholder="Vínculo" value={np.relation} onChange={e => setNp(v => ({ ...v, relation: e.currentTarget.value }))} />
                    <TextInput size="xs" w={100} placeholder="Documento" value={np.doc} onChange={e => setNp(v => ({ ...v, doc: e.currentTarget.value }))} />
                    <Button size="xs" variant="light" onClick={addPerson}>Agregar</Button>
                  </Group>
                </Stack>
              </Card>

              <Card withBorder radius="lg" p="md" shadow="sm">
                <Group gap={8} mb="sm"><ThemeIcon size={30} radius="md" variant="light" color="teal"><IconBuilding size={16} /></ThemeIcon><Text fw={700} fz="sm">Espacios</Text><Badge size="sm" variant="light" color="teal">{(sel.spaces || []).length}</Badge></Group>
                <Stack gap={6}>
                  {(sel.spaces || []).length === 0 && <Text c="dimmed" size="sm" ta="center" py="sm">Sin espacios cargados.</Text>}
                  {(sel.spaces || []).map(s => (
                    <Group key={s.id} justify="space-between" wrap="nowrap" className="pbx-row">
                      <Text fz="sm"><b>{s.name}</b>{s.kind ? ' · ' + s.kind : ''}</Text>
                      <ActionIcon size="sm" variant="subtle" color="red" onClick={() => delSpace(s.id)}><IconTrash size={14} /></ActionIcon>
                    </Group>
                  ))}
                  <Divider my={4} />
                  <Group gap={6} align="flex-end">
                    <TextInput style={{ flex: 1 }} size="xs" placeholder="Nombre / unidad" value={nsp.name} onChange={e => setNsp(v => ({ ...v, name: e.currentTarget.value }))} />
                    <TextInput size="xs" w={130} placeholder="Tipo" value={nsp.kind} onChange={e => setNsp(v => ({ ...v, kind: e.currentTarget.value }))} />
                    <Button size="xs" variant="light" color="teal" onClick={addSpace}>Agregar</Button>
                  </Group>
                </Stack>
              </Card>
            </SimpleGrid>
          </div>
        </Tabs.Panel>

        {/* ── Dispositivos en vivo ── */}
        <Tabs.Panel value="video">
          <div className="pbx-tabin">
            <Card withBorder radius="lg" p="md" shadow="sm" mb="md">
              <Group justify="space-between" mb="sm">
                <Group gap={8}>
                  <ThemeIcon size={30} radius="md" variant="light" color="grape"><IconDeviceCctv size={16} /></ThemeIcon>
                  <div><Text fw={700} fz="sm">Porteros y cámaras</Text><Text fz="xs" c="dimmed">{streams.length ? streams.length + ' flujo(s) en vivo' : 'Agregá un dispositivo con URL RTSP para ver el video'}</Text></div>
                </Group>
              </Group>
              <Intercom streams={streams} columns={streams.length > 1 ? 2 : 1} emptyHint="Agregá un portero o cámara con URL RTSP para ver el video acá." />
            </Card>

            <Card withBorder radius="lg" p="md" shadow="sm">
              <Text fw={700} fz="sm" mb="sm">Dispositivos asociados</Text>
              <Stack gap={6}>
                {(sel.devices || []).map(d => (
                  <Group key={d.id} justify="space-between" wrap="nowrap" className="pbx-row">
                    <div style={{ minWidth: 0 }}>
                      <Text fz="sm"><b>{d.label}</b>{' '}
                        <Badge size="xs" variant="light" color={d.type === 'intercom' ? 'orange' : 'grape'} leftSection={d.type === 'intercom' ? <IconBell size={10} /> : <IconDeviceCctv size={10} />}>
                          {d.type === 'intercom' ? 'Portero' : 'Cámara'}
                        </Badge>
                      </Text>
                      <Text fz={11} c="dimmed" truncate>{d.rtsp_url || 'sin URL'}</Text>
                    </div>
                    <ActionIcon size="sm" variant="subtle" color="red" onClick={() => delDevice(d.id)}><IconTrash size={14} /></ActionIcon>
                  </Group>
                ))}
                <Divider my={4} />
                <Group gap={6} align="flex-end">
                  <TextInput size="xs" w={130} placeholder="Etiqueta" value={nd.label} onChange={e => setNd(v => ({ ...v, label: e.currentTarget.value }))} />
                  <Select size="xs" w={110} data={[{ value: 'intercom', label: 'Portero' }, { value: 'camera', label: 'Cámara' }]} value={nd.type} onChange={v => setNd(s => ({ ...s, type: v }))} />
                  <TextInput style={{ flex: 1 }} size="xs" placeholder="rtsp://usuario:clave@ip:554/stream" value={nd.rtsp_url} onChange={e => setNd(v => ({ ...v, rtsp_url: e.currentTarget.value }))} />
                  <Button size="xs" variant="light" color="grape" onClick={addDevice}>Agregar</Button>
                </Group>
              </Stack>
            </Card>
          </div>
        </Tabs.Panel>

        {/* ── Historial ── */}
        <Tabs.Panel value="historial">
          <div className="pbx-tabin">
            <Card withBorder radius="lg" p="md" shadow="sm">
              <Group gap={8} mb="sm">
                <ThemeIcon size={30} radius="md" variant="light" color="cyan"><IconHistory size={16} /></ThemeIcon>
                <div><Text fw={700} fz="sm">Llamadas de este cliente</Text><Text fz="xs" c="dimmed">Se cruzan sus teléfonos contra el historial de la central</Text></div>
              </Group>
              {calls.length === 0 ? (
                <Stack align="center" py={40} gap={6}>
                  <ThemeIcon size={50} radius="xl" variant="light" color="gray"><IconPhone size={24} /></ThemeIcon>
                  <Text c="dimmed" size="sm">Todavía no hay llamadas asociadas.</Text>
                  <Text c="dimmed" size="xs">Cargá sus teléfonos en la pestaña Datos para que se vinculen solas.</Text>
                </Stack>
              ) : (
                <Table.ScrollContainer minWidth={640}>
                  <Table striped highlightOnHover verticalSpacing="xs">
                    <Table.Thead><Table.Tr>
                      <Table.Th>Fecha</Table.Th><Table.Th>Origen</Table.Th><Table.Th>Destino</Table.Th>
                      <Table.Th>Duración</Table.Th><Table.Th>Resultado</Table.Th><Table.Th>Grabación</Table.Th>
                    </Table.Tr></Table.Thead>
                    <Table.Tbody>
                      {calls.map((c, i) => {
                        const rec = recFor(c);
                        const ok = c.disposition === 'ANSWERED';
                        return (
                          <Fragment key={i}>
                            <Table.Tr>
                              <Table.Td><Text fz="xs">{fmtDate(c.start)}</Text></Table.Td>
                              <Table.Td ff="monospace" fz="sm">{c.src || '—'}</Table.Td>
                              <Table.Td ff="monospace" fz="sm">{c.dst || '—'}</Table.Td>
                              <Table.Td fz="sm">{fmtDur(c.billsec)}</Table.Td>
                              <Table.Td><Badge size="sm" variant="light" color={ok ? 'teal' : 'orange'}>{ok ? 'Atendida' : 'Sin respuesta'}</Badge></Table.Td>
                              <Table.Td>
                                {rec ? (
                                  <Button size="compact-xs" variant={playId === rec.id ? 'filled' : 'light'} color="teal"
                                    leftSection={playId === rec.id ? <IconPlayerPause size={13} /> : <IconPlayerPlay size={13} />}
                                    onClick={() => setPlayId(playId === rec.id ? null : rec.id)}>
                                    {playId === rec.id ? 'Cerrar' : 'Escuchar'}
                                  </Button>
                                ) : <Text c="dimmed" fz="xs">—</Text>}
                              </Table.Td>
                            </Table.Tr>
                            {rec && playId === rec.id && (
                              <Table.Tr>
                                <Table.Td colSpan={6} style={{ background: 'var(--mantine-color-default-hover)' }}>
                                  <RecordingPlayer recId={rec.id} src={'/backend/api/recordings/' + rec.id + '/audio'} label={(c.src || '?') + '  →  ' + (c.dst || '?')} />
                                </Table.Td>
                              </Table.Tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </Card>
          </div>
        </Tabs.Panel>

        {/* ── Intervenciones ── */}
        <Tabs.Panel value="intervenciones">
          <div className="pbx-tabin">
            <Card withBorder radius="lg" p="lg" shadow="sm">
              <Group gap={8} mb="md">
                <ThemeIcon size={30} radius="md" variant="light" color="blue"><IconClipboardList size={16} /></ThemeIcon>
                <div><Text fw={700} fz="sm">Intervenciones</Text><Text fz="xs" c="dimmed">Lo que el agente registró al terminar cada llamada</Text></div>
              </Group>
              {(inter.items || []).length === 0 ? (
                <Stack align="center" py={40} gap={6}>
                  <ThemeIcon size={50} radius="xl" variant="light" color="gray"><IconInfoCircle size={24} /></ThemeIcon>
                  <Text c="dimmed" size="sm">Sin intervenciones registradas.</Text>
                  <Text c="dimmed" size="xs">Aparecen acá cuando un agente completa la encuesta al cortar la llamada.</Text>
                </Stack>
              ) : (
                <Timeline active={inter.items.length} bulletSize={26} lineWidth={2}>
                  {inter.items.map(it => {
                    const a = it.answers || {};
                    return (
                      <Timeline.Item key={it.id} bullet={<ThemeIcon size={26} radius="xl" variant="light" color="blue"><IconClipboardList size={13} /></ThemeIcon>}
                        title={<Group gap={8}>
                          <Text fw={700} fz="sm">{a.Motivo || a.motivo || 'Intervención'}</Text>
                          {(a.Resultado || a.resultado) && <Badge size="xs" variant="light" color={/resuelto/i.test(a.Resultado || a.resultado) ? 'teal' : 'orange'}>{a.Resultado || a.resultado}</Badge>}
                        </Group>}>
                        <Group gap={10} mb={4}>
                          <Text fz="xs" c="dimmed">{fmtDate(it.created_at)}</Text>
                          <Text fz="xs" c="dimmed">· atendió la extensión <b>{it.ext || '—'}</b></Text>
                          {it.caller && <Text fz="xs" c="dimmed" ff="monospace">· {it.caller}</Text>}
                        </Group>
                        {(a.Satisfaccion || a.satisfaccion) && (
                          <Group gap={6} mb={4}><IconMoodSmile size={14} opacity={.6} /><Rating value={Number(a.Satisfaccion || a.satisfaccion)} readOnly size="xs" /></Group>
                        )}
                        {Object.entries(a).filter(([k]) => !/^(Motivo|motivo|Resultado|resultado|Satisfaccion|satisfaccion)$/.test(k)).map(([k, v]) => (
                          <Text key={k} fz="sm"><b>{k}:</b> {String(v)}</Text>
                        ))}
                      </Timeline.Item>
                    );
                  })}
                </Timeline>
              )}
            </Card>
          </div>
        </Tabs.Panel>

        {/* ── Mapa ── */}
        <Tabs.Panel value="mapa">
          <div className="pbx-tabin">
            <MapaCliente cliente={sel} onGeocode={reload} />
          </div>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
