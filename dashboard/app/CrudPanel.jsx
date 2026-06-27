'use client';
import { useEffect, useState } from 'react';
import { Card, Group, Title, Text, Button, Table, Modal, TextInput, PasswordInput, Select, Textarea, Switch, Stack, ActionIcon, ThemeIcon, Divider } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconTrash, IconSearch, IconPencil } from '@tabler/icons-react';
import { toast } from './notify';
import { TableSkeleton } from './Skeletons';

function Field({ f, value, up }) {
  const common = { label: f.label, description: f.description, required: f.required, leftSection: f.icon, value: value ?? '', onChange: (e) => up(f.name, e.currentTarget.value) };
  if (f.type === 'select') return <Select label={f.label} description={f.description} leftSection={f.icon} data={f.data} value={value || f.data?.[0]?.value} onChange={(v) => up(f.name, v)} required={f.required} />;
  if (f.type === 'textarea') return <Textarea label={f.label} description={f.description} placeholder={f.placeholder} value={value || ''} onChange={e => up(f.name, e.currentTarget.value)} required={f.required} autosize minRows={3} maxRows={8} />;
  if (f.type === 'switch') return <Switch label={f.label} description={f.description} checked={value !== false} onChange={e => up(f.name, e.currentTarget.checked)} />;
  if (f.type === 'password') return <PasswordInput {...common} placeholder={f.placeholder} />;
  return <TextInput {...common} placeholder={f.placeholder} />;
}

export default function CrudPanel({ title, subtitle, fetchUrl, columns, fields, createUrl, idKey, deleteUrl, emptyText = 'Sin registros.', icon, color = 'pbx' }) {
  const [list, setList] = useState([]); const [opened, { open, close }] = useDisclosure(false);
  const [form, setForm] = useState({}); const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true); const [q, setQ] = useState('');
  async function load() { try { const d = await fetch(fetchUrl).then(r => r.json()); setList(Array.isArray(d) ? d : []); } catch (_) { setList([]); } setLoading(false); }
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [fetchUrl]);
  const up = (k, v) => setForm(s => ({ ...s, [k]: v }));
  async function submit() {
    setSaving(true);
    try {
      const r = await fetch(createUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }).then(x => x.json());
      if (r.error) toast('Error: ' + r.error, 'bad');
      else { toast((title || 'Registro') + ' creado', 'ok'); setForm({}); close(); load(); }
    } catch (e) { toast('Error de red', 'bad'); } finally { setSaving(false); }
  }
  async function del(row) {
    if (!confirm('¿Eliminar este registro?')) return;
    await fetch(deleteUrl(row), { method: 'DELETE' }); toast('Eliminado', 'info'); load();
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
          <Button leftSection={<IconPlus size={16} />} onClick={() => { setForm({}); open(); }}>Nuevo</Button>
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
                    <Table.Td ta="right"><ActionIcon variant="subtle" color="red" onClick={() => del(row)}><IconTrash size={17} /></ActionIcon></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>}
      <Modal opened={opened} onClose={close} centered radius="lg" size="lg"
        title={<Group gap="sm"><ThemeIcon size={38} radius="md" variant="light" color={color}>{icon || <IconPlus size={20} />}</ThemeIcon><div><Text fw={800} lh={1.1}>Nuevo · {title || ''}</Text>{subtitle && <Text size="xs" c="dimmed">{subtitle}</Text>}</div></Group>}>
        <Stack gap="md">
          {fields.map(f => <Field key={f.name} f={f} value={form[f.name]} up={up} />)}
          <Divider />
          <Group justify="flex-end"><Button variant="default" onClick={close}>Cancelar</Button><Button onClick={submit} loading={saving} leftSection={<IconPlus size={16} />}>Crear</Button></Group>
        </Stack>
      </Modal>
    </Card>
  );
}
