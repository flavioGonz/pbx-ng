'use client';
import { useState } from 'react';
import { Stack, Title, Text, Card, Group, Button, Table, Badge, TextInput, PasswordInput, Select, ActionIcon, Tooltip, ThemeIcon, Alert } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconTrash, IconKey, IconSearch, IconUser, IconId, IconShieldCheck, IconCalendar } from '@tabler/icons-react';
import { toast } from '../notify';
import { TableSkeleton } from '../Skeletons';
import { apiPost, apiDel, useApi } from '../api';
import { fmtFecha } from '../fmt';
import DrawerNG, { BloqueNG } from '../DrawerNG';
import { IcoPersona, IcoLlave } from '../IconosNG';
/* Mismos roles que control-plane/rbac.js (docs/CONTRATOS.md §2). Los viejos 'operator' y
 * 'viewer' ya no existen en la API: un usuario con ese rol guardado se muestra con la
 * etiqueta cruda (roleLabel) para que el admin lo vea y lo corrija. */
const ROLES = [{ value: 'admin', label: 'Administrador' }, { value: 'supervisor', label: 'Supervisor' }, { value: 'agente', label: 'Agente' }];
// Por defecto el rol MENOS privilegiado: crear administradores tiene que ser una decisión explícita.
const ROL_DEFAULT = 'agente';
const PASS_MIN = 8;

const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
export default function Usuarios() {
  const { data: usuarios, cargando: loading, recargar: load } = useApi('/users');
  const list = Array.isArray(usuarios) ? usuarios : [];
  const [q, setQ] = useState('');
  const [opened, { open, close }] = useDisclosure(false);
  const [pwOpen, { open: openPw, close: closePw }] = useDisclosure(false);
  const [f, setF] = useState({ role: ROL_DEFAULT }); const [pwTarget, setPwTarget] = useState(null); const [pw, setPw] = useState('');
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  async function create() {
    if (!f.password || f.password.length < PASS_MIN) { toast(`La contraseña debe tener al menos ${PASS_MIN} caracteres`, 'bad'); return; }
    try {
      const r = await apiPost('/users', f);
      toast('Usuario ' + ((r && r.created) || f.username) + ' creado', 'ok');
      setF({ role: ROL_DEFAULT }); close(); load();
    } catch (e) { toast('Error: ' + e.message, 'bad'); }
  }
  async function del(u) {
    if (!confirm('¿Eliminar el usuario ' + u.username + '?')) return;
    try { await apiDel('/users/' + u.id); toast('Usuario eliminado', 'info'); load(); }
    catch (e) { toast('Error: ' + e.message, 'bad'); }
  }
  async function resetPw() {
    if (pw.length < PASS_MIN) { toast(`La contraseña debe tener al menos ${PASS_MIN} caracteres`, 'bad'); return; }
    try {
      await apiPost('/users/' + pwTarget.id + '/password', { password: pw });
      toast('Contraseña actualizada', 'ok'); setPw(''); closePw();
    } catch (e) { toast('Error: ' + e.message, 'bad'); }
  }
  const roleLabel = (r) => (ROLES.find(x => x.value === r) || {}).label || r;
  const roleColor = (r) => r === 'admin' ? 'pbx' : r === 'supervisor' ? 'teal' : r === 'agente' ? 'blue' : 'gray';
  const fl = list.filter(u => !q || u.username.toLowerCase().includes(q.toLowerCase()) || (u.name || '').toLowerCase().includes(q.toLowerCase()));
  return (
    <Stack gap="lg">
      <Group justify="space-between"><div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-indigo-5),var(--mantine-color-indigo-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'indigo.5', to: 'indigo.8', deg: 135 }}><IconKey size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Usuarios</Title><Text c="dimmed" size="sm">Cuentas de acceso al panel de administración</Text></div></div>
        <Button leftSection={<IconPlus size={16} />} onClick={() => { setF({ role: ROL_DEFAULT }); open(); }}>Nuevo usuario</Button></Group>
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
                    <Table.Td>{fmtFecha(u.created_at)}</Table.Td>
                    <Table.Td ta="right"><Group gap={4} justify="flex-end">
                      <Tooltip label="Cambiar contraseña"><ActionIcon variant="subtle" color="gray" onClick={() => { setPwTarget(u); setPw(''); openPw(); }}><IconKey size={17} /></ActionIcon></Tooltip>
                      {u.username !== 'admin' && <Tooltip label="Eliminar"><ActionIcon variant="subtle" color="red" onClick={() => del(u)}><IconTrash size={17} /></ActionIcon></Tooltip>}
                    </Group></Table.Td>
                  </Table.Tr>
                ))}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
      </Card>
      {/* Alta de usuario y cambio de contraseña: dos cajones, no dos modales. La lista de
          cuentas queda a la izquierda mientras se crea una —que es donde uno mira si el
          nombre de usuario ya existe— y el botón de guardar no se va con el scroll. */}
      <DrawerNG
        opened={opened} onClose={close} ancho={480}
        icono={<IcoPersona s={24} />} titulo="Nuevo usuario"
        subtitulo="Una cuenta para entrar al panel de administración"
        solapas={[{
          value: 'cuenta', label: 'Cuenta',
          contenido: (
            <>
              <BloqueNG icon={<IconUser size={16} />} titulo="Quién es"
                ayuda="El usuario es con lo que entra al panel y lo que queda registrado en la auditoría: conviene que sea una persona, no un puesto compartido.">
                <TextInput label="Usuario" placeholder="operador1" value={f.username || ''} onChange={e => up('username', e.target.value)} required />
                <TextInput label="Nombre completo" value={f.name || ''} onChange={e => up('name', e.target.value)} />
              </BloqueNG>
              <BloqueNG icon={<IcoLlave s={16} />} titulo="Acceso"
                ayuda="El rol decide qué puede tocar. Por defecto se crea como agente —el menos privilegiado—: dar administrador tiene que ser una decisión, no un descuido.">
                <PasswordInput label="Contraseña" description={`Mínimo ${PASS_MIN} caracteres`} value={f.password || ''} onChange={e => up('password', e.target.value)} required />
                <Select label="Rol" data={ROLES} value={f.role} onChange={v => up('role', v)} />
                {f.role === 'admin' && (
                  <Alert variant="light" color="orange" icon={<IconShieldCheck size={15} />} py={8}>
                    <Text size="xs">Un administrador puede cambiar troncales, internos y la configuración de la central, y crear otros administradores.</Text>
                  </Alert>
                )}
              </BloqueNG>
            </>
          ),
        }]}
        pie={
          <Group justify="space-between">
            <Button variant="subtle" color="gray" onClick={close}>Cancelar</Button>
            <Button onClick={create} leftSection={<IconPlus size={16} />}>Crear usuario</Button>
          </Group>
        }
      />
      <DrawerNG
        opened={pwOpen} onClose={closePw} ancho={440} color="gray"
        icono={<IcoLlave s={24} />} titulo="Cambiar contraseña"
        subtitulo={pwTarget ? 'Cuenta ' + pwTarget.username : ''}
        solapas={[{
          value: 'clave', label: 'Contraseña',
          contenido: (
            <BloqueNG icon={<IcoLlave s={16} />} titulo="Nueva contraseña"
              ayuda="La contraseña anterior no se muestra ni se recupera: se reemplaza. La sesión abierta de esa persona sigue viva hasta que venza.">
              <PasswordInput label="Nueva contraseña" description={`Mínimo ${PASS_MIN} caracteres`} value={pw} onChange={e => setPw(e.target.value)} required />
            </BloqueNG>
          ),
        }]}
        pie={
          <Group justify="space-between">
            <Button variant="subtle" color="gray" onClick={closePw}>Cancelar</Button>
            <Button onClick={resetPw} leftSection={<IconKey size={16} />}>Actualizar</Button>
          </Group>
        }
      />
    </Stack>
  );
}
