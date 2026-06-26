'use client';
import { useEffect, useState } from 'react';
import { Card, Title, Text, Stack, Table, Badge, ThemeIcon, Group } from '@mantine/core';
import { IconBuilding, IconHash, IconTag, IconTerminal2, IconCircleCheck } from '@tabler/icons-react';

const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
export default function Empresas() {
  const [tn, setTn] = useState([]);
  useEffect(() => { fetch('/backend/api/tenants').then(r => r.json()).then(setTn).catch(() => setTn([])); }, []);
  return (
    <Stack gap="lg">
      <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-teal-5),var(--mantine-color-teal-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'teal.5', to: 'teal.8', deg: 135 }}><IconBuilding size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Empresas</Title><Text c="dimmed" size="sm">Arquitectura multi-tenant · en fase single-tenant opera la empresa Default</Text></div></div>
      <Card withBorder radius="lg" padding={0} shadow="sm">
        <Table striped highlightOnHover verticalSpacing="sm">
          <Table.Thead><Table.Tr><Th icon={<IconHash size={13} />}>ID</Th><Th icon={<IconBuilding size={13} />}>Nombre</Th><Th icon={<IconTag size={13} />}>Slug</Th><Th icon={<IconTerminal2 size={13} />}>Contexto</Th><Th icon={<IconCircleCheck size={13} />}>Estado</Th></Table.Tr></Table.Thead>
          <Table.Tbody>{tn.map(t => <Table.Tr key={t.id}><Table.Td ff="monospace">#{t.id}</Table.Td><Table.Td fw={600}>{t.name}</Table.Td><Table.Td>{t.slug}</Table.Td><Table.Td>{t.context_prefix}</Table.Td>
            <Table.Td><Badge color={t.active ? 'teal' : 'gray'} variant="light">{t.active ? 'Activa' : 'Inactiva'}</Badge></Table.Td></Table.Tr>)}</Table.Tbody>
        </Table>
      </Card>
    </Stack>
  );
}
