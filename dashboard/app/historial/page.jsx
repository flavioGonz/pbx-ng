'use client';
import { useEffect, useMemo, useState, Fragment } from 'react';
import { Card, Table, Text, Stack, Badge, Group, Button, TextInput, Tabs, ActionIcon, Tooltip, SimpleGrid, ThemeIcon } from '@mantine/core';
import { IconRefresh, IconSearch, IconDownload, IconPlayerPlay, IconPlayerPause, IconPhone, IconPhoneCheck, IconPhoneX, IconClock, IconCalendar, IconArrowUpRight, IconArrowDownLeft, IconArrowsLeftRight, IconCircleCheck, IconMicrophone2, IconRobot, IconArrowsSplit, IconWorld, IconDeviceLandlinePhone, IconRouteAltLeft, IconList } from '@tabler/icons-react';
import { TableSkeleton } from '../Skeletons';
import PageHeader from '../PageHeader';
import { useLive } from '../useLive';
import Slot from '../Slot';
import RecordingPlayer from '../RecordingPlayer';

const dispColor = (d) => d === 'ANSWERED' ? 'teal' : d === 'NO ANSWER' ? 'yellow' : d === 'BUSY' ? 'orange' : d === 'FAILED' ? 'red' : 'gray';
const dispLabel = (d) => ({ ANSWERED: 'Atendida', 'NO ANSWER': 'Sin respuesta', BUSY: 'Ocupado', FAILED: 'Fallida', CONGESTION: 'Congestión' }[d] || d || '—');
const TYPES = {
  inbound: { label: 'Entrante', color: 'blue', icon: IconArrowDownLeft },
  outbound: { label: 'Saliente', color: 'grape', icon: IconArrowUpRight },
  internal: { label: 'Interna', color: 'gray', icon: IconArrowsLeftRight },
  ivr: { label: 'IVR', color: 'orange', icon: IconArrowsSplit },
  ia: { label: 'Agente IA', color: 'pink', icon: IconRobot },
  other: { label: 'Otra', color: 'gray', icon: IconPhone },
};
const MEDIA = {
  web: { label: 'WebRTC', color: 'teal', icon: IconWorld },
  sip: { label: 'SIP', color: 'blue', icon: IconDeviceLandlinePhone },
  troncal: { label: 'Troncal', color: 'indigo', icon: IconRouteAltLeft },
  ia: { label: 'IA', color: 'pink', icon: IconRobot },
};
const fmtDur = (s) => { s = s || 0; const m = Math.floor(s / 60), ss = s % 60; return m ? `${m}m ${ss}s` : `${ss}s`; };
const clidName = (clid) => { if (!clid) return ''; const m = clid.match(/"?([^"<]*)"?\s*<?/); const n = (m && m[1] || '').trim(); return n && !/^\d+$/.test(n) ? n : ''; };
const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;

export default function Historial() {
  const { snap } = useLive();
  const [rows, setRows] = useState([]); const [recs, setRecs] = useState([]); const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(''); const [tab, setTab] = useState('all'); const [playId, setPlayId] = useState(null); const [shown, setShown] = useState(80);
  async function load() {
    try { const d = await fetch('/backend/api/cdr?limit=300').then(r => r.json()); setRows(Array.isArray(d) ? d : []); } catch (_) { setRows([]); }
    try { const d = await fetch('/backend/api/recordings').then(r => r.json()); setRecs(Array.isArray(d) ? d : []); } catch (_) {}
    setLoading(false);
  }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  useEffect(() => { setShown(80); }, [tab, q]);

  const eps = snap?.extensions || [];
  const internalSet = useMemo(() => new Set(eps.map(e => String(e.id))), [eps]);
  const webrtcSet = useMemo(() => new Set(eps.filter(e => e.webrtc).map(e => String(e.id))), [eps]);

  const typeOf = (r) => {
    const la = (r.lastapp || '').toLowerCase(); const chans = ((r.channel || '') + ' ' + (r.dstchannel || '')).toLowerCase(); const dc = (r.dcontext || '').toLowerCase();
    const src = String(r.src || ''); const dst = String(r.dst || '');
    if (la === 'stasis' || chans.includes('audiosocket') || dc.includes('ai') || dc.includes('c2c')) return 'ia';
    if (dc.includes('ivr') || /^7[0-9]{3}$/.test(dst)) return 'ivr';
    const sInt = internalSet.has(src), dInt = internalSet.has(dst);
    const dstLong = dst.replace(/[^0-9]/g, '').length >= 6; const srcLong = src.replace(/[^0-9]/g, '').length >= 6;
    if (dc.includes('trunk') || (!sInt && dInt) || (!sInt && srcLong && dInt)) return 'inbound';
    if (sInt && !dInt && dstLong) return 'outbound';
    if (sInt && dInt) return 'internal';
    if (sInt || dInt) return 'internal';
    return 'other';
  };
  const mediumOf = (r, t) => {
    if (t === 'ia') return 'ia';
    if (t === 'inbound' || t === 'outbound') return 'troncal';
    if (webrtcSet.has(String(r.src)) || webrtcSet.has(String(r.dst))) return 'web';
    return 'sip';
  };

  const enriched = useMemo(() => rows.map(r => { const t = typeOf(r); return { ...r, _t: t, _m: mediumOf(r, t) }; }), [rows, internalSet, webrtcSet]);

  const recIndex = useMemo(() => { const m = new Map(); for (const rec of recs) { if (!rec.ext || !rec.started_at) continue; const k = String(rec.ext); if (!m.has(k)) m.set(k, []); m.get(k).push({ rec, t: new Date(rec.started_at).getTime() }); } return m; }, [recs]);
  const recFor = (r) => {
    const start = r.start ? new Date(r.start).getTime() : 0; if (!start) return null;
    const end = start + ((r.duration || 0) + 15) * 1000;
    const cand = (recIndex.get(String(r.src)) || []).concat(recIndex.get(String(r.dst)) || []);
    const hit = cand.find(x => x.t >= start - 5000 && x.t <= end);
    return hit ? hit.rec : null;
  };

  const fr = useMemo(() => enriched.filter(r => {
    const okTab = tab === 'all' ? true : tab === 'missed' ? r.disposition !== 'ANSWERED' : r._t === tab;
    const okQ = !q || String(r.src || '').includes(q) || String(r.dst || '').includes(q) || (r.clid || '').toLowerCase().includes(q.toLowerCase());
    return okTab && okQ;
  }), [enriched, tab, q]);
  const counts = useMemo(() => { const c = { all: enriched.length, missed: 0 }; for (const r of enriched) { if (r.disposition !== 'ANSWERED') c.missed++; c[r._t] = (c[r._t] || 0) + 1; } return c; }, [enriched]);

  const answered = rows.filter(r => r.disposition === 'ANSWERED').length;
  const talkMin = Math.round(rows.reduce((a, r) => a + (r.billsec || 0), 0) / 60);
  const today = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return rows.filter(r => r.start && new Date(r.start) >= d).length; })();
  const kpis = [{ k: 'Llamadas', v: rows.length, icon: IconPhone, c: 'cyan' }, { k: 'Atendidas', v: answered, icon: IconPhoneCheck, c: 'teal' }, { k: 'Sin respuesta', v: rows.length - answered, icon: IconPhoneX, c: 'orange' }, { k: 'Minutos hablados', v: talkMin, icon: IconClock, c: 'grape' }, { k: 'Hoy', v: today, icon: IconCalendar, c: 'blue' }];
  const count = (t) => t === 'all' ? counts.all : (counts[t] || 0);

  function exportCSV() {
    const head = ['Fecha', 'Tipo', 'Medio', 'Origen', 'Nombre', 'Destino', 'Duracion_s', 'Hablado_s', 'Resultado'];
    const lines = [head.join(',')].concat(fr.map(r => [r.start ? new Date(r.start).toISOString() : '', TYPES[r._t]?.label, MEDIA[r._m]?.label, r.src || '', clidName(r.clid), r.dst || '', r.duration || 0, r.billsec || 0, dispLabel(r.disposition)].map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'cdr-pbxng-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click(); URL.revokeObjectURL(a.href);
  }

  const tabs = [
    { v: 'all', l: 'Todas', icon: <IconList size={15} /> },
    { v: 'inbound', l: 'Entrantes', icon: <IconArrowDownLeft size={15} /> },
    { v: 'outbound', l: 'Salientes', icon: <IconArrowUpRight size={15} /> },
    { v: 'internal', l: 'Internas', icon: <IconArrowsLeftRight size={15} /> },
    { v: 'ivr', l: 'IVR', icon: <IconArrowsSplit size={15} /> },
    { v: 'ia', l: 'Agente IA', icon: <IconRobot size={15} /> },
    { v: 'missed', l: 'Perdidas', icon: <IconPhoneX size={15} /> },
  ];

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
            <Group gap="sm" wrap="nowrap"><ThemeIcon size={40} radius="md" variant="light" color={x.c}><x.icon size={20} /></ThemeIcon><div><Text fw={800} fz={24} lh={1}><Slot value={x.v} /></Text><Text size="xs" c="dimmed">{x.k}</Text></div></Group>
          </Card>
        ))}
      </SimpleGrid>
      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Tabs value={tab} onChange={setTab} variant="pills" radius="md" mb="md">
          <Tabs.List>
            {tabs.map(t => <Tabs.Tab key={t.v} value={t.v} leftSection={t.icon} rightSection={<Badge size="xs" variant="light" circle>{count(t.v)}</Badge>}>{t.l}</Tabs.Tab>)}
          </Tabs.List>
        </Tabs>
        <Group justify="flex-end" mb="md"><TextInput placeholder="Buscar origen / destino / nombre" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={300} /></Group>
        {loading ? <TableSkeleton rows={8} cols={7} /> :
          fr.length === 0 ? <Text c="dimmed" ta="center" py="xl">{rows.length ? 'Sin resultados en esta vista.' : 'Aún no hay llamadas registradas.'}</Text> :
            <Table.ScrollContainer minWidth={900}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr>
                  <Th icon={<IconCalendar size={13} />}>Fecha</Th><Th icon={<IconArrowsLeftRight size={13} />}>Tipo</Th>
                  <Th icon={<IconArrowUpRight size={13} />}>Origen</Th><Th icon={<IconArrowDownLeft size={13} />}>Destino</Th>
                  <Th icon={<IconDeviceLandlinePhone size={13} />}>Medio</Th><Th icon={<IconClock size={13} />}>Duración</Th>
                  <Th icon={<IconCircleCheck size={13} />}>Resultado</Th><Th icon={<IconMicrophone2 size={13} />}>Grabación</Th>
                </Table.Tr></Table.Thead>
                <Table.Tbody>{fr.slice(0, shown).map((r, i) => {
                  const rec = recFor(r); const T = TYPES[r._t] || TYPES.other; const M = MEDIA[r._m] || MEDIA.sip; const nm = clidName(r.clid);
                  return (
                    <Fragment key={i}>
                    <Table.Tr>
                      <Table.Td><Text fz="xs">{r.start ? new Date(r.start).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</Text></Table.Td>
                      <Table.Td><Badge variant="light" color={T.color} leftSection={<T.icon size={12} />}>{T.label}</Badge></Table.Td>
                      <Table.Td><Text ff="monospace" fz="sm">{r.src || '—'}</Text>{nm && <Text fz="10px" c="dimmed" truncate maw={140}>{nm}</Text>}</Table.Td>
                      <Table.Td ff="monospace" fz="sm">{r.dst || '—'}</Table.Td>
                      <Table.Td><Badge variant="dot" color={M.color} size="sm">{M.label}</Badge></Table.Td>
                      <Table.Td><Text fz="sm" fw={500}>{fmtDur(r.billsec)}</Text>{r.duration !== r.billsec && <Text fz="10px" c="dimmed">tot {fmtDur(r.duration)}</Text>}</Table.Td>
                      <Table.Td><Badge variant="light" color={dispColor(r.disposition)}>{dispLabel(r.disposition)}</Badge></Table.Td>
                      <Table.Td>{rec ? <Button size="compact-xs" variant={playId === rec.id ? 'filled' : 'light'} color="teal" leftSection={playId === rec.id ? <IconPlayerPause size={13} /> : <IconPlayerPlay size={13} />} onClick={() => setPlayId(playId === rec.id ? null : rec.id)}>{playId === rec.id ? 'Cerrar' : 'Ver'}</Button> : <Text c="dimmed" size="xs">—</Text>}</Table.Td>
                    </Table.Tr>
                    {rec && playId === rec.id && <Table.Tr><Table.Td colSpan={8} style={{ background: 'var(--mantine-color-default-hover)' }}><RecordingPlayer recId={rec.id} src={'/backend/api/recordings/' + rec.id + '/audio'} label={(r.src || '?') + '  \u2192  ' + (r.dst || '?')} /></Table.Td></Table.Tr>}
                    </Fragment>
                  );
                })}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
        {fr.length > shown && <Group justify="center" mt="md"><Button variant="light" onClick={() => setShown(s => s + 100)}>Ver mas ({fr.length - shown})</Button></Group>}
      </Card>
    </Stack>
  );
}
