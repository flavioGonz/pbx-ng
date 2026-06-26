'use client';
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, Button, Table, Badge, ThemeIcon, SimpleGrid, Divider, Textarea, TextInput, Switch, PasswordInput, Alert, ActionIcon, Tooltip } from '@mantine/core';
import { IconBell, IconBrandFirebase, IconBrandApple, IconWorld, IconDeviceFloppy, IconSend, IconInfoCircle, IconDeviceMobile, IconRefresh, IconCircleCheck, IconCircleDashed } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
const provBadge = (p) => p === 'fcm' ? <Badge variant="light" color="orange" leftSection={<IconBrandFirebase size={12} />}>FCM</Badge> : p === 'apns' ? <Badge variant="light" color="gray" leftSection={<IconBrandApple size={12} />}>APNs</Badge> : <Badge variant="light" color="blue">{p}</Badge>;
const StatChip = ({ on, label }) => <Badge variant="light" color={on ? 'teal' : 'gray'} leftSection={on ? <IconCircleCheck size={13} /> : <IconCircleDashed size={13} />}>{label}: {on ? 'configurado' : 'sin configurar'}</Badge>;

export default function Notificaciones() {
  const [data, setData] = useState(null);
  const [fcmSa, setFcmSa] = useState(''); const [fcmSaving, setFcmSaving] = useState(false);
  const [ap, setAp] = useState({ apns_key_p8: '', apns_key_id: '', apns_team_id: '', apns_topic: '', apns_prod: false }); const [apSaving, setApSaving] = useState(false);
  const [setStatus, setSetStatus] = useState({});
  const [testExt, setTestExt] = useState('');

  async function load() {
    try { setData(await fetch('/backend/api/push/devices').then(r => r.json())); } catch (_) {}
    try { const s = await fetch('/backend/api/settings').then(r => r.json()); setSetStatus(s); setAp(a => ({ ...a, apns_key_id: s.apns_key_id && s.apns_key_id !== '__SET__' ? s.apns_key_id : a.apns_key_id, apns_team_id: s.apns_team_id || a.apns_team_id, apns_topic: s.apns_topic || a.apns_topic, apns_prod: s.apns_prod === '1' })); } catch (_) {}
  }
  useEffect(() => { load(); const t = setInterval(load, 12000); return () => clearInterval(t); }, []);

  async function saveSettings(obj, after) {
    const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }).then(x => x.json()).catch(() => ({ error: 1 }));
    if (r.error) toast('Error al guardar', 'bad'); else { toast('Guardado', 'ok'); after && after(); load(); }
  }
  async function saveFcm() { if (!fcmSa.trim()) return; setFcmSaving(true); try { JSON.parse(fcmSa); } catch (_) { setFcmSaving(false); toast('El JSON del service account no es válido', 'bad'); return; } await saveSettings({ fcm_service_account: fcmSa }, () => setFcmSa('')); setFcmSaving(false); }
  async function saveApns() { setApSaving(true); const body = { apns_key_id: ap.apns_key_id, apns_team_id: ap.apns_team_id, apns_topic: ap.apns_topic, apns_prod: ap.apns_prod ? '1' : '0' }; if (ap.apns_key_p8.trim()) body.apns_key_p8 = ap.apns_key_p8; await saveSettings(body, () => setAp(a => ({ ...a, apns_key_p8: '' }))); setApSaving(false); }
  async function sendTest() { if (!testExt) return; const r = await fetch('/backend/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext: testExt }) }).then(x => x.json()).catch(() => ({ error: 1 })); toast(r.error ? 'Error' : 'Enviadas ' + (r.sent || 0) + ' notificación(es)', r.error ? 'bad' : (r.sent ? 'ok' : 'info')); }

  const webTotal = (data?.webpush || []).reduce((a, x) => a + (x.n || 0), 0);
  const devices = data?.devices || [];
  const st = data?.status || {};

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconBell size={24} />} title="Notificaciones Push" subtitle="RFC 8599 · despertar dispositivos en segundo plano (Web Push, FCM, APNs)" color="orange"
        right={<Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>Recargar</Button>} />

      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="sm" mb="xs"><ThemeIcon variant="light" color="blue" size={40} radius="md"><IconWorld size={20} /></ThemeIcon><div><Text fw={700}>Web Push (PWA)</Text><Text size="xs" c="dimmed">VAPID</Text></div></Group>
          <Text fw={800} fz={28} lh={1}>{webTotal}</Text><Text size="xs" c="dimmed">suscripciones web activas</Text>
          <Badge mt="sm" variant="light" color={data?.vapid ? 'teal' : 'gray'}>{data?.vapid ? 'VAPID activo' : '—'}</Badge>
        </Card>
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="sm" mb="xs"><ThemeIcon variant="light" color="orange" size={40} radius="md"><IconBrandFirebase size={20} /></ThemeIcon><div><Text fw={700}>FCM (Android)</Text><Text size="xs" c="dimmed">Firebase HTTP v1</Text></div></Group>
          <StatChip on={st.fcm} label="Credencial" />
          <Text size="xs" c="dimmed" mt="sm">{devices.filter(d => d.provider === 'fcm').length} dispositivo(s) registrados</Text>
        </Card>
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="sm" mb="xs"><ThemeIcon variant="light" color="gray" size={40} radius="md"><IconBrandApple size={20} /></ThemeIcon><div><Text fw={700}>APNs (iOS)</Text><Text size="xs" c="dimmed">VoIP push HTTP/2</Text></div></Group>
          <StatChip on={st.apns} label="Credencial" />
          <Text size="xs" c="dimmed" mt="sm">{devices.filter(d => d.provider === 'apns').length} dispositivo(s) registrados</Text>
        </Card>
      </SimpleGrid>

      <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />}>
        El móvil actual es la PWA, que ya se despierta por <b>Web Push</b> (no requiere configuración). FCM y APNs quedan listos para cuando exista una app nativa: el cliente registra su token con los parámetros <b>pn-provider / pn-prid / pn-param</b> (RFC 8599) en el REGISTER o vía <code>/api/push/register</code>, y la PBX despierta el dispositivo al entrar una llamada.
      </Alert>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Card withBorder radius="lg" padding="lg">
          <Group gap="sm" mb="md"><ThemeIcon variant="light" color="orange"><IconBrandFirebase size={18} /></ThemeIcon><Text fw={600}>Credenciales FCM (Android)</Text></Group>
          <Text size="xs" c="dimmed" mb={6}>Pegá el JSON de la <b>cuenta de servicio</b> de Firebase (Configuración del proyecto → Cuentas de servicio → Generar clave privada).</Text>
          <Textarea placeholder={st.fcm ? 'Credencial guardada · pegá un JSON nuevo para reemplazar' : '{ "type": "service_account", "project_id": "...", ... }'} value={fcmSa} onChange={e => setFcmSa(e.currentTarget.value)} autosize minRows={5} maxRows={10} styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }} />
          <Group justify="flex-end" mt="sm"><Button leftSection={<IconDeviceFloppy size={16} />} loading={fcmSaving} disabled={!fcmSa.trim()} onClick={saveFcm}>Guardar FCM</Button></Group>
        </Card>
        <Card withBorder radius="lg" padding="lg">
          <Group gap="sm" mb="md"><ThemeIcon variant="light" color="gray"><IconBrandApple size={18} /></ThemeIcon><Text fw={600}>Credenciales APNs (iOS)</Text></Group>
          <PasswordInput label="Clave de firma .p8" description="Contenido del archivo AuthKey_XXXX.p8" placeholder={st.apns ? '•••••• (guardada)' : '-----BEGIN PRIVATE KEY-----'} value={ap.apns_key_p8} onChange={e => setAp(a => ({ ...a, apns_key_p8: e.currentTarget.value }))} mb="sm" />
          <SimpleGrid cols={2}>
            <TextInput label="Key ID" value={ap.apns_key_id} onChange={e => setAp(a => ({ ...a, apns_key_id: e.currentTarget.value }))} placeholder="ABC123DEFG" />
            <TextInput label="Team ID" value={ap.apns_team_id} onChange={e => setAp(a => ({ ...a, apns_team_id: e.currentTarget.value }))} placeholder="TEAM123456" />
          </SimpleGrid>
          <TextInput label="Topic (bundle .voip)" mt="sm" value={ap.apns_topic} onChange={e => setAp(a => ({ ...a, apns_topic: e.currentTarget.value }))} placeholder="com.ies.pbx.voip" />
          <Switch label="Producción (api.push.apple.com)" mt="sm" checked={ap.apns_prod} onChange={e => setAp(a => ({ ...a, apns_prod: e.currentTarget.checked }))} />
          <Group justify="flex-end" mt="sm"><Button leftSection={<IconDeviceFloppy size={16} />} loading={apSaving} onClick={saveApns}>Guardar APNs</Button></Group>
        </Card>
      </SimpleGrid>

      <Card withBorder radius="lg" padding="lg">
        <Group justify="space-between" mb="md">
          <Group gap="sm"><ThemeIcon variant="light" color="grape"><IconDeviceMobile size={18} /></ThemeIcon><Text fw={600}>Dispositivos registrados</Text></Group>
          <Group gap="xs"><TextInput size="xs" placeholder="Interno a probar" value={testExt} onChange={e => setTestExt(e.currentTarget.value)} w={150} /><Button size="xs" variant="light" leftSection={<IconSend size={14} />} disabled={!testExt} onClick={sendTest}>Probar envío</Button></Group>
        </Group>
        {devices.length === 0 ? <Text c="dimmed" ta="center" py="lg">Aún no hay dispositivos nativos (FCM/APNs) registrados. La PWA usa Web Push.</Text> :
          <Table.ScrollContainer minWidth={620}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr><Th icon={<IconDeviceMobile size={13} />}>Interno</Th><Th icon={<IconBell size={13} />}>Proveedor</Th><Th>Token</Th><Th>Dispositivo</Th><Th icon={<IconRefresh size={13} />}>Actualizado</Th></Table.Tr></Table.Thead>
              <Table.Tbody>{devices.map(d => (
                <Table.Tr key={d.id}><Table.Td ff="monospace" fw={600}>{d.ext}</Table.Td><Table.Td>{provBadge(d.provider)}</Table.Td><Table.Td ff="monospace" fz="xs" c="dimmed">{d.prid_head}…</Table.Td><Table.Td fz="xs">{d.ua || '—'}</Table.Td><Table.Td fz="xs" c="dimmed">{d.updated_at ? new Date(d.updated_at).toLocaleString('es-UY') : '—'}</Table.Td></Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>}
      </Card>
    </Stack>
  );
}
