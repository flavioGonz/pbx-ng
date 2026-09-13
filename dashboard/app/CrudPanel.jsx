'use client';
import { useEffect, useState } from 'react';
import { Card, Group, Title, Text, Button, Table, Modal, TextInput, PasswordInput, Select, Textarea, Switch, Stack, ActionIcon, ThemeIcon, Divider } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconTrash, IconSearch, IconPencil } from '@tabler/icons-react';
import { toast } from './notify';
import { apiDel, apiPost, apiPut, usePoll } from './api';
import { TableSkeleton } from './Skeletons';

function Field({ f, value, up }) {
  const common = { label: f.label, description: f.description, required: f.required, leftSection: f.icon, value: value ?? '', onChange: (e) => up(f.name, e.currentTarget.value) };
  if (f.type === 'select') return <Select label={f.label} description={f.description} leftSection={f.icon} data={f.data} value={value || f.data?.[0]?.value} onChange={(v) => up(f.name, v)} required={f.required} />;
  if (f.type === 'textarea') return <Textarea label={f.label} description={f.description} placeholder={f.placeholder} value={value || ''} onChange={e => up(f.name, e.currentTarget.value)} required={f.required} autosize minRows={3} maxRows={8} />;
  if (f.type === 'switch') return <Switch label={f.label} description={f.description} checked={value !== false} onChange={e => up(f.name, e.currentTarget.checked)} />;
  if (f.type === 'password') return <PasswordInput {...common} placeholder={f.placeholder} />;
  return <TextInput {...common} placeholder={f.placeholder} />;
}

/* `fetchUrl` / `createUrl` / `deleteUrl(row)` son rutas de la API SIN el prefijo
   `/backend/api` (lo arma `app/api.js`): '/ringgroups', '/routes/inbound/12'…

   `editUrl(row)` es OPCIONAL y, cuando está, la tabla deja editar: aparece el lápiz,
   el formulario se abre con la fila cargada y se guarda con PUT a esa ruta. Antes
   todo lo que usa este panel era crear-y-borrar, que para una ruta entrante con
   horario significaba borrarla y rehacerla (y perder el DID unos segundos).
   `rowToForm(row)` adapta la fila al formulario (por ejemplo un id numérico que el
   Select necesita como texto). */
export default function CrudPanel({ title, subtitle, fetchUrl, columns, fields, createUrl, idKey, deleteUrl, editUrl, rowToForm, emptyText = 'Sin registros.', icon, color = 'pbx' }) {
  const [opened, { open, close }] = useDisclosure(false);
  const [form, setForm] = useState({}); const [saving, setSaving] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [q, setQ] = useState('');
  /* Esta tabla es siempre CONFIGURACIÓN (ring groups, rutas, códigos…): la cambia una
   * persona desde este mismo panel, y cuando la cambia acá se llama a `load()` a mano.
   * El poll es sólo por si la tocó otro operador en otra pestaña, así que 30 s sobra;
   * a 6 s cada pantalla CRUD abierta eran 10 pedidos por minuto para nada. */
  const { data, error, cargando: loading, recargar: load } = usePoll(fetchUrl, 30000);
  const list = Array.isArray(data) ? data : [];
  useEffect(() => { if (error) toast(error.message, 'bad'); }, [error]);
  const up = (k, v) => setForm(s => ({ ...s, [k]: v }));
  function openEdit(row) {
    setEditRow(row);
    setForm(rowToForm ? rowToForm(row) : { ...row });
    open();
  }
  async function submit() {
    setSaving(true);
    try {
      if (editRow) await apiPut(editUrl(editRow), form);
      else await apiPost(createUrl, form);
      toast((title || 'Registro') + (editRow ? ' guardado' : ' creado'), 'ok');
      setForm({}); setEditRow(null); close(); load();
    } catch (e) {
      /* Una API vieja no tiene el PUT y contesta 404/405: decirlo así evita que el
       * usuario crea que el dato que escribió está mal. */
      const viejo = editRow && (e.status === 404 || e.status === 405);
      toast(viejo ? 'Esta versión de la API todavía no permite editar acá' : 'Error: ' + e.message, 'bad',
        viejo ? { description: 'Actualizá la central o borrá y volvé a crear el registro.' } : undefined);
    } finally { setSaving(false); }
  }
  async function del(row) {
    if (!confirm('¿Eliminar este registro?')) return;
    try { await apiDel(deleteUrl(row)); toast('Eliminado', 'info'); load(); }
    catch (e) { toast(e.message, 'bad'); }
  }
  const fl = list.filter(row => !q || columns.some(c => String(row[c.key] ?? '').toLowerCase().includes(q.toLowerCase())));
  return (
    <Card withBorder radius="lg" padding="lg">
      <Group justify="space-between" mb="md">
        <Group gap={10} wrap="nowrap">
          {icon && <ThemeIcon size={32} radius="md" variant="light" color={color}>{icon}</ThemeIcon>}
          <div>{title && <Title order={4} lh={1.15}>{title}</Title>}{subtitle && <Text size="sm" c="dimmed">{subtitle}</Text>}</div>
        </Group>
        <Group gap="sm">
          <TextInput placeholder="Buscar" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={200} />
          <Button leftSection={<IconPlus size={16} />} onClick={() => { setForm({}); setEditRow(null); open(); }}>Nuevo</Button>
        </Group>
      </Group>
      {loading ? <TableSkeleton rows={5} cols={columns.length + 1} /> :
        fl.length === 0 ? <Text c="dimmed" ta="center" py="xl">{q ? 'Sin resultados.' : emptyText}</Text> :
          <Table.ScrollContainer minWidth={500}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr>{columns.map(c => <Table.Th key={c.key}><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}>{c.icon && <span style={{ opacity: .55, display: 'flex' }}>{c.icon}</span>}{c.label}</Group></Table.Th>)}<Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {fl.map(row => (
                  <Table.Tr key={row[idKey]}>
                    {columns.map(c => <Table.Td key={c.key}>{c.render ? c.render(row) : (c.mono ? <Text ff="monospace" fw={600}>{row[c.key]}</Text> : (row[c.key] ?? '—'))}</Table.Td>)}
                    <Table.Td ta="right">
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        {editUrl && <ActionIcon variant="subtle" color="blue" onClick={() => openEdit(row)}><IconPencil size={17} /></ActionIcon>}
                        <ActionIcon variant="subtle" color="red" onClick={() => del(row)}><IconTrash size={17} /></ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>}
      <Modal opened={opened} onClose={() => { setEditRow(null); close(); }} centered radius="lg" size="lg"
        title={<Group gap="sm"><ThemeIcon size={38} radius="md" variant="light" color={color}>{icon || <IconPlus size={20} />}</ThemeIcon><div><Text fw={800} lh={1.1}>{editRow ? 'Editar' : 'Nuevo'} · {title || ''}</Text>{subtitle && <Text size="xs" c="dimmed">{subtitle}</Text>}</div></Group>}>
        <Stack gap="md">
          {fields.map(f => <Field key={f.name} f={f} value={form[f.name]} up={up} />)}
          <Divider />
          <Group justify="flex-end"><Button variant="default" onClick={() => { setEditRow(null); close(); }}>Cancelar</Button><Button onClick={submit} loading={saving} leftSection={editRow ? <IconPencil size={16} /> : <IconPlus size={16} />}>{editRow ? 'Guardar cambios' : 'Crear'}</Button></Group>
        </Stack>
      </Modal>
    </Card>
  );
}
