'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Group, Text, Button, Table, Badge, ActionIcon } from '@mantine/core';
import { IconArrowsSplit, IconHash, IconVolume, IconList, IconPlus, IconEdit, IconTrash } from '@tabler/icons-react';
import { toast } from './notify';

const DLABEL = { extension: 'Interno', ringgroup: 'Ring Group', queue: 'Cola', voicemail: 'Buzon', ivr: 'Otro IVR', ai: 'Agente IA', hangup: 'Colgar' };
const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;

export default function IvrPanel() {
  const router = useRouter();
  const [list, setList] = useState([]);
  async function load() { try { setList(await fetch('/backend/api/ivr').then(r => r.json())); } catch (_) {} }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  async function del(id) {
    if (!confirm('Eliminar este IVR?')) return;
    await fetch('/backend/api/ivr/' + id, { method: 'DELETE' });
    toast('IVR eliminado', 'info'); load();
  }
  return (
    <Card withBorder radius="lg" padding="lg">
      <Group justify="space-between" mb="md">
        <Group gap="xs"><IconArrowsSplit size={18} /><Text fw={600}>Menus de voz (IVR)</Text><Badge variant="light" color="teal">Disenador visual</Badge></Group>
        <Button leftSection={<IconPlus size={16} />} onClick={() => router.push('/ivr/nuevo')}>Nuevo IVR</Button>
      </Group>
      {list.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin IVRs. Crea uno con el disenador visual.</Text> :
        <Table.ScrollContainer minWidth={620}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead><Table.Tr><Th icon={<IconArrowsSplit size={13} />}>Nombre</Th><Th icon={<IconHash size={13} />}>Acceso</Th><Th icon={<IconVolume size={13} />}>Saludo</Th><Th icon={<IconList size={13} />}>Opciones</Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>{list.map(iv => (
              <Table.Tr key={iv.id} style={{ cursor: 'pointer' }} onClick={() => router.push('/ivr/' + iv.id)}>
                <Table.Td fw={600}>{iv.name}</Table.Td>
                <Table.Td ff="monospace">{iv.exten}</Table.Td>
                <Table.Td><Badge variant="light" color="gray" radius="sm">{iv.greeting}</Badge></Table.Td>
                <Table.Td><Group gap={6}>{(iv.options || []).map((o, i) => <Badge key={i} variant="light" radius="sm">{o.digit} → {DLABEL[o.dest_type] || o.dest_type}{o.dest_value ? ' ' + o.dest_value : ''}</Badge>)}</Group></Table.Td>
                <Table.Td ta="right" onClick={e => e.stopPropagation()}>
                  <Group gap={4} justify="flex-end">
                    <ActionIcon variant="subtle" onClick={() => router.push('/ivr/' + iv.id)}><IconEdit size={17} /></ActionIcon>
                    <ActionIcon variant="subtle" color="red" onClick={() => del(iv.id)}><IconTrash size={17} /></ActionIcon>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>}
    </Card>
  );
}
