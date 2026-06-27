'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Stack, Group, Text, Badge, Card, Button, TextInput, Switch, ScrollArea, ActionIcon, Tooltip, Code, SegmentedControl, Box, Table, ThemeIcon } from '@mantine/core';
import { IconBug, IconTrash, IconSearch, IconInfoCircle, IconRefresh, IconPlayerPlay, IconPlayerPause, IconX, IconPhoneCall, IconPhoneOff, IconPhonePlus, IconCircleCheck, IconCircleX, IconAlertTriangle, IconClock, IconBell, IconUserCheck, IconHeartbeat, IconArrowsExchange, IconCheck, IconArrowRight, IconDownload, IconTable, IconTimeline, IconPhone } from '@tabler/icons-react';
import { toast } from './notify';

const userOf = (u) => { if (!u) return '?'; const m = String(u).match(/sips?:([^@>;\s]+)/i); if (m) return m[1]; const m2 = String(u).match(/<?([^@>;\s]+)/); return m2 ? m2[1] : String(u).slice(0, 14); };
const ipOf = (hp) => (hp || '').split(':')[0];
const HOSTCOL = { asterisk: '#2f74e6', sbc: '#7c3aed' };

const METHOD_DESC = {
  INVITE: 'INVITE — inicia o modifica una sesion de llamada (negocia los medios/codecs).',
  ACK: 'ACK — confirma la recepcion de la respuesta final (200 OK) a un INVITE.',
  BYE: 'BYE — finaliza una llamada ya establecida.',
  CANCEL: 'CANCEL — cancela un INVITE que aun no recibio respuesta final (cuelgan antes de atender).',
  REGISTER: 'REGISTER — el interno publica su ubicacion (registro) en el servidor.',
  OPTIONS: 'OPTIONS — sondeo de disponibilidad / keepalive (qualify de PJSIP).',
  SUBSCRIBE: 'SUBSCRIBE — se suscribe a eventos (BLF, presencia, buzon de voz).',
  NOTIFY: 'NOTIFY — notifica un evento a quien esta suscripto.',
  INFO: 'INFO — informacion durante la sesion (por ejemplo digitos DTMF).',
  PRACK: 'PRACK — confirma una respuesta provisional fiable (100rel).',
  UPDATE: 'UPDATE — modifica la sesion sin un nuevo INVITE.',
  MESSAGE: 'MESSAGE — mensajeria instantanea SIP.',
  REFER: 'REFER — solicita una transferencia de llamada.',
  PUBLISH: 'PUBLISH — publica estado de presencia.',
};
const STATUS_REASON = { 100: 'Trying', 180: 'Ringing', 181: 'Call Is Being Forwarded', 182: 'Queued', 183: 'Session Progress', 200: 'OK', 202: 'Accepted', 300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Moved Temporarily', 305: 'Use Proxy', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 410: 'Gone', 413: 'Request Entity Too Large', 415: 'Unsupported Media Type', 420: 'Bad Extension', 423: 'Interval Too Brief', 480: 'Temporarily Unavailable', 481: 'Call/Transaction Does Not Exist', 482: 'Loop Detected', 483: 'Too Many Hops', 484: 'Address Incomplete', 486: 'Busy Here', 487: 'Request Terminated', 488: 'Not Acceptable Here', 491: 'Request Pending', 500: 'Server Internal Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Server Time-out', 505: 'Version Not Supported', 600: 'Busy Everywhere', 603: 'Decline', 604: 'Does Not Exist Anywhere', 606: 'Not Acceptable' };
const STATUS_HINT = { 401: 'El servidor pide autenticacion; el cliente reintenta con credenciales (normal).', 407: 'Como 401, pero lo pide un proxy.', 403: 'Credenciales o identidad rechazadas.', 404: 'El destino marcado no existe.', 408: 'No hubo respuesta a tiempo.', 480: 'El destino esta registrado pero no disponible.', 486: 'El destino esta ocupado.', 487: 'El INVITE fue cancelado por un CANCEL.', 488: 'No hay codecs en comun (revisar allow).', 503: 'Servicio no disponible (sobrecarga o caida).', 481: 'El dialogo/transaccion ya no existe.' };
function statusDesc(code) {
  const r = STATUS_REASON[code] || '';
  let cls = '';
  if (code < 200) cls = 'Provisional: la peticion se recibio y se esta procesando.';
  else if (code < 300) cls = 'Exito: la peticion se completo correctamente.';
  else if (code < 400) cls = 'Redireccion: la llamada debe intentarse en otro destino.';
  else if (code < 500) cls = 'Error del cliente: la peticion no pudo completarse.';
  else if (code < 600) cls = 'Error del servidor: no pudo procesar una peticion valida.';
  else cls = 'Fallo global: la peticion falla en cualquier destino.';
  const hint = STATUS_HINT[code] || '';
  return (code + ' ' + r).trim() + ' — ' + cls + (hint ? ' ' + hint : '');
}
function sipDesc(m) { return m.method ? (METHOD_DESC[m.method] || (m.method + ' — metodo SIP.')) : statusDesc(m.status); }
function reasonOf(m) { return m.method ? m.method : ((m.status || '') + ' ' + (STATUS_REASON[m.status] || '')).trim(); }
function msgColor(m) { if (m.status) { if (m.status < 200) return 'yellow'; if (m.status < 300) return 'teal'; if (m.status < 400) return 'cyan'; return 'red'; } if (['INVITE', 'REGISTER', 'SUBSCRIBE', 'PUBLISH', 'REFER'].includes(m.method)) return 'blue'; if (['BYE', 'CANCEL'].includes(m.method)) return 'grape'; return 'gray'; }
function MsgIcon({ m, size = 14 }) {
  const col = 'var(--mantine-color-' + msgColor(m) + '-6)';
  let I = IconArrowRight;
  if (m.status) { I = m.status < 200 ? IconClock : m.status < 300 ? IconCircleCheck : m.status < 400 ? IconArrowsExchange : IconCircleX; }
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
function fmtT(t) { const d = new Date(t); const p = (n, l = 2) => String(n).padStart(l, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3); }

function dlgStatus(ms) { const codes = ms.filter((m) => m.status).map((m) => m.status); if (codes.some((c) => c >= 400)) return 'fail'; if (codes.some((c) => c >= 200 && c < 300)) return 'ok'; if (codes.some((c) => c >= 100 && c < 200)) return 'ring'; return 'info'; }
const ST = { ok: { c: 'teal', t: 'OK' }, fail: { c: 'red', t: 'Error' }, ring: { c: 'yellow', t: 'En curso' }, info: { c: 'gray', t: 'Info' } };

export default function SipLadder() {
  const [msgs, setMsgs] = useState([]);
  const [view, setView] = useState('table');
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState('');
  const [hostF, setHostF] = useState('all');
  const [filt, setFilt] = useState('all');
  const [live, setLive] = useState(true);
  const [follow, setFollow] = useState(true);
  const [on, setOn] = useState(true);
  const [raw, setRaw] = useState(null);
  const liveRef = useRef(live); liveRef.current = live;
  const vpRef = useRef(null);

  const load = async () => { try { const d = await fetch('/backend/api/sip/messages?limit=800').then((r) => r.json()); if (Array.isArray(d)) setMsgs(d); } catch (_) {} };
  useEffect(() => { load(); fetch('/backend/api/sip/state').then((r) => r.json()).then((d) => setOn(!!d.on)).catch(() => {}); }, []);
  useEffect(() => { const t = setInterval(() => { if (liveRef.current) load(); }, 2000); return () => clearInterval(t); }, []);

  const filtered = useMemo(() => {
    let arr = msgs;
    if (hostF !== 'all') arr = arr.filter((m) => m.host === hostF);
    if (filt === 'err') arr = arr.filter((m) => m.status >= 400);
    else if (filt === 'sig') arr = arr.filter((m) => ['INVITE', 'ACK', 'BYE', 'CANCEL'].includes(m.method) || m.status);
    else if (filt === 'reg') arr = arr.filter((m) => m.method === 'REGISTER' || m.method === 'OPTIONS' || m.method === 'SUBSCRIBE');
    if (q.trim()) { const s = q.toLowerCase(); arr = arr.filter((m) => ((m.src || '') + (m.dst || '') + (m.callid || '') + (m.method || '') + (m.status || '') + reasonOf(m)).toLowerCase().includes(s)); }
    return arr;
  }, [msgs, hostF, filt, q]);

  useEffect(() => { if (follow && view === 'table' && vpRef.current) vpRef.current.scrollTo({ top: vpRef.current.scrollHeight }); }, [filtered, follow, view]);

  const dialogs = useMemo(() => {
    const map = new Map();
    for (const m of msgs) { const k = m.callid || ('nocid-' + m.id); if (!map.has(k)) map.set(k, []); map.get(k).push(m); }
    let arr = [...map.entries()].map(([callid, ms]) => { ms.sort((a, b) => a.id - b.id); const inv = ms.find((m) => m.method); return { callid, ms, from: userOf((inv || ms[0]).from_uri), to: userOf((inv || ms[0]).to_uri), kind: (ms.find((m) => m.method) || {}).method || 'SIP', status: dlgStatus(ms), last: ms[ms.length - 1].t, hosts: [...new Set(ms.map((m) => m.host))] }; });
    arr.sort((a, b) => b.last - a.last);
    if (hostF !== 'all') arr = arr.filter((d) => d.hosts.includes(hostF));
    if (q.trim()) { const s = q.toLowerCase(); arr = arr.filter((d) => (d.callid + d.from + d.to + d.kind).toLowerCase().includes(s)); }
    return arr;
  }, [msgs, q, hostF]);
  const current = useMemo(() => dialogs.find((d) => d.callid === sel) || dialogs[0] || null, [dialogs, sel]);

  const showRaw = async (m) => { setRaw({ id: m.id, loading: true, text: '' }); try { const d = await fetch('/backend/api/sip/raw/' + m.id).then((r) => r.json()); setRaw({ id: m.id, loading: false, text: d.raw || '(sin contenido)' }); } catch (_) { setRaw({ id: m.id, loading: false, text: '(error)' }); } };
  const toggle = async (v) => { setOn(v); try { await fetch('/backend/api/sip/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: v }) }); toast(v ? 'Captura activada' : 'Captura pausada', 'ok'); } catch (_) {} };
  const clear = async () => { if (!confirm('Borrar todos los mensajes SIP capturados?')) return; try { await fetch('/backend/api/sip/clear', { method: 'POST' }); setMsgs([]); setSel(null); setRaw(null); toast('Captura limpiada', 'ok'); } catch (_) {} };
  const exportTxt = () => { const lines = filtered.map((m) => fmtT(m.t) + '  ' + (m.host || '') + '  ' + (m.src || '') + ' -> ' + (m.dst || '') + '  ' + reasonOf(m) + '  CSeq:' + (m.cseq || '') + '  ' + (m.callid || '')); const blob = new Blob([lines.join('\n')], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sip-capture.txt'; a.click(); };

  const lanes = useMemo(() => { if (!current) return []; const L = []; current.ms.forEach((m) => [ipOf(m.src), ipOf(m.dst)].forEach((ip) => { if (ip && ip !== '?' && !L.includes(ip)) L.push(ip); })); return L; }, [current]);
  const W = Math.max(560, 160 + Math.max(0, lanes.length - 1) * 230);
  const rowH = 46, top = 78;
  const H = top + (current ? current.ms.length : 0) * rowH + 40;
  const laneX = (ip) => { const i = lanes.indexOf(ip); if (lanes.length <= 1) return W / 2; return 90 + i * ((W - 170) / (lanes.length - 1)); };
  const laneHost = (ip) => { const m = current?.ms.find((x) => ipOf(x.src) === ip || ipOf(x.dst) === ip); return m ? m.host : ''; };
  const ladderColor = (m) => { const c = msgColor(m); return { yellow: '#f59e0b', teal: '#16a34a', cyan: '#0891b2', red: '#dc2626', blue: '#2f74e6', grape: '#7c3aed', gray: '#64748b' }[c]; };

  return (
    <Stack gap="md">
      <style>{`@keyframes sipDraw{from{stroke-dashoffset:var(--len)}to{stroke-dashoffset:0}} @keyframes sipIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}} .sip-arrow{animation:sipDraw .5s ease forwards} .sip-row{animation:sipIn .4s ease both} @keyframes sipRowIn{from{opacity:0;background:rgba(47,116,230,.18)}to{opacity:1}} .sip-trow{animation:sipRowIn .5s ease both}`}</style>

      <Card withBorder radius="md" padding="md" style={{ background: 'var(--mantine-color-grape-light)' }}>
        <Group gap="xs" mb={4}><IconInfoCircle size={16} /><Text fw={700} size="sm">Analizador SIP en vivo (estilo Wireshark)</Text></Group>
        <Text size="sm" c="dimmed">Cada fila es un mensaje SIP capturado en <b>Asterisk</b> (incluye WebRTC, via HEP) o en el <b>SBC</b> (troncales, via tcpdump), ordenado por tiempo. Pasa el mouse por el tipo de mensaje para ver <b>que significa</b> en el protocolo. Filtra por <b>errores</b> para ver solo respuestas 4xx-6xx. Vista <b>Tabla</b> para la traza cruda; vista <b>Flujo</b> para el diagrama de la llamada.</Text>
      </Card>

      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="sm">
          <SegmentedControl size="xs" value={view} onChange={setView} data={[{ label: (<Group gap={4}><IconTable size={13} /> Tabla</Group>), value: 'table' }, { label: (<Group gap={4}><IconTimeline size={13} /> Flujo</Group>), value: 'flow' }]} />
          <Switch checked={on} onChange={(e) => toggle(e.currentTarget.checked)} label="Captura" color="grape" size="sm" />
          <Tooltip label={live ? 'Pausar' : 'Reanudar'}><ActionIcon variant="light" color={live ? 'teal' : 'gray'} onClick={() => setLive((v) => !v)}>{live ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />}</ActionIcon></Tooltip>
          <Tooltip label="Refrescar"><ActionIcon variant="light" color="blue" onClick={load}><IconRefresh size={16} /></ActionIcon></Tooltip>
        </Group>
        <Group gap="sm">
          <SegmentedControl size="xs" value={filt} onChange={setFilt} data={[{ label: 'Todo', value: 'all' }, { label: 'Errores', value: 'err' }, { label: 'Senalizacion', value: 'sig' }, { label: 'Registro', value: 'reg' }]} />
          <SegmentedControl size="xs" value={hostF} onChange={setHostF} data={[{ label: 'Ambos', value: 'all' }, { label: 'Asterisk', value: 'asterisk' }, { label: 'SBC', value: 'sbc' }]} />
        </Group>
      </Group>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <TextInput size="xs" leftSection={<IconSearch size={14} />} placeholder="Filtrar (IP, interno, Call-ID, codigo...)" value={q} onChange={(e) => setQ(e.target.value)} w={300} />
        <Group gap="sm">
          <Switch checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} label="Auto-scroll" size="xs" />
          <Badge variant="light" color="gray">{filtered.length} msgs</Badge>
          <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={exportTxt}>Exportar</Button>
          <Button size="xs" variant="light" color="red" leftSection={<IconTrash size={14} />} onClick={clear}>Limpiar</Button>
        </Group>
      </Group>

      {view === 'table' ? (
        <Card withBorder radius="md" padding={0} style={{ overflow: 'hidden' }}>
          <ScrollArea.Autosize mah={560} viewportRef={vpRef}>
            <Table stickyHeader highlightOnHover verticalSpacing={4} fz="xs" striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40}>#</Table.Th><Table.Th w={104}>Hora</Table.Th><Table.Th>Origen</Table.Th><Table.Th w={26}></Table.Th><Table.Th>Destino</Table.Th><Table.Th>Mensaje</Table.Th><Table.Th w={90}>CSeq</Table.Th><Table.Th>Call-ID</Table.Th><Table.Th w={80}>Punto</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filtered.length === 0 ? <Table.Tr><Table.Td colSpan={9}><Text c="dimmed" ta="center" py="xl" size="sm">Sin trafico SIP capturado todavia.</Text></Table.Td></Table.Tr> :
                  filtered.map((m, i) => {
                    const col = msgColor(m);
                    const tint = m.status >= 400 ? 'rgba(220,38,38,.07)' : (m.status >= 200 && m.status < 300) ? 'rgba(22,163,74,.06)' : (m.method === 'INVITE' || m.method === 'BYE') ? 'rgba(47,116,230,.05)' : undefined;
                    return (
                      <Table.Tr key={m.id} className="sip-trow" style={{ cursor: 'pointer', background: raw && raw.id === m.id ? 'var(--mantine-color-blue-light)' : tint }} onClick={() => showRaw(m)}>
                        <Table.Td c="dimmed">{i + 1}</Table.Td>
                        <Table.Td style={MONO}>{fmtT(m.t)}</Table.Td>
                        <Table.Td style={MONO}>{m.src}</Table.Td>
                        <Table.Td><IconArrowRight size={12} style={{ opacity: .5 }} /></Table.Td>
                        <Table.Td style={MONO}>{m.dst}</Table.Td>
                        <Table.Td>
                          <Tooltip multiline w={330} withArrow label={sipDesc(m)} events={{ hover: true, focus: true, touch: true }}>
                            <Badge variant="light" color={col} leftSection={<MsgIcon m={m} size={12} />} style={{ cursor: 'help' }}>{reasonOf(m)}</Badge>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td style={MONO} c="dimmed">{m.cseq || ''}</Table.Td>
                        <Table.Td><Text size="xs" c="dimmed" truncate maw={150} style={MONO}>{m.callid || ''}</Text></Table.Td>
                        <Table.Td><Badge size="xs" variant="dot" color={m.host === 'sbc' ? 'grape' : 'blue'}>{m.host}</Badge></Table.Td>
                      </Table.Tr>
                    );
                  })}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 14, alignItems: 'start' }}>
          <Card withBorder radius="md" padding={0} style={{ overflow: 'hidden' }}>
            <Box p="xs" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}><Text fw={700} size="sm">Dialogos ({dialogs.length})</Text></Box>
            <ScrollArea.Autosize mah={560}>
              {dialogs.length === 0 ? <Text size="sm" c="dimmed" ta="center" py="xl">Sin trafico SIP.</Text> :
                dialogs.map((d) => { const st = ST[d.status]; const a = current && current.callid === d.callid; return (
                  <Box key={d.callid} onClick={() => setSel(d.callid)} style={{ cursor: 'pointer', padding: '9px 12px', borderBottom: '1px solid var(--mantine-color-gray-1)', background: a ? 'var(--mantine-color-blue-light)' : 'transparent' }}>
                    <Group justify="space-between" gap={6} wrap="nowrap">
                      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}><Badge size="xs" variant="light" color={st.c}>{st.t}</Badge><Text fw={600} size="sm" truncate>{d.from} {'->'} {d.to}</Text></Group>
                      <Badge size="xs" variant="outline" color="gray">{d.ms.length}</Badge>
                    </Group>
                    <Group gap={5} mt={3}><Badge size="xs" variant="dot" color="blue">{d.kind}</Badge>{d.hosts.map((h) => <Badge key={h} size="xs" variant="light" color={h === 'sbc' ? 'grape' : 'blue'}>{h}</Badge>)}</Group>
                  </Box>); })}
            </ScrollArea.Autosize>
          </Card>
          <Card withBorder radius="md" padding="md">
            {!current ? <Text size="sm" c="dimmed" ta="center" py="xl">Seleccciona un dialogo.</Text> :
              <>
                <Group justify="space-between" mb="xs">
                  <div><Text fw={700} size="sm">{current.from} {'->'} {current.to}</Text><Text size="xs" c="dimmed" style={MONO} truncate maw={420}>{current.callid}</Text></div>
                  <Badge variant="light" color={ST[current.status].c}>{ST[current.status].t}</Badge>
                </Group>
                <ScrollArea.Autosize mah={520}>
                  <svg viewBox={'0 0 ' + W + ' ' + H} style={{ width: '100%', minWidth: W, height: H, display: 'block' }}>
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
                      const dir = x2 >= x1 ? 1 : -1; const col = ladderColor(m); const len = Math.abs(x2 - x1) || 90;
                      const dt = i > 0 ? '+' + Math.max(0, Math.round(m.t - current.ms[i - 1].t)) + 'ms' : '';
                      const cseq = (m.cseq || '').split(' ')[1] || '';
                      return (
                        <g key={m.id} className="sip-row" style={{ animationDelay: (i * 0.04) + 's', cursor: 'pointer' }} onClick={() => showRaw(m)}>
                          <text x={6} y={y - 3} style={{ fontSize: 9, fill: '#94a3b8' }}>{dt}</text>
                          <text x={(x1 + x2) / 2} y={y - 7} textAnchor="middle" style={{ fontSize: 11, fontWeight: 700, fill: col }}>{reasonOf(m)}{cseq ? ' (' + cseq + ')' : ''}</text>
                          <path d={'M ' + x1 + ' ' + y + ' L ' + x2 + ' ' + y} stroke={col} strokeWidth={raw && raw.id === m.id ? 3.5 : 2.2} fill="none" className="sip-arrow" style={{ '--len': len, strokeDasharray: len, animationDelay: (i * 0.04) + 's' }} />
                          <path d={'M ' + x2 + ' ' + y + ' l ' + (-9 * dir) + ' -4 l 0 8 z'} fill={col} />
                          {self && <text x={x1 + 96} y={y + 3} style={{ fontSize: 9, fill: '#94a3b8' }}>(mismo host)</text>}
                          <circle r="3.5" fill={col}><animateMotion dur="1.3s" begin={(i * 0.04) + 's'} repeatCount="1" fill="freeze" path={'M ' + x1 + ' ' + y + ' L ' + x2 + ' ' + y} /></circle>
                        </g>);
                    })}
                  </svg>
                </ScrollArea.Autosize>
              </>}
          </Card>
        </div>
      )}

      {raw && <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="xs"><Text fw={700} size="sm">Mensaje SIP #{raw.id}</Text><ActionIcon variant="subtle" onClick={() => setRaw(null)}><IconX size={16} /></ActionIcon></Group>
        <Code block style={{ maxHeight: 320, overflow: 'auto', fontSize: 12 }}>{raw.loading ? 'Cargando...' : raw.text}</Code>
      </Card>}
    </Stack>
  );
}
