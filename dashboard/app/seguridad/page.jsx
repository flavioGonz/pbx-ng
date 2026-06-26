'use client';
import { useEffect, useState } from 'react';
import { Stack, Title, Text, Card, Group, Button, Table, Badge, SimpleGrid, ThemeIcon, TextInput, ActionIcon, Tooltip } from '@mantine/core';
import { IconRefresh, IconShieldCheck, IconBan, IconWorld, IconSearch, IconLockOpen, IconAlertTriangle, IconMapPin } from '@tabler/icons-react';
import { TableSkeleton, CardsSkeleton } from '../Skeletons';
import { toast } from '../notify';

export default function Seguridad() {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [q, setQ] = useState('');
  async function load() { try { const d = await fetch('/backend/api/security').then(r => r.json()); setData(d); } catch (_) { setData({ jails: [], geo: {} }); } setLoading(false); }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  async function unban(ip, jail) { const r = await fetch('/backend/api/security/unban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, jail }) }).then(x => x.json()).catch(() => ({ error: 1 })); toast(r.error ? 'Error' : 'Desbloqueando ' + ip, r.error ? 'bad' : 'ok'); }

  const jails = data?.jails || []; const geo = data?.geo || {};
  const rows = [];
  for (const j of jails) for (const ip of (j.banned || [])) rows.push({ ip, jail: j.jail, ...(geo[ip] || {}) });
  const totalBanned = rows.length;
  const totalFailed = jails.reduce((a, j) => a + (j.total_failed || 0), 0);
  const byCountry = {};
  for (const r of rows) { const k = r.country || 'Desconocido'; byCountry[k] = (byCountry[k] || 0) + 1; }
  const topCountries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const fr = rows.filter(r => !q || r.ip.includes(q) || (r.country || '').toLowerCase().includes(q.toLowerCase()) || (r.city || '').toLowerCase().includes(q.toLowerCase()));

  const cards = [
    ['IPs bloqueadas', totalBanned, IconBan, 'red'],
    ['Intentos fallidos', totalFailed, IconAlertTriangle, 'orange'],
    ['Jails activas', jails.length, IconShieldCheck, 'teal'],
    ['Países de origen', Object.keys(byCountry).length, IconWorld, 'blue'],
  ];

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-red-5),var(--mantine-color-red-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'red.5', to: 'red.8', deg: 135 }}><IconShieldCheck size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Seguridad</Title><Text c="dimmed" size="sm">Fail2Ban · ataques bloqueados y origen geográfico</Text></div></div>
        <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>Actualizar</Button>
      </Group>

      {loading ? <CardsSkeleton count={4} /> :
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          {cards.map(([l, v, Ic, c]) => (
            <Card key={l} withBorder radius="lg" padding="lg" shadow="sm"><Group><ThemeIcon size={44} radius="md" variant="light" color={c}><Ic size={22} /></ThemeIcon>
              <div><Text size="sm" c="dimmed">{l}</Text><Text fw={800} fz={26}>{v}</Text></div></Group></Card>
          ))}
        </SimpleGrid>}

      {!loading && topCountries.length > 0 &&
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={600} mb="sm">Orígenes por país</Text>
          <Group gap="sm">{topCountries.map(([c, n]) => <Badge key={c} size="lg" variant="light" color="indigo" leftSection={<IconMapPin size={12} />}>{c}: {n}</Badge>)}</Group>
        </Card>}

      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md">
          <Text fw={600}>IPs bloqueadas ({fr.length})</Text>
          <TextInput placeholder="Buscar IP, país o ciudad" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={260} />
        </Group>
        {loading ? <TableSkeleton rows={6} cols={5} /> :
          rows.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin IPs bloqueadas. El sistema está limpio.</Text> :
            <Table.ScrollContainer minWidth={680}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr><Table.Th>IP</Table.Th><Table.Th>País</Table.Th><Table.Th>Ciudad</Table.Th><Table.Th>ISP</Table.Th><Table.Th>Jail</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>{fr.map((r, i) => (
                  <Table.Tr key={r.ip + i}>
                    <Table.Td ff="monospace" fw={600}>{r.ip}</Table.Td>
                    <Table.Td>{r.country ? <Badge variant="light" color="gray">{r.cc ? r.cc + ' · ' : ''}{r.country}</Badge> : <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                    <Table.Td><Text size="sm">{r.city || '—'}</Text></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{r.isp || '—'}</Text></Table.Td>
                    <Table.Td><Badge variant="dot" color="orange">{r.jail}</Badge></Table.Td>
                    <Table.Td ta="right"><Tooltip label="Desbloquear"><ActionIcon variant="subtle" color="teal" onClick={() => unban(r.ip, r.jail)}><IconLockOpen size={17} /></ActionIcon></Tooltip></Table.Td>
                  </Table.Tr>
                ))}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
      </Card>
    </Stack>
  );
}
