'use client';
/* Seguridad — panel de ataques a la central. Diseño CLARO y theme-aware (adapta a dark
 * por tokens de Mantine). Muestra qué ataca a la PBX: detecciones, intentos, IPs bloqueadas
 * con banderas, orígenes por país y actividad en el tiempo. Datos: Fail2Ban + geo (/api/security). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Group, Text, Badge, ThemeIcon, SimpleGrid, Table, TextInput, ActionIcon, Tooltip, Modal, Stack, Button, Divider, ScrollArea, RingProgress, Progress } from '@mantine/core';
import { IconShieldCheck, IconShieldX, IconBan, IconWorld, IconFlame, IconActivity, IconAlertTriangle, IconSearch, IconLockOpen, IconShieldPlus, IconTrash, IconHandStop, IconPlus, IconClock, IconRefresh, IconChartBar, IconDeviceDesktop, IconTargetArrow } from '@tabler/icons-react';
import { TableSkeleton, CardsSkeleton } from '../Skeletons';
import PageHeader from '../PageHeader';
import Slot from '../Slot';
import { toast } from '../notify';

const fmtDur = (s) => { if (s == null) return '—'; if (s < 0) return 'permanente'; if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + ' min'; if (s < 86400) return (s / 3600).toFixed(s % 3600 ? 1 : 0) + ' h'; return Math.round(s / 86400) + ' d'; };
const ago = (ts) => { if (!ts) return '—'; const d = Math.floor(Date.now() / 1000 - ts); if (d < 60) return 'hace ' + d + 's'; if (d < 3600) return 'hace ' + Math.floor(d / 60) + ' min'; if (d < 86400) return 'hace ' + Math.floor(d / 3600) + ' h'; return 'hace ' + Math.floor(d / 86400) + ' d'; };
const expiresIn = (ts, bantime) => { if (bantime != null && bantime < 0) return 'permanente'; if (!ts || bantime == null) return '—'; const left = ts + bantime - Math.floor(Date.now() / 1000); return left <= 0 ? 'expirado' : 'en ' + fmtDur(left); };
const Flag = ({ cc, w = 22 }) => cc && cc.length === 2 ? <img src={`https://flagcdn.com/${w * 2}x${Math.round(w * 0.75) * 2}/${cc.toLowerCase()}.png`} width={w} height={Math.round(w * 0.75)} alt={cc} style={{ borderRadius: 3, boxShadow: '0 0 0 1px rgba(0,0,0,.12)', objectFit: 'cover', flex: 'none' }} /> : <IconWorld size={w - 4} style={{ opacity: .35 }} />;

/* Barras de actividad (bloqueos por hora, últimas 24 h) — theme-aware */
function Actividad({ rows }) {
  const buckets = new Array(24).fill(0);
  for (const r of rows) { if (!r.ts) continue; const h = Math.floor((Date.now() / 1000 - r.ts) / 3600); if (h >= 0 && h < 24) buckets[23 - h]++; }
  const max = Math.max(1, ...buckets);
  const total = buckets.reduce((a, b) => a + b, 0);
  return (
    <Card withBorder radius="lg" padding="lg" shadow="sm" h="100%">
      <Group justify="space-between" mb="md">
        <Group gap={9}><ThemeIcon size={32} radius="md" variant="light" color="orange"><IconChartBar size={18} /></ThemeIcon><div><Text fw={700}>Actividad de ataques</Text><Text size="xs" c="dimmed">bloqueos por hora · últimas 24 h</Text></div></Group>
        <Badge variant="light" color="orange" size="lg">{total}</Badge>
      </Group>
      {total === 0 ? <Group justify="center" py={40} gap={8}><ThemeIcon size={40} radius="xl" variant="light" color="teal"><IconShieldCheck size={22} /></ThemeIcon><Text c="dimmed" size="sm">Sin bloqueos en las últimas 24 h.</Text></Group> :
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 130 }}>
          {buckets.map((v, i) => (
            <Tooltip key={i} label={v + ' bloqueo(s) · hace ' + (23 - i) + ' h'} withArrow disabled={!v}>
              <div style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                <div style={{ width: '100%', height: Math.max(4, (v / max) * 118) + 'px', borderRadius: 4, background: v ? 'linear-gradient(180deg, var(--mantine-color-red-5), var(--mantine-color-orange-5))' : 'var(--mantine-color-default-border)', opacity: v ? 1 : .5, transition: 'height .4s ease' }} />
              </div>
            </Tooltip>
          ))}
        </div>}
      <Group justify="space-between" mt={6}><Text fz={10} c="dimmed">-24 h</Text><Text fz={10} c="dimmed">ahora</Text></Group>
    </Card>
  );
}

export default function Seguridad() {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [q, setQ] = useState('');
  const [banIp, setBanIp] = useState(''); const [wlIp, setWlIp] = useState(''); const [wlNote, setWlNote] = useState('');
  const [confirmCfg, setConfirmCfg] = useState(null);
  const [live, setLive] = useState([]); const prevRef = useRef(null); const [, tk] = useState(0);
  const ask = (cfg) => setConfirmCfg(cfg);
  const doConfirm = async () => { const fn = confirmCfg && confirmCfg.onConfirm; setConfirmCfg(null); if (fn) await fn(); };

  function rowsOf(d) {
    const jails = (d && d.jails) || [], geo = (d && d.geo) || {}, out = [];
    for (const j of jails) { const det = {}; for (const b of (j.bans || [])) det[b.ip] = b; const ips = (j.bans && j.bans.length) ? j.bans.map(b => b.ip) : (j.banned || []); for (const ip of ips) out.push({ ip, jail: j.jail, ...(det[ip] || {}), ...(geo[ip] || {}) }); }
    return out;
  }
  async function load() {
    let d; try { d = await fetch('/backend/api/security').then(r => r.json()); } catch (_) { d = { jails: [], geo: {}, whitelist: [] }; }
    setData(d); setLoading(false);
    const rows = rowsOf(d); const cur = new Set(rows.map(r => r.ip));
    if (prevRef.current) { const nv = rows.filter(r => !prevRef.current.has(r.ip)); if (nv.length) setLive(L => [...nv.map(r => ({ id: r.ip + Date.now(), ip: r.ip, cc: r.cc, country: r.country, jail: r.jail, at: Date.now() })), ...L].slice(0, 30)); }
    prevRef.current = cur;
  }
  useEffect(() => { load(); const t = setInterval(load, 5000); const t2 = setInterval(() => tk(x => x + 1), 1000); return () => { clearInterval(t); clearInterval(t2); }; }, []);

  async function post(url, body, okMsg) { const r = await fetch('/backend/api/security/' + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 1 })); toast(r.error ? 'Error' : okMsg, r.error ? 'bad' : 'ok'); setTimeout(load, 700); }
  const unban = (ip, jail) => post('unban', { ip, jail }, 'Desbloqueando ' + ip);
  const banManual = () => { const ip = banIp.trim(); if (!ip) return; ask({ title: 'Bloquear IP', message: 'Se bloqueará ' + ip + ' en todas las jails de Fail2Ban.', confirmLabel: 'Bloquear', color: 'red', icon: <IconBan size={22} />, onConfirm: () => { post('ban', { ip }, 'Bloqueando ' + ip); setBanIp(''); } }); };
  const wlAdd = () => { const ip = wlIp.trim(); if (!ip) return; post('whitelist', { ip, note: wlNote.trim() }, ip + ' agregada a la lista blanca'); setWlIp(''); setWlNote(''); };
  const wlRemove = (ip) => ask({ title: 'Quitar de la lista blanca', message: 'Se quitará ' + ip + '. Volverá a estar sujeta a Fail2Ban.', confirmLabel: 'Quitar', color: 'red', icon: <IconTrash size={22} />, onConfirm: () => post('whitelist/remove', { ip }, ip + ' quitada') });

  const rows = useMemo(() => rowsOf(data), [data]);
  const jails = data?.jails || []; const whitelist = data?.whitelist || [];
  const totalBanned = rows.length;
  const totalFailed = jails.reduce((a, j) => a + (j.total_failed || 0), 0);
  const last24 = rows.filter(r => r.ts && (Date.now() / 1000 - r.ts) < 86400).length;
  const byCC = {}; for (const r of rows) { const cc = r.cc || '??'; byCC[cc] = byCC[cc] || { cc, country: r.country || 'Desconocido', n: 0 }; byCC[cc].n++; }
  const countries = Object.values(byCC).sort((a, b) => b.n - a.n);
  const maxPais = Math.max(1, ...countries.map(c => c.n));
  const attackers = [...rows].sort((a, b) => (b.attempts || 0) - (a.attempts || 0)).slice(0, 6);
  const fr = rows.filter(r => !q || r.ip.includes(q) || (r.country || '').toLowerCase().includes(q.toLowerCase()) || (r.city || '').toLowerCase().includes(q.toLowerCase()) || (r.isp || '').toLowerCase().includes(q.toLowerCase()));
  const threat = totalBanned === 0 ? 'teal' : totalBanned > 10 ? 'red' : 'orange';
  const threatLbl = totalBanned === 0 ? 'Protegida' : (totalBanned + ' amenaza(s) activa(s)');

  const kpis = [
    { k: 'IPs bloqueadas', v: totalBanned, icon: IconBan, c: 'red', tip: 'IPs actualmente bloqueadas por Fail2Ban.' },
    { k: 'Intentos detectados', v: totalFailed, icon: IconTargetArrow, c: 'orange', tip: 'Total de intentos de autenticación fallidos vistos.' },
    { k: 'Últimas 24 h', v: last24, icon: IconFlame, c: 'grape', tip: 'IPs bloqueadas en el último día.' },
    { k: 'Países origen', v: countries.length, icon: IconWorld, c: 'blue', tip: 'Cantidad de países distintos que atacaron.' },
    { k: 'Lista blanca', v: whitelist.length, icon: IconShieldCheck, c: 'teal', tip: 'IPs/redes que nunca se bloquean.' },
  ];

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconShieldCheck size={24} />} title="Seguridad" subtitle="Ataques y detecciones sobre la central · Fail2Ban" color="red"
        right={<><Badge size="lg" variant="light" color={threat} leftSection={totalBanned ? <IconShieldX size={14} /> : <IconShieldCheck size={14} />}>{threatLbl}</Badge>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>Actualizar</Button></>} />

      {loading ? <CardsSkeleton count={5} /> :
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="md">
          {kpis.map(x => (
            <Tooltip key={x.k} label={x.tip} withArrow>
              <Card withBorder radius="lg" padding="md" shadow="sm" style={{ cursor: 'help' }}>
                <Group gap="sm" wrap="nowrap"><ThemeIcon size={42} radius="md" variant="light" color={x.c}><x.icon size={21} /></ThemeIcon>
                  <div><Text fw={800} fz={26} lh={1}><Slot value={x.v} /></Text><Text size="xs" c="dimmed">{x.k}</Text></div></Group>
              </Card>
            </Tooltip>
          ))}
        </SimpleGrid>}

      <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="lg">
        <div style={{ gridColumn: 'span 1' }}>
          <Card withBorder radius="lg" padding="lg" shadow="sm" h="100%">
            <Group gap={9} mb="md"><ThemeIcon size={32} radius="md" variant="light" color={threat}><IconShieldCheck size={18} /></ThemeIcon><Text fw={700}>Estado de protección</Text></Group>
            <Group justify="center" py="sm">
              <RingProgress size={150} thickness={13} roundCaps
                sections={[{ value: totalBanned === 0 ? 100 : Math.min(100, totalBanned * 8), color: threat }]}
                label={<div style={{ textAlign: 'center' }}><Text fw={800} fz={30} lh={1}><Slot value={totalBanned} /></Text><Text size="xs" c="dimmed">bloqueadas</Text></div>} />
            </Group>
            <Text ta="center" size="sm" c={threat} fw={600}>{totalBanned === 0 ? '🛡️ Sin amenazas activas' : '⚠️ ' + threatLbl}</Text>
            <Divider my="sm" />
            <Group justify="space-between"><Text size="sm" c="dimmed">Detecciones recientes</Text><Badge size="sm" variant="light" color="orange">{live.length}</Badge></Group>
            <ScrollArea.Autosize mah={110} mt={6}>
              {live.length === 0 ? <Text size="xs" c="dimmed" py="xs">Sin detecciones nuevas. Aparecen acá en cuanto ocurren.</Text> :
                <Stack gap={4}>{live.slice(0, 8).map(e => <Group key={e.id} gap={7} wrap="nowrap"><Flag cc={e.cc} w={16} /><Text fz="xs" ff="monospace" fw={600} truncate>{e.ip}</Text><Text fz={10} c="dimmed" style={{ marginLeft: 'auto' }}>{ago(Math.floor(e.at / 1000))}</Text></Group>)}</Stack>}
            </ScrollArea.Autosize>
          </Card>
        </div>
        <div style={{ gridColumn: 'span 2' }}><Actividad rows={rows} /></div>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap={9} mb="md"><ThemeIcon size={32} radius="md" variant="light" color="blue"><IconWorld size={18} /></ThemeIcon><Text fw={700}>Orígenes por país</Text></Group>
          {countries.length === 0 ? <Text size="sm" c="dimmed" ta="center" py="lg">Sin ataques registrados todavía.</Text> :
            <Stack gap="sm">{countries.slice(0, 8).map(c => (
              <div key={c.cc}><Group justify="space-between" mb={3}><Group gap={8}><Flag cc={c.cc} /><Text size="sm" fw={600}>{c.country}</Text></Group><Badge size="sm" variant="light" color="red">{c.n}</Badge></Group><Progress value={(c.n / maxPais) * 100} color="red" size="sm" radius="xl" /></div>
            ))}</Stack>}
        </Card>
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap={9} mb="md"><ThemeIcon size={32} radius="md" variant="light" color="orange"><IconFlame size={18} /></ThemeIcon><Text fw={700}>Los más insistentes</Text><Text size="xs" c="dimmed">por intentos</Text></Group>
          {attackers.length === 0 ? <Text size="sm" c="dimmed" ta="center" py="lg">Nadie golpeando ahora mismo.</Text> :
            <Table verticalSpacing="sm" fz="sm"><Table.Tbody>{attackers.map(a => (
              <Table.Tr key={a.ip + a.jail}><Table.Td w={30}><Flag cc={a.cc} w={20} /></Table.Td><Table.Td ff="monospace" fw={650}>{a.ip}</Table.Td><Table.Td><Text fz="xs" c="dimmed" truncate maw={150}>{a.isp || a.country || '—'}</Text></Table.Td><Table.Td ta="right"><Badge variant="light" color={(a.attempts || 0) > 10 ? 'red' : 'orange'}>{a.attempts || 1} int.</Badge></Table.Td></Table.Tr>
            ))}</Table.Tbody></Table>}
        </Card>
      </SimpleGrid>

      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md">
          <Group gap={9}><ThemeIcon size={32} radius="md" variant="light" color="red"><IconBan size={18} /></ThemeIcon><Text fw={700}>IPs bloqueadas</Text><Badge variant="light" color="red">{fr.length}</Badge></Group>
          <TextInput placeholder="Buscar IP, país, ciudad o ISP" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={280} />
        </Group>
        {loading ? <TableSkeleton rows={6} cols={7} /> :
          rows.length === 0 ? <Group justify="center" py={44} gap={10}><ThemeIcon size={48} radius="xl" variant="light" color="teal"><IconShieldCheck size={24} /></ThemeIcon><div><Text fw={600}>Ninguna IP bloqueada</Text><Text size="sm" c="dimmed">La central está limpia. Cuando alguien insista, aparece acá con su bandera.</Text></div></Group> :
            <Table.ScrollContainer minWidth={880}>
              <Table striped highlightOnHover verticalSpacing="sm" stickyHeader>
                <Table.Thead><Table.Tr><Table.Th>País</Table.Th><Table.Th>IP</Table.Th><Table.Th>Ciudad</Table.Th><Table.Th>ISP</Table.Th><Table.Th>Jail</Table.Th><Table.Th>Intentos</Table.Th><Table.Th>Bloqueada</Table.Th><Table.Th>Expira</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>{fr.map((r, i) => (
                  <Table.Tr key={r.ip + i}>
                    <Table.Td><Group gap={8} wrap="nowrap"><Flag cc={r.cc} /><Text fz="sm">{r.country || '—'}</Text></Group></Table.Td>
                    <Table.Td ff="monospace" fw={600}>{r.ip}</Table.Td>
                    <Table.Td><Text fz="sm">{r.city || '—'}</Text></Table.Td>
                    <Table.Td><Text fz="xs" c="dimmed" lineClamp={1} maw={160}>{r.isp || '—'}</Text></Table.Td>
                    <Table.Td><Badge size="xs" variant="light" color="gray">{r.jail}</Badge></Table.Td>
                    <Table.Td>{r.attempts != null ? <Badge variant="light" color={r.attempts >= 10 ? 'red' : 'orange'}>{r.attempts}</Badge> : <Text c="dimmed" fz="sm">—</Text>}</Table.Td>
                    <Table.Td><Text fz="xs">{ago(r.ts)}</Text></Table.Td>
                    <Table.Td><Text fz="xs" c="dimmed">{expiresIn(r.ts, r.bantime)}</Text></Table.Td>
                    <Table.Td ta="right"><Tooltip label="Desbloquear (soltar de Fail2Ban)"><ActionIcon variant="subtle" color="teal" onClick={() => unban(r.ip, r.jail)}><IconLockOpen size={17} /></ActionIcon></Tooltip></Table.Td>
                  </Table.Tr>
                ))}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
      </Card>

      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="lg">
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="xs" mb="md"><ThemeIcon variant="light" color="red" size={30} radius="md"><IconHandStop size={17} /></ThemeIcon><Text fw={700}>Bloqueo manual</Text></Group>
          <Text size="xs" c="dimmed" mb="sm">Bloquea una IP al instante en todas las jails.</Text>
          <Group gap="xs"><TextInput placeholder="203.0.113.5" value={banIp} onChange={e => setBanIp(e.target.value)} style={{ flex: 1 }} /><Button color="red" variant="light" leftSection={<IconBan size={16} />} onClick={banManual}>Bloquear</Button></Group>
        </Card>
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="xs" mb="md"><ThemeIcon variant="light" color="teal" size={30} radius="md"><IconShieldPlus size={17} /></ThemeIcon><Text fw={700}>Lista blanca</Text><Badge variant="light" color="teal">{whitelist.length}</Badge></Group>
          <Group gap="xs" mb="sm" align="flex-end"><TextInput label="IP o red" placeholder="190.64.0.0/16" value={wlIp} onChange={e => setWlIp(e.target.value)} style={{ flex: 1 }} size="xs" /><TextInput label="Nota" placeholder="opcional" value={wlNote} onChange={e => setWlNote(e.target.value)} w={90} size="xs" /><Button size="xs" leftSection={<IconPlus size={14} />} onClick={wlAdd}>+</Button></Group>
          <ScrollArea.Autosize mah={130}>{whitelist.length === 0 ? <Text c="dimmed" size="xs" ta="center" py="sm">Lista blanca vacía.</Text> :
            <Stack gap={4}>{whitelist.map(w => <Group key={w.ip} gap={6} wrap="nowrap"><Text fz="xs" ff="monospace" fw={600}>{w.ip}</Text><Text fz={10} c="dimmed" truncate>{w.note || ''}</Text><ActionIcon variant="subtle" color="red" size="sm" style={{ marginLeft: 'auto' }} onClick={() => wlRemove(w.ip)}><IconTrash size={14} /></ActionIcon></Group>)}</Stack>}</ScrollArea.Autosize>
        </Card>
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="xs" mb="md"><ThemeIcon variant="light" color="indigo" size={30} radius="md"><IconDeviceDesktop size={17} /></ThemeIcon><Text fw={700}>Política de detección</Text></Group>
          {jails.length === 0 ? <Text c="dimmed" size="sm">Sin jails activas.</Text> :
            <Stack gap="xs">{jails.map(j => { const c = j.config || {}; return (
              <Card key={j.jail} withBorder radius="md" padding="xs">
                <Group justify="space-between" mb={4}><Badge variant="dot" color="orange">{j.jail}</Badge><Badge size="xs" variant="light" color={(j.banned || []).length ? 'red' : 'teal'}>{(j.banned || []).length} act.</Badge></Group>
                <Text fz="xs" c="dimmed">Tras <b>{c.maxretry ?? '?'}</b> intentos en <b>{fmtDur(c.findtime)}</b> → bloqueo por <b>{fmtDur(c.bantime)}</b>.</Text>
              </Card>
            ); })}</Stack>}
        </Card>
      </SimpleGrid>

      <Modal opened={!!confirmCfg} onClose={() => setConfirmCfg(null)} centered radius="lg" size="sm" withCloseButton={false} overlayProps={{ blur: 3, backgroundOpacity: 0.45 }}>
        <Stack gap="md" align="center" ta="center" py="xs">
          <ThemeIcon size={58} radius="xl" variant="light" color={confirmCfg?.color || 'red'}>{confirmCfg?.icon || <IconAlertTriangle size={26} />}</ThemeIcon>
          <div><Text fw={800} fz="lg">{confirmCfg?.title}</Text><Text c="dimmed" fz="sm" mt={6}>{confirmCfg?.message}</Text></div>
          <Group grow w="100%" mt="xs"><Button variant="default" onClick={() => setConfirmCfg(null)}>Cancelar</Button><Button color={confirmCfg?.color || 'red'} onClick={doConfirm}>{confirmCfg?.confirmLabel || 'Confirmar'}</Button></Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
