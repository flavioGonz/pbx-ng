'use client';
import { useState, useEffect } from 'react';
import { Stack, Title, Text, Card, Group, Button, Table, Badge, Modal, TextInput, PasswordInput, Switch, SegmentedControl, ActionIcon, ThemeIcon, NumberInput, Divider, Tooltip, CopyButton, Code, Skeleton, SimpleGrid, Loader, Alert, Select } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconTrash, IconVideo, IconWorld, IconDeviceLandlinePhone, IconPencil, IconUserPlus, IconQrcode, IconSearch, IconCopy, IconCheck, IconMail, IconSend, IconUsers, IconActivity, IconPhoneCall, IconHash, IconUser, IconClock, IconMicrophone2, IconRouteAltLeft, IconServer, IconShieldHalf, IconAlertTriangle } from '@tabler/icons-react';
import { QRCodeSVG } from 'qrcode.react';
import { useLive } from '../useLive';
import { toast } from '../notify';
import { TableSkeleton } from '../Skeletons';
import PageHeader from '../PageHeader';
import Slot from '../Slot';

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
// Estado del acceso (QR / enlace) que se le mando a la persona: si lo activo, cuando y con que.
function AccesoBadge({ a }) {
  if (!a) return <Text c="dimmed" size="sm">—</Text>;
  if (a.estado === 'activado') {
    const cuando = new Date(a.activated_at).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
  const [qrOpen, { open: openQr, close: closeQr }] = useDisclosure(false);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const [qrExt, setQrExt] = useState(''); const [enroll, setEnroll] = useState(null); const [gen, setGen] = useState(false);
  const [emailTo, setEmailTo] = useState(''); const [sending, setSending] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [recAll, setRecAll] = useState(false); const [recBusy, setRecBusy] = useState(false);
  // Bitacora del acceso enviado: si lo activaron, cuando y con que aparato.
  const [acc, setAcc] = useState({});
  async function loadAcc() {
    try {
      const d = await fetch('/backend/api/enrollments').then(r => r.json());
      const m = {}; (Array.isArray(d) ? d : []).forEach(x => { m[String(x.ext)] = x; }); setAcc(m);
    } catch (_) {}
  }
  useEffect(() => { loadAcc(); const t = setInterval(loadAcc, 20000); return () => clearInterval(t); }, []);
  useEffect(() => { fetch('/backend/api/extensions/record-all').then(r => r.json()).then(d => setRecAll(!!d.enabled)).catch(() => {}); }, []);
  async function toggleRecAll(on) { setRecBusy(true); setRecAll(on); const r = await fetch('/backend/api/extensions/record-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) }).then(x => x.json()).catch(() => ({ error: 1 })); setRecBusy(false); if (r.error) { setRecAll(!on); toast('Error', 'bad'); } else toast(on ? 'Grabación global activada' : 'Grabación global desactivada', 'ok'); }

  // Plan de numeracion: el backend sabe que numeros estan ocupados (y por quien) y cual es el
  // proximo libre dentro del rango que ya se usa. Sugerimos ese, no "el ultimo + 1" a ciegas.
  const [plan, setPlan] = useState(null);
  const [numChk, setNumChk] = useState(null);   // { ok, mensaje, motivo, aviso }
  const [numBusy, setNumBusy] = useState(false);
  async function loadPlan() { try { setPlan(await fetch('/backend/api/numbering/plan').then(r => r.json())); } catch (_) {} }
  useEffect(() => { loadPlan(); }, []);

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
    const t = setTimeout(async () => {
      try { setNumChk(await fetch('/backend/api/numbering/check?ext=' + encodeURIComponent(n)).then(r => r.json())); }
      catch (_) { setNumChk(null); }
      setNumBusy(false);
    }, 350);
    return () => { clearTimeout(t); setNumBusy(false); };
  }, [form.id, editing, opened]);

  function openNew() { loadPlan(); setForm(EMPTY); setEditing(false); setEnroll(null); setEmailTo(''); setNumChk(null); open(); }
  function openEdit(e) { setForm({ id: e.id, name: e.name || '', pass: '', video: !!e.video, record: !!e.record, type: e.webrtc ? 'webrtc' : 'sip', max_contacts: 2, tenant_id: e.tenant_id || 1, dtmf_mode: e.dtmf_mode || 'rfc4733' }); setEditing(true); setEnroll(null); setEmailTo(''); open(); generate(e.id); }
  function openQrModal() { setEnroll(null); setQrExt(suggestExt()); openQr(); }

  async function save() {
    if (!form.id || (!editing && !form.pass)) { toast('Completá extensión y contraseña', 'bad'); return; }
    if (!editing && numChk && !numChk.ok) { toast('Ese número no se puede usar', 'bad', { description: numChk.mensaje }); return; }
    setSaving(true);
    const body = { id: form.id, name: form.name || '', password: form.pass || undefined, video: form.video, record: form.record, webrtc: form.type === 'webrtc', max_contacts: form.max_contacts, dtmf_mode: form.dtmf_mode };
    const url = editing ? '/backend/api/endpoints/' + form.id : '/backend/api/endpoints';
    const r = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) toast('Error: ' + r.error, 'bad');
    else { toast(editing ? 'Extensión ' + form.id + ' actualizada' : 'Extensión ' + (r.created || form.id) + ' creada', 'ok'); close(); loadPlan(); }
  }
  async function generate(extArg) {
    const ex = extArg || qrExt; if (!ex) return; setGen(true); setEnroll(null);
    const r = await fetch('/backend/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext: ex }) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setGen(false);
    if (r.error) toast('Error: ' + r.error, 'bad');
    else setEnroll({ ...r, url: location.origin + '/enroll?token=' + r.token });
  }
  async function sendEmail() {
    if (!emailTo) return; setSending(true);
    const r = await fetch('/backend/api/enroll/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext: form.id, to: emailTo, tenant_id: form.tenant_id || 1 }) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSending(false);
    toast(r.error ? 'Error: ' + r.error : 'QR enviado a ' + emailTo, r.error ? 'bad' : 'ok');
    if (!r.error) setEmailTo('');
  }
  async function del(epid) { if (!confirm('¿Eliminar la extensión ' + epid + '?')) return; await fetch('/backend/api/endpoints/' + epid, { method: 'DELETE' }); toast('Extensión ' + epid + ' eliminado', 'info'); }

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
      <Card withBorder radius="lg" padding="md" shadow="sm" style={{ background: recAll ? 'rgba(225,29,72,.05)' : undefined }}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap={12} wrap="nowrap"><ThemeIcon size={40} radius="md" variant="light" color={recAll ? 'red' : 'gray'}><IconMicrophone2 size={22} /></ThemeIcon>
            <div><Text fw={700}>Grabación global de llamadas</Text><Text fz="sm" c="dimmed">Si la activás, se graban todas las llamadas internas de la central (anula los interruptores por interno).</Text></div></Group>
          <Switch size="lg" color="red" checked={recAll} disabled={recBusy} onChange={e => toggleRecAll(e.currentTarget.checked)} />
        </Group>
      </Card>
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

      <Modal opened={opened} onClose={close} centered radius="lg" size={editing ? 'xl' : 'lg'} overlayProps={{ blur: 3, backgroundOpacity: 0.45 }}
        title={<Group gap="sm">
          <ThemeIcon size={42} radius="md" variant="light" color={form.type === 'webrtc' ? 'pbx' : 'gray'}>{editing ? <IconPencil size={22} /> : <IconUserPlus size={22} />}</ThemeIcon>
          <div><Text fw={800} size="lg" lh={1.1}>{editing ? 'Editar extensión ' + form.id : 'Nuevo extensión'}</Text><Text size="xs" c="dimmed">{form.type === 'webrtc' ? 'Softphone WebRTC (navegador / PWA)' : 'Teléfono SIP físico'}</Text></div>
        </Group>}>
        <Stack>
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
            <Stack gap="sm">
              <TextInput label="Número de extensión" placeholder={plan && plan.next ? plan.next : '1006'}
                value={form.id} onChange={e => set('id', e.target.value.replace(/[^0-9*]/g, ''))} required disabled={editing}
                description={!editing && plan && plan.principal
                  ? `Estás usando el rango ${plan.principal.desde}–${plan.principal.hasta}. El próximo libre es ${plan.next || '—'}.`
                  : undefined}
                error={numChk && !numChk.ok ? numChk.mensaje : undefined}
                rightSection={numBusy ? <Loader size={14} />
                  : numChk && numChk.ok && !numChk.aviso ? <IconCircleCheck size={16} color="var(--mantine-color-teal-6)" />
                  : numChk && numChk.aviso ? <IconAlertTriangle size={16} color="var(--mantine-color-orange-6)" />
                  : null}
                rightSectionPointerEvents="none" />
              {!editing && plan && plan.next && !form.id && (
                <Button size="compact-xs" variant="light" mt={-6} w="fit-content"
                  leftSection={<IconHash size={13} />} onClick={() => set('id', plan.next)}>
                  Usar el siguiente libre: {plan.next}
                </Button>
              )}
              {!editing && numChk && numChk.ok && numChk.aviso && (
                <Alert variant="light" color="orange" icon={<IconAlertTriangle size={15} />} py={6}>
                  <Text size="xs">{numChk.mensaje}</Text>
                </Alert>
              )}
              <PasswordInput label="Contraseña SIP" value={form.pass} onChange={e => set('pass', e.target.value)} required={!editing} placeholder={editing ? 'Sin cambios' : ''} />
              <TextInput label="Nombre (libreta)" placeholder="Ej: Recepción, Juan Pérez" value={form.name} onChange={e => set('name', e.target.value)} description="Visible en la libreta de direcciones" />
            </Stack>
            <Stack gap="sm">
              <div>
                <Text size="sm" fw={500} mb={6}>Tipo de extensión</Text>
                <SegmentedControl fullWidth value={form.type} onChange={v => set('type', v)} data={[
                  { value: 'webrtc', label: (<Group gap={6} justify="center"><IconWorld size={15} /> WebRTC</Group>) },
                  { value: 'sip', label: (<Group gap={6} justify="center"><IconDeviceLandlinePhone size={15} /> SIP físico</Group>) },
                ]} />
                <Text size="xs" c="dimmed" mt={6}>{form.type === 'webrtc' ? 'Para navegador / app (DTLS-SRTP, ICE, ulaw/g722).' : 'Para teléfonos físicos (Yealink, Grandstream) por UDP/TLS.'}</Text>
              </div>
              <Group grow align="flex-start">
                <Switch label="Video (VP8/H264)" mt={6} checked={form.video} onChange={e => set('video', e.currentTarget.checked)} />
                <NumberInput label="Dispositivos" description="Registros simultáneos" min={1} max={10} value={form.max_contacts} onChange={v => set('max_contacts', v || 1)} />
              </Group>
              <Select
                label="Envío de tonos (DTMF)"
                description={DTMF_HELP[form.dtmf_mode] || ''}
                value={form.dtmf_mode}
                onChange={v => set('dtmf_mode', v || 'rfc4733')}
                allowDeselect={false}
                data={DTMF_OPCIONES}
              />
            </Stack>
          </SimpleGrid>
          <Card withBorder radius="md" padding="sm" style={{ background: form.record ? 'rgba(225,29,72,.05)' : undefined }}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={10} wrap="nowrap"><ThemeIcon size={32} radius="md" variant="light" color={form.record ? 'red' : 'gray'}><IconMicrophone2 size={18} /></ThemeIcon>
                <div><Text fw={600} fz="sm">Grabar las llamadas de esta extensión</Text><Text fz="xs" c="dimmed">Se guardan en Grabaciones y quedan enlazadas en el Historial</Text></div></Group>
              <Switch checked={form.record} onChange={e => set('record', e.currentTarget.checked)} color="red" disabled={recAll} />
            </Group>
            {recAll && <Text fz="xs" c="dimmed" mt={6}>La grabación global está activa: se graban TODAS las llamadas, sin importar este interruptor.</Text>}
          </Card>

          {editing &&
            <Card withBorder radius="md" padding="md">
              <Group align="stretch" wrap="nowrap" gap="lg">
                <Stack gap={8} align="center" style={{ flex: 'none', width: 172 }}>
                  <div style={{ background: '#fff', padding: 12, borderRadius: 14, border: '1px solid rgba(120,130,150,.25)', lineHeight: 0 }}>
                    {gen || !enroll ? <Skeleton height={148} width={148} /> : <QRCodeSVG value={enroll.url} size={148} level="M" />}
                  </div>
                  <Badge variant="light" color="pbx" leftSection={<IconQrcode size={12} />}>Extensión {form.id}</Badge>
                </Stack>
                <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <Text fw={700} size="sm">Acceso QR dla extensión</Text>
                    <Text size="xs" c="dimmed">Escaneá con el celular para configurar el softphone. El enlace vence en 24 h.</Text>
                  </div>
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
            </Card>}

          <Divider />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>Cancelar</Button>
            <Button onClick={save} loading={saving} leftSection={editing ? <IconPencil size={16} /> : <IconPlus size={16} />}>{editing ? 'Guardar cambios' : 'Crear extensión'}</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={qrOpen} onClose={closeQr} centered radius="lg" size="sm" title={<Group gap="sm"><ThemeIcon size={40} radius="md" variant="light" color="pbx"><IconQrcode size={22} /></ThemeIcon><div><Text fw={800} lh={1.1}>Acceso rápido WebRTC</Text><Text size="xs" c="dimmed">Escaneá con el celular para instalar la PWA</Text></div></Group>}>
        {!enroll ?
          <Stack>
            <Text size="sm" c="dimmed">Se crea una extensión WebRTC y un enlace con QR que auto-configura el teléfono. Válido 24 h.</Text>
            <TextInput label="Número de extensión" value={qrExt} onChange={e => setQrExt(e.target.value)} />
            <Button onClick={() => generate()} loading={gen} leftSection={<IconQrcode size={16} />}>Generar acceso</Button>
          </Stack> :
          <Stack align="center" gap="sm">
            <div style={{ background: '#fff', padding: 14, borderRadius: 16, border: '1px solid #e5eaf3' }}><QRCodeSVG value={enroll.url} size={196} level="M" /></div>
            <Text fw={700} size="lg">Extensión {enroll.ext}</Text>
            <Group gap={6}><Text size="sm" c="dimmed">Contraseña:</Text><Code>{enroll.password}</Code></Group>
            <CopyButton value={enroll.url}>{({ copied, copy }) => <Button fullWidth variant="light" color={copied ? 'teal' : 'pbx'} leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy}>{copied ? 'Enlace copiado' : 'Copiar enlace'}</Button>}</CopyButton>
            <Button variant="subtle" onClick={() => setEnroll(null)}>Generar otro</Button>
          </Stack>}
      </Modal>
    </Stack>
  );
}
