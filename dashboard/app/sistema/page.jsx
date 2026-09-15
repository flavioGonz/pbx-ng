'use client';
/* ============================================================================
 *  Sistema — el inventario de la plataforma.
 *
 *  Todo esto vivía en el Resumen y lo cargaba sin aportar: el motor, sus módulos y
 *  transportes, y cada nodo con su disco, su memoria y sus interfaces no cambian de un
 *  minuto a otro. No se vigilan: se consultan cuando algo falla o cuando hay que
 *  contarle a alguien cómo está armada la central. El Resumen se quedó con lo que sí
 *  cambia en vivo —llamadas, ataques, troncales, salud de los servicios— y desde ahí se
 *  llega acá con un enlace.
 * ==========================================================================*/
import { usePoll } from '../api';
import { SimpleGrid, Card, Group, Text, ThemeIcon, Badge, Stack } from '@mantine/core';
import { IconServer2, IconBolt, IconPlugConnected, IconCpu } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import SystemOverview from '../SystemOverview';
import { useLive } from '../useLive';

export default function Sistema() {
  const { snap } = useLive();
  /* Mismas cadencias que traía el Resumen: lo que cambia poco se pide cada 60 s, y
   * `usePoll` se frena solo con la pestaña de fondo. */
  const { data: ov } = usePoll('/system/overview', 60000);
  const { data: core } = usePoll('/asterisk/core', 60000);
  const h = snap?.health || {};
  const ch = snap?.channels || [];
  const eps = snap?.extensions || [];

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconCpu size={24} />} title="Sistema" subtitle="Cómo está armada la central: motor, módulos y nodos" color="pbx" />

      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md">
          <Group gap="sm">
            <ThemeIcon size={42} radius="md" variant="light" color="pbx"><IconServer2 size={22} /></ThemeIcon>
            <div><Text fw={800} lh={1.1}>Núcleo de Asterisk</Text><Text size="xs" c="dimmed">{core?.version || 'Consultando el motor…'}</Text></div>
          </Group>
          <Group gap={6}>
            <Badge variant={h.ami ? 'filled' : 'light'} color={h.ami ? 'teal' : 'red'} leftSection={<IconBolt size={12} />}>{h.ami ? 'AMI' : 'Sin AMI'}</Badge>
            <Badge variant="light" color={h.ari ? 'teal' : 'gray'}>{h.ari ? 'ARI' : 'Sin ARI'}</Badge>
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
          <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Versión</Text><Text fw={700} size="sm">{core?.version || '—'}</Text></Card>
          <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Canales activos</Text><Text fw={800} size="xl">{core?.channels ?? ch.length}</Text></Card>
          <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Endpoints</Text><Text fw={800} size="xl">{core?.endpoints ?? eps.length}</Text></Card>
          <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Uptime del motor</Text><Text fw={700} size="sm">{(core?.uptime || '—').replace(/^System uptime:\s*/i, '')}</Text></Card>
        </SimpleGrid>
        {core?.transports?.length > 0 && <><Text fw={600} size="sm" mt="md" mb={6}>Transportes PJSIP</Text><Group gap="xs">{core.transports.map(t => <Badge key={t.id} variant="light" color="pbx" leftSection={<IconPlugConnected size={12} />}>{t.id} · {(t.proto || '').toUpperCase()}</Badge>)}</Group></>}
        {core?.modules && <><Text fw={600} size="sm" mt="md" mb={6}>Módulos clave</Text><Group gap="xs">{Object.entries(core.modules).map(([k, v]) => <Badge key={k} variant="light" color={v ? 'teal' : 'red'}>{k}: {v ? 'cargado' : 'no'}</Badge>)}</Group></>}
      </Card>

      {/* Cada nodo con sus recursos, interfaces y servicios */}
      <SystemOverview data={ov} />
    </Stack>
  );
}
