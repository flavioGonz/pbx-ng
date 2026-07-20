'use client';
import { useEffect, useState } from 'react';
import { Stack, Title, Text, Card, Group, Badge, Table, Button, Modal, TextInput, ThemeIcon, SimpleGrid } from '@mantine/core';
import { IconHeadphones, IconMicrophone, IconUsersGroup, IconPhone, IconActivity, IconEar, IconBroadcast } from '@tabler/icons-react';
import { useLive } from '../useLive';
import { toast } from '../notify';
import Slot from '../Slot';

const SUPKEY = 'pbxng_sup_ext';
const MODES = {
  spy: { label: 'Escuchar', desc: 'Escuchás la llamada sin que te oigan', color: 'blue', icon: IconEar },
  whisper: { label: 'Susurrar', desc: 'Hablás sólo con tu agente (el cliente no te oye)', color: 'violet', icon: IconMicrophone },
  barge: { label: 'Irrumpir', desc: 'Entrás a la llamada (te oyen los dos)', color: 'orange', icon: IconBroadcast },
};


const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
export default function Monitor() {
  const { snap, connected } = useLive();
  const [sup, setSup] = useState(''); const [sel, setSel] = useState(null);
  useEffect(() => { try { setSup(localStorage.getItem(SUPKEY) || ''); } catch (_) {} }, []);

  const chans = snap?.channels || [];
  const seen = new Set(); const calls = [];
  for (const c of chans) {
    const m = /PJSIP\/([^-]+)-/.exec(c.name || ''); if (!m) continue;
    const ext = m[1]; const other = c.connected || c.caller || '?';
    const key = [ext, other].sort().join('|'); if (seen.has(key)) continue; seen.add(key);
    calls.push({ ext, other, state: c.state });
  }

  function ask(target) { setSel(target); }
  async function go(mode) {
    const s = (sup || '').trim();
    if (!s) { toast('Indicá tu extensión', 'bad'); return; }
    try { localStorage.setItem(SUPKEY, s); } catch (_) {}
    const r = await fetch('/backend/api/calls/spy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sup: s, target: sel, mode }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setSel(null);
    toast(r.error ? 'Error: ' + (r.error || '') : 'Llamando a tu extensión ' + s + '…', r.error ? 'bad' : 'ok');
  }

  const kpis = [
    { k: 'Llamadas activas', v: calls.length, icon: IconActivity, c: 'teal' },
    { k: 'Canales', v: chans.length, icon: IconPhone, c: 'pbx' },
    { k: 'Tiempo real', v: connected ? 'En vivo' : '—', icon: IconBroadcast, c: connected ? 'green' : 'gray' },
  ];

  return (
    <Stack gap="lg">
      <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-indigo-5),var(--mantine-color-indigo-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'indigo.5', to: 'indigo.8', deg: 135 }}><IconHeadphones size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Llamadas en vivo</Title><Text c="dimmed" size="sm">Supervisión de llamadas activas · escuchar, susurrar o irrumpir (ChanSpy)</Text></div></div>

      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        {kpis.map(x => (
          <Card key={x.k} withBorder radius="lg" padding="lg" shadow="sm"><Group><ThemeIcon size={44} radius="md" variant="light" color={x.c}><x.icon size={22} /></ThemeIcon>
            <div><Text fw={800} fz={24} lh={1.1}>{typeof x.v === 'number' ? <Slot value={x.v} /> : x.v}</Text><Text size="sm" c="dimmed">{x.k}</Text></div></Group></Card>
        ))}
      </SimpleGrid>

      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md">
          <Text fw={600}>{calls.length} llamadas en curso</Text>
          <TextInput placeholder="Tu extensión (supervisor)" value={sup} onChange={e => setSup(e.target.value)} leftSection={<IconHeadphones size={15} />} w={220} />
        </Group>
        {!snap ? <Text c="dimmed" ta="center" py="xl">Cargando…</Text> :
          calls.length === 0 ? <Text c="dimmed" ta="center" py="xl">No hay llamadas activas en este momento.</Text> :
            <Table.ScrollContainer minWidth={620}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr><Th icon={<IconPhone size={13} />}>Extensión</Th><Th icon={<IconUsersGroup size={13} />}>En llamada con</Th><Th icon={<IconActivity size={13} />}>Estado</Th><Th icon={<IconHeadphones size={13} />}>Acciones</Th></Table.Tr></Table.Thead>
                <Table.Tbody>{calls.map((c, i) => (
                  <Table.Tr key={i}>
                    <Table.Td><Group gap={6}><ThemeIcon size="sm" radius="xl" variant="light" color="teal"><IconPhone size={13} /></ThemeIcon><Text ff="monospace" fw={600}>{c.ext}</Text></Group></Table.Td>
                    <Table.Td ff="monospace">{c.other}</Table.Td>
                    <Table.Td><Badge variant="dot" color={c.state === 'Up' ? 'teal' : 'yellow'}>{c.state === 'Up' ? 'Hablando' : c.state}</Badge></Table.Td>
                    <Table.Td><Button size="compact-sm" variant="light" leftSection={<IconHeadphones size={14} />} onClick={() => ask(c.ext)}>Supervisar</Button></Table.Td>
                  </Table.Tr>
                ))}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
      </Card>

      <Modal opened={!!sel} onClose={() => setSel(null)} centered radius="lg" title={<Group gap="sm"><ThemeIcon size={40} radius="md" variant="light" color="pbx"><IconHeadphones size={22} /></ThemeIcon><div><Text fw={800} lh={1.1}>Supervisar extensión {sel}</Text><Text size="xs" c="dimmed">Sonará tu extensión {sup || '—'} y se conectará a la llamada</Text></div></Group>}>
        <Stack>
          <TextInput label="Tu extensión (supervisor)" value={sup} onChange={e => setSup(e.target.value)} required />
          <SimpleGrid cols={1} spacing="xs">
            {Object.entries(MODES).map(([m, info]) => (
              <Button key={m} variant="light" color={info.color} justify="flex-start" h={56} leftSection={<info.icon size={20} />} disabled={!sup} onClick={() => go(m)}>
                <div style={{ textAlign: 'left' }}><div style={{ fontWeight: 700 }}>{info.label}</div><div style={{ fontSize: 11, opacity: .75 }}>{info.desc}</div></div>
              </Button>
            ))}
          </SimpleGrid>
        </Stack>
      </Modal>
    </Stack>
  );
}
