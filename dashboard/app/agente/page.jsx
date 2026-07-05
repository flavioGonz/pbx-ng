'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useSoftphone } from '../useSoftphone';
import { useAuth, logout } from '../auth';
import Softphone from '../Softphone';
import Intercom from '../Intercom';
import {
  Card, Text, Group, Badge, Button, PasswordInput, Modal, ThemeIcon, Stack,
  ActionIcon, Tooltip, ScrollArea, useComputedColorScheme, SegmentedControl,
  Avatar, Loader, Select, Switch, Textarea, Rating, Table,
} from '@mantine/core';
import {
  IconPhone, IconLogout, IconKey, IconPhoneIncoming, IconPhoneOutgoing, IconRefresh,
  IconHeadset, IconPlayerPlay, IconDeviceCctv, IconSparkles, IconUserCheck, IconBuilding,
  IconId, IconMapPin, IconClipboardCheck, IconPlayerPause, IconCircleDot, IconVideoOff,
  IconUsers, IconVideo,
} from '@tabler/icons-react';
import { toast } from '../notify';

function fdur(sec){ sec=+sec||0; const m=Math.floor(sec/60), s=sec%60; return m+':'+String(s).padStart(2,'0'); }
const initials = (n) => (n || '?').split(/[\s.]+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const enc = encodeURIComponent;

const CSS = `
@keyframes agUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes agPulse{0%,100%{opacity:.55}50%{opacity:1}}
.ag-fade{animation:agUp .5s cubic-bezier(.2,.8,.2,1) both}
.glass{background:rgba(255,255,255,.62);backdrop-filter:blur(22px) saturate(170%);-webkit-backdrop-filter:blur(22px) saturate(170%);border:1px solid rgba(0,0,0,.06);border-radius:20px;box-shadow:0 12px 34px rgba(0,0,0,.09);transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s}
[data-mantine-color-scheme=dark] .glass{background:rgba(24,26,33,.55);border:1px solid rgba(255,255,255,.08);box-shadow:0 12px 34px rgba(0,0,0,.4)}
.glass.hoverable:hover{transform:translateY(-2px);box-shadow:0 18px 46px rgba(0,0,0,.16)}
.ag-row{transition:background .14s ease,transform .14s ease}
.ag-row:hover{background:var(--mantine-color-default-hover)}
.selfcam{position:relative;border-radius:20px;overflow:hidden;aspect-ratio:16/10;background:linear-gradient(135deg,#0b1220,#131a2b);box-shadow:0 12px 34px rgba(0,0,0,.28)}
.selfcam video{width:100%;height:100%;object-fit:cover;display:block;transform:scaleX(-1)}
.selfcam .ov{position:absolute;inset:auto 0 0 0;padding:12px 14px 11px;background:linear-gradient(180deg,transparent,rgba(0,0,0,.72));display:flex;align-items:flex-end;justify-content:space-between;gap:8px}
.vtile{border-radius:16px;overflow:hidden;box-shadow:0 8px 22px rgba(0,0,0,.14);transition:transform .2s}
.vtile:hover{transform:translateY(-2px)}
`;

function RecPlay({ row }) {
  const [state, setState] = useState('idle'); const [src, setSrc] = useState(null); const audioRef = useRef(null);
  async function toggle() {
    if (state === 'ready') { const a = audioRef.current; if (a) { a.paused ? a.play() : a.pause(); } return; }
    setState('loading');
    try {
      const ts = row.start ? Date.parse(row.start) : 0;
      const d = await fetch(`/backend/api/recordings/match?from=${enc(row.src)}&to=${enc(row.dst)}&ts=${ts}`).then(r => r.json());
      if (d && d.id) { setSrc(`/backend/api/recordings/${d.id}/audio`); setState('ready'); setTimeout(() => audioRef.current && audioRef.current.play().catch(() => {}), 60); }
      else { setState('none'); toast('Sin grabación para esta llamada', 'bad'); }
    } catch { setState('none'); }
  }
  if (state === 'ready') return <audio ref={audioRef} src={src} controls style={{ height: 28, maxWidth: 150 }} />;
  return <Tooltip label={state === 'none' ? 'Sin grabación' : 'Escuchar'}><ActionIcon size="sm" variant="light" color={state === 'none' ? 'gray' : 'grape'} loading={state === 'loading'} onClick={toggle} disabled={state === 'none'}><IconPlayerPlay size={14} /></ActionIcon></Tooltip>;
}

function Ficha({ client, caller, compact }) {
  if (!client || !client.id) return <Text c="dimmed" fz="sm" ta="center" py={compact ? 'xs' : 'md'}>{caller ? 'Cliente no identificado para ' + caller : 'Sin ficha'}</Text>;
  return (
    <div>
      <Group gap={10} wrap="nowrap" mb={8}>
        <Avatar size={compact ? 40 : 48} radius="xl" color="blue">{initials(client.name)}</Avatar>
        <div style={{ minWidth: 0 }}>
          <Text fw={800} fz={compact ? 'md' : 'lg'} truncate>{client.name}</Text>
          <Group gap={10}>{client.doc && <Text fz="xs" c="dimmed"><IconId size={11} style={{ verticalAlign: -1 }} /> {client.doc}</Text>}{client.address && <Text fz="xs" c="dimmed" truncate><IconMapPin size={11} style={{ verticalAlign: -1 }} /> {client.address}</Text>}</Group>
        </div>
      </Group>
      {(client.persons || []).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Group gap={6} mb={6}><IconUserCheck size={15} color="#4dabf7" /><Text fz="xs" fw={800} c="dimmed" style={{ letterSpacing: .3 }}>PERSONAS AUTORIZADAS</Text></Group>
          <Stack gap={5}>{client.persons.map(p => (
            <Group key={p.id} gap={8} wrap="nowrap" style={{ background: 'var(--mantine-color-blue-light)', borderRadius: 10, padding: '5px 9px' }}>
              <ThemeIcon size={22} radius="xl" variant="light" color="blue"><IconUserCheck size={13} /></ThemeIcon>
              <Text fz="sm" fw={600} style={{ flex: 1, minWidth: 0 }} truncate>{p.name}</Text>
              {p.relation && <Badge size="xs" variant="light" color="blue">{p.relation}</Badge>}
              {p.doc && <Text fz={11} c="dimmed">{p.doc}</Text>}
            </Group>
          ))}</Stack>
        </div>
      )}
      {(client.spaces || []).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Group gap={6} mb={4}><IconBuilding size={14} color="#12b886" /><Text fz="xs" fw={800} c="dimmed">ESPACIOS</Text></Group>
          <Group gap={6}>{client.spaces.map(s => <Badge key={s.id} size="sm" variant="light" color="teal">{s.name}{s.kind ? ' · ' + s.kind : ''}</Badge>)}</Group>
        </div>
      )}
      {client.notes && <Text fz="xs" c="dimmed" mt={8} style={{ whiteSpace: 'pre-wrap' }}>{client.notes}</Text>}
    </div>
  );
}

function SelfCam({ name, ext, paused, registered }) {
  const ref = useRef(null); const streamRef = useRef(null);
  const [on, setOn] = useState(false); const [err, setErr] = useState('');
  const start = useCallback(async () => {
    setErr('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setErr('No soportado'); return; }
    try {
      const cam = (typeof localStorage !== 'undefined' && localStorage.getItem('pbxng_dev_cam')) || '';
      const s = await navigator.mediaDevices.getUserMedia({ video: cam ? { deviceId: { ideal: cam } } : true, audio: false });
      streamRef.current = s;
      if (ref.current) { ref.current.srcObject = s; ref.current.play().catch(() => {}); }
      setOn(true);
    } catch (e) {
      const n = e && e.name;
      setErr(n === 'NotAllowedError' ? 'Permiso denegado' : n === 'NotReadableError' ? 'Cámara en uso' : n === 'NotFoundError' ? 'Sin cámara' : 'No disponible');
      setOn(false);
    }
  }, []);
  const stop = useCallback(() => { if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; } if (ref.current) ref.current.srcObject = null; setOn(false); }, []);
  useEffect(() => { start(); return () => stop(); }, [start, stop]);
  const stColor = paused ? '#ffa94d' : (registered ? '#40c057' : '#868e96');
  const stText = paused ? 'En pausa' : (registered ? 'Disponible' : 'Conectando');
  return (
    <div className="selfcam ag-fade">
      <video ref={ref} autoPlay muted playsInline style={{ display: on ? 'block' : 'none' }} />
      {!on && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: '#9aa3b7' }}>
          <Avatar size={64} radius="xl" color="teal">{initials(name)}</Avatar>
          <Group gap={5}><IconVideoOff size={14} /><Text fz="xs">{err ? 'Cámara: ' + err : 'Cámara apagada'}</Text></Group>
          <Button size="xs" radius="xl" variant="light" color="teal" leftSection={<IconVideo size={14} />} onClick={start}>Encender cámara</Button>
        </div>
      )}
      <div className="ov">
        <div style={{ minWidth: 0 }}>
          <Text fw={800} c="#fff" fz="md" truncate style={{ textShadow: '0 1px 4px rgba(0,0,0,.7)' }}>{name}</Text>
          <Text fz={11} c="rgba(255,255,255,.8)" ff="monospace">Interno {ext || '\u2014'}</Text>
        </div>
        <Group gap={6} wrap="nowrap">
          {on && <Tooltip label="Apagar cámara"><ActionIcon size={26} radius="xl" variant="filled" color="dark" onClick={stop}><IconVideoOff size={14} /></ActionIcon></Tooltip>}
          <Group gap={5} style={{ background: 'rgba(0,0,0,.45)', borderRadius: 20, padding: '3px 9px', backdropFilter: 'blur(6px)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: stColor, animation: 'agPulse 1.6s infinite' }} />
            <Text fz={11} fw={700} c="#fff">{stText}</Text>
          </Group>
        </Group>
      </div>
    </div>
  );
}

function SurveyModal({ opened, onClose, fields, ctx }) {
  const [ans, setAns] = useState({}); const [busy, setBusy] = useState(false);
  useEffect(() => { if (opened) setAns({}); }, [opened]);
  const setA = (id, v) => setAns(a => ({ ...a, [id]: v }));
  async function submit() {
    for (const f of fields) if (f.required && (ans[f.id] === undefined || ans[f.id] === '' || ans[f.id] === null)) { toast('Completá: ' + f.label, 'bad'); return; }
    setBusy(true);
    const labeled = {}; fields.forEach(f => { if (ans[f.id] !== undefined) labeled[f.label] = ans[f.id]; });
    const r = await fetch('/backend/api/survey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext: ctx.ext, client_id: ctx.clientId, caller: ctx.num, answers: labeled }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setBusy(false);
    if (r && r.error) { toast('No se pudo guardar la encuesta', 'bad'); return; }
    toast('Encuesta registrada', 'ok'); onClose();
  }
  return (
    <Modal opened={opened} onClose={onClose} title={<Group gap={8}><ThemeIcon variant="light" color="grape" radius="md"><IconClipboardCheck size={18} /></ThemeIcon><Text fw={800}>Encuesta de la llamada</Text></Group>} centered radius="lg" closeOnClickOutside={false}>
      <Stack gap="sm">
        {ctx.num && <Text fz="sm" c="dimmed">Llamada con {ctx.num}</Text>}
        {fields.length === 0 ? <Text c="dimmed" fz="sm">No hay campos de encuesta configurados.</Text> : fields.map(f => (
          <div key={f.id}>
            <Text fz="sm" fw={600} mb={4}>{f.label}{f.required ? ' *' : ''}</Text>
            {f.ftype === 'select' && <Select data={(f.options || []).map(o => ({ value: o, label: o }))} value={ans[f.id] || null} onChange={v => setA(f.id, v)} placeholder="Elegí…" />}
            {f.ftype === 'text' && <Textarea autosize minRows={2} value={ans[f.id] || ''} onChange={e => setA(f.id, e.currentTarget.value)} />}
            {f.ftype === 'rating' && <Rating value={ans[f.id] || 0} onChange={v => setA(f.id, v)} />}
            {f.ftype === 'bool' && <Switch checked={!!ans[f.id]} onChange={e => setA(f.id, e.currentTarget.checked)} label={ans[f.id] ? 'Sí' : 'No'} />}
          </div>
        ))}
        <Group justify="flex-end" mt="xs"><Button variant="default" onClick={onClose}>Omitir</Button><Button color="grape" loading={busy} onClick={submit}>Guardar</Button></Group>
      </Stack>
    </Modal>
  );
}

export default function AgentePanel() {
  const { user } = useAuth();
  const sp = useSoftphone();
  const scheme = useComputedColorScheme('dark', { getInitialValueInEffect: true });
  const dark = scheme === 'dark';
  const [cdr, setCdr] = useState([]);
  const [dir, setDir] = useState([]);
  const [cliCache, setCliCache] = useState({});
  const [pwOpen, setPwOpen] = useState(false);
  const [np, setNp] = useState(''); const [np2, setNp2] = useState(''); const [pwBusy, setPwBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  const [client, setClient] = useState(null);
  const [surveyFields, setSurveyFields] = useState([]);
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [surveyCtx, setSurveyCtx] = useState({});
  const [paused, setPaused] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [agentState, setAgentState] = useState({ inQueue: false });
  const wasInCall = useRef(false);
  const lastCtx = useRef({});
  const connectedRef = useRef(false);
  const registered = sp.reg === 'registered';
  const inCall = !!sp.call;
  const ext = user?.ext;

  useEffect(() => {
    if (connectedRef.current) return; connectedRef.current = true;
    fetch('/backend/api/me/sipcreds').then(r => r.json()).then(d => { if (d && d.ext && d.password) sp.connect(d.ext, d.password, false).catch(() => {}); else toast('Tu usuario no tiene interno asignado', 'bad'); }).catch(() => {});
    fetch('/backend/api/survey/fields').then(r => r.json()).then(d => Array.isArray(d) && setSurveyFields(d)).catch(() => {});
    fetch('/backend/api/agent/state').then(r => r.json()).then(d => { if (d) { setPaused(!!d.paused); setAgentState(d); } }).catch(() => {});
  }, []);

  const loadCdr = useCallback(() => { if (!ext) return; fetch('/backend/api/cdr?ext=' + ext + '&limit=80').then(r => r.json()).then(d => Array.isArray(d) && setCdr(d)).catch(() => {}); }, [ext]);
  useEffect(() => { loadCdr(); const t = setInterval(loadCdr, 15000); return () => clearInterval(t); }, [loadCdr]);
  useEffect(() => { const l = () => fetch('/backend/api/directory').then(r => r.json()).then(d => Array.isArray(d) && setDir(d)).catch(() => {}); l(); const t = setInterval(l, 12000); return () => clearInterval(t); }, []);

  // cache de nombre de cliente por número (para columna Cliente)
  useEffect(() => {
    if (!ext) return;
    const nums = [...new Set(cdr.map(r => String(r.src) === String(ext) ? r.dst : r.src))].filter(n => n && !(n in cliCache));
    if (!nums.length) return; let alive = true;
    (async () => { const upd = {}; for (const n of nums.slice(0, 30)) { try { const c = await fetch('/backend/api/clients/lookup?number=' + enc(n)).then(r => r.json()); upd[n] = (c && c.id) ? c.name : null; } catch { upd[n] = null; } } if (alive) setCliCache(m => ({ ...m, ...upd })); })();
    return () => { alive = false; };
  }, [cdr, ext]);

  const callNum = sp.callInfo?.number || (sp.incoming && sp.incoming.remoteIdentity && sp.incoming.remoteIdentity.uri && sp.incoming.remoteIdentity.uri.user) || null;
  useEffect(() => {
    let live = true;
    if (!callNum) { setClient(null); return; }
    fetch('/backend/api/clients/lookup?number=' + enc(callNum)).then(r => r.json()).then(c => { if (live) setClient(c && c.id ? c : { _miss: true }); }).catch(() => { if (live) setClient(null); });
    return () => { live = false; };
  }, [callNum]);
  useEffect(() => { if (callNum) lastCtx.current = { num: callNum, clientId: client && client.id ? client.id : null, ext }; }, [callNum, client, ext]);
  useEffect(() => {
    if (inCall) { wasInCall.current = true; }
    else if (wasInCall.current) { wasInCall.current = false; if (surveyFields.length && lastCtx.current.num) { setSurveyCtx({ ...lastCtx.current }); setSurveyOpen(true); } }
  }, [inCall, surveyFields]);

  const callStreams = (client && Array.isArray(client.devices)) ? client.devices : [];

  async function togglePause() {
    setPauseBusy(true); const nv = !paused;
    const r = await fetch('/backend/api/agent/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: nv }) }).then(x => x.json()).catch(() => null);
    setPauseBusy(false);
    if (r && !r.error) { setPaused(!!r.paused); toast(r.paused ? 'En pausa — no recibirás llamadas de cola' : 'Disponible de nuevo', 'ok'); }
    else toast('No se pudo cambiar el estado', 'bad');
  }
  async function changePw() {
    if (np.length < 4) { toast('Mínimo 4 caracteres', 'bad'); return; }
    if (np !== np2) { toast('No coinciden', 'bad'); return; }
    setPwBusy(true);
    const r = await fetch('/backend/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: np }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setPwBusy(false);
    if (r.error) { toast('No se pudo cambiar', 'bad'); return; }
    toast('Contraseña actualizada', 'ok'); setPwOpen(false); setNp(''); setNp2('');
  }

  const nameOf = (n) => { const d = dir.find(x => String(x.ext) === String(n)); return d?.name || null; };
  const todayStr = new Date().toDateString();
  const countToday = (num) => cdr.filter(r => { const o = String(r.src) === String(ext) ? r.dst : r.src; return String(o) === String(num) && r.start && new Date(r.start).toDateString() === todayStr; }).length;
  const fcdr = cdr.filter(r => filter === 'all' ? true : filter === 'ans' ? r.disposition === 'ANSWERED' : (r.disposition !== 'ANSWERED' && String(r.dst) === String(ext)));
  const showFicha = !!callNum;

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(1200px 640px at 82% -18%, rgba(17,179,40,.12), transparent), radial-gradient(900px 500px at 10% 110%, rgba(64,120,255,.10), transparent), var(--mantine-color-body)', color: 'var(--mantine-color-text)', padding: 20 }}>
      <style>{CSS}</style>
      <Group justify="space-between" mb="lg" wrap="nowrap" className="ag-fade">
        <Group gap="sm">
          <ThemeIcon size={46} radius="md" variant="gradient" gradient={{ from: 'teal.6', to: 'green.8' }}><IconHeadset size={25} /></ThemeIcon>
          <div><Text fw={800} fz="xl" lh={1.05}>Panel de Agente</Text><Text fz="xs" c="dimmed">Centro de contacto · Infratec</Text></div>
        </Group>
        <Group gap="xs">
          <Button size="sm" radius="xl" variant={paused ? 'filled' : 'light'} color={paused ? 'orange' : 'teal'} loading={pauseBusy}
            leftSection={paused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />} onClick={togglePause}>
            {paused ? 'Reanudar' : 'Tomar pausa'}
          </Button>
          <Badge size="lg" variant="dot" color={paused ? 'orange' : (registered ? 'teal' : 'orange')}>{paused ? 'En pausa' : (registered ? 'En línea' : 'Conectando…')}</Badge>
          <Tooltip label="Cambiar contraseña"><ActionIcon size={38} variant="light" color="gray" onClick={() => setPwOpen(true)}><IconKey size={18} /></ActionIcon></Tooltip>
          <Tooltip label="Salir"><ActionIcon size={38} variant="light" color="red" onClick={logout}><IconLogout size={18} /></ActionIcon></Tooltip>
        </Group>
      </Group>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px,360px) minmax(0,1fr) minmax(320px,380px)', gap: 18, alignItems: 'start' }}>
        {/* Columna 1: self-cam + softphone */}
        <Stack gap="md">
          <SelfCam name={user?.name || user?.username} ext={ext} paused={paused} registered={registered} />
          <Card className="glass ag-fade" padding="lg" style={{ animationDelay: '.05s' }}>
            <Softphone sp={sp} dark={dark} directory={dir} height={470} onIncomingCard={(num) => <div style={{ borderTop: '1px solid var(--mantine-color-default-border)', padding: '12px 6px 2px' }}><Ficha client={client && client.id ? client : null} caller={num} compact /></div>} />
          </Card>
        </Stack>

        {/* Columna 2: ficha en llamada + Mis llamadas (título/tabs fuera del recuadro) */}
        <Stack gap="md">
          {showFicha && (
            <Card className="glass ag-fade" padding="md" style={{ borderColor: 'var(--mantine-color-blue-5)', animationDelay: '.04s' }}>
              <Group justify="space-between" mb={6}><Group gap={8}><ThemeIcon size={30} radius="md" variant="light" color="blue"><IconId size={17} /></ThemeIcon><Text fw={800}>Ficha del cliente en llamada</Text></Group><Badge color="blue" variant="light" size="lg">{callNum}</Badge></Group>
              <Ficha client={client && client.id ? client : null} caller={callNum} />
            </Card>
          )}

          <div>
            <Group justify="space-between" wrap="nowrap" px={4} mb={8}>
              <Group gap={8}><ThemeIcon size={30} radius="md" variant="light" color="blue"><IconPhoneIncoming size={17} /></ThemeIcon><Text fw={800} fz="lg">Mis llamadas</Text></Group>
              <Group gap="xs">
                <SegmentedControl size="xs" radius="xl" value={filter} onChange={setFilter} data={[{ label: 'Todas', value: 'all' }, { label: 'Contestadas', value: 'ans' }, { label: 'Perdidas', value: 'miss' }]} />
                <ActionIcon variant="subtle" color="gray" onClick={loadCdr}><IconRefresh size={16} /></ActionIcon>
              </Group>
            </Group>
            <Card className="glass ag-fade" padding={0} style={{ animationDelay: '.08s' }}>
              <ScrollArea h="calc(100vh - 200px)" type="hover">
                <Table verticalSpacing={8} horizontalSpacing="md" stickyHeader highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Contacto</Table.Th>
                      <Table.Th>Cliente</Table.Th>
                      <Table.Th style={{ textAlign: 'center' }}>Hoy</Table.Th>
                      <Table.Th>Cuándo</Table.Th>
                      <Table.Th>Duración</Table.Th>
                      <Table.Th>Estado</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {fcdr.length === 0 ? <Table.Tr><Table.Td colSpan={7}><Text c="dimmed" ta="center" py={40}>Sin llamadas</Text></Table.Td></Table.Tr> : fcdr.map((r, i) => {
                      const out = String(r.src) === String(ext); const other = out ? r.dst : r.src;
                      const ok = r.disposition === 'ANSWERED'; const cli = cliCache[other]; const tc = countToday(other);
                      return (
                        <Table.Tr key={i} className="ag-row">
                          <Table.Td>
                            <Group gap={9} wrap="nowrap">
                              <Avatar size={34} radius="xl" color={out ? 'blue' : (ok ? 'teal' : 'red')}>{initials(nameOf(other) || cli || other)}</Avatar>
                              <div style={{ minWidth: 0 }}><Group gap={5} wrap="nowrap"><Text fz="sm" fw={700} truncate>{nameOf(other) || other}</Text>{out ? <IconPhoneOutgoing size={12} color="#4dabf7" /> : <IconPhoneIncoming size={12} color={ok ? '#12b328' : '#fa5252'} />}</Group><Text fz={11} c="dimmed" ff="monospace">{other}</Text></div>
                            </Group>
                          </Table.Td>
                          <Table.Td>{cli ? <Badge variant="light" color="grape" leftSection={<IconUsers size={11} />}>{cli}</Badge> : <Text fz="xs" c="dimmed">—</Text>}</Table.Td>
                          <Table.Td style={{ textAlign: 'center' }}>{tc > 1 ? <Badge variant="light" color={tc >= 3 ? 'orange' : 'blue'}>{tc}×</Badge> : <Text fz="sm" c="dimmed">{tc || '—'}</Text>}</Table.Td>
                          <Table.Td><Text fz="xs">{r.start ? new Date(r.start).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</Text></Table.Td>
                          <Table.Td><Text fz="xs" ff="monospace">{fdur(r.billsec)}</Text></Table.Td>
                          <Table.Td>{out ? <Badge size="sm" variant="light" color="blue">Saliente</Badge> : ok ? <Badge size="sm" variant="light" color="teal">Contestada</Badge> : <Badge size="sm" variant="light" color="red">Perdida</Badge>}</Table.Td>
                          <Table.Td><Group gap={6} wrap="nowrap" justify="flex-end">{ok ? <RecPlay row={r} /> : null}<Tooltip label="Rellamar"><ActionIcon size="sm" variant="light" color="teal" disabled={!registered || inCall} onClick={() => sp.placeCall(String(other))}><IconPhone size={14} /></ActionIcon></Tooltip></Group></Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            </Card>
          </div>
        </Stack>

        {/* Columna 3: Video en vivo — sin recuadro oscuro, título fuera */}
        <div className="ag-fade" style={{ animationDelay: '.1s' }}>
          <Group justify="space-between" wrap="nowrap" px={4} mb={8}>
            <Group gap={8}><ThemeIcon size={30} radius="md" variant="light" color="grape"><IconDeviceCctv size={17} /></ThemeIcon><Text fw={800} fz="lg">Video en vivo</Text></Group>
            {callNum ? <Badge variant="light" color="grape">{callStreams.length} canal(es)</Badge> : <Badge variant="light" color="gray">En espera</Badge>}
          </Group>
          <div className="vtile">
            <Intercom streams={callStreams} columns={1} emptyHint={callNum ? ('Sin dispositivos de video para ' + callNum + '. Cargalos en Clientes.') : 'Al iniciar o recibir una llamada se mostrará acá el video del intercom y las cámaras del cliente.'} />
          </div>
        </div>
      </div>

      <SurveyModal opened={surveyOpen} onClose={() => setSurveyOpen(false)} fields={surveyFields} ctx={surveyCtx} />
      <Modal opened={pwOpen} onClose={() => setPwOpen(false)} title="Cambiar mi contraseña" centered radius="lg">
        <Stack>
          <PasswordInput label="Nueva contraseña" value={np} onChange={(e) => setNp(e.target.value)} />
          <PasswordInput label="Repetir" value={np2} onChange={(e) => setNp2(e.target.value)} />
          <Button color="teal" loading={pwBusy} onClick={changePw}>Guardar</Button>
        </Stack>
      </Modal>
    </div>
  );
}
