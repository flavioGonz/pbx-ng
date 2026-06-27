'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Stack, Group, Text, Badge, Card, Button, TextInput, Switch, ScrollArea, ActionIcon, Tooltip, Code, SegmentedControl, Box, Table, Drawer, Divider, Anchor } from '@mantine/core';
import { IconInfoCircle, IconRefresh, IconPlayerPlay, IconPlayerPause, IconX, IconPhoneCall, IconPhoneOff, IconPhonePlus, IconCircleCheck, IconCircleX, IconArrowsExchange, IconClock, IconBell, IconUserCheck, IconHeartbeat, IconCheck, IconArrowRight, IconDownload, IconTrash, IconSearch, IconWaveSine } from '@tabler/icons-react';
import { toast } from './notify';

const ipOf = (hp) => (hp || '').split(':')[0];
const userOf = (u) => { if (!u) return '?'; const m = String(u).match(/sips?:([^@>;\s]+)/i); if (m) return m[1]; const m2 = String(u).match(/<?([^@>;\s]+)/); return m2 ? m2[1] : String(u).slice(0, 14); };

const METHOD_DESC = {
  INVITE: 'Inicia o modifica una sesion de llamada (negocia los medios/codecs).',
  ACK: 'Confirma la recepcion de la respuesta final (200 OK) a un INVITE.',
  BYE: 'Finaliza una llamada ya establecida.',
  CANCEL: 'Cancela un INVITE que aun no recibio respuesta final (cuelgan antes de atender).',
  REGISTER: 'El interno publica su ubicacion (registro) en el servidor.',
  OPTIONS: 'Sondeo de disponibilidad / keepalive (qualify de PJSIP).',
  SUBSCRIBE: 'Se suscribe a eventos (BLF, presencia, buzon de voz).',
  NOTIFY: 'Notifica un evento a quien esta suscripto.',
  INFO: 'Informacion durante la sesion (por ejemplo digitos DTMF).',
  PRACK: 'Confirma una respuesta provisional fiable (100rel).',
  UPDATE: 'Modifica la sesion sin un nuevo INVITE.',
  MESSAGE: 'Mensajeria instantanea SIP.',
  REFER: 'Solicita una transferencia de llamada.',
  PUBLISH: 'Publica estado de presencia.',
};
const STATUS_REASON = { 100: 'Trying', 180: 'Ringing', 181: 'Being Forwarded', 182: 'Queued', 183: 'Session Progress', 200: 'OK', 202: 'Accepted', 300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Moved Temporarily', 305: 'Use Proxy', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Auth Required', 408: 'Request Timeout', 410: 'Gone', 413: 'Entity Too Large', 415: 'Unsupported Media', 420: 'Bad Extension', 423: 'Interval Too Brief', 480: 'Temporarily Unavailable', 481: 'Does Not Exist', 482: 'Loop Detected', 483: 'Too Many Hops', 484: 'Address Incomplete', 486: 'Busy Here', 487: 'Request Terminated', 488: 'Not Acceptable Here', 491: 'Request Pending', 500: 'Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Server Timeout', 505: 'Version Not Supported', 600: 'Busy Everywhere', 603: 'Decline', 604: 'Does Not Exist Anywhere', 606: 'Not Acceptable' };
const STATUS_HINT = { 401: 'El servidor pide autenticacion; el cliente reintenta con credenciales (normal).', 407: 'Como 401 pero lo pide un proxy.', 403: 'Credenciales o identidad rechazadas.', 404: 'El destino marcado no existe.', 408: 'No hubo respuesta a tiempo.', 480: 'Registrado pero no disponible.', 486: 'El destino esta ocupado.', 487: 'El INVITE fue cancelado por un CANCEL.', 488: 'No hay codecs en comun (revisar allow).', 503: 'Servicio no disponible (sobrecarga o caida).', 481: 'El dialogo/transaccion ya no existe.' };
function statusDesc(code) {
  const r = STATUS_REASON[code] || '';
  let cls = code < 200 ? 'Provisional: recibido, en proceso.' : code < 300 ? 'Exito: se completo correctamente.' : code < 400 ? 'Redireccion: intentar en otro destino.' : code < 500 ? 'Error del cliente.' : code < 600 ? 'Error del servidor.' : 'Fallo global.';
  const hint = STATUS_HINT[code] || '';
  return (code + ' ' + r).trim() + ' — ' + cls + (hint ? ' ' + hint : '');
}
function sipDesc(m) { return m.method ? (METHOD_DESC[m.method] || 'Metodo SIP.') : statusDesc(m.status); }
function reasonOf(m) { return m.method ? m.method : ((m.status || '') + ' ' + (STATUS_REASON[m.status] || '')).trim(); }
function msgColor(m) { if (m.status) { if (m.status < 200) return 'yellow'; if (m.status < 300) return 'teal'; if (m.status < 400) return 'cyan'; return 'red'; } if (['INVITE', 'REGISTER', 'SUBSCRIBE', 'PUBLISH', 'REFER'].includes(m.method)) return 'blue'; if (['BYE', 'CANCEL'].includes(m.method)) return 'grape'; return 'gray'; }
function MsgIcon({ m, size = 13 }) {
  const col = 'var(--mantine-color-' + msgColor(m) + '-6)';
  let I = IconArrowRight;
  if (m.status) I = m.status < 200 ? IconClock : m.status < 300 ? IconCircleCheck : m.status < 400 ? IconArrowsExchange : IconCircleX;
  else if (m.method === 'INVITE') I = IconPhonePlus;
  else if (m.method === 'BYE' || m.method === 'CANCEL') I = IconPhoneOff;
  else if (m.method === 'ACK') I = IconCheck;
  else if (m.method === 'REGISTER') I = IconUserCheck;
  else if (m.method === 'OPTIONS') I = IconHeartbeat;
  else if (m.method === 'SUBSCRIBE' || m.method === 'NOTIFY') I = IconBell;
  else I = IconPhoneCall;
  return <I size={size} color={col} />;
}
const MONO = { fontFamily: 'monospace' };
const fmtT = (t) => { const d = new Date(t); const p = (n, l = 2) => String(n).padStart(l, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3); };
function dlgStatus(ms) { const c = ms.filter((m) => m.status).map((m) => m.status); if (c.some((x) => x >= 400)) return 'fail'; if (c.some((x) => x >= 200 && x < 300)) return 'ok'; if (c.some((x) => x >= 100 && x < 200)) return 'ring'; return 'info'; }
const ST = { ok: { c: 'teal', t: 'OK' }, fail: { c: 'red', t: 'Error' }, ring: { c: 'yellow', t: 'En curso' }, info: { c: 'gray', t: 'Info' } };
const DISPLAY = 300;
const hasAudio = (ms) => ms.some((m) => m.method === 'INVITE') && ms.some((m) => m.status >= 200 && m.status < 300 && /INVITE/i.test(m.cseq || ''));
function AudioBars() { return <span className="sip-eq" title="audio (llamada atendida)">{[0, 1, 2, 3].map((i) => <span key={i} style={{ animationDelay: (i * 0.12) + 's' }} />)}</span>; }

export default function SipLadder() {
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [hostF, setHostF] = useState('all');
  const [filt, setFilt] = useState('all');
  const [live, setLive] = useState(true);
  const [follow, setFollow] = useState(true);
  const [on, setOn] = useState(true);
  const [drawer, setDrawer] = useState(null);
  const [raw, setRaw] = useState(null);
  const [grouped, setGrouped] = useState(false);
  const liveRef = useRef(live); liveRef.current = live;
  const vpRef = useRef(null);

  const load = async () => { try { const d = await fetch('/backend/api/sip/messages?limit=500').then((r) => r.json()); if (Array.isArray(d)) setMsgs(d); } catch (_) {} };
  useEffect(() => { load(); fetch('/backend/api/sip/state').then((r) => r.json()).then((d) => setOn(!!d.on)).catch(() => {}); }, []);
  useEffect(() => { const t = setInterval(() => { if (liveRef.current && !drawer) load(); }, 3000); return () => clearInterval(t); }, [drawer]);

  const filtered = useMemo(() => {
    let arr = msgs;
    if (hostF !== 'all') arr = arr.filter((m) => m.host === hostF);
    if (filt === 'err') arr = arr.filter((m) => m.status >= 400);
    else if (filt === 'sig') arr = arr.filter((m) => ['INVITE', 'ACK', 'BYE', 'CANCEL'].includes(m.method) || m.status);
    else if (filt === 'reg') arr = arr.filter((m) => m.method === 'REGISTER' || m.method === 'OPTIONS' || m.method === 'SUBSCRIBE');
    if (q.trim()) { const s = q.toLowerCase(); arr = arr.filter((m) => ((m.src || '') + (m.dst || '') + (m.callid || '') + (m.method || '') + (m.status || '') + reasonOf(m)).toLowerCase().includes(s)); }
    return arr.length > DISPLAY ? arr.slice(arr.length - DISPLAY) : arr;
  }, [msgs, hostF, filt, q]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const m of filtered) { const k = m.callid || ('id' + m.id); if (!map.has(k)) map.set(k, []); map.get(k).push(m); }
    return [...map.entries()].map(([callid, ms]) => ({ callid, ms, from: userOf((ms.find((x) => x.method) || ms[0]).from_uri), to: userOf((ms.find((x) => x.method) || ms[0]).to_uri), status: dlgStatus(ms), audio: hasAudio(ms), t0: ms[0].t })).sort((a, b) => b.t0 - a.t0);
  }, [filtered]);

  useEffect(() => { if (follow && vpRef.current) vpRef.current.scrollTo({ top: vpRef.current.scrollHeight }); }, [filtered, follow]);

  const dialog = useMemo(() => {
    if (!drawer) return null;
    const ms = msgs.filter((m) => (m.callid || ('id' + m.id)) === drawer).sort((a, b) => a.id - b.id);
    if (!ms.length) return null;
    const inv = ms.find((m) => m.method) || ms[0];
    return { callid: drawer, ms, from: userOf(inv.from_uri), to: userOf(inv.to_uri), status: dlgStatus(ms) };
  }, [drawer, msgs]);

  const showRaw = async (id) => { setRaw({ id, text: 'Cargando...' }); try { const d = await fetch('/backend/api/sip/raw/' + id).then((r) => r.json()); setRaw({ id, text: d.raw || '(sin contenido)' }); } catch (_) { setRaw({ id, text: '(error)' }); } };
  const toggle = async (v) => { setOn(v); try { await fetch('/backend/api/sip/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: v }) }); toast(v ? 'Captura activada' : 'Captura pausada', 'ok'); } catch (_) {} };
  const clear = async () => { if (!confirm('Borrar todos los mensajes SIP capturados?')) return; try { await fetch('/backend/api/sip/clear', { method: 'POST' }); setMsgs([]); toast('Captura limpiada', 'ok'); } catch (_) {} };
  const exportTxt = () => {
    const all = msgs.filter((m) => hostF === 'all' || m.host === hostF);
    const lines = all.map((m) => fmtT(m.t) + '  ' + (m.host || '') + '  ' + (m.src || '') + ' -> ' + (m.dst || '') + '  ' + reasonOf(m) + '  CSeq:' + (m.cseq || '') + '  Call-ID:' + (m.callid || ''));
    const blob = new Blob(['# PBX-NG captura SIP  ' + new Date().toISOString() + '  (' + all.length + ' msgs)\n' + lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sip-capture-' + Date.now() + '.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // drawer ladder geometry
  const lanes = useMemo(() => { if (!dialog) return []; const L = []; dialog.ms.forEach((m) => [ipOf(m.src), ipOf(m.dst)].forEach((ip) => { if (ip && ip !== '?' && !L.includes(ip)) L.push(ip); })); return L; }, [dialog]);
  const W = Math.max(420, 120 + Math.max(0, lanes.length - 1) * 200);
  const rowH = 40, top = 64;
  const H = top + (dialog ? dialog.ms.length : 0) * rowH + 24;
  const laneX = (ip) => { const i = lanes.indexOf(ip); if (lanes.length <= 1) return W / 2; return 70 + i * ((W - 140) / (lanes.length - 1)); };
  const lcol = (m) => ({ yellow: '#f59e0b', teal: '#16a34a', cyan: '#0891b2', red: '#dc2626', blue: '#2f74e6', grape: '#7c3aed', gray: '#64748b' }[msgColor(m)]);

  return (
    <Stack gap="sm">
      <style>{`.sip-eq{display:inline-flex;gap:1px;align-items:flex-end;height:12px} .sip-eq>span{width:2px;height:4px;background:var(--mantine-color-teal-6);border-radius:1px;animation:sipeq .8s ease-in-out infinite} @keyframes sipeq{0%,100%{height:3px}50%{height:11px}}`}</style>
      <Card withBorder radius="md" padding="sm" style={{ background: 'var(--mantine-color-grape-light)' }}>
        <Group gap="xs" mb={2}><IconInfoCircle size={15} /><Text fw={700} size="sm">Analizador SIP en vivo</Text></Group>
        <Text size="xs" c="dimmed">Cada fila es un mensaje SIP capturado en Asterisk (incl. WebRTC) o el SBC (troncales). Filtra por errores, busca, y <b>hace click en una fila</b> para ver el dialogo completo de esa llamada y la explicacion de cada paso.</Text>
      </Card>

      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs">
          <Switch checked={on} onChange={(e) => toggle(e.currentTarget.checked)} label="Captura" color="grape" size="sm" />
          <Tooltip label={live ? 'Pausar' : 'Reanudar'}><ActionIcon variant="light" color={live ? 'teal' : 'gray'} onClick={() => setLive((v) => !v)}>{live ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />}</ActionIcon></Tooltip>
          <Tooltip label="Refrescar"><ActionIcon variant="light" color="blue" onClick={load}><IconRefresh size={16} /></ActionIcon></Tooltip>
          <SegmentedControl size="xs" value={filt} onChange={setFilt} data={[{ label: 'Todo', value: 'all' }, { label: 'Errores', value: 'err' }, { label: 'Senial.', value: 'sig' }, { label: 'Registro', value: 'reg' }]} />
          <SegmentedControl size="xs" value={hostF} onChange={setHostF} data={[{ label: 'Ambos', value: 'all' }, { label: 'Asterisk', value: 'asterisk' }, { label: 'SBC', value: 'sbc' }]} />
        </Group>
        <Group gap="xs">
          <TextInput size="xs" leftSection={<IconSearch size={14} />} placeholder="Filtrar..." value={q} onChange={(e) => setQ(e.target.value)} w={190} />
          <Switch checked={grouped} onChange={(e) => setGrouped(e.currentTarget.checked)} label="Agrupar" size="xs" color="grape" /><Switch checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} label="Auto" size="xs" />
          <Badge variant="light" color="gray">{filtered.length}</Badge>
          <Tooltip label="Exportar captura (.txt)"><Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={exportTxt}>Exportar</Button></Tooltip>
          <Tooltip label="Limpiar captura"><ActionIcon variant="light" color="red" onClick={clear}><IconTrash size={16} /></ActionIcon></Tooltip>
        </Group>
      </Group>

      <Card withBorder radius="md" padding={0} style={{ overflow: 'hidden' }}>
        <ScrollArea.Autosize mah={560} viewportRef={vpRef}>
          <Table stickyHeader highlightOnHover verticalSpacing={4} fz="xs">
            <Table.Thead>
              <Table.Tr><Table.Th w={96}>Hora</Table.Th><Table.Th>Origen</Table.Th><Table.Th w={22}></Table.Th><Table.Th>Destino</Table.Th><Table.Th>Mensaje</Table.Th><Table.Th w={84}>CSeq</Table.Th><Table.Th w={72}>Punto</Table.Th></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {grouped ? (groups.length === 0 ? <Table.Tr><Table.Td colSpan={7}><Text c="dimmed" ta="center" py="xl" size="sm">Sin conversaciones.</Text></Table.Td></Table.Tr> : groups.map((g) => (<Table.Tr key={g.callid} style={{ cursor: 'pointer' }} onClick={() => setDrawer(g.callid)}><Table.Td style={MONO}>{fmtT(g.t0)}</Table.Td><Table.Td style={MONO}>{g.from}</Table.Td><Table.Td><IconArrowRight size={12} style={{ opacity: .5 }} /></Table.Td><Table.Td style={MONO}>{g.to}</Table.Td><Table.Td><Group gap={6} wrap="nowrap"><Badge variant="light" color={ST[g.status].c}>{ST[g.status].t}</Badge><Badge size="xs" variant="outline" color="gray">{g.ms.length}</Badge>{g.audio && <AudioBars />}</Group></Table.Td><Table.Td></Table.Td><Table.Td>{[...new Set(g.ms.map((m) => m.host))].map((h) => <Badge key={h} size="xs" variant="dot" color={h === 'sbc' ? 'grape' : 'blue'}>{h}</Badge>)}</Table.Td></Table.Tr>))) : (filtered.length === 0 ? <Table.Tr><Table.Td colSpan={7}><Text c="dimmed" ta="center" py="xl" size="sm">Sin trafico SIP capturado todavia.</Text></Table.Td></Table.Tr> :
                filtered.map((m) => {
                  const tint = m.status >= 400 ? 'rgba(220,38,38,.07)' : (m.status >= 200 && m.status < 300) ? 'rgba(22,163,74,.06)' : (m.method === 'INVITE' || m.method === 'BYE') ? 'rgba(47,116,230,.05)' : undefined;
                  return (
                    <Table.Tr key={m.id} style={{ cursor: 'pointer', background: tint }} onClick={() => setDrawer(m.callid || ('id' + m.id))}>
                      <Table.Td style={MONO}>{fmtT(m.t)}</Table.Td>
                      <Table.Td style={MONO}>{m.src}</Table.Td>
                      <Table.Td><IconArrowRight size={12} style={{ opacity: .5 }} /></Table.Td>
                      <Table.Td style={MONO}>{m.dst}</Table.Td>
                      <Table.Td><Badge variant="light" color={msgColor(m)} leftSection={<MsgIcon m={m} />}>{reasonOf(m)}</Badge></Table.Td>
                      <Table.Td style={MONO} c="dimmed">{m.cseq || ''}</Table.Td>
                      <Table.Td><Badge size="xs" variant="dot" color={m.host === 'sbc' ? 'grape' : 'blue'}>{m.host}</Badge></Table.Td>
                    </Table.Tr>
                  );
                }))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Card>

      <Drawer opened={!!drawer} onClose={() => { setDrawer(null); setRaw(null); }} position="right" size="xl" keepMounted={false}
        title={dialog && <Group gap="sm"><MsgIcon m={dialog.ms[0]} size={20} /><div><Text fw={800} lh={1.1}>{dialog.from} {'->'} {dialog.to}</Text><Text size="xs" c="dimmed" style={MONO} truncate maw={360}>{dialog.callid}</Text></div><Badge variant="light" color={ST[dialog.status].c}>{ST[dialog.status].t}</Badge>{hasAudio(dialog.ms) && <Badge variant="light" color="teal" leftSection={<IconWaveSine size={12} />}>Audio</Badge>}</Group>}>
        {dialog && <Stack gap="md">
          <Card withBorder radius="md" padding="xs">
            <Text fw={700} size="sm" mb={6}>Flujo de la llamada</Text>
            <ScrollArea.Autosize mah={300}>
              <svg viewBox={'0 0 ' + W + ' ' + H} style={{ width: '100%', minWidth: W, height: H, display: 'block' }}>
                {lanes.map((ip) => { const x = laneX(ip); return (
                  <g key={ip}>
                    <line x1={x} y1={48} x2={x} y2={H - 8} stroke="var(--mantine-color-default-border)" strokeWidth="1.2" strokeDasharray="3 4" />
                    <rect x={x - 64} y={10} width={128} height={28} rx={8} fill="var(--mantine-color-body)" stroke="var(--mantine-color-default-border)" />
                    <text x={x} y={28} textAnchor="middle" style={{ fontSize: 10.5, fontWeight: 700, fill: 'var(--mantine-color-text)' }}>{ip}</text>
                  </g>); })}
                {dialog.ms.map((m, i) => {
                  const x1 = laneX(ipOf(m.src)), x2v = laneX(ipOf(m.dst)); const y = top + i * rowH;
                  const self = Math.abs(x1 - x2v) < 1; const x2 = self ? x1 + 70 : x2v; const dir = x2 >= x1 ? 1 : -1; const c = lcol(m); const len = Math.abs(x2 - x1) || 70;
                  const cseq = (m.cseq || '').split(' ')[1] || '';
                  return (
                    <g key={m.id} style={{ cursor: 'pointer' }} onClick={() => showRaw(m.id)}>
                      <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: c }}>{reasonOf(m)}{cseq ? ' (' + cseq + ')' : ''}</text>
                      <path d={'M ' + x1 + ' ' + y + ' L ' + x2 + ' ' + y} stroke={c} strokeWidth={raw && raw.id === m.id ? 3.4 : 2} fill="none" />
                      <path d={'M ' + x2 + ' ' + y + ' l ' + (-8 * dir) + ' -4 l 0 8 z'} fill={c} />
                    </g>);
                })}
              </svg>
            </ScrollArea.Autosize>
          </Card>

          <Box>
            <Text fw={700} size="sm" mb={6}>Mensajes (cada paso explicado)</Text>
            <Stack gap={6}>
              {dialog.ms.map((m, i) => {
                const dt = i > 0 ? '+' + Math.max(0, Math.round(m.t - dialog.ms[i - 1].t)) + 'ms' : fmtT(m.t);
                return (
                  <Card key={m.id} withBorder radius="sm" padding="xs">
                    <Group justify="space-between" gap={6} wrap="nowrap">
                      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}><Badge variant="light" color={msgColor(m)} leftSection={<MsgIcon m={m} />}>{reasonOf(m)}</Badge><Text size="xs" c="dimmed" style={MONO} truncate>{m.src} {'->'} {m.dst}</Text></Group>
                      <Text size="xs" c="dimmed" style={MONO}>{dt}</Text>
                    </Group>
                    <Text size="xs" c="dimmed" mt={4}>{sipDesc(m)}</Text>
                    <Anchor size="xs" onClick={() => showRaw(m.id)} mt={2}>{raw && raw.id === m.id ? 'ocultar crudo' : 'ver mensaje crudo'}</Anchor>
                    {raw && raw.id === m.id && <Code block mt={4} style={{ fontSize: 11, maxHeight: 220, overflow: 'auto' }}>{raw.text}</Code>}
                  </Card>
                );
              })}
            </Stack>
          </Box>
        </Stack>}
      </Drawer>
    </Stack>
  );
}
