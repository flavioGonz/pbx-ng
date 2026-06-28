'use client';
import { useEffect, useState } from 'react';
import { Card, Group, Text, Badge, Table, ThemeIcon } from '@mantine/core';
import { IconPhoneIncoming, IconAlertTriangle, IconCircleCheck, IconDeviceLandlinePhone } from '@tabler/icons-react';

const destLabel = { interno: 'Interno', ivr: 'IVR', cola: 'Cola', app: 'Aplicación' };

export default function DidOverview() {
  const [trunks, setTrunks] = useState([]);
  const [routes, setRoutes] = useState([]);
  useEffect(() => {
    fetch('/backend/api/trunks').then((r) => r.json()).then((d) => Array.isArray(d) && setTrunks(d)).catch(() => {});
    fetch('/backend/api/routes/inbound').then((r) => r.json()).then((d) => Array.isArray(d) && setRoutes(d)).catch(() => {});
  }, []);
  const rmap = {};
  routes.forEach((r) => { rmap[String(r.did)] = r; });
  const rows = [];
  trunks.forEach((t) => (t.dids || []).forEach((d) => rows.push({ did: String(d), trunk: t, route: rmap[String(d)] })));
  if (!rows.length) return null;
  const routed = rows.filter((r) => r.route).length;
  return (
    <Card withBorder radius="md" padding="md" mb="md">
      <Group justify="space-between" mb="xs">
        <Group gap="xs"><IconPhoneIncoming size={16} /><Text fw={700} size="sm">Números (DID) de tus troncales</Text></Group>
        <Group gap={6}><Badge variant="light" color="teal">{routed} ruteados</Badge>{rows.length - routed > 0 && <Badge variant="light" color="orange">{rows.length - routed} sin ruta</Badge>}</Group>
      </Group>
      <Text size="xs" c="dimmed" mb="sm">Números que entregan tus proveedores y a dónde se dirigen las llamadas entrantes. Los marcados «sin ruta» todavía no tienen destino: agregalos abajo.</Text>
      <Table verticalSpacing={5} fz="sm" highlightOnHover>
        <Table.Thead><Table.Tr><Table.Th>Proveedor</Table.Th><Table.Th>DID / Número</Table.Th><Table.Th>Destino</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{rows.map((r, i) => (
          <Table.Tr key={i}>
            <Table.Td><Group gap={6} wrap="nowrap">{r.trunk.logo ? <img src={r.trunk.logo} alt="" style={{ width: 22, height: 22, objectFit: 'contain' }} /> : <ThemeIcon size={22} radius="sm" variant="light" color="gray"><IconDeviceLandlinePhone size={13} /></ThemeIcon>}<Text size="sm">{r.trunk.name}</Text></Group></Table.Td>
            <Table.Td ff="monospace">{r.did}</Table.Td>
            <Table.Td>{r.route ? <Badge variant="light" color="teal" leftSection={<IconCircleCheck size={12} />}>{destLabel[r.route.dest_type] || r.route.dest_type} → {r.route.dest_value}</Badge> : <Badge variant="light" color="orange" leftSection={<IconAlertTriangle size={12} />}>sin ruta</Badge>}</Table.Td>
          </Table.Tr>
        ))}</Table.Tbody>
      </Table>
    </Card>
  );
}
