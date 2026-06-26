'use client';
import { useEffect, useState } from 'react';
import { Card, Table, Title, Text, Stack, Badge, Group, Button, TextInput, SegmentedControl, ActionIcon, Tooltip, SimpleGrid, ThemeIcon } from '@mantine/core';
import { IconRefresh, IconSearch, IconDownload, IconPlayerPlay, IconPhone, IconPhoneCheck, IconPhoneX, IconClock, IconCalendar, IconArrowUpRight, IconArrowDownLeft, IconCircleCheck, IconMicrophone2 } from '@tabler/icons-react';
import { TableSkeleton } from '../Skeletons';
import PageHeader from '../PageHeader';
const dispColor = (d) => d === 'ANSWERED' ? 'teal' : d === 'NO ANSWER' ? 'yellow' : d === 'BUSY' ? 'orange' : 'gray';
const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;

export default function Historial() {
  const [rows, setRows] = useState([]); const [recs, setRecs] = useState([]); const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(''); const [filt, setFilt] = useState('all');
  async function load() {
    try { const d = await fetch('/backend/api/cdr?limit=200').then(r => r.json()); setRows(Array.isArray(d) ? d : []); } catch (_) { setRows([]); }
    try { const d = await fetch('/backend/api/recordings').then(r => r.json()); setRecs(Array.isArray(d) ? d : []); } catch (_) {}
    setLoading(false);
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  // match grabación por interno (src/dst) y ventana temporal
  const recFor = (r) => {
    const start = r.start ? new Date(r.start).getTime() : 0; if (!start) return null;
    const end = start + ((r.duration || 0) + 15) * 1000;
    return recs.find(rec => {
      if (!rec.started_at) return false;
      const rt = new Date(rec.started_at).getTime();
      const okExt = rec.ext && (rec.ext === String(r.src) || rec.ext === String(r.dst));
      return okExt && rt >= start - 5000 && rt <= end;
    });
  };

  const fr = rows.filter(r => (filt === 'all' || r.disposition === filt) && (!q || String(r.src || '').includes(q) || String(r.dst || '').includes(q)));
  const answered = rows.filter(r => r.disposition === 'ANSWERED').length;
  const noans = rows.length - answered;
  const talkMin = Math.round(rows.reduce((a, r) => a + (r.billsec || 0), 0) / 60);
  const today = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return rows.filter(r => r.start && new Date(r.start) >= d).length; })();
  const kpis = [{ k: 'Llamadas', v: rows.length, icon: IconPhone, c: 'pbx' }, { k: 'Atendidas', v: answered, icon: IconPhoneCheck, c: 'teal' }, { k: 'Sin respuesta', v: noans, icon: IconPhoneX, c: 'orange' }, { k: 'Minutos hablados', v: talkMin, icon: IconClock, c: 'grape' }, { k: 'Hoy', v: today, icon: IconCalendar, c: 'blue' }];

  function exportCSV() {
    const head = ['Fecha', 'Origen', 'Destino', 'Duracion_s', 'Hablado_s', 'Resultado'];
    const lines = [head.join(',')].concat(fr.map(r => [
      r.start ? new Date(r.start).toISOString() : '', r.src || '', r.dst || '', r.duration || 0, r.billsec || 0, r.disposition || ''
    ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'cdr-pbxng-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconPhone size={24} />} title="Historial de llamadas" subtitle="Registros CDR · se actualiza solo" color="cyan"
        right={<>
          <Button variant="light" leftSection={<IconDownload size={16} />} onClick={exportCSV} disabled={!fr.length}>Exportar CSV</Button>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>Recargar</Button>
        </>} />
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="md">
        {kpis.map(x => (
          <Card key={x.k} withBorder radius="lg" padding="md" shadow="sm">
            <Group gap="sm" wrap="nowrap"><ThemeIcon size={40} radius="md" variant="light" color={x.c}><x.icon size={20} /></ThemeIcon><div><Text fw={800} fz={24} lh={1}>{x.v}</Text><Text size="xs" c="dimmed">{x.k}</Text></div></Group>
          </Card>
        ))}
      </SimpleGrid>
      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md">
          <SegmentedControl size="xs" value={filt} onChange={setFilt} data={[{ value: 'all', label: 'Todas' }, { value: 'ANSWERED', label: 'Atendidas' }, { value: 'NO ANSWER', label: 'Sin respuesta' }, { value: 'BUSY', label: 'Ocupado' }]} />
          <TextInput placeholder="Buscar origen / destino" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={240} />
        </Group>
        {loading ? <TableSkeleton rows={8} cols={7} /> :
          fr.length === 0 ? <Text c="dimmed" ta="center" py="xl">{rows.length ? 'Sin resultados.' : 'Aún no hay llamadas registradas.'}</Text> :
            <Table.ScrollContainer minWidth={760}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr><Th icon={<IconCalendar size={13} />}>Fecha</Th><Th icon={<IconArrowUpRight size={13} />}>Origen</Th><Th icon={<IconArrowDownLeft size={13} />}>Destino</Th><Th icon={<IconClock size={13} />}>Duración</Th><Th icon={<IconClock size={13} />}>Hablado</Th><Th icon={<IconCircleCheck size={13} />}>Resultado</Th><Th icon={<IconMicrophone2 size={13} />}>Grabación</Th></Table.Tr></Table.Thead>
                <Table.Tbody>{fr.map((r, i) => { const rec = recFor(r); return (
                  <Table.Tr key={i}><Table.Td>{r.start ? new Date(r.start).toLocaleString('es-UY') : '—'}</Table.Td>
                    <Table.Td ff="monospace">{r.src}</Table.Td><Table.Td ff="monospace">{r.dst}</Table.Td>
                    <Table.Td>{r.duration}s</Table.Td><Table.Td>{r.billsec}s</Table.Td>
                    <Table.Td><Badge variant="light" color={dispColor(r.disposition)}>{r.disposition}</Badge></Table.Td>
                    <Table.Td>{rec
                      ? <Group gap={4} wrap="nowrap"><Tooltip label="Reproducir"><ActionIcon variant="subtle" component="a" href={'/backend/api/recordings/' + rec.id + '/audio'} target="_blank"><IconPlayerPlay size={16} /></ActionIcon></Tooltip><audio controls preload="none" style={{ height: 28, maxWidth: 150 }} src={'/backend/api/recordings/' + rec.id + '/audio'} /></Group>
                      : <Text c="dimmed" size="xs">—</Text>}</Table.Td></Table.Tr>
                ); })}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
      </Card>
    </Stack>
  );
}
