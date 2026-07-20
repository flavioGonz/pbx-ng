/* AstNet.jsx — Red del núcleo Asterisk: switch SVG animado + diagnóstico animado (fila partida),
 * cambio de IP y activar/desactivar interfaces EN CALIENTE (vía ast-agent), y rutas estáticas. */
'use client';
import { useEffect, useMemo, useState } from 'react';
import { Card, Group, Text, Badge, ThemeIcon, Grid, Stack, SimpleGrid, TextInput, Button, Code, Alert, Loader, NumberInput, Tooltip, ActionIcon, Modal, Switch as MSwitch } from '@mantine/core';
import { IconNetwork, IconStethoscope, IconActivity, IconMapPin, IconInfoCircle, IconAlertTriangle, IconPlugConnected, IconServer2, IconWifi, IconEdit, IconPower, IconCircleCheck, IconCircleX, IconRoute, IconWorld, IconPlayerPlay } from '@tabler/icons-react';
import RoutesPanel from './RoutesPanel';
import { toast } from './notify';

const UP = (fi) => /UP/i.test(fi.state || '');
const primaryIp = (fi) => ((fi.addrs || []).find((a) => a.includes('/')) || (fi.addrs || [])[0] || '').split('/')[0];

function Puerto({ x, y, fi, sel, onClick }) {
  const up = UP(fi);
  const c = up ? '#12b76a' : '#94a3b8';
  const w = 46, h = 38;
  return (
    <g transform={`translate(${x} ${y})`} onClick={onClick} style={{ cursor: 'pointer', opacity: up ? 1 : 0.62 }}>
      {sel && <rect x="-8" y="-8" width={w + 16} height={h + 26} rx="10" fill={c} opacity=".14" />}
      <path d={`M${w / 2 - 8} 5 v-5 h16 v5`} fill="none" stroke={c} strokeWidth="1.9" strokeLinejoin="round" />
      <rect x="0" y="5" width={w} height={h - 5} rx="3.5" fill="none" stroke={c} strokeWidth="2" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <line key={i} x1={6 + i * 4.5} y1="10" x2={6 + i * 4.5} y2="19" stroke={c} strokeWidth="1.1" opacity=".5" />)}
      <circle cx="10" cy="30" r="2.5" fill={up ? '#12b76a' : '#475569'} className={up ? 'an-link' : undefined} />
      <circle cx={w - 10} cy="30" r="2.5" fill={up ? '#f59e0b' : '#475569'} className={up ? 'an-act' : undefined} />
      {!up && <g stroke="#94a3b8" strokeWidth="2.1" strokeLinecap="round"><line x1="7" y1="9" x2={w - 7} y2={h - 4} /><line x1={w - 7} y1="9" x2="7" y2={h - 4} /></g>}
      <text x={w / 2} y={h + 16} textAnchor="middle" fontSize="11" fontWeight="700" fill="currentColor" fontFamily="ui-monospace, monospace">{fi.name}</text>
      <text x={w / 2} y={h + 27} textAnchor="middle" fontSize="8.5" fontWeight="600" fill={up ? '#12b76a' : '#94a3b8'} fontFamily="ui-monospace, monospace">{up ? (primaryIp(fi) || 'sin IP') : (fi.state || 'DOWN')}</text>
    </g>
  );
}

function Switch({ ifaces, sel, setSel }) {
  const n = Math.max(ifaces.length, 1);
  const cols = Math.min(n, 3);
  const rows = Math.ceil(n / cols);
  const X0 = 52, SEP = 112, PORTW = 46, HEAD = 40, PTOP = HEAD + 26, ROWH = 84;
  const gridW = X0 * 2 + (cols - 1) * SEP + PORTW;
  const totalH = PTOP + rows * ROWH;
  const upN = ifaces.filter(UP).length;
  return (
    <Card withBorder radius="lg" padding="md" style={{ height: '100%', background: 'linear-gradient(180deg, rgba(37,99,235,.04), transparent)' }}>
      <Group justify="space-between" mb="xs">
        <Group gap={9}><ThemeIcon size={30} radius="md" variant="light" color="blue"><IconServer2 size={17} /></ThemeIcon><div><Text fw={700} lh={1}>Switch del núcleo</Text><Text size="xs" c="dimmed">clic en una placa para ver acciones</Text></div></Group>
        <Badge variant="light" color={upN ? 'teal' : 'gray'} leftSection={<IconWifi size={12} />}>{upN}/{ifaces.length} con enlace</Badge>
      </Group>
      <div style={{ maxWidth: gridW, margin: '0 auto' }}>
        <svg viewBox={`0 0 ${gridW} ${totalH}`} width="100%" style={{ display: 'block', color: 'var(--mantine-color-text)' }}>
          <rect x="12" y="16" width={gridW - 24} height={totalH - 24} rx="14" fill="rgba(30,41,59,.05)" stroke="rgba(100,116,139,.35)" strokeWidth="1.5" />
          <circle cx="30" cy="35" r="3.2" fill={upN ? '#12b76a' : '#94a3b8'} className={upN ? 'an-link' : undefined} />
          <text x="42" y="39" fontSize="10.5" fontWeight="800" fill="currentColor" opacity=".7" fontFamily="ui-monospace, monospace">PBX · ASTERISK</text>
          {ifaces.map((fi, i) => { const col = i % cols, row = Math.floor(i / cols); return <Puerto key={fi.name} x={X0 + col * SEP} y={PTOP + row * ROWH} fi={fi} sel={sel === fi.name} onClick={() => setSel(sel === fi.name ? null : fi.name)} />; })}
        </svg>
      </div>
      <style jsx>{`
        :global(.an-link){ animation: anLink 2.4s ease-in-out infinite; }
        @keyframes anLink { 0%,100%{opacity:1} 50%{opacity:.35} }
        :global(.an-act){ animation: anAct .4s steps(2,end) infinite; }
        @keyframes anAct { 0%{opacity:1} 100%{opacity:.2} }
        @media (prefers-reduced-motion: reduce){ :global(.an-link),:global(.an-act){ animation:none } }
      `}</style>
    </Card>
  );
}

/* ── Diagnóstico animado: corre ping → SIP → traceroute y anima cada paso ─────── */
function Diagnostico({ sugerencias }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(5060);
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  async function call(que) {
    try { return await fetch('/backend/api/asterisk/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: host.trim(), que, port }) }).then((r) => r.json()); }
    catch (_) { return { ok: false, salida: 'no se pudo ejecutar' }; }
  }
  async function diagnosticar() {
    const h = host.trim(); if (!h) { toast('Escribí un host o una IP', 'bad'); return; }
    setRunning(true);
    const seq = [{ key: 'ping', label: 'Ping (ICMP)' }, { key: 'sip', label: 'Alcance SIP :' + port }, { key: 'trace', label: 'Traceroute' }];
    setSteps(seq.map((s) => ({ ...s, state: 'wait', hops: [] })));
    for (const s of seq) {
      setSteps((p) => p.map((x) => x.key === s.key ? { ...x, state: 'run' } : x));
      const d = await call(s.key);
      if (s.key === 'trace') {
        const hops = (d.salida || '').split('\n').filter((l) => /^\s*\d+\s/.test(l));
        setSteps((p) => p.map((x) => x.key === s.key ? { ...x, state: d.ok ? 'ok' : 'info', detail: d.comando, hops: [] } : x));
        for (let i = 0; i < hops.length; i++) { await new Promise((r) => setTimeout(r, 200)); setSteps((p) => p.map((x) => x.key === s.key ? { ...x, hops: hops.slice(0, i + 1) } : x)); }
      } else {
        const st = d.ok ? 'ok' : (s.key === 'ping' ? 'info' : 'bad');
        setSteps((p) => p.map((x) => x.key === s.key ? { ...x, state: st, detail: (d.salida || '').split('\n')[0] || '', ms: d.ms } : x));
      }
    }
    setRunning(false);
  }
  const sicon = (st) => st === 'run' ? <Loader size={14} /> : st === 'ok' ? <IconCircleCheck size={15} /> : st === 'bad' ? <IconCircleX size={15} /> : st === 'info' ? <IconInfoCircle size={15} /> : <IconActivity size={14} />;
  const scol = (st) => st === 'ok' ? 'teal' : st === 'bad' ? 'red' : st === 'info' ? 'blue' : 'gray';
  return (
    <Card withBorder radius="lg" padding="lg" style={{ height: '100%' }}>
      <Group gap={9} mb="sm"><ThemeIcon size={30} radius="md" variant="light" color="blue"><IconStethoscope size={17} /></ThemeIcon><div><Text fw={700} lh={1}>Diagnóstico</Text><Text size="xs" c="dimmed">desde el núcleo Asterisk</Text></div></Group>
      <Group align="flex-end" gap="sm" wrap="wrap">
        <TextInput label="Host o IP" placeholder="172.20.30.9" value={host} onChange={(e) => setHost(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') diagnosticar(); }} leftSection={<IconNetwork size={15} />} style={{ flex: 1, minWidth: 150 }} />
        <NumberInput label="Puerto SIP" value={port} onChange={(v) => setPort(Number(v) || 5060)} w={110} min={1} max={65535} />
        <Button leftSection={<IconPlayerPlay size={16} />} loading={running} onClick={diagnosticar}>Diagnosticar</Button>
      </Group>
      {sugerencias.length > 0 && <Group gap={6} mt="sm"><Text size="xs" c="dimmed">Rápido:</Text>{sugerencias.map((s) => <Badge key={s} variant="light" color="gray" style={{ cursor: 'pointer' }} onClick={() => setHost(s)}>{s}</Badge>)}</Group>}
      <Stack gap={8} mt="md">
        {steps.map((s) => (
          <div key={s.key} className="diag-row">
            <Group gap={9} wrap="nowrap" align="flex-start">
              <ThemeIcon size={24} radius="xl" variant="light" color={scol(s.state)} style={{ flex: 'none' }}>{sicon(s.state)}</ThemeIcon>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6}><Text fz="sm" fw={700}>{s.label}</Text>{s.ms != null && s.ms > 0 && <Text fz={10} c="dimmed" ff="monospace">{s.ms}ms</Text>}{s.state === 'ok' && <Badge size="xs" color="teal" variant="light">OK</Badge>}{s.state === 'bad' && <Badge size="xs" color="red" variant="light">sin respuesta</Badge>}</Group>
                {s.detail && s.key !== 'trace' && <Text fz="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>{s.detail}</Text>}
                {s.key === 'trace' && s.hops && s.hops.length > 0 &&
                  <Code block fz="11px" mt={4} style={{ maxHeight: 200, overflow: 'auto' }}>{s.hops.map((h, i) => <div key={i} className="hop-line">{h.trim()}</div>)}</Code>}
                {s.key === 'trace' && s.state === 'run' && (!s.hops || !s.hops.length) && <Text fz="xs" c="dimmed">trazando la ruta salto a salto…</Text>}
              </div>
            </Group>
          </div>
        ))}
        {!steps.length && <Alert variant="light" color="blue" radius="md" icon={<IconInfoCircle size={16} />}>Escribí un destino y tocá <b>Diagnosticar</b>: se anima el ping, el alcance SIP y el traceroute salto a salto, todo <b>desde la central</b>.</Alert>}
      </Stack>
      <style jsx>{`
        .diag-row{ animation: diagIn .34s ease both; }
        @keyframes diagIn{ from{opacity:0; transform: translateY(-4px)} to{opacity:1; transform:none} }
        :global(.hop-line){ animation: hopIn .3s ease both; }
        @keyframes hopIn{ from{opacity:0; transform: translateX(-8px)} to{opacity:1; transform:none} }
      `}</style>
    </Card>
  );
}

export default function AstNet() {
  const [net, setNet] = useState(null);
  const [sel, setSel] = useState(null);
  const [ipModal, setIpModal] = useState(null);   // { dev }
  const [cidr, setCidr] = useState(''); const [replace, setReplace] = useState(false); const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);   // { dev, action, up }
  async function load() { try { setNet(await fetch('/backend/api/asterisk/net').then((r) => r.json())); } catch (_) {} }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  const ifaces = (net && net.ifaces) || [];
  const sugerencias = useMemo(() => {
    const s = [];
    for (const ln of (net && net.kernel_routes) || []) { const m = /default\s+via\s+([\d.]+)/.exec(ln); if (m) s.push(m[1]); }
    return Array.from(new Set(s)).slice(0, 4);
  }, [net]);

  async function applyIp() {
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr.trim())) { toast('Escribí una IP/CIDR válida (ej 192.168.1.50/24)', 'bad'); return; }
    setBusy(true);
    const r = await fetch('/backend/api/asterisk/iface', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: replace ? 'replace' : 'addip', dev: ipModal.dev, cidr: cidr.trim() }) }).then((x) => x.json()).catch(() => ({ error: 'red' }));
    setBusy(false);
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast('IP aplicada en ' + ipModal.dev + ' (en caliente)', 'ok'); setIpModal(null); setCidr(''); setReplace(false); setTimeout(load, 800); }
  }
  async function applyUpDown() {
    setBusy(true);
    const r = await fetch('/backend/api/asterisk/iface', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: confirm.up ? 'up' : 'down', dev: confirm.dev }) }).then((x) => x.json()).catch(() => ({ error: 'red' }));
    setBusy(false);
    if (r.error) toast('Error: ' + r.error, 'bad'); else { toast((confirm.up ? 'Activada ' : 'Desactivada ') + confirm.dev, 'info'); setConfirm(null); setTimeout(load, 800); }
  }

  return (
    <Stack gap="md">
      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 7 }}><Switch ifaces={ifaces} sel={sel} setSel={setSel} /></Grid.Col>
        <Grid.Col span={{ base: 12, md: 5 }}><Diagnostico sugerencias={sugerencias} /></Grid.Col>
      </Grid>

      <Card withBorder radius="lg" padding="lg">
        <Group justify="space-between" mb="sm">
          <Group gap={9}><ThemeIcon size={28} radius="md" variant="light" color="blue"><IconNetwork size={16} /></ThemeIcon><Text fw={700}>Interfaces</Text><Badge size="sm" variant="light" color="gray">{ifaces.length}</Badge></Group>
        </Group>
        <Alert variant="light" color="orange" radius="md" mb="md" icon={<IconAlertTriangle size={16} />}>
          Los cambios de IP y activar/desactivar se aplican <b>en caliente</b> sobre el contenedor: no persisten a un reinicio y, si tocás la placa de gestión, podés perder el acceso al panel. Usalos con cuidado.
        </Alert>
        {ifaces.length === 0 ? <Text size="sm" c="dimmed" py="lg" ta="center">Sin datos del agente (CT:8092).</Text> :
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">{ifaces.map((fi) => { const up = UP(fi); return (
            <Card key={fi.name} withBorder radius="md" padding="sm" style={sel === fi.name ? { borderColor: 'var(--mantine-color-blue-5)', boxShadow: '0 0 0 2px var(--mantine-color-blue-1)' } : undefined} onClick={() => setSel(fi.name)}>
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <ThemeIcon size={40} radius="md" variant="light" color={up ? 'teal' : 'gray'}><IconNetwork size={20} /></ThemeIcon>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Group gap={6} mb={2}><Text fw={700} ff="monospace" size="sm">{fi.name}</Text><Badge size="xs" variant="dot" color={up ? 'teal' : 'gray'}>{up ? 'enlace' : (fi.state || '—')}</Badge></Group>
                  {(fi.addrs || []).length ? (fi.addrs || []).map((a) => <Text key={a} ff="monospace" fz="11px" c="dimmed">{a}</Text>) : <Text fz="11px" c="dimmed">sin dirección</Text>}
                </div>
                <Group gap={4} wrap="nowrap">
                  <Tooltip label="Cambiar IP" withArrow><ActionIcon variant="light" color="blue" onClick={(e) => { e.stopPropagation(); setCidr(''); setReplace(false); setIpModal({ dev: fi.name }); }}><IconEdit size={16} /></ActionIcon></Tooltip>
                  <Tooltip label={up ? 'Desactivar' : 'Activar'} withArrow><ActionIcon variant="light" color={up ? 'red' : 'teal'} onClick={(e) => { e.stopPropagation(); setConfirm({ dev: fi.name, up: !up }); }}><IconPower size={16} /></ActionIcon></Tooltip>
                </Group>
              </Group>
            </Card>
          ); })}</SimpleGrid>}
      </Card>

      <RoutesPanel scope="asterisk" />

      {/* Modal: cambiar IP */}
      <Modal opened={!!ipModal} onClose={() => setIpModal(null)} centered radius="lg" title={<Group gap="sm"><ThemeIcon variant="light" color="blue"><IconWorld size={18} /></ThemeIcon><Text fw={800}>Cambiar IP · {ipModal && ipModal.dev}</Text></Group>}>
        <Stack gap="md">
          <TextInput label="Nueva IP / CIDR" placeholder="192.168.1.50/24" value={cidr} onChange={(e) => setCidr(e.currentTarget.value)} leftSection={<IconWorld size={15} />} description="Formato IP/máscara. Ej: 192.168.99.60/24" />
          <MSwitch label="Reemplazar la IP actual (borra las que tenga)" checked={replace} onChange={(e) => setReplace(e.currentTarget.checked)} color="red" />
          <Alert variant="light" color={replace ? 'red' : 'orange'} radius="md" icon={<IconAlertTriangle size={16} />}>
            {replace ? 'Vas a BORRAR las IP actuales de la placa y dejar solo la nueva. Si es la placa de gestión, perdés el acceso al panel.' : 'Se AGREGA la IP como secundaria (no borra la actual). Es la opción segura.'}
          </Alert>
          <Group justify="flex-end"><Button variant="default" onClick={() => setIpModal(null)}>Cancelar</Button><Button color={replace ? 'red' : 'blue'} loading={busy} onClick={applyIp}>Aplicar</Button></Group>
        </Stack>
      </Modal>

      {/* Modal: activar/desactivar */}
      <Modal opened={!!confirm} onClose={() => setConfirm(null)} centered radius="lg" size="sm" withCloseButton={false}>
        <Stack gap="md" align="center" ta="center" py="xs">
          <ThemeIcon size={54} radius="xl" variant="light" color={confirm && confirm.up ? 'teal' : 'red'}><IconPower size={26} /></ThemeIcon>
          <div><Text fw={800} fz="lg">{confirm && confirm.up ? 'Activar' : 'Desactivar'} {confirm && confirm.dev}</Text>
            <Text c="dimmed" fz="sm" mt={6}>{confirm && confirm.up ? 'Se levanta la interfaz (ip link set up).' : 'Se baja la interfaz. Si es la placa por la que llega el panel, vas a perder el acceso.'}</Text></div>
          <Group grow w="100%"><Button variant="default" onClick={() => setConfirm(null)}>Cancelar</Button><Button color={confirm && confirm.up ? 'teal' : 'red'} loading={busy} onClick={applyUpDown}>{confirm && confirm.up ? 'Activar' : 'Desactivar'}</Button></Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
