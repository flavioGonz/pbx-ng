'use client';
import { useEffect, useState } from 'react';
import { Stack, Switch, Card, Group, Text, Button, Table, Badge, ActionIcon, TextInput, Select, ThemeIcon, SimpleGrid, Divider, Tooltip, CopyButton, Alert, Code, List } from '@mantine/core';
import { IconAddressBook, IconDeviceLandlinePhone, IconPlus, IconEdit, IconTrash, IconCopy, IconCheck, IconHash, IconBolt, IconDeviceFloppy, IconInfoCircle, IconServer2, IconRouter, IconWifi } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';
import DrawerNG, { BloqueNG } from '../DrawerNG';
import { IcoConexion, IcoPersona } from '../IconosNG';

const VENDORS = [{ value: 'yealink', label: 'Yealink' }, { value: 'grandstream', label: 'Grandstream' }];
const fileFor = (v, mac) => v === 'grandstream' ? 'cfg' + mac + '.xml' : mac + '.cfg';
const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
const empty = { mac: '', vendor: 'yealink', model: '', ext: '', label: '', line_label: '' };
const online = (t) => t && (Date.now() - new Date(t).getTime()) < 10 * 60 * 1000;

export default function Telefonos() {
  const [list, setList] = useState([]); const [opened, setOpened] = useState(false); const [form, setForm] = useState(empty); const [saving, setSaving] = useState(false);
  const [srv, setSrv] = useState(''); const [srvSaving, setSrvSaving] = useState(false);
  /* La libreta: el título que ve el usuario en el teléfono y si van también los clientes
   * del CRM. Los teléfonos aprovisionados la reciben SOLOS —la URL va en su config—; las
   * URLs de acá abajo son para las marcas que no aprovisionamos o para cargarla a mano. */
  /* Los que se registraron. Un teléfono configurado a mano anda para hablar y se ve igual
   * que uno aprovisionado; lo que le falta —la libreta, los codecs— no se nota hasta que
   * alguien lo busca. Acá se dice antes. */
  const [detectados, setDetectados] = useState([]);
  const [agTitulo, setAgTitulo] = useState(''); const [agClientes, setAgClientes] = useState(true); const [agSaving, setAgSaving] = useState(false);
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  const pendientes = detectados.filter(d => !d.aprovisionado && d.agenda);
  async function load() {
    try { setList(await fetch('/backend/api/phones').then(r => r.json())); } catch (_) {}
    try { setDetectados(await fetch('/backend/api/phones/detectados').then(r => r.json())); } catch (_) {}
  }
  async function loadSrv() {
    try {
      const s = await fetch('/backend/api/settings').then(r => r.json());
      setSrv(s.prov_sip_server || '');
      setAgTitulo(s.prov_agenda_titulo || 'Central');
      setAgClientes(String(s.agenda_clientes ?? '1') !== '0');
    } catch (_) {}
  }
  /* Los teléfonos aprovisionados son una tabla de configuración; lo único que se mueve
   * es el `last_seen` (y la ventana de "en línea" es de 10 minutos, no de 10 segundos). */
  useEffect(() => { load(); loadSrv(); const t = setInterval(() => { if (!document.hidden) load(); }, 30000); return () => clearInterval(t); }, []);
  const up = (k, v) => setForm(s => ({ ...s, [k]: v }));
  function nuevo() { setForm(empty); setOpened(true); }
  /* Dar de alta uno detectado: se precarga lo que el propio teléfono contó al registrarse.
   * Lo único que suele faltar es la MAC —la mayoría no la manda— y es justamente lo que
   * NO se puede inventar: aprovisionar la MAC equivocada le cambia la configuración a otro
   * aparato. */
  function altaDetectado(d) {
    setForm({ ...empty, mac: d.mac || '', vendor: VENDORS.find(v => v.value === d.vendor) ? d.vendor : 'yealink', model: d.modelo || '', ext: d.ext, label: d.ext });
    setOpened(true);
  }
  function edit(p) { setForm({ ...empty, ...p }); setOpened(true); }
  async function save() {
    if (!form.mac || !form.ext) { toast('MAC e extensión son obligatorios', 'bad'); return; }
    setSaving(true);
    const url = form.id ? '/backend/api/phones/' + form.id : '/backend/api/phones';
    const r = await fetch(url, { method: form.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast(form.id ? 'Teléfono actualizado' : 'Teléfono aprovisionado (extensión ' + form.ext + ')', 'ok'); setOpened(false); load(); }
  }
  async function del(p) { if (!confirm('¿Eliminar el teléfono ' + p.mac + '?')) return; await fetch('/backend/api/phones/' + p.id, { method: 'DELETE' }); toast('Teléfono eliminado', 'info'); load(); }
  async function saveAgenda() {
    setAgSaving(true);
    const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prov_agenda_titulo: agTitulo || 'Central', agenda_clientes: agClientes ? '1' : '0' }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setAgSaving(false);
    toast(r.error ? 'Error' : 'Libreta guardada · los teléfonos la toman en el próximo refresco', r.error ? 'bad' : 'ok');
  }
  async function saveSrv() { setSrvSaving(true); const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prov_sip_server: srv }) }).then(x => x.json()).catch(() => ({ error: 1 })); setSrvSaving(false); toast(r.error ? 'Error' : 'Servidor SIP guardado', r.error ? 'bad' : 'ok'); }

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconDeviceLandlinePhone size={24} />} title="Aprovisionamiento de teléfonos" subtitle="Auto-config de teléfonos físicos (Yealink, Grandstream) por dirección MAC" color="blue"
        right={<Button leftSection={<IconPlus size={16} />} onClick={nuevo}>Nuevo teléfono</Button>} />

      <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />} title="Cómo configurar los teléfonos">
        <Text size="sm" mb={6}>Apuntá los teléfonos al servidor de aprovisionamiento (por <b>DHCP opción 66</b> en toda la red, o manualmente en cada teléfono):</Text>
        <Group gap="xs" mb={8}><Code>{base}/prov</Code><CopyButton value={base + '/prov'}>{({ copied, copy }) => <Button size="compact-xs" variant="light" color={copied ? 'teal' : 'blue'} leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />} onClick={copy}>{copied ? 'Copiado' : 'Copiar URL'}</Button>}</CopyButton></Group>
        <List size="xs" spacing={2} c="dimmed">
          <List.Item>Yealink pide <Code>&lt;mac&gt;.cfg</Code> · Grandstream pide <Code>cfg&lt;mac&gt;.xml</Code> — se generan solos según la base de datos.</List.Item>
          <List.Item>El teléfono toma su extensión, contraseña y codecs automáticamente al arrancar; el usuario solo lo enchufa a la red.</List.Item>
        </List>
      </Alert>

      <Card withBorder radius="lg" padding="md">
        <Group align="flex-end" gap="sm">
          <TextInput label="Servidor SIP para los teléfonos" description="IP/host que se inyecta en la config (registro UDP/5060)" value={srv} onChange={e => setSrv(e.currentTarget.value)} placeholder="ip-del-asterisk" style={{ flex: 1, maxWidth: 360 }} leftSection={<IconServer2 size={15} />} />
          <Button variant="light" leftSection={<IconDeviceFloppy size={16} />} loading={srvSaving} onClick={saveSrv}>Guardar</Button>
        </Group>
      </Card>

      {/* ── Detectados ────────────────────────────────────────────────────
          Lo que contestó a un REGISTER. Es información que el teléfono manda gratis en
          cada registro (el User-Agent), y alcanza para saber la marca y para decir si la
          central lo conoce o no. */}
      {detectados.length > 0 && (
        <Card withBorder radius="lg" padding="md">
          <Group gap="sm" wrap="nowrap" mb="xs">
            <ThemeIcon variant="light" color={pendientes.length ? 'orange' : 'teal'} size={38} radius="md"><IconRouter size={20} /></ThemeIcon>
            <div>
              <Text fw={700}>Teléfonos registrados</Text>
              <Text size="xs" c="dimmed">
                {pendientes.length
                  ? `${pendientes.length} sin aprovisionar · andan para hablar, pero no reciben la libreta ni la configuración de la central`
                  : 'Todos los registrados están dados de alta en la central'}
              </Text>
            </div>
          </Group>
          <Table.ScrollContainer minWidth={700}>
            <Table verticalSpacing="xs" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={90}>Interno</Table.Th>
                  <Table.Th>Qué es</Table.Th>
                  <Table.Th w={140}>IP</Table.Th>
                  <Table.Th w={150}>MAC</Table.Th>
                  <Table.Th w={210}>Estado</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>{detectados.map(d => (
                <Table.Tr key={d.ext}>
                  <Table.Td><Code>{d.ext}</Code></Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={600}>{d.marca}{d.modelo ? ' ' + d.modelo : ''}</Text>
                    <Text size="xs" c="dimmed">{d.ua}</Text>
                  </Table.Td>
                  <Table.Td><Text size="xs" c="dimmed">{d.ip || '—'}</Text></Table.Td>
                  <Table.Td><Text size="xs" c="dimmed">{d.mac || '—'}</Text></Table.Td>
                  <Table.Td>
                    {d.aprovisionado
                      ? <Badge color="teal" variant="light" leftSection={<IconCheck size={12} />}>Aprovisionado</Badge>
                      : d.agenda
                        ? <Button size="compact-xs" variant="light" color="orange" leftSection={<IconPlus size={13} />} onClick={() => altaDetectado(d)}>Dar de alta</Button>
                        : <Tooltip label="Esta marca no toma libreta remota: sus contactos los maneja su propio sistema" withArrow multiline w={250}>
                            <Badge color="gray" variant="light">Sin libreta remota</Badge>
                          </Tooltip>}
                  </Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}

      {/* ── La libreta ────────────────────────────────────────────────────
          Un teléfono de escritorio no sabe pedirle contactos a una API, pero todos saben
          bajar un XML de una URL cada tantas horas. Cada marca inventó el suyo, así que la
          central sirve la misma libreta en varios dialectos. */}
      <Card withBorder radius="lg" padding="md">
        <Group justify="space-between" wrap="nowrap" mb="xs">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color="grape" size={38} radius="md"><IconAddressBook size={20} /></ThemeIcon>
            <div>
              <Text fw={700}>Libreta de la central</Text>
              <Text size="xs" c="dimmed">Los internos —y los clientes, si querés— en la tecla de Contactos de cada teléfono</Text>
            </div>
          </Group>
          <Button variant="light" leftSection={<IconDeviceFloppy size={16} />} loading={agSaving} onClick={saveAgenda}>Guardar</Button>
        </Group>
        <Group align="flex-end" gap="sm" mb="sm">
          <TextInput label="Cómo se llama en el teléfono" description="El título de la agenda" value={agTitulo} onChange={e => setAgTitulo(e.currentTarget.value)} placeholder="Central" w={260} />
          <Switch mb={6} label="Incluir clientes del CRM" checked={agClientes} onChange={e => setAgClientes(e.currentTarget.checked)} />
        </Group>
        <Alert variant="light" color="grape" icon={<IconInfoCircle size={18} />}>
          <Text size="sm" mb={6}>
            Los teléfonos que aprovisiona la central <b>la reciben solos</b>: la URL ya va en su configuración. Estas son para
            cargarla a mano en cualquier otra marca:
          </Text>
          <Stack gap={4}>
            {[
              ['Yealink', '/prov/agenda-yealink.xml'],
              ['Grandstream', '/prov/phonebook.xml'],
              ['Fanvil / Akuvox', '/prov/agenda-fanvil.xml'],
              ['Snom', '/prov/agenda-snom.xml'],
              ['Cualquier otra (CSV)', '/prov/agenda.csv'],
            ].map(([marca, ruta]) => (
              <Group key={ruta} gap="xs" wrap="nowrap">
                <Text size="xs" c="dimmed" w={130} style={{ flex: 'none' }}>{marca}</Text>
                <Code style={{ fontSize: 11 }}>{base + ruta}</Code>
                <CopyButton value={base + ruta}>{({ copied, copy }) => (
                  <Tooltip label={copied ? 'Copiada' : 'Copiar la URL'}><ActionIcon variant="subtle" size="sm" color={copied ? 'teal' : 'gray'} onClick={copy}>{copied ? <IconCheck size={13} /> : <IconCopy size={13} />}</ActionIcon></Tooltip>
                )}</CopyButton>
              </Group>
            ))}
          </Stack>
          <Text size="xs" c="dimmed" mt={8}>
            Si pusiste un token de aprovisionamiento, va en el medio: <Code style={{ fontSize: 10 }}>{base}/prov/&lt;token&gt;/agenda-yealink.xml</Code>.
            Grandstream no deja elegir el nombre del archivo: siempre baja <Code style={{ fontSize: 10 }}>phonebook.xml</Code> de la ruta que se le configure.
          </Text>
        </Alert>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        {list.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin teléfonos. Agregá uno con «Nuevo teléfono».</Text> :
          <Table.ScrollContainer minWidth={720}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr><Th icon={<IconRouter size={13} />}>MAC</Th><Th icon={<IconDeviceLandlinePhone size={13} />}>Modelo</Th><Th icon={<IconHash size={13} />}>Extensión</Th><Th>Etiqueta</Th><Th icon={<IconBolt size={13} />}>Estado</Th><Th icon={<IconWifi size={13} />}>Archivo</Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>{list.map(p => (
                <Table.Tr key={p.id}>
                  <Table.Td ff="monospace" fw={600} style={{ cursor: 'pointer' }} onClick={() => edit(p)}>{p.mac}</Table.Td>
                  <Table.Td><Badge variant="light" color={p.vendor === 'grandstream' ? 'orange' : 'blue'}>{p.vendor}{p.model ? ' · ' + p.model : ''}</Badge></Table.Td>
                  <Table.Td ff="monospace">{p.ext}</Table.Td>
                  <Table.Td>{p.label || '—'}</Table.Td>
                  <Table.Td><Badge variant="dot" color={online(p.last_seen) ? 'teal' : 'gray'}>{p.last_seen ? (online(p.last_seen) ? 'Aprovisionado' : 'Visto ' + new Date(p.last_seen).toLocaleDateString('es-UY')) : 'Pendiente'}</Badge></Table.Td>
                  <Table.Td><Group gap={4} wrap="nowrap"><Code style={{ fontSize: 11 }}>{fileFor(p.vendor, p.mac)}</Code><CopyButton value={base + '/prov/' + fileFor(p.vendor, p.mac)}>{({ copied, copy }) => <Tooltip label={copied ? 'Copiado' : 'Copiar URL del config'}><ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy}>{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</ActionIcon></Tooltip>}</CopyButton></Group></Table.Td>
                  <Table.Td ta="right"><Group gap={4} justify="flex-end"><ActionIcon variant="subtle" onClick={() => edit(p)}><IconEdit size={17} /></ActionIcon><ActionIcon variant="subtle" color="red" onClick={() => del(p)}><IconTrash size={17} /></ActionIcon></Group></Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>}
      </Card>

      {/* El alta de un teléfono físico es un cajón: la lista de teléfonos detectados queda
          a la izquierda mientras se carga la MAC, que es de donde se la copia. */}
      <DrawerNG
        opened={opened} onClose={() => setOpened(false)} ancho={600} color="blue"
        icono={<IconDeviceLandlinePhone size={24} />}
        titulo={form.id ? 'Editar teléfono' : 'Nuevo teléfono físico'}
        subtitulo="Auto-provisioning por MAC"
        solapas={[{
          value: 'aparato', label: 'Aparato',
          contenido: (
            <>
              <BloqueNG icon={<IconRouter size={16} />} titulo="Qué aparato es"
                ayuda="La MAC es lo único que el teléfono manda para pedir su configuración: si está mal, se la lleva otro aparato. El fabricante decide el dialecto del archivo que se le sirve.">
                <SimpleGrid cols={2}>
                  <TextInput label="Dirección MAC" description="Sin separadores o con : / -. Ej: 805ec0aabbcc" value={form.mac} onChange={e => up('mac', e.currentTarget.value)} ff="monospace" required leftSection={<IconRouter size={15} />} disabled={!!form.id} />
                  <Select label="Fabricante" data={VENDORS} value={form.vendor} onChange={v => up('vendor', v)} />
                </SimpleGrid>
                <TextInput label="Modelo (opcional)" value={form.model} onChange={e => up('model', e.currentTarget.value)} placeholder="T31P / GRP2601" />
              </BloqueNG>
              <BloqueNG icon={<IcoPersona s={16} />} titulo="Qué línea atiende"
                ayuda="El interno que va a registrar el teléfono, y los textos que se ven en su pantalla: el nombre a mostrar sale en las llamadas y la etiqueta, en la tecla de línea.">
                <SimpleGrid cols={2}>
                  <TextInput label="Extensión" description="Extensión SIP que usará el teléfono" value={form.ext} onChange={e => up('ext', e.currentTarget.value)} ff="monospace" required leftSection={<IconHash size={15} />} />
                  <TextInput label="Nombre a mostrar" value={form.label} onChange={e => up('label', e.currentTarget.value)} placeholder="Recepción" />
                </SimpleGrid>
                <TextInput label="Etiqueta de línea" description="Texto en la tecla de línea" value={form.line_label} onChange={e => up('line_label', e.currentTarget.value)} placeholder="Recepción IES" />
              </BloqueNG>
              <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>Se crea/actualiza la extensión SIP (UDP) con su contraseña. El teléfono lo toma al pedir <Code>{fileFor(form.vendor, form.mac || '<mac>')}</Code>.</Alert>
            </>
          ),
        }]}
        pie={
          <Group justify="space-between">
            <Button variant="subtle" color="gray" onClick={() => setOpened(false)}>Cancelar</Button>
            <Button onClick={save} loading={saving} leftSection={<IconDeviceFloppy size={16} />}>{form.id ? 'Guardar' : 'Aprovisionar'}</Button>
          </Group>
        }
      />
    </Stack>
  );
}
