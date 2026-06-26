'use client';
import { useEffect, useState } from 'react';
import { Card, Title, Text, Stack, SegmentedControl, Group, Code, Button, Table, Badge, Switch, TextInput, ThemeIcon } from '@mantine/core';
import { IconRefresh, IconSearch, IconTerminal2, IconRoute, IconHash, IconApps } from '@tabler/icons-react';
import { TableSkeleton } from '../Skeletons';

const APPC = { Dial: 'teal', Hangup: 'gray', NoOp: 'gray', Answer: 'blue', Goto: 'violet', Queue: 'orange', ConfBridge: 'grape', Playback: 'cyan', Background: 'cyan', Page: 'orange', VoiceMail: 'indigo', Set: 'blue', Authenticate: 'red' };

function parseDialplan(txt) {
  const rows = []; let cur = null;
  for (const line of String(txt).split('\n')) {
    let m = /^\s*'([^']+)'\s*=>\s*(\d+)\.\s*(.+?)\s*(\[[^\]]*\])?\s*$/.exec(line);
    if (m) { cur = m[1]; rows.push({ exten: cur, prio: m[2], call: m[3].trim() }); continue; }
    m = /^\s*(\d+)\.\s*(.+?)\s*(\[[^\]]*\])?\s*$/.exec(line);
    if (m && cur) { rows.push({ exten: '', prio: m[1], call: m[2].trim() }); }
  }
  return rows.map(r => { const a = /^([\w]+)\((.*)\)\s*$/.exec(r.call); return { ...r, app: a ? a[1] : r.call, data: a ? a[2] : '' }; });
}


const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
export default function Dialplan() {
  const [ctx, setCtx] = useState('internal'); const [out, setOut] = useState(''); const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState(false); const [q, setQ] = useState('');
  async function load(c) { setLoading(true); try { const r = await fetch('/backend/api/dialplan?context=' + c).then(x => x.json()); setOut(r.output || r.error || ''); } catch (_) { setOut('Error'); } setLoading(false); }
  useEffect(() => { load(ctx); }, [ctx]);
  const rows = parseDialplan(out);
  const fr = rows.filter(r => !q || (r.exten || '').includes(q) || r.app.toLowerCase().includes(q.toLowerCase()) || (r.data || '').toLowerCase().includes(q.toLowerCase()));
  const exCount = new Set(rows.map(r => r.exten).filter(Boolean)).size;

  return (
    <Stack gap="lg">
      <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-cyan-5),var(--mantine-color-cyan-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'cyan.5', to: 'cyan.8', deg: 135 }}><IconTerminal2 size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Dialplan</Title><Text c="dimmed" size="sm">Plan de marcado activo · estático + realtime (PostgreSQL)</Text></div></div>
      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md" wrap="wrap">
          <Group gap="sm">
            <SegmentedControl value={ctx} onChange={setCtx} data={[{ label: 'internal', value: 'internal' }, { label: 'ivr', value: 'ivr' }, { label: 'from-trunk', value: 'from-trunk' }, { label: 'default', value: 'default' }]} />
            <Badge variant="light" color="pbx" leftSection={<IconRoute size={12} />}>{exCount} extensiones</Badge>
          </Group>
          <Group gap="sm">
            {!raw && <TextInput placeholder="Buscar extensión / app" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={220} />}
            <Switch label="Texto crudo" checked={raw} onChange={e => setRaw(e.currentTarget.checked)} />
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => load(ctx)}>Recargar</Button>
          </Group>
        </Group>

        {loading ? <TableSkeleton rows={8} cols={4} /> :
          raw ? <Code block style={{ maxHeight: '62vh', overflow: 'auto', fontSize: 12.5, lineHeight: 1.6 }}>{out || 'Sin datos'}</Code> :
            rows.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin reglas en el contexto “{ctx}”.</Text> :
              <Table.ScrollContainer minWidth={640}>
                <Table highlightOnHover verticalSpacing={6} withRowBorders={false}>
                  <Table.Thead><Table.Tr><Th icon={<IconRoute size={13} />}>Extensión</Th><Th icon={<IconHash size={13} />}>#</Th><Th icon={<IconApps size={13} />}>Aplicación</Th><Th icon={<IconTerminal2 size={13} />}>Datos</Th></Table.Tr></Table.Thead>
                  <Table.Tbody>{fr.map((r, i) => (
                    <Table.Tr key={i} style={{ borderTop: r.exten ? '1px solid var(--mantine-color-gray-2)' : 'none' }}>
                      <Table.Td ff="monospace" fw={700} c={r.exten ? undefined : 'dimmed'}>{r.exten || ''}</Table.Td>
                      <Table.Td c="dimmed" fz="xs">{r.prio}</Table.Td>
                      <Table.Td><Badge size="sm" variant="light" color={APPC[r.app] || 'blue'}>{r.app}</Badge></Table.Td>
                      <Table.Td ff="monospace" fz="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>{r.data || '—'}</Table.Td>
                    </Table.Tr>
                  ))}</Table.Tbody>
                </Table>
              </Table.ScrollContainer>}
      </Card>
    </Stack>
  );
}
