'use client';
import { SimpleGrid, Card, Text, Title, Stack, Table, Badge, Group, ThemeIcon } from '@mantine/core';
import { IconPhone, IconUsers, IconHeadset, IconBolt } from '@tabler/icons-react';
import { useLive } from '../useLive';
export default function Wallboard() {
  const { snap } = useLive();
  const eps = snap?.extensions || [], ch = snap?.channels || [], qs = snap?.queues || [];
  const online = eps.filter(e => e.status === 'online').length;
  const agents = qs.reduce((a, q) => a + q.agents_online, 0);
  const stats = [
    { l: 'Llamadas activas', v: ch.length, accent: true, icon: IconPhone },
    { l: 'Internos en línea', v: `${online}/${eps.length}`, icon: IconUsers },
    { l: 'Colas', v: qs.length, icon: IconHeadset },
    { l: 'Agentes disponibles', v: agents, icon: IconBolt },
  ];
  return (
    <Stack gap="xl">
      <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-teal-5),var(--mantine-color-teal-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'teal.5', to: 'teal.8', deg: 135 }}><IconBolt size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Wallboard</Title><Text c="dimmed" size="sm">Monitoreo operativo en vivo</Text></div></div>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        {stats.map(s => (
          <Card key={s.l} withBorder={!s.accent} radius="lg" padding="xl" shadow="sm"
            style={s.accent ? { background: 'linear-gradient(135deg,#1d4ed8,#143196)', color: '#fff', border: 'none' } : {}}>
            <Group justify="space-between" align="flex-start">
              <div><Text size="sm" style={s.accent ? { color: 'rgba(255,255,255,.85)' } : {}} c={s.accent ? undefined : 'dimmed'}>{s.l}</Text>
                <Text fw={800} fz={46} lh={1}>{snap ? s.v : '—'}</Text></div>
              <s.icon size={40} opacity={s.accent ? 0.4 : 0.15} />
            </Group>
          </Card>
        ))}
      </SimpleGrid>
      <div><Text fw={600} c="dimmed" tt="uppercase" fz="sm" mb="sm">Colas en tiempo real</Text>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          {qs.length === 0 ? <Text c="dimmed">Sin colas.</Text> : qs.map(q => (
            <Card key={q.name} withBorder radius="lg" padding="lg" shadow="sm">
              <Text size="sm" c="dimmed">{q.label || q.name}</Text>
              <Text fw={800} fz={34}>{q.agents_online}<Text span c="dimmed" fz="md"> /{q.agents_total} ag.</Text></Text>
              <Text size="xs" c="dimmed" mt={4}>Acceso {q.access_exten} · {q.strategy}</Text>
            </Card>
          ))}
        </SimpleGrid>
      </div>
      <div><Text fw={600} c="dimmed" tt="uppercase" fz="sm" mb="sm">Llamadas en curso</Text>
        <Card withBorder radius="lg" padding={0} shadow="sm">
          {ch.length === 0 ? <Text c="dimmed" ta="center" py="xl">No hay llamadas en curso.</Text> :
            <Table striped><Table.Thead><Table.Tr><Table.Th>Canal</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Origen</Table.Th><Table.Th>Conectado</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{ch.map(c => <Table.Tr key={c.id}><Table.Td ff="monospace">{c.name}</Table.Td><Table.Td><Badge variant="light">{c.state}</Badge></Table.Td><Table.Td>{c.caller || '—'}</Table.Td><Table.Td>{c.connected || '—'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
        </Card>
      </div>
    </Stack>
  );
}
