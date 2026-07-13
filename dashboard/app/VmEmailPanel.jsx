/* VmEmailPanel.jsx — Buzón de voz -> Email (con transcripción por IA) */
'use client';
import { useEffect, useState } from 'react';
import { Card, Group, Text, Table, Switch, TextInput, Badge, ThemeIcon, Button, Loader, Center, Stack, Tooltip } from '@mantine/core';
import { IconMailForward, IconRefresh, IconDeviceFloppy, IconSparkles } from '@tabler/icons-react';
import { toast } from './notify';

export default function VmEmailPanel() {
  const [rows, setRows] = useState(null);
  const [dirty, setDirty] = useState({});
  const [busy, setBusy] = useState('');

  async function load() {
    try { const d = await fetch('/backend/api/vm/email').then(r => r.json()); setRows(Array.isArray(d) ? d : []); setDirty({}); }
    catch (_) { setRows([]); }
  }
  useEffect(() => { load(); }, []);

  const upd = (mb, patch) => { setRows(rs => rs.map(r => r.mailbox === mb ? { ...r, ...patch } : r)); setDirty(d => ({ ...d, [mb]: true })); };

  async function save(r) {
    setBusy(r.mailbox);
    const res = await fetch('/backend/api/vm/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setBusy('');
    if (res.error) { toast('No se pudo guardar: ' + res.error, 'bad'); return; }
    setDirty(d => ({ ...d, [r.mailbox]: false }));
    toast('Buzón ' + r.mailbox + ': envío por correo actualizado', 'ok');
  }

  if (!rows) return <Center mih={200}><Loader color="indigo" /></Center>;

  return (
    <Card withBorder radius="md" padding="md" mt="lg">
      <Group justify="space-between" mb="xs">
        <Group gap="sm">
          <ThemeIcon size={40} radius="md" variant="light" color="indigo"><IconMailForward size={22} /></ThemeIcon>
          <div>
            <Text fw={800} lh={1.1}>Mensaje de voz al correo</Text>
            <Text size="xs" c="dimmed">Cada mensaje nuevo se envía al email del buzón, con el audio adjunto y la transcripción automática.</Text>
          </div>
        </Group>
        <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={load}>Refrescar</Button>
      </Group>

      {rows.length === 0
        ? <Text size="sm" c="dimmed">No hay buzones. Creá uno arriba.</Text>
        : (
          <Table striped highlightOnHover verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Buzón</Table.Th>
                <Table.Th>Email destino</Table.Th>
                <Table.Th ta="center">Enviar</Table.Th>
                <Table.Th ta="center">Adjuntar audio</Table.Th>
                <Table.Th ta="center"><Tooltip label="Transcribe el mensaje con Whisper y lo incluye en el correo"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconSparkles size={13} /> Transcribir</span></Tooltip></Table.Th>
                <Table.Th ta="center"><Tooltip label="Borra el mensaje del buzón después de enviarlo por correo"><span>Borrar tras enviar</span></Tooltip></Table.Th>
                <Table.Th ta="center">Enviados</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map(r => (
                <Table.Tr key={r.mailbox}>
                  <Table.Td><Badge variant="light" ff="monospace">{r.mailbox}</Badge> <Text span size="xs" c="dimmed">{r.fullname || ''}</Text></Table.Td>
                  <Table.Td style={{ minWidth: 220 }}>
                    <TextInput size="xs" placeholder="nombre@empresa.com" value={r.email || ''} onChange={e => upd(r.mailbox, { email: e.target.value })} />
                  </Table.Td>
                  <Table.Td ta="center"><Switch size="sm" color="teal" checked={!!r.email_enabled} onChange={e => upd(r.mailbox, { email_enabled: e.currentTarget.checked })} /></Table.Td>
                  <Table.Td ta="center"><Switch size="sm" checked={!!r.email_attach} onChange={e => upd(r.mailbox, { email_attach: e.currentTarget.checked })} /></Table.Td>
                  <Table.Td ta="center"><Switch size="sm" color="grape" checked={!!r.email_transcribe} onChange={e => upd(r.mailbox, { email_transcribe: e.currentTarget.checked })} /></Table.Td>
                  <Table.Td ta="center"><Switch size="sm" color="red" checked={!!r.email_delete} onChange={e => upd(r.mailbox, { email_delete: e.currentTarget.checked })} /></Table.Td>
                  <Table.Td ta="center"><Text size="sm" c={Number(r.enviados) ? 'teal' : 'dimmed'} fw={600}>{r.enviados || 0}</Text></Table.Td>
                  <Table.Td>
                    <Button size="xs" variant={dirty[r.mailbox] ? 'filled' : 'light'} color="indigo" disabled={!dirty[r.mailbox]} loading={busy === r.mailbox}
                      leftSection={<IconDeviceFloppy size={14} />} onClick={() => save(r)}>Guardar</Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}

      <Stack gap={4} mt="md">
        <Text size="xs" c="dimmed">El envío usa el SMTP de la empresa (Configuración → Email). Si no está configurado o está apagado, no se manda nada.</Text>
        <Text size="xs" c="dimmed">Los mensajes se revisan cada 45 segundos; cada mensaje se envía una sola vez.</Text>
      </Stack>
    </Card>
  );
}
