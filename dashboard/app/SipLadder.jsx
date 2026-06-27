'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Stack, Group, Text, Badge, Card, Button, TextInput, Switch, ScrollArea, ActionIcon, Tooltip, Code, SegmentedControl, Box } from '@mantine/core';
import { IconBug, IconTrash, IconSearch, IconInfoCircle, IconRefresh, IconPlayerPlay, IconPlayerPause, IconX } from '@tabler/icons-react';
import { toast } from './notify';

const userOf = (u) => { if (!u) return '?'; const m = String(u).match(/sips?:([^@>;\s]+)/i); if (m) return m[1]; const m2 = String(u).match(/<?([^@>;\s]+)/); return m2 ? m2[1] : String(u).slice(0, 14); };
const ipOf = (hp) => (hp || '').split(':')[0];
const HOSTCOL = { asterisk: '#2f74e6', sbc: '#7c3aed' };

function msgColor(m) {
  if (m.status) { if (m.status < 200) return '#f59e0b'; if (m.status < 300) return '#16a34a'; if (m.status < 400) return '#0891b2'; return '#dc2626'; }
  if (['INVITE', 'REGISTER', 'SUBSCRIBE', 'PUBLISH', 'REFER'].includes(m.method)) return '#2f74e6';
  if (['BYE', 'CANCEL'].includes(m.method)) return '#7c3aed';
  return '#64748b';
}
function dlgStatus(ms) {
  const codes = ms.filter(m => m.status).map(m => m.status);
  if (codes.some(c => c >= 400)) return 'fail';
  if (codes.some(c => c >= 200 && c < 300)) return 'ok';
  if (codes.some(c => c >= 100 && c < 200)) return 'ring';
  return 'info';
}
const ST = { ok: { c: 'teal', t: 'OK' }, fail: { c: 'red', t: 'Error' }, ring: { c: 'yellow', t: 'En curso' }, info: { c: 'gray', t: 'Info' } };

export default function SipLadder() {
  const [msgs, setMsgs] = useState([]);
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState('');
  const [hostF, setHostF] = useState('all');
  const [live, setLive] = useState(true);
  const [on, setOn] = useState(true);
  const [raw, setRaw] = useState(null);
  const liveRef = useRef(live); liveRef.current = live;

  const load = async () => {
    try { const d = await fetch('/backend/api/sip/messages?limit=700').then(r => r.json()); if (Array.isArray(d)) setMsgs(d); } catch (_) {}
  };
  useEffect(() => { load(); fetch('/backend/api/sip/state').then(r => r.json()).then(d => setOn(!!d.on)).catch(() => {}); }, []);
  useEffect(() => { const t = setInterval(() => { if (liveRef.current) load(); }, 2000); return () => clearInterval(t); }, []);

  const dialogs = useMemo(() => {
    const map = new Map();
    for (const m of msgs) {
      const k = m.callid || ('nocid-' + m.id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(m);
    }
    let arr = [...map.entries()].map(([callid, ms]) => {
      ms.sort((a, b) => a.id - b.id);
      const inv = ms.find(m => m.method);
      return { callid, ms, from: userOf((inv || ms[0]).from_uri), to: userOf((inv || ms[0]).to_uri), kind: (ms.find(m => m.method) || {}).method || 'SIP', status: dlgStatus(ms), last: ms[ms.length - 1].t, hosts: [...new Set(ms.map(m => m.host))] };
    });
    arr.sort((a, b) => b.last - a.last);
    if (hostF !== 'all') arr = arr.filter(d => d.hosts.includes(hostF));
    if (q.trim()) { const s = q.toLowerCase(); arr = arr.filter(d => (d.callid + d.from + d.to + d.kind).toLowerCase().includes(s)); }
    return arr;
  }, [msgs, q, hostF]);

  const current = useMemo(() => dialogs.find(d => d.callid === sel) || dialogs[0] || null, [dialogs, sel]);

  const showRaw = async (m) => {
    setRaw({ id: m.id, loading: true, text: '' });
    try { const d = await fetch('/backend/api/sip/raw/' + m.id).then(r => r.json()); setRaw({ id: m.id, loading: false, text: d.raw || '(sin contenido)' }); }
    catch (_) { setRaw({ id: m.id, loading: false, text: '(error)' }); }
  };
  const toggle = async (v) => { setOn(v); try { await fetch('/backend/api/sip/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: v }) }); toast(v ? 'Captura activada' : 'Captura pausada', 'ok'); } catch (_) {} };
  const clear = async () => { if (!confirm('¿Borrar todos los mensajes SIP capturados?')) return; try { await fetch('/backend/api/sip/clear', { method: 'POST' }); setMsgs([]); setSel(null); setRaw(null); toast('Captura limpiada', 'ok'); } catch (_) {} };

  // --- ladder geometry ---
  const lanes = useMemo(() => { if (!current) return []; const L = []; current.ms.forEach(m => [ipOf(m.src), ipOf(m.dst)].forEach(ip => { if (ip && ip !== '?' && !L.includes(ip)) L.push(ip); })); return L; }, [current]);
  const W = Math.max(560, 160 + Math.max(0, lanes.length - 1) * 230);
  const rowH = 46, top = 78;
  const H = top + (current ? current.ms.length : 0) * rowH + 40;
  const laneX = (ip) => { const i = lanes.indexOf(ip); if (lanes.length <= 1) return W / 2; return 90 + i * ((W - 170) / (lanes.length - 1)); };
  const laneHost = (ip) => { const m = current?.ms.find(x => ipOf(x.src) === ip || ipOf(x.dst) === ip); return m ? m.host : ''; };

  return (
    <Stack gap="md">
      <style>{`@keyframes sipDraw{from{stroke-dashoffset:var(--len)}to{stroke-dashoffset:0}} @keyframes sipIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}} .sip-arrow{animation:sipDraw .5s ease forwards} .sip-row{animation:sipIn .4s ease both}`}</style>

      <Card withBorder radius="md" padding="md" style={{ background: 'var(--mantine-color-grape-light)' }}>
        <Group gap="xs" mb={4}><IconInfoCircle size={16} /><Text fw={700} size="sm">Debug SIP en vivo (estilo sngrep)</Text></Group>
        <Text size="sm" c="dimmed">Captura los mensajes SIP en dos puntos: <b>Asterisk</b> (incluye WebRTC, vía HEP) y el <b>SBC</b> (troncales del operador, vía tcpdump). Elegí un diálogo a la izquierda y mirá el <b>diagrama de flujo</b>: cada flecha es un mensaje SIP entre dos IPs. <Badge size="xs" color="teal" variant="light">2xx</Badge> OK, <Badge size="xs" color="yellow" variant="light">1xx</Badge> provisional, <Badge size="xs" color="red" variant="light">4xx-6xx</Badge> error. Si una llamada falla, vas a ver el código de error exacto y en qué tramo ocurre.</Text>
      </Card>

      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="sm">
          <Switch checked={on} onChange={e => toggle(e.currentTarget.checked)} label="Captura" color="grape" />
          <Tooltip label={live ? 'Pausar auto-refresh' : 'Reanudar'}><ActionIcon variant="light" color={live ? 'teal' : 'gray'} onClick={() => setLive(v => !v)}>{live ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />}</ActionIcon></Tooltip>
          <Tooltip label="Refrescar"><ActionIcon variant="light" color="blue" onClick={load}><IconRefresh size={16} /></ActionIcon></Tooltip>
          <SegmentedControl size="xs" value={hostF} onChange={setHostF} data={[{ label: 'Todo', value: 'all' }, { label: 'Asterisk', value: 'asterisk' }, { label: 'SBC', value: 'sbc' }]} />
        </Group>
        <Group gap="sm">
          <TextInput size="xs" leftSection={<IconSearch size={14} />} placeholder="Filtrar (interno, Call-ID...)" value={q} onChange={e => setQ(e.target.value)} w={230} />
          <Button size="xs" variant="light" color="red" leftSection={<IconTrash size={14} />} onClick={clear}>Limpiar</Button>
        </Group>
      </Group>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 14, alignItems: 'start' }}>
        <Card withBorder radius="md" padding={0} style={{ overflow: 'hidden' }}>
          <Box p="xs" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}><Text fw={700} size="sm">Diálogos ({dialogs.length})</Text></Box>
          <ScrollArea.Autosize mah={560}>
            {dialogs.length === 0 ? <Text size="sm" c="dimmed" ta="center" py="xl">Sin tráfico SIP capturado todavía.</Text> :
              dialogs.map(d => { const st = ST[d.status]; const a = current && current.callid === d.callid; return (
                <Box key={d.callid} onClick={() => setSel(d.callid)} style={{ cursor: 'pointer', padding: '9px 12px', borderBottom: '1px solid var(--mantine-color-gray-1)', background: a ? 'var(--mantine-color-blue-light)' : 'transparent' }}>
                  <Group justify="space-between" gap={6} wrap="nowrap">
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}><Badge size="xs" variant="light" color={st.c}>{st.t}</Badge><Text fw={600} size="sm" truncate>{d.from} → {d.to}</Text></Group>
                    <Badge size="xs" variant="outline" color="gray">{d.ms.length}</Badge>
                  </Group>
                  <Group gap={5} mt={3}><Badge size="xs" variant="dot" color="blue">{d.kind}</Badge>{d.hosts.map(h => <Badge key={h} size="xs" variant="light" color={h === 'sbc' ? 'grape' : 'blue'}>{h}</Badge>)}</Group>
                </Box>); })}
          </ScrollArea.Autosize>
        </Card>

        <Card withBorder radius="md" padding="md">
          {!current ? <Text size="sm" c="dimmed" ta="center" py="xl">Seleccioná un diálogo para ver el flujo SIP.</Text> :
            <>
              <Group justify="space-between" mb="xs">
                <div><Text fw={700} size="sm">{current.from} → {current.to}</Text><Text size="xs" c="dimmed" ff="monospace" truncate maw={420}>{current.callid}</Text></div>
                <Badge variant="light" color={ST[current.status].c}>{ST[current.status].t}</Badge>
              </Group>
              <ScrollArea.Autosize mah={520}>
                <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: W, height: H, display: 'block' }}>
                  {lanes.map((ip) => { const x = laneX(ip); const hc = HOSTCOL[laneHost(ip)] || '#64748b'; return (
                    <g key={ip}>
                      <line x1={x} y1={58} x2={x} y2={H - 10} stroke="#cbd5e1" strokeWidth="1.4" strokeDasharray="3 4" />
                      <rect x={x - 70} y={12} width={140} height={34} rx={9} fill="#fff" stroke={hc} strokeWidth="1.5" />
                      <text x={x} y={28} textAnchor="middle" style={{ fontSize: 11.5, fontWeight: 700, fill: hc }}>{ip}</text>
                      <text x={x} y={40} textAnchor="middle" style={{ fontSize: 9.5, fill: '#94a3b8' }}>{laneHost(ip)}</text>
                    </g>); })}
                  {current.ms.map((m, i) => {
                    const x1 = laneX(ipOf(m.src)), x2v = laneX(ipOf(m.dst)); const y = top + i * rowH;
                    const self = Math.abs(x1 - x2v) < 1; const x2 = self ? x1 + 90 : x2v;
                    const dir = x2 >= x1 ? 1 : -1; const col = msgColor(m); const len = Math.abs(x2 - x1) || 90;
                    const dt = i > 0 ? '+' + Math.max(0, Math.round(m.t - current.ms[i - 1].t)) + 'ms' : '';
                    const label = m.method ? m.method : (m.status + '');
                    const cseq = (m.cseq || '').split(' ')[1] || '';
                    return (
                      <g key={m.id} className="sip-row" style={{ animationDelay: (i * 0.04) + 's', cursor: 'pointer' }} onClick={() => showRaw(m)}>
                        <text x={6} y={y - 3} style={{ fontSize: 9, fill: '#94a3b8' }}>{dt}</text>
                        <text x={(x1 + x2) / 2} y={y - 7} textAnchor="middle" style={{ fontSize: 11, fontWeight: 700, fill: col }}>{label}{cseq ? ' (' + cseq + ')' : ''}</text>
                        <path d={`M ${x1} ${y} L ${x2} ${y}`} stroke={col} strokeWidth={raw && raw.id === m.id ? 3.5 : 2.2} fill="none" className="sip-arrow" style={{ ['--len']: len, strokeDasharray: len, animationDelay: (i * 0.04) + 's' }} />
                        <path d={`M ${x2} ${y} l ${-9 * dir} -4 l 0 8 z`} fill={col} />
                        {self && <text x={x1 + 96} y={y + 3} style={{ fontSize: 9, fill: '#94a3b8' }}>(mismo host)</text>}
                        <circle r="3.5" fill={col}><animateMotion dur="1.3s" begin={(i * 0.04) + 's'} repeatCount="1" fill="freeze" path={`M ${x1} ${y} L ${x2} ${y}`} /></circle>
                      </g>);
                  })}
                </svg>
              </ScrollArea.Autosize>
            </>}
        </Card>
      </div>

      {raw && <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="xs"><Text fw={700} size="sm">Mensaje SIP #{raw.id}</Text><ActionIcon variant="subtle" onClick={() => setRaw(null)}><IconX size={16} /></ActionIcon></Group>
        <Code block style={{ maxHeight: 320, overflow: 'auto', fontSize: 12 }}>{raw.loading ? 'Cargando...' : raw.text}</Code>
      </Card>}
    </Stack>
  );
}
