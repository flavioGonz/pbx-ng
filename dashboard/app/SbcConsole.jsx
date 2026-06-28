'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Modal, Tabs, Stack, Group, Text, Badge, Card, SimpleGrid, Table, Button, TextInput, NumberInput, Textarea, ThemeIcon, Progress, ActionIcon, Tooltip, Code, ScrollArea, Divider } from '@mantine/core';
import { IconActivity, IconShieldLock, IconRouteAltLeft, IconArrowsLeftRight, IconFileCode, IconBan, IconRefresh, IconTrash, IconPlugConnected, IconPlugConnectedX, IconDeviceFloppy, IconAlertTriangle, IconClock, IconCpu, IconReload, IconSitemap } from '@tabler/icons-react';
import { toast } from './notify';
import SbcFlow from './SbcFlow';
import Slot from './Slot';
import SipLadder from './SipLadder';
import Troncales from './troncales/page';
import { useLive } from './useLive';
import { IconPlus, IconInfoCircle, IconPhone, IconNetwork, IconRouter, IconRoute, IconWorld, IconBug, IconDeviceLandlinePhone } from '@tabler/icons-react';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
  const { snap } = useLive(); const ch = (snap && snap.channels) || [];
  const [now, setNow] = useState(Date.now()); useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const [newTgt, setNewTgt] = useState('');
  const [routes, setRoutes] = useState([]); const [rt, setRt] = useState({ dest: '', gw: '', dev: '', note: '' }); const [editId, setEditId] = useState(null);
  const loadRoutes = useCallback(async () => { try { const d = await fetch('/backend/api/sbc/routes').then(r => r.json()); if (Array.isArray(d)) setRoutes(d); } catch (_) {} }, []);
  useEffect(() => { loadRoutes(); }, [loadRoutes]);
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
  const disp = sbc?.dispatcher || []; const banned = sbc?.banned || []; const rtp = sbc?.rtpengine || {};
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

  return (
    <Tabs defaultValue="flow" variant="pills" radius="md" keepMounted={false}>
      <Tabs.List mb="md">
        <Tabs.Tab value="flow" leftSection={<IconSitemap size={16} />}>Topología</Tabs.Tab>
        <Tabs.Tab value="mon" leftSection={<IconActivity size={16} />}>Monitoreo</Tabs.Tab>
        <Tabs.Tab value="sec" leftSection={<IconShieldLock size={16} />}>Seguridad {banned.length > 0 && <Badge size="xs" color="red" variant="filled" ml={4}>{banned.length}</Badge>}</Tabs.Tab>
        <Tabs.Tab value="disp" leftSection={<IconRouteAltLeft size={16} />}>Dispatcher</Tabs.Tab>
        <Tabs.Tab value="trunks" leftSection={<IconDeviceLandlinePhone size={16} />}>Troncales</Tabs.Tab>
        <Tabs.Tab value="net" leftSection={<IconNetwork size={16} />}>Red</Tabs.Tab>
        <Tabs.Tab value="rtp" leftSection={<IconArrowsLeftRight size={16} />}>rtpengine</Tabs.Tab>
        <Tabs.Tab value="sip" leftSection={<IconBug size={16} />}>SIP debug</Tabs.Tab>
        <Tabs.Tab value="cfg" leftSection={<IconFileCode size={16} />}>Configuracion</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="flow"><SbcFlow /></Tabs.Panel>

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
        <Card withBorder radius="md" padding="md">
          <Group justify="space-between" mb="sm"><Text fw={700}>Destinos del dispatcher ({disp.length})</Text><Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} loading={busy === 'reload'} onClick={() => sendCmd('reload')}>Recargar</Button></Group>
          <Group align="flex-end" gap="xs" mb="md">
            <TextInput label="Agregar destino (Asterisk)" placeholder="sip:172.26.20.183:5060 o 172.26.20.x" value={newTgt} onChange={e => setNewTgt(e.target.value)} style={{ flex: 1 }} size="xs" />
            <Button size="xs" leftSection={<IconPlus size={14} />} disabled={!newTgt} loading={busy === 'add_target' + newTgt} onClick={async () => { await sendCmd('add_target', newTgt.trim()); setNewTgt(''); }}>Agregar</Button>
          </Group>
          <Table highlightOnHover><Table.Thead><Table.Tr><Table.Th>Destino</Table.Th><Table.Th>Prioridad</Table.Th><Table.Th>Latencia</Table.Th><Table.Th>Estado</Table.Th><Table.Th ta="right">Acciones</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{disp.length === 0 ? <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="md" size="sm">Sin destinos. Agregá tu primer Asterisk arriba.</Text></Table.Td></Table.Tr> : disp.map((d, i) => { const fi = flagInfo(d.flags); const active = /A/.test(d.flags || ''); return (
              <Table.Tr key={i}>
                <Table.Td ff="monospace" fz="sm">{d.uri}</Table.Td><Table.Td>{d.priority}</Table.Td><Table.Td>{d.latency != null ? <Badge size="sm" variant="dot" color={d.latency < 50 ? 'teal' : d.latency < 200 ? 'yellow' : 'red'}><Slot value={d.latency} /> ms</Badge> : '-'}</Table.Td>
                <Table.Td><Badge variant="light" color={fi.c}>{fi.t}</Badge></Table.Td>
                <Table.Td ta="right"><Group gap={4} justify="flex-end" wrap="nowrap">{active
                  ? <Button size="compact-xs" variant="light" color="orange" leftSection={<IconPlugConnectedX size={13} />} loading={busy === 'disable_target' + d.uri} onClick={() => sendCmd('disable_target', d.uri)}>Deshabilitar</Button>
                  : <Button size="compact-xs" variant="light" color="teal" leftSection={<IconPlugConnected size={13} />} loading={busy === 'enable_target' + d.uri} onClick={() => sendCmd('enable_target', d.uri)}>Habilitar</Button>}
                  <Tooltip label="Quitar destino"><ActionIcon variant="subtle" color="red" loading={busy === 'del_target' + d.uri} onClick={() => { if (confirm('¿Quitar ' + d.uri + ' del dispatcher?')) sendCmd('del_target', d.uri); }}><IconTrash size={15} /></ActionIcon></Tooltip>
                </Group></Table.Td>
              </Table.Tr>); })}</Table.Tbody></Table>
        </Card>
      </Tabs.Panel>

      <Tabs.Panel value="trunks"><Troncales /></Tabs.Panel>

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
        <Card withBorder radius="md" padding="md">
          <Text fw={700} mb="xs">Rutas estáticas administradas</Text>
          <Group align="flex-end" gap="xs" mb="md" wrap="wrap">
            <TextInput label="Destino (red/host)" placeholder="ej 200.40.10.0/24 o 1.2.3.4" value={rt.dest} onChange={e => setRt({ ...rt, dest: e.target.value })} w={200} size="xs" />
            <TextInput label="Gateway (via)" placeholder="ej 172.26.30.1" value={rt.gw} onChange={e => setRt({ ...rt, gw: e.target.value })} w={170} size="xs" />
            <TextInput label="Interfaz (dev, opc.)" placeholder="ej eth1" value={rt.dev} onChange={e => setRt({ ...rt, dev: e.target.value })} w={150} size="xs" />
            <TextInput label="Nota (opc.)" placeholder="ej WAN troncal Antel" value={rt.note} onChange={e => setRt({ ...rt, note: e.target.value })} style={{ flex: 1, minWidth: 160 }} size="xs" />
            <Button size="xs" leftSection={<IconPlus size={14} />} loading={busy === 'route_add'} onClick={addRoute}>{editId ? 'Guardar cambios' : 'Agregar ruta'}</Button>{editId && <Button size="xs" variant="subtle" color="gray" onClick={() => { setEditId(null); setRt({ dest: '', gw: '', dev: '', note: '' }); }}>Cancelar</Button>}
          </Group>
          <Table highlightOnHover><Table.Thead><Table.Tr><Table.Th>Destino</Table.Th><Table.Th>Gateway</Table.Th><Table.Th>Interfaz</Table.Th><Table.Th>Nota</Table.Th><Table.Th ta="right">Acción</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{routes.length === 0 ? <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="md" size="sm">Sin rutas estáticas. Todo sale por la ruta por defecto.</Text></Table.Td></Table.Tr> : routes.map(r => (
              <Table.Tr key={r.id}>
                <Table.Td ff="monospace" fz="sm">{r.dest}</Table.Td>
                <Table.Td ff="monospace" fz="sm">{r.gw || '—'}</Table.Td>
                <Table.Td ff="monospace" fz="sm">{r.dev || '—'}</Table.Td>
                <Table.Td fz="sm">{r.note || ''}</Table.Td>
                <Table.Td ta="right"><Group gap={4} justify="flex-end" wrap="nowrap"><Tooltip label="Editar"><ActionIcon variant="subtle" color="gray" onClick={() => { setRt({ dest: r.dest, gw: r.gw || '', dev: r.dev || '', note: r.note || '' }); setEditId(r.id); }}><IconRoute size={15} /></ActionIcon></Tooltip><Tooltip label="Quitar ruta"><ActionIcon variant="subtle" color="red" loading={busy === 'route_del' + r.id} onClick={() => delRoute(r.id, r.dest)}><IconTrash size={15} /></ActionIcon></Tooltip></Group></Table.Td>
              </Table.Tr>))}</Table.Tbody></Table>
          <Group gap="xs" mt="sm" c="orange"><IconAlertTriangle size={15} /><Text size="xs" c="dimmed">Las rutas se aplican con <Code>ip route replace</Code> en el SBC (CT107). Una ruta mal configurada puede afectar la conectividad; verificá gateway e interfaz antes de guardar.</Text></Group>
        </Card>
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

      <Tabs.Panel value="sip"><SipLadder /></Tabs.Panel>

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
            <div><Text fw={800} lh={1.1}>Consola SBC-NG</Text><Text size="xs" style={{ opacity: .75 }}>{sbc?.version || 'kamailio'} - 172.26.20.205 - uptime {fmtUptime(sbc?.uptime)}</Text></div>
            <Badge ml="sm" variant="light" color={sbc && !sbc.error ? 'teal' : 'red'}>{sbc && !sbc.error ? 'En linea' : 'Sin datos'}</Badge>
          </Group>
          <Group gap="xs"><Tooltip label="Refrescar"><ActionIcon variant="light" color="gray" onClick={load}><IconRefresh size={18} /></ActionIcon></Tooltip><Button variant="white" color="dark" onClick={onClose}>Cerrar</Button></Group>
        </Group>
        <ScrollArea style={{ flex: 1 }} p="md"><ConsoleBody sbc={sbc} load={load} hist={hist} /></ScrollArea>
      </Stack>
    </Modal>
  );
}
