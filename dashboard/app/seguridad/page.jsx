'use client';
import { useEffect, useMemo, useState } from 'react';
import { Stack, Title, Text, Card, Group, Button, Table, Badge, SimpleGrid, ThemeIcon, TextInput, ActionIcon, Tooltip, Modal, Divider } from '@mantine/core';
import { IconRefresh, IconShieldCheck, IconBan, IconWorld, IconSearch, IconLockOpen, IconAlertTriangle, IconMapPin, IconClock, IconHandStop, IconShieldPlus, IconTrash, IconPlus, IconList, IconActivity, IconClockHour4 } from '@tabler/icons-react';
import { TableSkeleton, CardsSkeleton } from '../Skeletons';
import { toast } from '../notify';

const fmtDur = (s) => { if (s == null) return '—'; if (s < 0) return 'permanente'; if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + ' min'; if (s < 86400) return (s / 3600).toFixed(s % 3600 ? 1 : 0) + ' h'; return Math.round(s / 86400) + ' d'; };
const ago = (ts) => { if (!ts) return '—'; const d = Math.floor(Date.now() / 1000 - ts); if (d < 60) return 'hace ' + d + 's'; if (d < 3600) return 'hace ' + Math.floor(d / 60) + ' min'; if (d < 86400) return 'hace ' + Math.floor(d / 3600) + ' h'; return 'hace ' + Math.floor(d / 86400) + ' d'; };
const expiresIn = (ts, bantime) => { if (bantime != null && bantime < 0) return 'permanente'; if (!ts || bantime == null) return '—'; const left = ts + bantime - Math.floor(Date.now() / 1000); return left <= 0 ? 'expirado' : 'en ' + fmtDur(left); };
const Flag = ({ cc }) => cc ? <img src={`https://flagcdn.com/20x15/${cc.toLowerCase()}.png`} width={20} height={15} alt={cc} style={{ borderRadius: 2, boxShadow: '0 0 0 1px rgba(0,0,0,.12)', objectFit: 'cover' }} /> : <IconWorld size={16} style={{ opacity: .35 }} />;

export default function Seguridad() {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [q, setQ] = useState('');
  const [wlIp, setWlIp] = useState(''); const [wlNote, setWlNote] = useState(''); const [banIp, setBanIp] = useState('');
  const [confirmCfg, setConfirmCfg] = useState(null);
  const ask = (cfg) => setConfirmCfg(cfg);
  const doConfirm = async () => { const fn = confirmCfg && confirmCfg.onConfirm; setConfirmCfg(null); if (fn) await fn(); };

  async function load() { try { const d = await fetch('/backend/api/security').then(r => r.json()); setData(d); } catch (_) { setData({ jails: [], geo: {}, whitelist: [] }); } setLoading(false); }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  async function post(url, body, okMsg) { const r = await fetch('/backend/api/security/' + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 1 })); toast(r.error ? 'Error' : okMsg, r.error ? 'bad' : 'ok'); setTimeout(load, 800); }
  const unban = (ip, jail) => post('unban', { ip, jail }, 'Desbloqueando ' + ip);
  const banManual = () => { if (!banIp.trim()) return; const ip = banIp.trim(); ask({ title: 'Bloquear IP manualmente', message: 'Se bloqueará ' + ip + ' en todas las jails de Fail2Ban.', confirmLabel: 'Bloquear', color: 'red', icon: <IconBan size={22} />, onConfirm: () => { post('ban', { ip }, 'Bloqueando ' + ip); setBanIp(''); } }); };
  const wlAdd = () => { if (!wlIp.trim()) return; const ip = wlIp.trim(); post('whitelist', { ip, note: wlNote.trim() }, ip + ' agregada a la lista blanca'); setWlIp(''); setWlNote(''); };
  const wlRemove = (ip) => ask({ title: 'Quitar de la lista blanca', message: 'Se quitará ' + ip + ' de la lista blanca. Volverá a estar sujeta a Fail2Ban.', confirmLabel: 'Quitar', color: 'red', icon: <IconTrash size={22} />, onConfirm: () => post('whitelist/remove', { ip }, ip + ' quitada de la lista blanca') });

  const jails = data?.jails || []; const geo = data?.geo || {}; const whitelist = data?.whitelist || [];
  const rows = useMemo(() => {
    const out = [];
    for (const j of jails) {
      const det = {}; for (const b of (j.bans || [])) det[b.ip] = b;
      const ips = (j.bans && j.bans.length) ? j.bans.map(b => b.ip) : (j.banned || []);
      for (const ip of ips) out.push({ ip, jail: j.jail, ...(det[ip] || {}), ...(geo[ip] || {}) });
    }
    return out;
  }, [jails, geo]);
  const totalBanned = rows.length;
  const totalFailed = jails.reduce((a, j) => a + (j.total_failed || 0), 0);
  const byCountry = {}; for (const r of rows) { const k = r.country || 'Desconocido'; byCountry[k] = byCountry[k] || { n: 0, cc: r.cc }; byCountry[k].n++; }
  const topCountries = Object.entries(byCountry).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  const fr = rows.filter(r => !q || r.ip.includes(q) || (r.country || '').toLowerCase().includes(q.toLowerCase()) || (r.city || '').toLowerCase().includes(q.toLowerCase()));

  const cards = [
    ['IPs bloqueadas', totalBanned, IconBan, 'red'],
    ['Intentos fallidos', totalFailed, IconAlertTriangle, 'orange'],
    ['En lista blanca', whitelist.length, IconShieldCheck, 'teal'],
    ['Países atacantes', Object.keys(byCountry).length, IconWorld, 'blue'],
  ];

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-red-5),var(--mantine-color-red-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'red.5', to: 'red.8', deg: 135 }}><IconShieldCheck size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Seguridad</Title><Text c="dimmed" size="sm">Fail2Ban · ataques bloqueados, origen geográfico y lista blanca</Text></div></div>
        <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>Actualizar</Button>
      </Group>

      {loading ? <CardsSkeleton count={4} /> :
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          {cards.map(([l, v, Ic, c]) => (
            <Card key={l} withBorder radius="lg" padding="lg" shadow="sm"><Group><ThemeIcon size={44} radius="md" variant="light" color={c}><Ic size={22} /></ThemeIcon>
              <div><Text size="sm" c="dimmed">{l}</Text><Text fw={800} fz={26}>{v}</Text></div></Group></Card>
          ))}
        </SimpleGrid>}

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        {/* política de jails */}
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="xs" mb="md"><ThemeIcon variant="light" color="indigo" size={32} radius="md"><IconShieldCheck size={18} /></ThemeIcon><Text fw={700}>Política de protección</Text></Group>
          {jails.length === 0 ? <Text c="dimmed" size="sm">Sin jails activas.</Text> : jails.map(j => {
            const c = j.config || {};
            return (
              <Card key={j.jail} withBorder radius="md" padding="sm" mb="xs" bg="var(--mantine-color-gray-0)">
                <Group justify="space-between" mb={6}><Badge variant="dot" color="orange" size="lg">{j.jail}</Badge><Badge variant="light" color={(j.banned || []).length ? 'red' : 'teal'}>{(j.banned || []).length} bloqueadas</Badge></Group>
                <SimpleGrid cols={3}>
                  <div><Group gap={4}><IconActivity size={13} style={{ opacity: .5 }} /><Text fz="xs" c="dimmed">Intentos máx.</Text></Group><Text fw={700}>{c.maxretry ?? '—'}</Text></div>
                  <div><Group gap={4}><IconClock size={13} style={{ opacity: .5 }} /><Text fz="xs" c="dimmed">Ventana</Text></Group><Text fw={700}>{fmtDur(c.findtime)}</Text></div>
                  <div><Group gap={4}><IconClockHour4 size={13} style={{ opacity: .5 }} /><Text fz="xs" c="dimmed">Duración ban</Text></Group><Text fw={700}>{fmtDur(c.bantime)}</Text></div>
                </SimpleGrid>
                <Text fz="xs" c="dimmed" mt={8}>Tras <b>{c.maxretry ?? '?'}</b> intentos fallidos en <b>{fmtDur(c.findtime)}</b>, la IP se bloquea por <b>{fmtDur(c.bantime)}</b>.</Text>
              </Card>
            );
          })}
          <Divider my="sm" label="Bloquear IP manualmente" labelPosition="left" />
          <Group gap="xs"><TextInput placeholder="IP a bloquear (ej 203.0.113.5)" leftSection={<IconHandStop size={15} />} value={banIp} onChange={e => setBanIp(e.target.value)} style={{ flex: 1 }} /><Button color="red" variant="light" leftSection={<IconBan size={16} />} onClick={banManual}>Bloquear</Button></Group>
        </Card>

        {/* lista blanca */}
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="xs" mb="md"><ThemeIcon variant="light" color="teal" size={32} radius="md"><IconShieldPlus size={18} /></ThemeIcon><Text fw={700}>Lista blanca</Text><Badge variant="light" color="teal">{whitelist.length}</Badge></Group>
          <Text fz="xs" c="dimmed" mb="sm">Las IPs o redes de esta lista nunca se bloquean (se aplican como <code>ignoreip</code> en todas las jails).</Text>
          <Group gap="xs" mb="md" align="flex-end">
            <TextInput label="IP o red (CIDR)" placeholder="190.64.0.0/16" value={wlIp} onChange={e => setWlIp(e.target.value)} style={{ flex: 1 }} />
            <TextInput label="Nota" placeholder="opcional" value={wlNote} onChange={e => setWlNote(e.target.value)} style={{ flex: 1 }} />
            <Button leftSection={<IconPlus size={16} />} onClick={wlAdd}>Agregar</Button>
          </Group>
          {whitelist.length === 0 ? <Text c="dimmed" size="sm" ta="center" py="md">Lista blanca vacía.</Text> :
            <Table verticalSpacing={6}><Table.Tbody>{whitelist.map(w => (
              <Table.Tr key={w.ip}><Table.Td ff="monospace" fw={600}>{w.ip}</Table.Td><Table.Td><Text fz="sm" c="dimmed">{w.note || '—'}</Text></Table.Td>
                <Table.Td ta="right"><Tooltip label="Quitar"><ActionIcon variant="subtle" color="red" onClick={() => wlRemove(w.ip)}><IconTrash size={16} /></ActionIcon></Tooltip></Table.Td></Table.Tr>
            ))}</Table.Tbody></Table>}
        </Card>
      </SimpleGrid>

      {!loading && topCountries.length > 0 &&
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={700} mb="sm">Orígenes de ataque por país</Text>
          <Group gap="sm">{topCountries.map(([c, v]) => <Badge key={c} size="lg" variant="light" color="gray" leftSection={<Flag cc={v.cc} />} pl={6}>{c}: {v.n}</Badge>)}</Group>
        </Card>}

      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="md">
          <Group gap="xs"><Text fw={700}>IPs bloqueadas</Text><Badge variant="light" color="red">{fr.length}</Badge></Group>
          <TextInput placeholder="Buscar IP, país o ciudad" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={280} />
        </Group>
        {loading ? <TableSkeleton rows={6} cols={7} /> :
          rows.length === 0 ? <Group justify="center" py={40}><ThemeIcon size={46} radius="xl" variant="light" color="teal"><IconShieldCheck size={24} /></ThemeIcon><Text c="dimmed">Sin IPs bloqueadas. El sistema está limpio.</Text></Group> :
            <Table.ScrollContainer minWidth={860}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr><Table.Th>País</Table.Th><Table.Th>IP</Table.Th><Table.Th>Ciudad</Table.Th><Table.Th>ISP</Table.Th><Table.Th>Intentos</Table.Th><Table.Th>Bloqueada</Table.Th><Table.Th>Expira</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>{fr.map((r, i) => (
                  <Table.Tr key={r.ip + i}>
                    <Table.Td><Group gap={7} wrap="nowrap"><Flag cc={r.cc} /><Text fz="sm">{r.country || '—'}</Text></Group></Table.Td>
                    <Table.Td ff="monospace" fw={600}>{r.ip}</Table.Td>
                    <Table.Td><Text fz="sm">{r.city || '—'}</Text></Table.Td>
                    <Table.Td><Text fz="xs" c="dimmed" lineClamp={1} maw={160}>{r.isp || '—'}</Text></Table.Td>
                    <Table.Td>{r.attempts != null ? <Badge variant="light" color={r.attempts >= 10 ? 'red' : 'orange'}>{r.attempts}</Badge> : <Text c="dimmed" fz="sm">—</Text>}{r.bancount > 1 && <Text fz="10px" c="dimmed">{r.bancount}º ban</Text>}</Table.Td>
                    <Table.Td><Text fz="xs">{ago(r.ts)}</Text></Table.Td>
                    <Table.Td><Text fz="xs" c="dimmed">{expiresIn(r.ts, r.bantime)}</Text></Table.Td>
                    <Table.Td ta="right"><Tooltip label="Desbloquear"><ActionIcon variant="subtle" color="teal" onClick={() => unban(r.ip, r.jail)}><IconLockOpen size={17} /></ActionIcon></Tooltip></Table.Td>
                  </Table.Tr>
                ))}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
      </Card>

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
