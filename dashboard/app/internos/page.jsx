'use client';
import { useState } from 'react';
import { Stack, Title, Text, Card, Group, Button, Table, Badge, Modal, TextInput, PasswordInput, Switch, SegmentedControl, ActionIcon, ThemeIcon, NumberInput, Divider, Tooltip, CopyButton, Code, Skeleton, SimpleGrid } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconTrash, IconVideo, IconWorld, IconDeviceLandlinePhone, IconPencil, IconUserPlus, IconQrcode, IconSearch, IconCopy, IconCheck, IconMail, IconSend, IconUsers, IconActivity, IconPhoneCall, IconHash, IconUser, IconClock } from '@tabler/icons-react';
import { QRCodeSVG } from 'qrcode.react';
import { useLive } from '../useLive';
import { toast } from '../notify';
import { TableSkeleton } from '../Skeletons';
import PageHeader from '../PageHeader';

const EMPTY = { id: '', name: '', pass: '', video: false, type: 'webrtc', max_contacts: 2, tenant_id: 1 };
const rttColor = (r) => r == null ? 'gray' : r < 80 ? 'teal' : r < 200 ? 'yellow' : 'red';
const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;

export default function Internos() {
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

  function suggestExt() { const nums = list.map(e => parseInt(e.id, 10)).filter(n => !isNaN(n)); const base = nums.length ? Math.max(...nums) : 9100; return String(base + 1); }
  function openNew() { setForm(EMPTY); setEditing(false); setEnroll(null); setEmailTo(''); open(); }
  function openEdit(e) { setForm({ id: e.id, name: e.name || '', pass: '', video: !!e.video, type: e.webrtc ? 'webrtc' : 'sip', max_contacts: 2, tenant_id: e.tenant_id || 1 }); setEditing(true); setEnroll(null); setEmailTo(''); open(); generate(e.id); }
  function openQrModal() { setEnroll(null); setQrExt(suggestExt()); openQr(); }

  async function save() {
    if (!form.id || (!editing && !form.pass)) { toast('Completá interno y contraseña', 'bad'); return; }
    setSaving(true);
    const body = { id: form.id, name: form.name || '', password: form.pass || undefined, video: form.video, webrtc: form.type === 'webrtc', max_contacts: form.max_contacts };
    const url = editing ? '/backend/api/endpoints/' + form.id : '/backend/api/endpoints';
    const r = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) toast('Error: ' + r.error, 'bad');
    else { toast(editing ? 'Interno ' + form.id + ' actualizado' : 'Interno ' + (r.created || form.id) + ' creado', 'ok'); close(); }
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
  async function del(epid) { if (!confirm('¿Eliminar el interno ' + epid + '?')) return; await fetch('/backend/api/endpoints/' + epid, { method: 'DELETE' }); toast('Interno ' + epid + ' eliminado', 'info'); }

  const online = list.filter(e => e.status === 'online').length;
  const inCall = list.filter(e => e.channels > 0).length;
  const wrtc = list.filter(e => e.webrtc).length;
  const sip = list.length - wrtc;
  const kpis = [{ k: 'Total', v: list.length, icon: IconUsers, c: 'pbx' }, { k: 'En línea', v: online, icon: IconActivity, c: 'teal' }, { k: 'En llamada', v: inCall, icon: IconPhoneCall, c: 'orange' }, { k: 'WebRTC', v: wrtc, icon: IconWorld, c: 'grape' }, { k: 'SIP físico', v: sip, icon: IconDeviceLandlinePhone, c: 'gray' }];
  const fl = list.filter(e => !q || e.id.includes(q) || (e.name || '').toLowerCase().includes(q.toLowerCase()) || (e.ip || '').includes(q));

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconUsers size={24} />} title="Internos" subtitle="Aprovisionamiento y estado de registro en tiempo real" color="pbx" />
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="md">
        {kpis.map(x => (
          <Card key={x.k} withBorder radius="lg" padding="md" shadow="sm">
            <Group gap="sm" wrap="nowrap"><ThemeIcon size={40} radius="md" variant="light" color={x.c}><x.icon size={20} /></ThemeIcon><div><Text fw={800} fz={24} lh={1}>{x.v}</Text><Text size="xs" c="dimmed">{x.k}</Text></div></Group>
          </Card>
        ))}
      </SimpleGrid>
      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md">
          <Group gap="xs"><Text fw={600}>{list.length} internos</Text><Badge variant="light" color="teal">{online} en línea</Badge></Group>
          <Group gap="sm">
            <TextInput placeholder="Buscar interno, nombre o IP" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={230} />
            <Button variant="light" leftSection={<IconQrcode size={16} />} onClick={openQrModal}>Acceso QR</Button>
            <Button leftSection={<IconPlus size={16} />} onClick={openNew}>Nuevo interno</Button>
          </Group>
        </Group>
        {!snap ? <TableSkeleton rows={6} cols={7} /> :
          list.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin internos.</Text> :
            <Table.ScrollContainer minWidth={760}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr><Th icon={<IconHash size={13} />}>Interno</Th><Th icon={<IconUser size={13} />}>Nombre</Th><Th icon={<IconActivity size={13} />}>Estado</Th><Th icon={<IconWorld size={13} />}>IP</Th><Th icon={<IconClock size={13} />}>RTT</Th><Th icon={<IconDeviceLandlinePhone size={13} />}>Tipo</Th><Th icon={<IconVideo size={13} />}>Video</Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>{fl.map(e => (
                  <Table.Tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => openEdit(e)}>
                    <Table.Td ff="monospace" fw={600}>{e.id}</Table.Td>
                    <Table.Td>{e.name || <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                    <Table.Td><Badge variant="light" color={e.channels > 0 ? 'orange' : e.status === 'online' ? 'teal' : 'gray'} leftSection={<span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: e.channels > 0 ? '#f59e0b' : e.status === 'online' ? '#22c55e' : '#9aa3b2' }} />}>{e.channels > 0 ? 'En llamada' : e.status === 'online' ? 'Registrado' : 'Desconectado'}</Badge></Table.Td>
                    <Table.Td>{e.ip ? <Text ff="monospace" size="xs">{e.ip}</Text> : <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                    <Table.Td>{e.rtt != null ? <Badge size="sm" variant="dot" color={rttColor(e.rtt)}>{e.rtt.toFixed(0)} ms</Badge> : <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                    <Table.Td><Badge variant="dot" color={e.webrtc ? 'pbx' : 'gray'}>{e.webrtc ? 'WebRTC' : 'SIP'}</Badge></Table.Td>
                    <Table.Td>{e.video ? <Badge color="violet" variant="light" leftSection={<IconVideo size={12} />}>Sí</Badge> : <Text c="dimmed">—</Text>}</Table.Td>
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

      <Modal opened={opened} onClose={close} centered radius="lg" size={editing ? 'lg' : 'md'} overlayProps={{ blur: 3, backgroundOpacity: 0.45 }}
        title={<Group gap="sm">
          <ThemeIcon size={42} radius="md" variant="light" color={form.type === 'webrtc' ? 'pbx' : 'gray'}>{editing ? <IconPencil size={22} /> : <IconUserPlus size={22} />}</ThemeIcon>
          <div><Text fw={800} size="lg" lh={1.1}>{editing ? 'Editar interno ' + form.id : 'Nuevo interno'}</Text><Text size="xs" c="dimmed">{form.type === 'webrtc' ? 'Softphone WebRTC (navegador / PWA)' : 'Teléfono SIP físico'}</Text></div>
        </Group>}>
        <Stack>
          <Group grow align="flex-start">
            <TextInput label="Número de interno" placeholder="1006" value={form.id} onChange={e => set('id', e.target.value)} required disabled={editing} />
            <PasswordInput label="Contraseña SIP" value={form.pass} onChange={e => set('pass', e.target.value)} required={!editing} placeholder={editing ? 'Sin cambios' : ''} />
          </Group>
          <TextInput label="Nombre (libreta)" placeholder="Ej: Recepción, Juan Pérez" value={form.name} onChange={e => set('name', e.target.value)} description="Visible en la libreta de direcciones de los internos" />
          <div>
            <Text size="sm" fw={500} mb={6}>Tipo de interno</Text>
            <SegmentedControl fullWidth value={form.type} onChange={v => set('type', v)} data={[
              { value: 'webrtc', label: (<Group gap={6} justify="center"><IconWorld size={15} /> WebRTC</Group>) },
              { value: 'sip', label: (<Group gap={6} justify="center"><IconDeviceLandlinePhone size={15} /> SIP físico</Group>) },
            ]} />
            <Text size="xs" c="dimmed" mt={6}>{form.type === 'webrtc' ? 'Para llamar desde el navegador / app (DTLS-SRTP, ICE, codecs ulaw/g722).' : 'Para teléfonos físicos (Yealink, Grandstream) por UDP/TLS (G.711/G.722).'}</Text>
          </div>
          <Group grow>
            <Switch label="Video (VP8/H264)" checked={form.video} onChange={e => set('video', e.currentTarget.checked)} />
            <NumberInput label="Dispositivos" description="Registros simultáneos" min={1} max={10} value={form.max_contacts} onChange={v => set('max_contacts', v || 1)} />
          </Group>

          {editing &&
            <Card withBorder radius="md" padding="md">
              <Group align="stretch" wrap="nowrap" gap="lg">
                <Stack gap={8} align="center" style={{ flex: 'none', width: 172 }}>
                  <div style={{ background: '#fff', padding: 12, borderRadius: 14, border: '1px solid rgba(120,130,150,.25)', lineHeight: 0 }}>
                    {gen || !enroll ? <Skeleton height={148} width={148} /> : <QRCodeSVG value={enroll.url} size={148} level="M" />}
                  </div>
                  <Badge variant="light" color="pbx" leftSection={<IconQrcode size={12} />}>Interno {form.id}</Badge>
                </Stack>
                <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <Text fw={700} size="sm">Acceso QR del interno</Text>
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
            <Button onClick={save} loading={saving} leftSection={editing ? <IconPencil size={16} /> : <IconPlus size={16} />}>{editing ? 'Guardar cambios' : 'Crear interno'}</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={qrOpen} onClose={closeQr} centered radius="lg" size="sm" title={<Group gap="sm"><ThemeIcon size={40} radius="md" variant="light" color="pbx"><IconQrcode size={22} /></ThemeIcon><div><Text fw={800} lh={1.1}>Acceso rápido WebRTC</Text><Text size="xs" c="dimmed">Escaneá con el celular para instalar la PWA</Text></div></Group>}>
        {!enroll ?
          <Stack>
            <Text size="sm" c="dimmed">Se crea un interno WebRTC y un enlace con QR que auto-configura el teléfono. Válido 24 h.</Text>
            <TextInput label="Número de interno" value={qrExt} onChange={e => setQrExt(e.target.value)} />
            <Button onClick={() => generate()} loading={gen} leftSection={<IconQrcode size={16} />}>Generar acceso</Button>
          </Stack> :
          <Stack align="center" gap="sm">
            <div style={{ background: '#fff', padding: 14, borderRadius: 16, border: '1px solid #e5eaf3' }}><QRCodeSVG value={enroll.url} size={196} level="M" /></div>
            <Text fw={700} size="lg">Interno {enroll.ext}</Text>
            <Group gap={6}><Text size="sm" c="dimmed">Contraseña:</Text><Code>{enroll.password}</Code></Group>
            <CopyButton value={enroll.url}>{({ copied, copy }) => <Button fullWidth variant="light" color={copied ? 'teal' : 'pbx'} leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy}>{copied ? 'Enlace copiado' : 'Copiar enlace'}</Button>}</CopyButton>
            <Button variant="subtle" onClick={() => setEnroll(null)}>Generar otro</Button>
          </Stack>}
      </Modal>
    </Stack>
  );
}
