'use client';
import { useEffect, useState } from 'react';
import { Stack, Title, Text, Card, Group, Button, Table, Badge, Modal, TextInput, PasswordInput, Select, ActionIcon, Tooltip, ThemeIcon } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconTrash, IconKey, IconSearch, IconUser, IconId, IconShieldCheck, IconCalendar } from '@tabler/icons-react';
import { toast } from '../notify';
import { TableSkeleton } from '../Skeletons';
const ROLES = [{ value: 'admin', label: 'Administrador' }, { value: 'operator', label: 'Operador' }, { value: 'viewer', label: 'Solo lectura' }];

const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
export default function Usuarios() {
  const [list, setList] = useState([]); const [loading, setLoading] = useState(true); const [q, setQ] = useState('');
  const [opened, { open, close }] = useDisclosure(false);
  const [pwOpen, { open: openPw, close: closePw }] = useDisclosure(false);
  const [f, setF] = useState({ role: 'admin' }); const [pwTarget, setPwTarget] = useState(null); const [pw, setPw] = useState('');
  async function load() { try { const d = await fetch('/backend/api/users').then(r => r.json()); setList(Array.isArray(d) ? d : []); } catch (_) { setList([]); } setLoading(false); }
  useEffect(() => { load(); }, []);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  async function create() {
    const r = await fetch('/backend/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) }).then(x => x.json());
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast('Usuario ' + r.created + ' creado', 'ok'); setF({ role: 'admin' }); close(); load(); }
  }
  async function del(u) { if (!confirm('¿Eliminar el usuario ' + u.username + '?')) return; const r = await fetch('/backend/api/users/' + u.id, { method: 'DELETE' }).then(x => x.json()); if (r.error) toast('Error: ' + r.error, 'bad'); else { toast('Usuario eliminado', 'info'); load(); } }
  async function resetPw() {
    const r = await fetch('/backend/api/users/' + pwTarget.id + '/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) }).then(x => x.json());
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast('Contraseña actualizada', 'ok'); setPw(''); closePw(); }
  }
  const roleLabel = (r) => (ROLES.find(x => x.value === r) || {}).label || r;
  const roleColor = (r) => r === 'admin' ? 'pbx' : r === 'operator' ? 'teal' : 'gray';
  const fl = list.filter(u => !q || u.username.toLowerCase().includes(q.toLowerCase()) || (u.name || '').toLowerCase().includes(q.toLowerCase()));
  return (
    <Stack gap="lg">
      <Group justify="space-between"><div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-indigo-5),var(--mantine-color-indigo-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'indigo.5', to: 'indigo.8', deg: 135 }}><IconKey size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Usuarios</Title><Text c="dimmed" size="sm">Cuentas de acceso al panel de administración</Text></div></div>
        <Button leftSection={<IconPlus size={16} />} onClick={() => { setF({ role: 'admin' }); open(); }}>Nuevo usuario</Button></Group>
      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md">
          <Text fw={600}>{list.length} cuentas</Text>
          <TextInput placeholder="Buscar usuario" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={220} />
        </Group>
        {loading ? <TableSkeleton rows={4} cols={5} /> :
          fl.length === 0 ? <Text c="dimmed" ta="center" py="xl">{q ? 'Sin resultados.' : 'Sin usuarios.'}</Text> :
            <Table.ScrollContainer minWidth={560}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr><Th icon={<IconUser size={13} />}>Usuario</Th><Th icon={<IconId size={13} />}>Nombre</Th><Th icon={<IconShieldCheck size={13} />}>Rol</Th><Th icon={<IconCalendar size={13} />}>Creado</Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>{fl.map(u => (
                  <Table.Tr key={u.id}>
                    <Table.Td ff="monospace" fw={600}>{u.username}</Table.Td><Table.Td>{u.name}</Table.Td>
                    <Table.Td><Badge variant="light" color={roleColor(u.role)}>{roleLabel(u.role)}</Badge></Table.Td>
                    <Table.Td>{u.created_at ? new Date(u.created_at).toLocaleDateString('es-UY') : '—'}</Table.Td>
                    <Table.Td ta="right"><Group gap={4} justify="flex-end">
                      <Tooltip label="Cambiar contraseña"><ActionIcon variant="subtle" color="gray" onClick={() => { setPwTarget(u); setPw(''); openPw(); }}><IconKey size={17} /></ActionIcon></Tooltip>
                      {u.username !== 'admin' && <Tooltip label="Eliminar"><ActionIcon variant="subtle" color="red" onClick={() => del(u)}><IconTrash size={17} /></ActionIcon></Tooltip>}
                    </Group></Table.Td>
                  </Table.Tr>
                ))}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
      </Card>
      <Modal opened={opened} onClose={close} title="Nuevo usuario" centered radius="lg">
        <Stack>
          <TextInput label="Usuario" placeholder="operador1" value={f.username || ''} onChange={e => up('username', e.target.value)} required />
          <TextInput label="Nombre completo" value={f.name || ''} onChange={e => up('name', e.target.value)} />
          <PasswordInput label="Contraseña" value={f.password || ''} onChange={e => up('password', e.target.value)} required />
          <Select label="Rol" data={ROLES} value={f.role} onChange={v => up('role', v)} />
          <Button onClick={create} mt="xs">Crear usuario</Button>
        </Stack>
      </Modal>
      <Modal opened={pwOpen} onClose={closePw} title={`Cambiar contraseña · ${pwTarget?.username || ''}`} centered radius="lg">
        <Stack>
          <PasswordInput label="Nueva contraseña" value={pw} onChange={e => setPw(e.target.value)} required />
          <Button onClick={resetPw} mt="xs">Actualizar</Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
