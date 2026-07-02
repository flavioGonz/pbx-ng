'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Modal, Tabs, Stack, Group, Text, Badge, Card, SimpleGrid, Table, Button, TextInput, NumberInput, Textarea, ThemeIcon, Progress, ActionIcon, Tooltip, Code, ScrollArea, Divider, SegmentedControl, Switch, Select, Menu } from '@mantine/core';
import { IconActivity, IconShieldLock, IconRouteAltLeft, IconArrowsLeftRight, IconFileCode, IconBan, IconRefresh, IconTrash, IconPlugConnected, IconPlugConnectedX, IconDeviceFloppy, IconAlertTriangle, IconClock, IconCpu, IconReload, IconSitemap, IconServer2 } from '@tabler/icons-react';
import { toast } from './notify';
import SbcFlow from './SbcFlow';
import Slot from './Slot';
import SipLadder from './SipLadder';
import Troncales from './troncales/page';
import RoutesPanel from './RoutesPanel';
import TurnConsole from './TurnConsole';
import { useLive } from './useLive';
import { IconPlus, IconInfoCircle, IconPhone, IconNetwork, IconRouter, IconRoute, IconWorld, IconBug, IconDeviceLandlinePhone, IconCloud, IconReplace, IconChevronDown } from '@tabler/icons-react';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SECF_TYPE = { 0: 'User-Agent', 1: 'Pais', 2: 'Dominio', 3: 'IP', 4: 'Usuario', 5: 'Destino' };
function fmtUptime(s) { s = parseInt(s) || 0; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + 'd ' : '') + h + 'h ' + m + 'm'; }
function Kpi({ icon, color, label, value, sub }) {
  return <Card withBorder radius="md" padding="sm"><Group gap="sm" wrap="nowrap"><ThemeIcon variant="light" color={color} size={38} radius="md">{icon}</ThemeIcon><div style={{ minWidth: 0 }}><Text size="xs" c="dimmed">{label}</Text><Text fw={700} fz="lg" lh={1.1} truncate><Slot value={value} /></Text>{sub && <Text size="xs" c="dimmed">{sub}</Text>}</div></Group></Card>;
}

// Grafica de area en vivo (estilo Resumen)
function Spark({ data, color, label, unit, accent }) {
  const w = 320, h = 84, pad = 6;
  const vals = data.length ? data : [0];
  const max = Math.max(1, ...vals); const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const n = vals.length;
  const xs = (i) => pad + (n <= 1 ? 0 : (i * (w - pad * 2) / (n - 1)));
  const ys = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const pts = vals.map((v, i) => xs(i) + ',' + ys(v).toFixed(1));
  const line = 'M' + pts.join(' L');
  const area = line + ` L${xs(n - 1)},${h - pad} L${xs(0)},${h - pad} Z`;
  const last = vals[vals.length - 1];
  const id = 'g' + label.replace(/[^a-z]/gi, '');
  return (
    <Card withBorder radius="md" padding="sm">
      <Group justify="space-between" mb={4}><Text size="xs" c="dimmed">{label}</Text><Text fw={800} fz="lg" lh={1} c={accent}>{last}{unit ? <Text span size="xs" c="dimmed"> {unit}</Text> : null}</Text></Group>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 84, display: 'block' }} preserveAspectRatio="none">
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.34" /><stop offset="100%" stopColor={color} stopOpacity="0.02" /></linearGradient></defs>
        {[0.25, 0.5, 0.75].map(g => <line key={g} x1={pad} x2={w - pad} y1={pad + g * (h - pad * 2)} y2={pad + g * (h - pad * 2)} stroke="rgba(120,130,150,.12)" strokeWidth="1" />)}
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xs(n - 1)} cy={ys(last)} r="3" fill={color} />
      </svg>
    </Card>
  );
}

function ConsoleBody({ sbc, load, hist }) {
  const [cfg, setCfg] = useState(''); const [cfgOrig, setCfgOrig] = useState(''); const [cfgMsg, setCfgMsg] = useState(''); const [cfgBusy, setCfgBusy] = useState(false);
  const [banIp, setBanIp] = useState(''); const [debug, setDebug] = useState(2); const [busy, setBusy] = useState('');
  const cfgLoaded = useRef(false);
  const { snap } = useLive(); const ch = (snap && snap.channels) || []; const ext = (snap && snap.extensions) || []; const [extList, setExtList] = useState([]); const remExt = (extList.length ? extList : ext).filter(e => e.via === 'sbc');
  const [now, setNow] = useState(Date.now()); useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const [newTgt, setNewTgt] = useState(''); const [dlgOpen, setDlgOpen] = useState(false); const [dlgEdit, setDlgEdit] = useState(null); const [dtUri, setDtUri] = useState(''); const [dtPrio, setDtPrio] = useState(0);
  async function saveTgt() { const uri = dtUri.trim(); if (!uri) return; if (dlgEdit) await sendCmd('del_target', dlgEdit.uri); await sendCmd('add_target', uri + '|' + (dtPrio || 0)); setDlgOpen(false); }
  const [tab, setTab] = useState('mon'); const [secView, setSecView] = useState('sbc'); const [featLimit, setFeatLimit] = useState(30);
  async function applyFeats(next) { await sendCmd('feat_apply', JSON.stringify(next)); } const [f2b, setF2b] = useState(null); const [secf, setSecf] = useState([]); const [sfData, setSfData] = useState(''); const [sfType, setSfType] = useState('0'); const [sfBusy, setSfBusy] = useState(''); const loadSecf = useCallback(() => fetch('/backend/api/sbc/secfilter').then(r => r.json()).then(d => Array.isArray(d) && setSecf(d)).catch(() => {}), []); async function addSecf() { if (!sfData.trim()) return; setSfBusy('add'); await fetch('/backend/api/sbc/secfilter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 0, type: +sfType, data: sfData.trim() }) }).catch(() => {}); setSfData(''); setSfBusy(''); setTimeout(loadSecf, 500); toast('Regla agregada (SBC recargado)', 'ok'); } async function delSecf(id) { setSfBusy('d' + id); await fetch('/backend/api/sbc/secfilter/' + id, { method: 'DELETE' }).catch(() => {}); setSfBusy(''); setTimeout(loadSecf, 500); }
  const [lcrGws, setLcrGws] = useState([]); const [lcrRules, setLcrRules] = useState([]);
  const [smRules, setSmRules] = useState([]); const [smForm, setSmForm] = useState({ action: 'remove_header', scope: 'all', header: '', value: '', match: '', description: '' }); const [smBusy, setSmBusy] = useState('');
  const loadSm = useCallback(() => fetch('/backend/api/sbc/sipmanip').then(r => r.json()).then(d => Array.isArray(d) && setSmRules(d)).catch(() => {}), []);
  async function addSm() { if (!smForm.action) return; setSmBusy('add'); await fetch('/backend/api/sbc/sipmanip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(smForm) }).catch(() => {}); setSmForm(f => ({ ...f, header: '', value: '', match: '', description: '' })); setSmBusy(''); setTimeout(loadSm, 900); toast('Regla agregada (SBC recargado)', 'ok'); }
  async function delSm(id) { setSmBusy('d' + id); await fetch('/backend/api/sbc/sipmanip/' + id, { method: 'DELETE' }).catch(() => {}); setSmBusy(''); setTimeout(loadSm, 900); }
  async function toggleSm(id) { setSmBusy('t' + id); await fetch('/backend/api/sbc/sipmanip/' + id + '/toggle', { method: 'POST' }).catch(() => {}); setSmBusy(''); setTimeout(loadSm, 900); }
  async function presetsSm() { setSmBusy('pre'); await fetch('/backend/api/sbc/sipmanip/presets', { method: 'POST' }).catch(() => {}); setSmBusy(''); setTimeout(loadSm, 900); toast('Presets compatibles agregados (revisá cuáles activar)', 'ok'); }
  async function resetSm() { if (!confirm('¿Borrar todas las reglas y volver a SIN manipulación?')) return; setSmBusy('reset'); await fetch('/backend/api/sbc/sipmanip/reset', { method: 'POST' }).catch(() => {}); setSmBusy(''); setTimeout(loadSm, 900); toast('Restaurado: sin manipulación', 'info'); }
  const SM_ACTION_LABEL = { remove_header: 'Quitar header', add_header: 'Agregar header', set_from_user: 'Forzar From-user', set_ppi: 'P-Preferred-Identity', set_pai: 'P-Asserted-Identity', set_diversion: 'Diversion', modify_header: 'Modificar (regex)' };
  const [gwForm, setGwForm] = useState({ address: '', strip: 0, pri_prefix: '', description: '' });
  const [ruleForm, setRuleForm] = useState({ prefix: '', gwlist: '', description: '' });
  const [lcrBusy, setLcrBusy] = useState('');
  const loadLcrGw = useCallback(() => fetch('/backend/api/sbc/lcr/gateways').then(r => r.json()).then(d => Array.isArray(d) && setLcrGws(d)).catch(() => {}), []);
  const loadLcrRules = useCallback(() => fetch('/backend/api/sbc/lcr/rules').then(r => r.json()).then(d => Array.isArray(d) && setLcrRules(d)).catch(() => {}), []);
  async function addGw() { if (!gwForm.address.trim()) return; setLcrBusy('gw'); await fetch('/backend/api/sbc/lcr/gateways', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gwForm) }).catch(() => {}); setGwForm({ address: '', strip: 0, pri_prefix: '', description: '' }); setLcrBusy(''); setTimeout(loadLcrGw, 600); toast('Operador agregado (SBC recargado)', 'ok'); }
  async function delGw(id) { setLcrBusy('g' + id); await fetch('/backend/api/sbc/lcr/gateways/' + id, { method: 'DELETE' }).catch(() => {}); setLcrBusy(''); setTimeout(loadLcrGw, 600); }
  async function addRule() { if (!ruleForm.gwlist.trim()) return; setLcrBusy('rule'); await fetch('/backend/api/sbc/lcr/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ruleForm) }).catch(() => {}); setRuleForm({ prefix: '', gwlist: '', description: '' }); setLcrBusy(''); setTimeout(loadLcrRules, 600); toast('Regla agregada (SBC recargado)', 'ok'); }
  async function delRule(id) { setLcrBusy('r' + id); await fetch('/backend/api/sbc/lcr/rules/' + id, { method: 'DELETE' }).catch(() => {}); setLcrBusy(''); setTimeout(loadLcrRules, 600); }
  useEffect(() => { const lf = () => fetch('/backend/api/extensions').then(r => r.json()).then(d => { if (Array.isArray(d)) setExtList(d); }).catch(() => {}); lf(); const t = setInterval(lf, 7000); return () => clearInterval(t); }, []);
  useEffect(() => { const lf = () => fetch('/backend/api/security').then((r) => r.json()).then(setF2b).catch(() => {}); lf(); loadSecf(); loadLcrGw(); loadLcrRules(); loadSm(); const t = setInterval(lf, 8000); return () => clearInterval(t); }, []);
  const [routes, setRoutes] = useState([]); const [rt, setRt] = useState({ dest: '', gw: '', dev: '', note: '' }); const [editId, setEditId] = useState(null);
  const loadRoutes = useCallback(async () => { try { const d = await fetch('/backend/api/sbc/routes').then(r => r.json()); if (Array.isArray(d)) setRoutes(d); } catch (_) {} }, []);
  useEffect(() => { loadRoutes(); }, [loadRoutes]);
  useEffect(() => { const l = sbc?.stats?.modules?.feats_cfg?.dialog_limits?.limit; if (l) setFeatLimit(l); }, [sbc]);
  async function addRoute() {
    if (!rt.dest.trim() || (!rt.gw.trim() && !rt.dev.trim())) { toast('Indicá destino y gateway o interfaz', 'bad'); return; }
    setBusy('route_add');
    if (editId) { await fetch('/backend/api/sbc/routes/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editId }) }).catch(() => {}); await sleep(300); }
    const r = await fetch('/backend/api/sbc/routes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rt) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setBusy('');
    if (r.error) { toast(r.error === 1 ? 'No se pudo guardar' : r.error, 'bad'); return; }
    setRt({ dest: '', gw: '', dev: '', note: '' }); setEditId(null); toast(editId ? 'Ruta actualizada' : 'Ruta agregada (se aplica en ~6s)', 'ok'); await sleep(800); loadRoutes();
  }
  async function delRoute(id, dest) {
    if (!confirm('¿Quitar la ruta ' + dest + '?')) return;
    setBusy('route_del' + id);
    await fetch('/backend/api/sbc/routes/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {});
    setBusy(''); toast('Ruta quitada', 'ok'); await sleep(800); loadRoutes();
  }
  const fdur = (st) => { if (!st) return '—'; const d = Math.floor((now - new Date(st).getTime()) / 1000); const m = Math.floor(d / 60), ss = d % 60; return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss; };
  useEffect(() => { if (!cfgLoaded.current) { cfgLoaded.current = true; fetch('/backend/api/sbc/cfg').then(r => r.json()).then(d => { setCfg(d.cfg || ''); setCfgOrig(d.cfg || ''); }).catch(() => {}); } }, []);

  const sendCmd = useCallback(async (cmd, arg, opts = {}) => {
    setBusy(cmd + (arg || ''));
    const r = await fetch('/backend/api/sbc/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, arg }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    if (r.error || !r.id) { setBusy(''); toast('No se pudo enviar el comando', 'bad'); return null; }
    let res = null;
    for (let i = 0; i < 15; i++) { await sleep(1100); const s = await fetch('/backend/api/sbc/cmd/' + r.id).then(x => x.json()).catch(() => ({})); if (s.done) { res = s.result; break; } }
    setBusy(''); load();
    if (!opts.silent) toast(res ? (res.length > 40 ? 'Listo' : res) : 'Aplicado', res && /error|INVALID|fallo/i.test(res) ? 'bad' : 'ok');
    return res;
  }, [load]);

  const stats = sbc?.stats || {}; const core = stats.core || {}; const sl = stats.sl || {}; const shm = stats.shmem || {}; const rates = stats.rates || {};
  const disp = sbc?.dispatcher || []; const dispMain = disp.filter(d => Number(d.set || 1) !== 2); const opHealth = (addr) => { const d = disp.find(x => Number(x.set) === 2 && (x.uri || '').includes(addr)); if (!d) return null; const f = (d.flags || ''); return { state: f.charAt(0) === 'A' ? 'up' : f.charAt(0) === 'I' ? 'down' : 'probing', flags: f, latency: d.latency }; }; const banned = sbc?.banned || []; const rtp = sbc?.rtpengine || {};
  const net = stats.net || {}; const ifaces = net.ifaces || []; const liveRoutes = net.routes || [];
  const memPct = shm.total_size ? Math.round((shm.used_size / shm.total_size) * 100) : 0;
  const flagInfo = (f) => /A/.test(f) ? { c: 'teal', t: 'Activo' } : /I/.test(f) ? { c: 'orange', t: 'Inactivo' } : /D/.test(f) ? { c: 'red', t: 'Deshabilitado' } : { c: 'gray', t: f || '-' };

  async function saveCfg() {
    setCfgBusy(true); setCfgMsg('Validando con kamailio -c...');
    const b64 = btoa(unescape(encodeURIComponent(cfg)));
    const res = await sendCmd('cfg_save', b64, { silent: true });
    setCfgBusy(false);
    if (res && /INVALID/i.test(res)) { setCfgMsg('ERROR: ' + res); toast('Config invalida (no se aplico)', 'bad'); }
    else if (res && /aplicado/i.test(res)) { setCfgMsg('OK: ' + res); setCfgOrig(cfg); toast('Config aplicada y SBC-NG reiniciado', 'ok'); }
    else { setCfgMsg(res || 'Sin respuesta del agente'); }
  }
  const reqRow = (label, k) => <Table.Tr><Table.Td>{label}</Table.Td><Table.Td ta="right" ff="monospace"><Slot value={(core[k] ?? 0).toLocaleString()} /></Table.Td><Table.Td ta="right" c="dimmed">{rates[k] != null ? <><Slot value={rates[k]} />/s</> : ''}</Table.Td></Table.Tr>;

  // Accesos directos (los más usados) + grupos desplegables para el resto
  const SBC_NAV = [
    { v: 'mon', label: 'Monitoreo', icon: <IconActivity size={16} /> },
    { v: 'trunks', label: 'Troncales', icon: <IconDeviceLandlinePhone size={16} /> },
    { v: 'turn', label: 'TURN', icon: <IconCloud size={16} /> },
    { v: 'sec', label: 'Seguridad', icon: <IconShieldLock size={16} />, badge: banned.length || 0, bcolor: 'red' },
    { key: 'route', label: 'Ruteo', icon: <IconRoute size={16} />, items: [
      { v: 'lcr', label: 'Operadores', icon: <IconRoute size={15} /> },
      { v: 'smanip', label: 'Manipulación SIP', icon: <IconReplace size={15} /> },
      { v: 'disp', label: 'Dispatcher', icon: <IconRouteAltLeft size={15} /> },
      { v: 'remext', label: 'Remotos', icon: <IconWorld size={15} />, badge: remExt.length || 0, bcolor: 'grape' },
    ] },
    { key: 'netmedia', label: 'Red y Media', icon: <IconNetwork size={16} />, items: [
      { v: 'net', label: 'Red', icon: <IconNetwork size={15} /> },
      { v: 'rtp', label: 'rtpengine', icon: <IconArrowsLeftRight size={15} /> },
      { v: 'sip', label: 'SIP debug', icon: <IconBug size={15} /> },
    ] },
    { key: 'sys', label: 'Sistema', icon: <IconCpu size={16} />, items: [
      { v: 'adv', label: 'Módulos', icon: <IconCpu size={15} /> },
      { v: 'cfg', label: 'Configuración', icon: <IconFileCode size={15} /> },
    ] },
  ];

  return (
    <Tabs value={tab} onChange={setTab} variant="pills" radius="md" keepMounted={false}>
      <Group gap="xs" mb="md">
        {SBC_NAV.map((g) => {
          if (!g.items) { const active = tab === g.v; return (
            <Button key={g.v} variant={active ? 'filled' : 'subtle'} color={active ? 'blue' : 'gray'} size="sm" radius="md" leftSection={g.icon}
              rightSection={g.badge ? <Badge size="xs" color={g.bcolor || 'red'} variant="filled">{g.badge}</Badge> : null}
              onClick={() => setTab(g.v)}>{g.label}</Button>); }
          const active = g.items.some((it) => it.v === tab); return (
          <Menu key={g.key} trigger="click-hover" openDelay={60} closeDelay={140} position="bottom-start" radius="md" shadow="md" withinPortal>
            <Menu.Target><Button variant={active ? 'filled' : 'subtle'} color={active ? 'blue' : 'gray'} size="sm" radius="md" leftSection={g.icon} rightSection={<IconChevronDown size={14} />}>{g.label}</Button></Menu.Target>
            <Menu.Dropdown>
              {g.items.map((it) => <Menu.Item key={it.v} leftSection={it.icon} onClick={() => setTab(it.v)} style={it.v === tab ? { background: 'var(--mantine-color-blue-light)', fontWeight: 600 } : undefined} rightSection={it.badge ? <Badge size="xs" color={it.bcolor || 'red'} variant="filled">{it.badge}</Badge> : null}>{it.label}</Menu.Item>)}
            </Menu.Dropdown>
          </Menu>); })}
      </Group>

      <Tabs.Panel value="mon">
        <SimpleGrid cols={{ base: 1, sm: 3 }} mb="md">
          <Spark data={hist.map(p => p.req)} color="#2f74e6" label="SIP requests / s" accent="blue" />
          <Spark data={hist.map(p => p.sess)} color="#14b8a6" label="Sesiones de medios" accent="teal" />
          <Spark data={hist.map(p => p.mem)} color="#a855f7" label="Memoria compartida" unit="%" accent="grape" />
        </SimpleGrid>
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} mb="md">
          <Kpi icon={<IconClock size={20} />} color="grape" label="Uptime" value={fmtUptime(sbc?.uptime)} />
          <Kpi icon={<IconActivity size={20} />} color="blue" label="Req recibidas/s" value={rates.rcv_requests != null ? rates.rcv_requests : '-'} sub={'tot ' + (core.rcv_requests ?? 0)} />
          <Kpi icon={<IconArrowsLeftRight size={20} />} color="teal" label="Sesiones media" value={rtp.sessions ?? 0} sub={rtp.up ? 'rtpengine ok' : 'inactivo'} />
          <Kpi icon={<IconBan size={20} />} color={banned.length ? 'red' : 'gray'} label="IPs bloqueadas" value={banned.length} />
          <Kpi icon={<IconPlugConnected size={20} />} color="indigo" label="Conexiones TCP" value={stats.tcp_open ?? 0} />
          <Kpi icon={<IconCpu size={20} />} color={memPct > 80 ? 'red' : 'cyan'} label="Memoria compartida" value={memPct + '%'} sub={Math.round((shm.used_size || 0) / 1048576) + '/' + Math.round((shm.total_size || 0) / 1048576) + ' MB'} />
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Card withBorder radius="md" padding="md">
            <Text fw={700} mb="xs">Trafico SIP</Text>
            <Table verticalSpacing={6}><Table.Thead><Table.Tr><Table.Th>Contador</Table.Th><Table.Th ta="right">Total</Table.Th><Table.Th ta="right">Tasa</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {reqRow('Requests recibidas', 'rcv_requests')}{reqRow('Requests reenviadas', 'fwd_requests')}{reqRow('Replies recibidas', 'rcv_replies')}{reqRow('Replies reenviadas', 'fwd_replies')}{reqRow('Requests descartadas', 'drop_requests')}{reqRow('Requests con error', 'err_requests')}
              </Table.Tbody></Table>
          </Card>
          <Card withBorder radius="md" padding="md">
            <Text fw={700} mb="xs">Respuestas (stateless)</Text>
            <Group gap="xs">
              {[['1xx', sl['1xx_replies']], ['2xx', sl['2xx_replies']], ['3xx', sl['3xx_replies']], ['4xx', sl['4xx_replies']], ['5xx', sl['5xx_replies']], ['6xx', sl['6xx_replies']], ['404', sl['404_replies']], ['407', sl['407_replies']], ['480', sl['480_replies']]].map(([k, v]) => v != null && <Badge key={k} variant="light" color={k[0] === '2' ? 'teal' : k[0] === '4' || k[0] === '5' || k[0] === '6' ? 'orange' : 'gray'} radius="sm">{k}: <Slot value={v} /></Badge>)}
            </Group>
            <Divider my="sm" />
            <Text size="sm" c="dimmed">Memoria SBC-NG</Text>
            <Progress value={memPct} color={memPct > 80 ? 'red' : 'teal'} mt={6} />
            <Text size="xs" c="dimmed" mt={4}>{Math.round((shm.used_size || 0) / 1048576)} MB usados - {shm.fragments || 0} fragmentos - max {Math.round((shm.max_used_size || 0) / 1048576)} MB</Text>
          </Card>
        </SimpleGrid>
      </Tabs.Panel>

      <Tabs.Panel value="sec">
        <Card withBorder radius="md" padding="md" mb="md">
          <Group justify="space-between" mb="sm"><Text fw={700}>IPs bloqueadas (ipban)</Text>
            <Group gap="xs">
              <TextInput placeholder="Bloquear IP... (ej 1.2.3.4)" value={banIp} onChange={e => setBanIp(e.target.value)} w={200} size="xs" />
              <Button size="xs" color="red" variant="light" leftSection={<IconBan size={14} />} disabled={!banIp} loading={busy === 'ban' + banIp} onClick={async () => { await sendCmd('ban', banIp); setBanIp(''); }}>Bloquear</Button>
              <Button size="xs" variant="default" leftSection={<IconTrash size={14} />} loading={busy === 'unban_all'} onClick={() => sendCmd('unban_all')}>Limpiar todo</Button>
            </Group>
          </Group>
          {banned.length === 0 ? <Text size="sm" c="dimmed">Sin IPs bloqueadas.</Text> :
            <Table highlightOnHover><Table.Thead><Table.Tr><Table.Th>IP</Table.Th><Table.Th ta="right">Accion</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{banned.map(ip => <Table.Tr key={ip}><Table.Td ff="monospace">{ip}</Table.Td><Table.Td ta="right"><Button size="compact-xs" variant="light" color="teal" loading={busy === 'unban' + ip} onClick={() => sendCmd('unban', ip)}>Desbloquear</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table>}
        </Card>
        <Card withBorder radius="md" padding="md" mb="md">
          <Group justify="space-between" mb="sm"><Text fw={700}>Lista de bloqueo SIP (secfilter)</Text>
            <Group gap="xs">
              <Select size="xs" w={130} data={[{ value: '0', label: 'User-Agent' }, { value: '3', label: 'IP' }, { value: '4', label: 'Usuario' }, { value: '2', label: 'Dominio' }]} value={sfType} onChange={(v) => setSfType(v || '0')} />
              <TextInput size="xs" w={200} placeholder="valor a bloquear" value={sfData} onChange={e => setSfData(e.target.value)} />
              <Button size="xs" color="red" variant="light" leftSection={<IconBan size={14} />} loading={sfBusy === 'add'} disabled={!sfData.trim()} onClick={addSecf}>Bloquear</Button>
            </Group>
          </Group>
          {secf.length === 0 ? <Text size="sm" c="dimmed">Sin reglas. Bloquea User-Agents de scanners, IPs o usuarios; se aplica al instante.</Text> :
            <Table highlightOnHover><Table.Thead><Table.Tr><Table.Th>Tipo</Table.Th><Table.Th>Valor</Table.Th><Table.Th ta="right">Accion</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{secf.map(r => <Table.Tr key={r.id}><Table.Td><Badge size="sm" variant="light" color={r.action ? 'teal' : 'red'}>{SECF_TYPE[r.type] || ('tipo ' + r.type)}{r.action ? ' (permitir)' : ''}</Badge></Table.Td><Table.Td ff="monospace" fz="xs">{r.data}</Table.Td><Table.Td ta="right"><Button size="compact-xs" variant="light" color="gray" loading={sfBusy === 'd' + r.id} onClick={() => delSecf(r.id)}>Quitar</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table>}
        </Card>
        <Card withBorder radius="md" padding="md">
          <Text fw={700} mb="xs">Anti-flood (pike)</Text>
          <Text size="sm" c="dimmed">{(stats.pike_count || 0) === 0 ? 'Sin fuentes sospechosas en seguimiento.' : (stats.pike_count + ' IP(s) en seguimiento por pike.')}</Text>
          {(stats.pike || []).length > 0 && <Group gap={6} mt="xs">{stats.pike.map(ip => <Badge key={ip} variant="light" color="orange">{ip}</Badge>)}</Group>}
        </Card>
      </Tabs.Panel>

      <Tabs.Panel value="disp">
        <Card withBorder radius="md" padding="md" mb="md" style={{ background: 'var(--mantine-color-grape-light)' }}>
          <Group gap="xs" mb={4}><IconInfoCircle size={16} /><Text fw={700} size="sm">¿Qué es el dispatcher?</Text></Group>
          <Text size="sm" c="dimmed">SBC-NG (el SBC de borde) recibe las llamadas SIP y las <b>reparte</b> hacia uno o más servidores Asterisk de este grupo de destinos. Si agregás varios Asterisk, balancea y hace <b>failover</b>: si uno queda Inactivo, deriva a otro. Cada destino tiene una <b>prioridad</b> (mayor = se prefiere) y SBC-NG mide su <b>latencia</b> con pings (OPTIONS). Estados: <Badge size="xs" variant="light" color="teal">Activo</Badge> responde, <Badge size="xs" variant="light" color="orange">Inactivo</Badge> no responde los pings, <Badge size="xs" variant="light" color="red">Deshabilitado</Badge> apagado manualmente.</Text>
        </Card>
        <Card withBorder radius="md" padding="md" mb="md" style={{ background: 'var(--mantine-color-blue-light)' }}>
          <Group gap="xs" mb={4}><IconInfoCircle size={16} /><Text fw={700} size="sm">Llamadas salientes (importante)</Text></Group>
          <Text size="sm" c="dimmed">El dispatcher cubre el sentido <b>SBC &rarr; Asterisk</b> (entrantes). Para las <b>salientes</b> (Asterisk &rarr; proveedor a través del SBC) hace falta crear en Asterisk una <b>troncal interna hacia el SBC</b> (identificada por IP). Sin esa troncal, las llamadas salientes por el proveedor no funcionan. Configurala en <b>Asterisk &rarr; Troncal SBC</b>.</Text>
          <Button mt="sm" size="xs" variant="light" component="a" href="/asterisk" leftSection={<IconDeviceLandlinePhone size={14} />}>Ir a Asterisk &rarr; Troncal SBC</Button>
        </Card>
        <Card withBorder radius="md" padding="md">
          <Group justify="space-between" mb="sm"><Text fw={700}>Destinos del dispatcher ({dispMain.length})</Text><Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} loading={busy === 'reload'} onClick={() => sendCmd('reload')}>Recargar</Button></Group>
          <Group mb="md"><Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => { setDlgEdit(null); setDtUri(''); setDtPrio(0); setDlgOpen(true); }}>Nuevo destino</Button></Group>
          <Table highlightOnHover><Table.Thead><Table.Tr><Table.Th>Destino</Table.Th><Table.Th>Prioridad</Table.Th><Table.Th>Latencia</Table.Th><Table.Th>Estado</Table.Th><Table.Th ta="right">Acciones</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{dispMain.length === 0 ? <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="md" size="sm">Sin destinos. Agregá tu primer Asterisk arriba.</Text></Table.Td></Table.Tr> : dispMain.map((d, i) => { const fi = flagInfo(d.flags); const active = /A/.test(d.flags || ''); return (
              <Table.Tr key={i}>
                <Table.Td ff="monospace" fz="sm">{d.uri}</Table.Td><Table.Td>{d.priority}</Table.Td><Table.Td>{d.latency != null ? <Badge size="sm" variant="dot" color={d.latency < 50 ? 'teal' : d.latency < 200 ? 'yellow' : 'red'}><Slot value={d.latency} /> ms</Badge> : '-'}</Table.Td>
                <Table.Td><Badge variant="light" color={fi.c}>{fi.t}</Badge></Table.Td>
                <Table.Td ta="right"><Group gap={4} justify="flex-end" wrap="nowrap">{active
                  ? <Button size="compact-xs" variant="light" color="orange" leftSection={<IconPlugConnectedX size={13} />} loading={busy === 'disable_target' + d.uri} onClick={() => sendCmd('disable_target', d.uri)}>Deshabilitar</Button>
                  : <Button size="compact-xs" variant="light" color="teal" leftSection={<IconPlugConnected size={13} />} loading={busy === 'enable_target' + d.uri} onClick={() => sendCmd('enable_target', d.uri)}>Habilitar</Button>}
                  <Tooltip label="Editar"><ActionIcon variant="subtle" color="gray" onClick={() => { setDlgEdit(d); setDtUri(d.uri); setDtPrio(Number(d.priority) || 0); setDlgOpen(true); }}><IconRouteAltLeft size={15} /></ActionIcon></Tooltip><Tooltip label="Quitar destino"><ActionIcon variant="subtle" color="red" loading={busy === 'del_target' + d.uri} onClick={() => { if (confirm('¿Quitar ' + d.uri + ' del dispatcher?')) sendCmd('del_target', d.uri); }}><IconTrash size={15} /></ActionIcon></Tooltip>
                </Group></Table.Td>
              </Table.Tr>); })}</Table.Tbody></Table>
        </Card>
              <Modal opened={dlgOpen} onClose={() => setDlgOpen(false)} centered radius="lg" title={<Group gap="sm"><ThemeIcon size={34} radius="md" variant="light" color="grape"><IconRouteAltLeft size={18} /></ThemeIcon><Text fw={800}>{dlgEdit ? 'Editar destino' : 'Nuevo destino del dispatcher'}</Text></Group>}>
          <Stack gap="md">
            {dlgEdit && (() => { const fi = flagInfo(dlgEdit.flags); const active = /A/.test(dlgEdit.flags || ''); return <Group gap="xs"><Badge variant="light" color={fi.c}>{fi.t}</Badge>{active && dlgEdit.latency != null && <Badge variant="dot" color={dlgEdit.latency < 50 ? 'teal' : dlgEdit.latency < 200 ? 'yellow' : 'red'}>{Math.round(dlgEdit.latency)} ms</Badge>}</Group>; })()}
            <TextInput label="Destino (Asterisk)" description="IP o sip:host:puerto. Ej: ip-del-asterisk o sip:ip-del-asterisk:5060" placeholder="ip-del-asterisk" value={dtUri} onChange={(e) => setDtUri(e.target.value)} leftSection={<IconServer2 size={15} />} required />
            <NumberInput label="Prioridad" description="Mayor = se prefiere primero (failover al resto)" value={dtPrio} onChange={setDtPrio} min={0} max={100} w={160} />
            <Group justify="space-between"><Text size="xs" c="dimmed">Se mide latencia con OPTIONS automáticamente tras agregar.</Text><Button color="grape" onClick={saveTgt}>{dlgEdit ? 'Guardar' : 'Agregar destino'}</Button></Group>
          </Stack>
        </Modal>
      </Tabs.Panel>

      <Tabs.Panel value="trunks"><Troncales /></Tabs.Panel>

      <Tabs.Panel value="smanip">
        <Stack gap="md" mt="md">
          <Card withBorder radius="md" padding="md" style={{ background: 'var(--mantine-color-grape-light)' }}>
            <Group gap="xs" mb={4}><IconReplace size={16} /><Text fw={700} size="sm">Manipulación SIP avanzada (salientes a operadores)</Text></Group>
            <Text size="xs" c="dimmed">Reescribe headers SIP por operador para cumplir formatos propietarios (P-Preferred/Asserted-Identity, Diversion, From, etc.). Por defecto NO hay manipulación (no rompe nada). Usá "Reglas compatibles" para cargar una librería de reglas comunes (vienen desactivadas salvo las 100% seguras) y activá solo las que tu operador exija.</Text>
            <Group gap="xs" mt="sm">
              <Button size="xs" variant="light" color="grape" leftSection={<IconPlus size={14} />} loading={smBusy === 'pre'} onClick={presetsSm}>Generar reglas compatibles</Button>
              <Button size="xs" variant="subtle" color="gray" loading={smBusy === 'reset'} onClick={resetSm}>Restaurar sin manipulación</Button>
            </Group>
          </Card>
          <Card withBorder radius="md" padding="lg">
            <Text fw={700} mb="sm">Nueva regla</Text>
            <Group align="end" gap="xs" wrap="wrap">
              <Select size="xs" label="Acción" w={180} data={[{ value: 'remove_header', label: 'Quitar header' }, { value: 'add_header', label: 'Agregar header' }, { value: 'set_from_user', label: 'Forzar From-user' }, { value: 'set_ppi', label: 'P-Preferred-Identity' }, { value: 'set_pai', label: 'P-Asserted-Identity' }, { value: 'set_diversion', label: 'Diversion (desvío)' }, { value: 'modify_header', label: 'Modificar (regex)' }]} value={smForm.action} onChange={(v) => setSmForm(f => ({ ...f, action: v || 'remove_header' }))} />
              <Select size="xs" label="Operador" w={200} data={[{ value: 'all', label: 'Todos los operadores' }, ...lcrGws.map(g => ({ value: (g.address || '').split(':')[0], label: g.description || g.address }))]} value={smForm.scope} onChange={(v) => setSmForm(f => ({ ...f, scope: v || 'all' }))} />
              {['remove_header', 'add_header', 'modify_header'].includes(smForm.action) && <TextInput size="xs" label="Header" placeholder="P-Asserted-Identity" w={170} value={smForm.header} onChange={(e) => setSmForm(f => ({ ...f, header: e.target.value }))} />}
              {smForm.action === 'modify_header' && <TextInput size="xs" label="Buscar (regex)" placeholder="patrón" w={130} value={smForm.match} onChange={(e) => setSmForm(f => ({ ...f, match: e.target.value }))} />}
              {smForm.action !== 'remove_header' && <TextInput size="xs" label="Valor" placeholder="$fU o texto" w={160} value={smForm.value} onChange={(e) => setSmForm(f => ({ ...f, value: e.target.value }))} />}
              <Button size="xs" leftSection={<IconPlus size={14} />} loading={smBusy === 'add'} onClick={addSm}>Agregar</Button>
            </Group>
            <Text size="xs" c="dimmed" mt={6}>Variables: $fU (usuario From / origen), $rU (número marcado). El operador se matchea por su IP; "Todos" aplica global.</Text>
          </Card>
          <Card withBorder radius="md" padding="lg">
            <Text fw={700} mb="sm">Reglas ({smRules.length})</Text>
            {smRules.length === 0 ? <Text c="dimmed" size="sm">Sin reglas — sin manipulación (default seguro).</Text> :
            <Table striped highlightOnHover withTableBorder verticalSpacing={6}>
              <Table.Thead><Table.Tr><Table.Th>Operador</Table.Th><Table.Th>Acción</Table.Th><Table.Th>Header / Valor</Table.Th><Table.Th>Descripción</Table.Th><Table.Th>Estado</Table.Th><Table.Th></Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{smRules.map(r => <Table.Tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.5 }}>
                <Table.Td><Badge size="sm" variant="light" color={r.scope === 'all' ? 'gray' : 'grape'}>{r.scope === 'all' ? 'Todos' : r.scope}</Badge></Table.Td>
                <Table.Td fz="xs">{SM_ACTION_LABEL[r.action] || r.action}</Table.Td>
                <Table.Td ff="monospace" fz="xs">{[r.header, r.value].filter(Boolean).join(': ') || '—'}</Table.Td>
                <Table.Td fz="xs" c="dimmed" maw={260}>{r.description || ''}</Table.Td>
                <Table.Td><Switch size="sm" checked={!!r.enabled} disabled={smBusy === 't' + r.id} onChange={() => toggleSm(r.id)} /></Table.Td>
                <Table.Td ta="right"><Button size="compact-xs" variant="subtle" color="red" loading={smBusy === 'd' + r.id} onClick={() => delSm(r.id)}>Quitar</Button></Table.Td>
              </Table.Tr>)}</Table.Tbody>
            </Table>}
          </Card>
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="lcr">
        <Stack gap="md" mt="md">
          <Card withBorder radius="md" padding="md" style={{ background: 'var(--mantine-color-blue-light)' }}>
            <Group gap="xs" wrap="nowrap"><ThemeIcon variant="light" color="blue" size="md"><IconInfoCircle size={16} /></ThemeIcon><Text size="xs">En las llamadas salientes a operadores, el SBC anuncia su IP publica y oculta la topologia interna (version de software y headers internos) para maxima interoperabilidad y privacidad. El failover entre operadores es automatico segun el orden de la regla.</Text></Group>
          </Card>
          <Card withBorder radius="md" padding="lg">
            <Group justify="space-between" mb="sm">
              <div><Text fw={700}>Operadores de salida (gateways)</Text><Text size="xs" c="dimmed">Las llamadas salientes se entregan a estos operadores en orden; si uno falla (timeout o 5xx), el SBC reintenta por el siguiente. Esto es el failover.</Text></div>
              <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => { loadLcrGw(); loadLcrRules(); }}>Recargar</Button>
            </Group>
            <Group align="end" gap="xs" mb="sm" wrap="wrap">
              <TextInput size="xs" label="Direccion (host:puerto)" placeholder="190.64.60.10:5060" w={190} value={gwForm.address} onChange={e => setGwForm(f => ({ ...f, address: e.target.value }))} />
              <NumberInput size="xs" label="Strip" w={75} min={0} value={gwForm.strip} onChange={v => setGwForm(f => ({ ...f, strip: +v || 0 }))} />
              <TextInput size="xs" label="Prefijo" placeholder="opcional" w={100} value={gwForm.pri_prefix} onChange={e => setGwForm(f => ({ ...f, pri_prefix: e.target.value }))} />
              <TextInput size="xs" label="Descripcion" placeholder="Operador A" w={150} value={gwForm.description} onChange={e => setGwForm(f => ({ ...f, description: e.target.value }))} />
              <Button size="xs" leftSection={<IconPlus size={14} />} loading={lcrBusy === 'gw'} onClick={addGw}>Agregar</Button>
            </Group>
            {lcrGws.length === 0 ? <Text c="dimmed" size="sm">Sin operadores. Agrega al menos uno.</Text> :
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead><Table.Tr><Table.Th>ID</Table.Th><Table.Th>Direccion</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Strip</Table.Th><Table.Th>Prefijo</Table.Th><Table.Th>Descripcion</Table.Th><Table.Th></Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{lcrGws.map(g => <Table.Tr key={g.gwid}><Table.Td><Badge size="sm" variant="light">{g.gwid}</Badge></Table.Td><Table.Td ff="monospace" fz="xs">{g.address}</Table.Td>{(() => { const h = opHealth(g.address); return <Table.Td>{h ? <Badge size="sm" variant="light" color={h.state === 'up' ? 'teal' : h.state === 'down' ? 'red' : 'gray'} leftSection={<span className="pbx-pip" style={{ background: h.state === 'up' ? 'var(--mantine-color-teal-6)' : h.state === 'down' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-gray-5)' }} />}>{h.state === 'up' ? 'Activo' : h.state === 'down' ? 'Caído' : 'Probando'}</Badge> : <Badge size="sm" variant="light" color="gray">sin sonda</Badge>}</Table.Td>; })()}<Table.Td>{g.strip}</Table.Td><Table.Td ff="monospace" fz="xs">{g.pri_prefix || '—'}</Table.Td><Table.Td fz="xs">{g.description}</Table.Td><Table.Td ta="right"><Button size="compact-xs" variant="light" color="gray" loading={lcrBusy === 'g' + g.gwid} onClick={() => delGw(g.gwid)}>Quitar</Button></Table.Td></Table.Tr>)}</Table.Tbody>
            </Table>}
          </Card>
          <Card withBorder radius="md" padding="lg">
            <div><Text fw={700} mb={4}>Reglas de ruteo (LCR)</Text><Text size="xs" c="dimmed" mb="sm">Por prefijo del numero marcado, define el orden de operadores. La lista es por IDs separados por coma (ej "1,2") y ese es el orden de failover. Prefijo vacio = aplica a todos.</Text></div>
            <Group align="end" gap="xs" mb="sm" wrap="wrap">
              <TextInput size="xs" label="Prefijo" placeholder="vacio = todos" w={120} value={ruleForm.prefix} onChange={e => setRuleForm(f => ({ ...f, prefix: e.target.value }))} />
              <TextInput size="xs" label="Operadores (IDs)" placeholder="1,2" w={120} value={ruleForm.gwlist} onChange={e => setRuleForm(f => ({ ...f, gwlist: e.target.value }))} />
              <TextInput size="xs" label="Descripcion" placeholder="Default" w={170} value={ruleForm.description} onChange={e => setRuleForm(f => ({ ...f, description: e.target.value }))} />
              <Button size="xs" leftSection={<IconPlus size={14} />} loading={lcrBusy === 'rule'} onClick={addRule}>Agregar</Button>
            </Group>
            {lcrRules.length === 0 ? <Text c="dimmed" size="sm">Sin reglas.</Text> :
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead><Table.Tr><Table.Th>ID</Table.Th><Table.Th>Prefijo</Table.Th><Table.Th>Operadores</Table.Th><Table.Th>Descripcion</Table.Th><Table.Th></Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{lcrRules.map(r => <Table.Tr key={r.ruleid}><Table.Td><Badge size="sm" variant="light">{r.ruleid}</Badge></Table.Td><Table.Td ff="monospace" fz="xs">{r.prefix || '(todos)'}</Table.Td><Table.Td ff="monospace" fz="xs">{r.gwlist}</Table.Td><Table.Td fz="xs">{r.description}</Table.Td><Table.Td ta="right"><Button size="compact-xs" variant="light" color="gray" loading={lcrBusy === 'r' + r.ruleid} onClick={() => delRule(r.ruleid)}>Quitar</Button></Table.Td></Table.Tr>)}</Table.Tbody>
            </Table>}
          </Card>
        </Stack>
      </Tabs.Panel>
      <Tabs.Panel value="remext">
        <Stack gap="md" mt="md">
          <Card withBorder radius="md" padding="md">
            <Group justify="space-between" mb="sm">
              <Group gap="xs"><Text fw={700}>Extensiones remotas (por el SBC)</Text><Badge color="grape" variant="light">{remExt.length}</Badge></Group>
              <Text size="xs" c="dimmed">Internos que registran a través de SBC-NG (no directo a Asterisk)</Text>
            </Group>
            {remExt.length === 0
              ? <Text c="dimmed" size="sm" py="md" ta="center">Ningún interno registrado por el SBC en este momento.</Text>
              : <Table striped highlightOnHover verticalSpacing="sm">
                  <Table.Thead><Table.Tr><Table.Th>Interno</Table.Th><Table.Th>Nombre</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Origen real</Table.Th><Table.Th>Proto</Table.Th><Table.Th>RTT</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {remExt.map(e => <Table.Tr key={e.id}>
                      <Table.Td ff="monospace" fw={600}>{e.id}</Table.Td>
                      <Table.Td>{e.name || <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                      <Table.Td><Badge variant="light" color={e.channels > 0 ? 'orange' : e.status === 'online' ? 'teal' : 'gray'} leftSection={<span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: e.channels > 0 ? '#f59e0b' : e.status === 'online' ? '#22c55e' : '#9aa3b2' }} />}>{e.channels > 0 ? 'En llamada' : e.status === 'online' ? 'Registrado' : 'Desconectado'}</Badge></Table.Td>
                      <Table.Td><Text ff="monospace" size="xs">{e.origin || '—'}</Text></Table.Td>
                      <Table.Td><Badge size="sm" variant="dot" color="blue">{(e.vproto || 'udp').toUpperCase()}</Badge></Table.Td>
                      <Table.Td>{e.rtt != null ? <Badge size="sm" variant="dot" color="teal"><Slot value={e.rtt.toFixed(0)} /> ms</Badge> : <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                    </Table.Tr>)}
                  </Table.Tbody>
                </Table>}
          </Card>
        </Stack>
      </Tabs.Panel>


      <Tabs.Panel value="net">
        <Card withBorder radius="md" padding="md" mb="md" style={{ background: 'var(--mantine-color-cyan-light)' }}>
          <Group gap="xs" mb={4}><IconInfoCircle size={16} /><Text fw={700} size="sm">Multi-WAN y rutas estáticas</Text></Group>
          <Text size="sm" c="dimmed">El SBC puede tener <b>varias salidas a internet</b> (distintas WAN/interfaces). Por defecto todo sale por la ruta <Code>default</Code>. Acá podés crear <b>rutas estáticas</b> para forzar que el tráfico hacia una troncal o red específica salga por otro <b>gateway</b> o <b>interfaz</b>, sin depender del router de internet principal. Las rutas se reaplican automáticamente tras reiniciar el SBC.</Text>
        </Card>
        <SimpleGrid cols={{ base: 1, md: 2 }} mb="md">
          <Card withBorder radius="md" padding="md">
            <Text fw={700} mb="xs">Interfaces / WAN</Text>
            {ifaces.length === 0 ? <Text size="sm" c="dimmed">Sin datos del agente todavía.</Text> :
              <Table verticalSpacing={6}><Table.Thead><Table.Tr><Table.Th>Interfaz</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Direcciones</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{ifaces.map(f => <Table.Tr key={f.name}>
                  <Table.Td><Group gap={6} wrap="nowrap"><IconRouter size={15} color="var(--mantine-color-cyan-6)" /><Text ff="monospace" fz="sm">{f.name}</Text></Group></Table.Td>
                  <Table.Td><Badge size="sm" variant="light" color={/UP/i.test(f.state) ? 'teal' : 'gray'}>{f.state || '-'}</Badge></Table.Td>
                  <Table.Td>{(f.addrs || []).map(a => <Text key={a} ff="monospace" fz="xs">{a}</Text>)}</Table.Td>
                </Table.Tr>)}</Table.Tbody></Table>}
          </Card>
          <Card withBorder radius="md" padding="md">
            <Text fw={700} mb="xs">Tabla de ruteo del kernel (en vivo)</Text>
            {liveRoutes.length === 0 ? <Text size="sm" c="dimmed">Sin datos.</Text> :
              <ScrollArea.Autosize mah={220}><Stack gap={4}>{liveRoutes.map((r, i) => <Group key={i} gap={6} wrap="nowrap"><IconRoute size={13} color="var(--mantine-color-gray-5)" /><Text ff="monospace" fz="xs">{r}</Text></Group>)}</Stack></ScrollArea.Autosize>}
          </Card>
        </SimpleGrid>
        <RoutesPanel scope="sbc" />
      </Tabs.Panel>

      <Tabs.Panel value="rtp">
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} mb="md">
          <Kpi icon={<IconArrowsLeftRight size={20} />} color={rtp.up ? 'teal' : 'red'} label="Estado" value={rtp.up ? 'Activo' : 'Inactivo'} />
          <Kpi icon={<IconActivity size={20} />} color="blue" label="Sesiones media" value={rtp.sessions ?? 0} />
          <Kpi icon={<IconPlugConnected size={20} />} color="indigo" label="Paquetes/s" value={(rtp.pps ?? 0).toLocaleString()} />
          <Kpi icon={<IconCpu size={20} />} color="cyan" label="Tráfico" value={(((rtp.bps ?? 0) * 8) / 1e6).toFixed(2) + ' Mbps'} sub={((rtp.bps ?? 0) / 1048576).toFixed(2) + ' MB/s'} />
          <Kpi icon={<IconAlertTriangle size={20} />} color={(rtp.errps || 0) > 0 ? 'red' : 'gray'} label="Errores/s" value={rtp.errps ?? 0} />
          <Kpi icon={<IconReload size={20} />} color="grape" label="Transcodif." value={rtp.transcoded ?? 0} />
        </SimpleGrid>
        <Card withBorder radius="md" padding="md" mb="md">
          <Group justify="space-between" mb="sm"><Group gap="xs"><Text fw={700}>Flujos de medios en vivo</Text>{ch.length > 0 && <Badge color="teal" variant="light" leftSection={<span className="pbx-pip pbx-pulse" style={{ background: 'var(--mantine-color-teal-6)' }} />}><Slot value={ch.length} /> activo(s)</Badge>}</Group></Group>
          {ch.length === 0 ? <Text size="sm" c="dimmed" ta="center" py="md">No hay llamadas con medios en curso.</Text> :
            <Table highlightOnHover verticalSpacing={6}><Table.Thead><Table.Tr><Table.Th>Origen</Table.Th><Table.Th>Conectado con</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Duración</Table.Th><Table.Th>Canal</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{ch.map(c => (
                <Table.Tr key={c.id}>
                  <Table.Td fw={600}><Group gap={6} wrap="nowrap"><IconPhone size={14} color="var(--mantine-color-teal-6)" />{c.caller || '—'}</Group></Table.Td>
                  <Table.Td>{c.connected || '—'}</Table.Td>
                  <Table.Td><Badge size="sm" variant="light" color={/up|answer/i.test(c.state) ? 'teal' : 'yellow'}>{c.state}</Badge></Table.Td>
                  <Table.Td ff="monospace">{fdur(c.started)}</Table.Td>
                  <Table.Td><Text fz="xs" c="dimmed" ff="monospace" truncate maw={180}>{c.name}</Text></Table.Td>
                </Table.Tr>))}</Table.Tbody></Table>}
        </Card>
        <Card withBorder radius="md" padding="md" style={{ background: 'var(--mantine-color-blue-light)' }}><Group gap="xs" mb={4}><IconInfoCircle size={16} /><Text fw={700} size="sm">¿Qué hace rtpengine?</Text></Group><Text size="sm" c="dimmed">Es el motor que <b>ancla y reenvía el RTP</b> (audio/video) en el borde: oculta a Asterisk de internet, resuelve NAT y puentea WebRTC↔SIP. Cada sesión = una llamada con medios pasando por el SBC. «Paquetes/s» y «Tráfico» son el rendimiento en vivo del relay; «Transcodif.» cuenta medios que se están convirtiendo de códec.</Text></Card>
      </Tabs.Panel>

      <Tabs.Panel value="turn"><TurnConsole /></Tabs.Panel>

      <Tabs.Panel value="sip"><SipLadder /></Tabs.Panel>

      <Tabs.Panel value="adv">
        <Card withBorder radius="md" padding="md" mb="md" style={{ background: 'var(--mantine-color-grape-light)' }}>
          <Group gap="xs" mb={4}><IconInfoCircle size={16} /><Text fw={700} size="sm">SBC avanzado (Kamailio)</Text></Group>
          <Text size="sm" c="dimmed">Kamailio puede hacer mucho más como SBC: topology hiding, límite de llamadas concurrentes, accounting en el borde, LCR, rate-limiting y TLS. Acá ves qué módulos están instalados y qué features están activas. Cada activación se aplica de forma reversible (validación + backup + restart).</Text>
        </Card>
        <Card withBorder radius="md" padding="md" mb="md">
          <Text fw={700} mb="xs">Módulos cargados ({(stats.modules?.loaded || []).length})</Text>
          <Group gap={6}>{(stats.modules?.loaded || []).map((m) => <Badge key={m} variant="light" color="gray" size="sm">{m}</Badge>)}</Group>
        </Card>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          {[{ id: 'topos', mod: 'topos', label: 'Topology hiding', icon: <IconShieldLock size={18} />, desc: 'Oculta IPs y rutas internas a proveedores y clientes (privacidad/seguridad).' },
            { id: 'dialog_limits', mod: 'dialog', label: 'Límite de llamadas concurrentes', icon: <IconActivity size={18} />, desc: 'Máximo de llamadas simultáneas global y por troncal/IP (anti-fraude y capacidad).' },
            { id: 'acc', mod: 'acc', label: 'Accounting / CDR en el borde', icon: <IconFileCode size={18} />, desc: 'Registro de llamadas en el SBC, independiente de Asterisk.' },
            { id: 'topohide', label: 'Topology hiding (salientes)', icon: <IconShieldLock size={18} />, desc: 'En salientes a operadores anuncia la IP pública y oculta versión y headers internos.' },
            { id: 'sst', label: 'Session Timers (anti-zombi)', icon: <IconClock size={18} />, desc: 'Refresco de sesión RFC 4028: detecta y limpia llamadas colgadas/zombi en el borde.' },
            { id: 'drouting', mod: 'drouting', label: 'Routing avanzado / LCR', icon: <IconRoute size={18} />, desc: 'Ruteo de salientes por prefijo con failover entre operadores.', manage: 'lcr' },
            { id: 'secfilter', mod: 'secfilter', label: 'Filtro de seguridad', icon: <IconBan size={18} />, desc: 'Bloqueo por patrones, User-Agent y país.', manage: 'sec' },
            { id: 'ratelimit', mod: 'ratelimit', label: 'Rate limiting', icon: <IconActivity size={18} />, desc: 'Límites de tasa por método, más finos que pike.' },
            { id: 'tls', mod: 'tls', label: 'TLS troncales', icon: <IconShieldLock size={18} />, desc: 'Cifrado de la señalización SIP de las troncales del operador.' }].map((f) => {
            const av = f.mod ? (stats.modules?.avail || {})[f.mod] : true; const on = (stats.modules?.features || {})[f.id];
            return (<Card key={f.id} withBorder radius="md" padding="md">
              <Group justify="space-between" wrap="nowrap" mb={4}><Group gap="sm" wrap="nowrap"><ThemeIcon size={36} radius="md" variant="light" color={on ? 'teal' : av ? 'grape' : 'gray'}>{f.icon}</ThemeIcon><Text fw={700} size="sm">{f.label}</Text></Group>
                {on ? <Badge color="teal" variant="filled" size="sm">Activo</Badge> : av ? <Badge color="grape" variant="light" size="sm">Disponible</Badge> : <Badge color="gray" variant="light" size="sm">No instalado</Badge>}</Group>
              <Text size="xs" c="dimmed">{f.desc}</Text>
              {!av && f.id === 'tls' && <Text size="xs" c="orange" mt={4}>Requiere instalar kamailio-tls-modules en el CT107.</Text>}
              {av && ['topoh','dialog_limits','acc'].includes(f.id) && <Group mt="sm" gap="sm" align="center" wrap="wrap"><Switch checked={!!on} onChange={(e) => applyFeats({ ...(stats.modules?.feats_cfg || {}), [f.id]: { ...(((stats.modules?.feats_cfg || {})[f.id]) || {}), on: e.currentTarget.checked, ...(f.id === 'dialog_limits' ? { limit: featLimit } : {}) } })} onLabel="ON" offLabel="OFF" />{f.id === 'dialog_limits' && <Group gap={6} align="center"><Text size="xs" c="dimmed">Máx. simultáneas</Text><NumberInput size="xs" w={90} value={featLimit} onChange={setFeatLimit} min={1} max={2000} /><Button size="xs" variant="light" onClick={() => applyFeats({ ...(stats.modules?.feats_cfg || {}), dialog_limits: { on: true, limit: featLimit } })}>Aplicar</Button></Group>}</Group>}
              {av && !['topoh','dialog_limits','acc'].includes(f.id) && (f.manage ? <Button mt="sm" size="compact-xs" variant="light" leftSection={<IconRouteAltLeft size={13} />} onClick={() => setTab(f.manage)}>Gestionar</Button> : <Badge mt="sm" variant="dot" color={on ? 'teal' : 'gray'}>{on ? 'Gestionado en configuración' : 'Activación próximamente'}</Badge>)}
            </Card>);
          })}
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt="md">La activación de cada feature se habilita por etapas (cada una toca la configuración viva del SBC). Próximo: límite de llamadas concurrentes.</Text>
      </Tabs.Panel>

      <Tabs.Panel value="cfg">
        <Card withBorder radius="md" padding="md">
          <Group justify="space-between" mb="xs">
            <Group gap="xs"><Text fw={700}>kamailio.cfg</Text>{cfg !== cfgOrig && <Badge color="orange" variant="light">sin guardar</Badge>}</Group>
            <Group gap="xs">
              <Tooltip label="Recargar dispatcher (sin reiniciar)"><Button size="xs" variant="default" leftSection={<IconReload size={14} />} loading={busy === 'reload'} onClick={() => sendCmd('reload')}>Reload dispatcher</Button></Tooltip>
              <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={cfgBusy} disabled={cfg === cfgOrig} onClick={saveCfg}>Validar y guardar</Button>
            </Group>
          </Group>
          <Group gap="xs" mb="xs" c="orange"><IconAlertTriangle size={15} /><Text size="xs" c="dimmed">Se valida con <Code>kamailio -c</Code> antes de aplicar. Si es valido, se hace backup (.bak) y se reinicia SBC-NG (corta llamadas activas unos segundos).</Text></Group>
          <Textarea value={cfg} onChange={e => setCfg(e.target.value)} autosize minRows={18} maxRows={28} styles={{ input: { fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.5 } }} spellCheck={false} />
          {cfgMsg && <Code block mt="sm">{cfgMsg}</Code>}
        </Card>
        <Card withBorder radius="md" padding="md" mt="md">
          <Text fw={700} mb="xs">Avanzado</Text>
          <Group align="flex-end" gap="md">
            <NumberInput label="Nivel de debug (core)" value={debug} onChange={setDebug} min={-3} max={4} w={170} />
            <Button variant="light" loading={busy === 'debug' + debug} onClick={() => sendCmd('debug', debug)}>Aplicar debug</Button>
            <Divider orientation="vertical" />
            <Button color="red" variant="light" leftSection={<IconReload size={15} />} loading={busy === 'restart'} onClick={() => { if (confirm('Reiniciar SBC-NG? Corta las llamadas activas unos segundos.')) sendCmd('restart'); }}>Reiniciar SBC-NG</Button>
          </Group>
        </Card>
      </Tabs.Panel>
    </Tabs>
  );
}

export default function SbcConsole({ opened, onClose, inline = false }) {
  const [sbc, setSbc] = useState(null);
  const [hist, setHist] = useState([]);
  const load = useCallback(async () => {
    try {
      const d = await fetch('/backend/api/sbc').then(r => r.json());
      setSbc(d);
      const shm = d?.stats?.shmem || {}; const memPct = shm.total_size ? Math.round((shm.used_size / shm.total_size) * 100) : 0;
      setHist(h => [...h, { req: d?.stats?.rates?.rcv_requests || 0, sess: d?.rtpengine?.sessions || 0, mem: memPct }].slice(-40));
    } catch (_) {}
  }, []);
  useEffect(() => { if (!inline && !opened) return; load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [opened, inline, load]);

  if (inline) return <ConsoleBody sbc={sbc} load={load} hist={hist} />;

  return (
    <Modal opened={opened} onClose={onClose} fullScreen radius={0} padding={0} withCloseButton={false} styles={{ body: { padding: 0, height: '100vh' } }}>
      <Stack gap={0} h="100vh">
        <Group justify="space-between" px="lg" py="sm" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)', background: 'linear-gradient(120deg,#1d2540,#243a6b)', color: '#fff' }}>
          <Group gap="sm">
            <ThemeIcon size={40} radius="md" variant="light" color="grape"><IconRouteAltLeft size={22} /></ThemeIcon>
            <div><Text fw={800} lh={1.1}>Consola SBC-NG</Text><Text size="xs" style={{ opacity: .75 }}>{sbc?.version || 'kamailio'} - uptime {fmtUptime(sbc?.uptime)}</Text></div>
            <Badge ml="sm" variant="light" color={sbc && !sbc.error ? 'teal' : 'red'}>{sbc && !sbc.error ? 'En linea' : 'Sin datos'}</Badge>
          </Group>
          <Group gap="xs"><Tooltip label="Refrescar"><ActionIcon variant="light" color="gray" onClick={load}><IconRefresh size={18} /></ActionIcon></Tooltip><Button variant="white" color="dark" onClick={onClose}>Cerrar</Button></Group>
        </Group>
        <ScrollArea style={{ flex: 1 }} p="md"><ConsoleBody sbc={sbc} load={load} hist={hist} /></ScrollArea>
      </Stack>
    </Modal>
  );
}
