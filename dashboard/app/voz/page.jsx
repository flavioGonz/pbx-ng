'use client';
import { useEffect, useRef, useState } from 'react';
import { Stack, Card, Group, Text, Button, Badge, ThemeIcon, SimpleGrid, Tabs, Table, TextInput, Select, Slider, Progress, Divider, ActionIcon, Tooltip, Code, ScrollArea, Alert, Modal } from '@mantine/core';
import { IconWaveSine, IconActivity, IconMicrophone2, IconSettings, IconFileText, IconRefresh, IconCpu, IconDeviceFloppy, IconPlayerPlay, IconPlayerStop, IconDownload, IconTrash, IconClock, IconBolt, IconServer2, IconReload, IconInfoCircle, IconCheck, IconVolume, IconArrowBackUp, IconSparkles, IconAlertTriangle, IconStar, IconStarFilled, IconPlugConnected, IconGauge } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

/* ── Avatar parlante: un rostro moderno que "pronuncia" cuando suena el audio ─────── */
function TalkingAvatar({ speaking, gender = 'f', size = 150 }) {
  const skin = '#f2c9a8', skin2 = '#e6b28c';
  const hair = gender === 'm' ? '#3b2a20' : '#5b3b2a';
  const accent = gender === 'm' ? '#2f74e6' : '#ec4899';
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <radialGradient id="avbg" cx="50%" cy="38%" r="70%"><stop offset="0%" stopColor={accent} stopOpacity="0.20" /><stop offset="100%" stopColor={accent} stopOpacity="0.02" /></radialGradient>
          <linearGradient id="avface" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={skin} /><stop offset="100%" stopColor={skin2} /></linearGradient>
        </defs>
        <circle cx="100" cy="100" r="96" fill="url(#avbg)" />
        {[0, 1, 2].map((i) => <circle key={i} className={speaking ? 'av-ring' : undefined} cx="100" cy="100" r="72" fill="none" stroke={accent} strokeWidth="2" style={{ opacity: 0, animationDelay: (i * 0.5) + 's' }} />)}
        <g>
          <path d="M52 74 Q52 34 100 34 Q148 34 148 74 L148 96 Q148 150 100 150 Q52 150 52 96 Z" fill={hair} />
          <ellipse cx="100" cy="98" rx="42" ry="48" fill="url(#avface)" />
          <path d="M60 70 Q60 40 100 40 Q140 40 140 70 Q140 58 100 56 Q60 58 60 70 Z" fill={hair} />
          <circle cx="58" cy="100" r="8" fill={skin2} /><circle cx="142" cy="100" r="8" fill={skin2} />
          <g className={speaking ? 'av-blink' : undefined}>
            <ellipse cx="84" cy="92" rx="5.5" ry="7" fill="#2b2b3a" /><ellipse cx="116" cy="92" rx="5.5" ry="7" fill="#2b2b3a" />
            <circle cx="85.6" cy="89.5" r="1.7" fill="#fff" /><circle cx="117.6" cy="89.5" r="1.7" fill="#fff" />
          </g>
          <path d="M76 82 Q84 78 92 82" stroke={hair} strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M108 82 Q116 78 124 82" stroke={hair} strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M100 96 L96 108 Q100 111 104 108" stroke={skin2} strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <g transform="translate(100 124)">
            <ellipse className={speaking ? 'av-mouth' : undefined} cx="0" cy="0" rx="13" ry={speaking ? 8 : 3} fill="#8b3a3a" />
            <ellipse cx="0" cy="3" rx="8" ry="2.5" fill="#c96a6a" opacity="0.8" />
          </g>
        </g>
      </svg>
      {speaking && (
        <div style={{ position: 'absolute', bottom: -2, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 4, height: 20 }}>
          {[0, 1, 2, 3, 4].map((i) => <span key={i} className="av-eq" style={{ width: 4, background: accent, borderRadius: 3, animationDelay: (i * 0.12) + 's' }} />)}
        </div>
      )}
      <style jsx>{`
        :global(.av-ring){ animation: avRing 1.5s ease-out infinite; }
        @keyframes avRing { 0%{ r:52; opacity:.5 } 100%{ r:92; opacity:0 } }
        :global(.av-mouth){ animation: avMouth .28s ease-in-out infinite alternate; transform-origin:center; }
        @keyframes avMouth { from{ ry:3 } to{ ry:9 } }
        :global(.av-blink){ animation: avBlink 3.2s steps(1,end) infinite; transform-origin:center; }
        @keyframes avBlink { 0%,94%,100%{ opacity:1 } 96%{ opacity:.15 } }
        .av-eq{ animation: avEq .5s ease-in-out infinite alternate; }
        @keyframes avEq { from{ height:5px } to{ height:20px } }
        @media (prefers-reduced-motion: reduce){ :global(.av-ring),:global(.av-mouth),:global(.av-blink),.av-eq{ animation:none } }
      `}</style>
    </div>
  );
}

const FLAG = { UY: '🇺🇾', AR: '🇦🇷', MX: '🇲🇽', CO: '🇨🇴', CL: '🇨🇱', PE: '🇵🇪', VE: '🇻🇪', ES: '🇪🇸', US: '🇺🇸' };
const CCNAME = { UY: 'Uruguay', AR: 'Argentina', MX: 'México', CO: 'Colombia', CL: 'Chile', PE: 'Perú', VE: 'Venezuela', ES: 'España', US: 'EE.UU.' };
function edgeMeta(v) {
  const m = /^([a-z]{2})-([A-Z]{2})-([A-Za-z]+)Neural/.exec(v.key) || [];
  const cc = m[2] || '';
  const name = m[3] || v.label;
  const female = /femenina|Valentina|Elena|Dalia|Salome|Catalina|Camila|Paola/i.test(v.label + ' ' + name);
  return { cc, name, gender: female ? 'f' : 'm', flag: FLAG[cc] || '🌐', country: CCNAME[cc] || cc };
}

function Spark({ data, color, label, unit, value }) {
  const w = 300, h = 70, pad = 5; const vals = data.length ? data : [0];
  const max = Math.max(1, ...vals); const min = Math.min(0, ...vals); const span = max - min || 1; const n = vals.length;
  const xs = (i) => pad + (n <= 1 ? 0 : i * (w - pad * 2) / (n - 1));
  const ys = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = 'M' + vals.map((v, i) => xs(i) + ',' + ys(v).toFixed(1)).join(' L');
  const area = line + ` L${xs(n - 1)},${h - pad} L${xs(0)},${h - pad} Z`;
  const id = 'g' + label.replace(/[^a-z]/gi, '');
  return (<Card withBorder radius="md" padding="sm">
    <Group justify="space-between" mb={2}><Text size="xs" c="dimmed">{label}</Text><Text fw={800} fz="lg" lh={1}>{value}{unit ? <Text span size="xs" c="dimmed"> {unit}</Text> : null}</Text></Group>
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 70, display: 'block' }} preserveAspectRatio="none">
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.34" /><stop offset="100%" stopColor={color} stopOpacity="0.02" /></linearGradient></defs>
      {[0.5].map(g => <line key={g} x1={pad} x2={w - pad} y1={pad + g * (h - pad * 2)} y2={pad + g * (h - pad * 2)} stroke="rgba(120,130,150,.12)" />)}
      <path d={area} fill={`url(#${id})`} /><path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg></Card>);
}

const fmtUp = (s) => { s = parseInt(s) || 0; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + 'd ' : '') + h + 'h ' + m + 'm'; };

export default function VozConsole({ section = null }) {
  const [voz, setVoz] = useState(null); const [hist, setHist] = useState([]);
  const [voices, setVoices] = useState(null); const [cfg, setCfg] = useState({ whisper: 'small', default_voice: '', models: [] });
  const [url, setUrl] = useState(''); const [speed, setSpeed] = useState('1.0');
  const [logs, setLogs] = useState(''); const [busy, setBusy] = useState('');
  const [testText, setTestText] = useState('Hola, gracias por comunicarte con nosotros. ¿En qué puedo ayudarte?'); const [testVoice, setTestVoice] = useState(''); const audioRef = useRef(null);
  const [speaking, setSpeaking] = useState(false); const [playing, setPlaying] = useState(null);
  const [sp, setSp] = useState([]); const [spVoice, setSpVoice] = useState('es-UY-ValentinaNeural'); const [spProg, setSpProg] = useState(null); const [spFilter, setSpFilter] = useState(''); const spRef = useRef(null);
  const [confirmCfg, setConfirmCfg] = useState(null);
  const ask = (cfg) => setConfirmCfg(cfg);
  const doConfirm = async () => { const fn = confirmCfg && confirmCfg.onConfirm; setConfirmCfg(null); if (fn) await fn(); };

  async function loadVoz() {
    try { const v = await fetch('/backend/api/voz').then(r => r.json()); setVoz(v);
      if (v.ok && v.metrics) setHist(h => [...h, { cpu: v.metrics.cpu_pct || 0, mem: v.metrics.mem_pct || 0 }].slice(-40));
    } catch (_) { setVoz({ ok: false }); }
  }
  async function loadVoices() { try { setVoices(await fetch('/backend/api/voz/voices').then(r => r.json())); } catch (_) {} }
  async function loadCfg() {
    try { const c = await fetch('/backend/api/voz/config').then(r => r.json()); setCfg(c); if (!testVoice) setTestVoice(c.default_voice || 'es-UY-ValentinaNeural'); } catch (_) {}
    try { const s = await fetch('/backend/api/settings').then(r => r.json()); if (s.voz_url) setUrl(s.voz_url); if (s.voz_length_scale) setSpeed(s.voz_length_scale); } catch (_) {}
  }
  async function loadLogs() { try { const j = await fetch('/backend/api/voz/logs').then(r => r.json()); setLogs(j.logs || ''); } catch (_) {} }
  async function loadSp() { try { setSp(await fetch('/backend/api/sysprompts').then(r => r.json())); } catch (_) {} }
  async function spSeed() { setBusy('seed'); await fetch('/backend/api/sysprompts/seed', { method: 'POST' }); setBusy(''); loadSp(); toast('Catálogo cargado', 'ok'); }
  async function spGenerate(names) {
    const list = names || sp.map(x => x.name);
    if (!list.length) return;
    setSpProg({ done: 0, total: list.length });
    const B = 8;
    for (let i = 0; i < list.length; i += B) {
      const batch = list.slice(i, i + B);
      try { await fetch('/backend/api/sysprompts/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: spVoice, names: batch }) }); } catch (_) {}
      setSpProg({ done: Math.min(i + B, list.length), total: list.length });
      loadSp();
    }
    setSpProg(null); loadSp(); toast('Audios generados con ' + spVoice, 'ok');
  }
  async function spRevert(names) { setBusy('revert'); await fetch('/backend/api/sysprompts/revert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: names || [] }) }); setBusy(''); setTimeout(loadSp, 1500); toast('Restaurando originales…', 'info'); }
  async function spSaveText(name, text) { try { await fetch('/backend/api/sysprompts/' + encodeURIComponent(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); } catch (_) {} }
  async function spPlay(name) { try { const r = await fetch('/backend/api/sysprompts/test/' + encodeURIComponent(name) + '?t=' + Date.now()); if (!r.ok) return; const u = URL.createObjectURL(await r.blob()); if (spRef.current) { spRef.current.src = u; await spRef.current.play().catch(() => {}); } } catch (_) {} }
  useEffect(() => { loadVoz(); loadVoices(); loadCfg(); loadSp(); const t = setInterval(loadVoz, 4000); return () => clearInterval(t); }, []);

  async function saveBasics() { setBusy('basics'); const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voz_url: url, voz_length_scale: speed }) }).then(x => x.json()).catch(() => ({ error: 1 })); setBusy(''); toast(r.error ? 'Error' : 'Guardado', r.error ? 'bad' : 'ok'); }
  async function saveEngine() {
    setBusy('engine'); const r = await fetch('/backend/api/voz/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ whisper: cfg.whisper, default_voice: cfg.default_voice }) }).then(x => x.json()).catch(() => ({ error: 1 })); setBusy('');
    toast(r.error ? 'Error: ' + r.error : 'Aplicado · reiniciando servicio…', r.error ? 'bad' : 'ok');
  }
  async function setDefaultVoice(key) {
    setCfg(c => ({ ...c, default_voice: key }));
    const r = await fetch('/backend/api/voz/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ whisper: cfg.whisper, default_voice: key }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    toast(r.error ? 'Error al fijar la voz' : 'Voz por defecto: ' + key, r.error ? 'bad' : 'ok'); loadVoices();
  }
  async function install(key) { setBusy('inst' + key); const r = await fetch('/backend/api/voz/voices/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).then(x => x.json()).catch(() => ({ error: 'red' })); setBusy(''); toast(r.error ? 'Error: ' + r.error : 'Voz instalada', r.error ? 'bad' : 'ok'); loadVoices(); loadVoz(); }
  async function removeVoice(key) { await fetch('/backend/api/voz/voices/' + encodeURIComponent(key), { method: 'DELETE' }); toast('Voz eliminada', 'info'); loadVoices(); loadVoz(); }
  async function play(voiceKey, label, gender) {
    setBusy('test'); setPlaying({ key: voiceKey, label: label || voiceKey, gender: gender || 'f' });
    try {
      const r = await fetch('/backend/api/voz/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: testText, voice: voiceKey }) });
      if (!r.ok) { toast('Error generando audio', 'bad'); setBusy(''); setPlaying(null); return; }
      const blob = await r.blob(); const u = URL.createObjectURL(blob);
      if (audioRef.current) { audioRef.current.src = u; await audioRef.current.play().catch(() => {}); }
    } catch (_) { toast('Error de red', 'bad'); setPlaying(null); }
    setBusy('');
  }
  function stop() { if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; } setSpeaking(false); setPlaying(null); }
  async function restart() { setBusy('restart'); await fetch('/backend/api/voz/restart', { method: 'POST' }); toast('Reiniciando servicio…', 'info'); setBusy(''); setTimeout(() => { loadVoz(); loadVoices(); }, 6000); }

  const m = voz?.metrics || {}; const st = voz?.stats || {}; const inst = voices?.installed || []; const cat = voices?.catalog || []; const edge = voices?.edge || [];
  const edgeCards = edge.map(v => ({ ...v, ...edgeMeta(v) }));
  const uy = edgeCards.filter(v => v.cc === 'UY');
  const otherEdge = edgeCards.filter(v => v.cc !== 'UY');
  const isDefault = (k) => voices?.default === k || cfg.default_voice === k;

  const VoiceCard = ({ vkey, flag, title, subtitle, gender, sizeMb, onRemove }) => {
    const on = playing?.key === vkey;
    return (
      <Card withBorder radius="md" padding="sm" style={{ position: 'relative', cursor: 'pointer', transition: 'all .15s', borderColor: on ? 'var(--mantine-color-teal-5)' : undefined, boxShadow: on ? '0 0 0 2px var(--mantine-color-teal-2)' : undefined, background: on ? 'rgba(16,163,74,.05)' : undefined }} onClick={() => (on && speaking ? stop() : play(vkey, title, gender))}>
        <Group justify="space-between" wrap="nowrap" gap={6}>
          <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
            <div style={{ fontSize: 22, lineHeight: 1 }}>{flag}</div>
            <div style={{ minWidth: 0 }}>
              <Group gap={5} wrap="nowrap"><Text fw={700} fz="sm" truncate>{title}</Text>{isDefault(vkey) && <Badge size="xs" variant="light" color="teal" leftSection={<IconStarFilled size={9} />}>default</Badge>}</Group>
              <Text fz={11} c="dimmed" truncate>{subtitle}{sizeMb ? ' · ' + sizeMb + ' MB' : ''}</Text>
            </div>
          </Group>
          <Group gap={2} wrap="nowrap">
            <Tooltip label={isDefault(vkey) ? 'Voz por defecto' : 'Usar por defecto'}><ActionIcon variant="subtle" color="yellow" size="sm" onClick={e => { e.stopPropagation(); setDefaultVoice(vkey); }}>{isDefault(vkey) ? <IconStarFilled size={15} /> : <IconStar size={15} />}</ActionIcon></Tooltip>
            {onRemove && <ActionIcon variant="subtle" color="red" size="sm" disabled={isDefault(vkey)} onClick={e => { e.stopPropagation(); onRemove(); }}><IconTrash size={15} /></ActionIcon>}
            <ThemeIcon size={30} radius="xl" variant={on && speaking ? 'filled' : 'light'} color="teal">{on && speaking ? <IconPlayerStop size={15} /> : <IconPlayerPlay size={15} />}</ThemeIcon>
          </Group>
        </Group>
      </Card>
    );
  };

  /* ── secciones ──────────────────────────────────────────────────────────── */
  const panelVoices = (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Card withBorder radius="lg" padding="lg" style={{ background: 'linear-gradient(180deg, rgba(16,163,74,.05), transparent)' }}>
          <Group gap="lg" align="flex-start" wrap="nowrap">
            <TalkingAvatar speaking={speaking} gender={playing?.gender || 'f'} size={150} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text fw={800} fz="lg" lh={1.1}>Estudio de voz</Text>
              <Text fz="sm" c="dimmed" mb="sm">Elegí una voz de la derecha y escuchala. El avatar pronuncia el texto de prueba.</Text>
              {playing ? <Badge size="lg" variant="light" color="teal" mb="sm">{speaking ? '🔊 Hablando · ' : ''}{playing.label}</Badge> : <Badge size="lg" variant="light" color="gray" mb="sm">Sin reproducir</Badge>}
              <TextInput label="Texto de prueba" value={testText} onChange={e => setTestText(e.currentTarget.value)} mb="sm" />
              <Group gap="sm">
                <Button leftSection={<IconPlayerPlay size={16} />} loading={busy === 'test' && !speaking} onClick={() => play(testVoice || 'es-UY-ValentinaNeural', testVoice, edgeMeta({ key: testVoice, label: '' }).gender)}>Reproducir</Button>
                {speaking && <Button variant="light" color="red" leftSection={<IconPlayerStop size={16} />} onClick={stop}>Detener</Button>}
              </Group>
            </div>
          </Group>
          <audio ref={audioRef} onPlay={() => setSpeaking(true)} onEnded={() => { setSpeaking(false); setPlaying(null); }} onPause={() => setSpeaking(false)} style={{ display: 'none' }} />
        </Card>
        <Stack gap="md">
          <Card withBorder radius="lg" padding="lg" style={{ borderColor: 'var(--mantine-color-teal-3)' }}>
            <Group gap="sm" mb="sm"><Text fz={22}>🇺🇾</Text><div><Text fw={700}>Voces uruguayas</Text><Text fz="xs" c="dimmed">Neuronales Edge · acento local</Text></div><Badge variant="light" color="teal" ml="auto">{uy.length}</Badge></Group>
            <Stack gap={8}>{uy.length ? uy.map(v => <VoiceCard key={v.key} vkey={v.key} flag={v.flag} title={v.name} subtitle={v.country + ' · ' + (v.gender === 'f' ? 'femenina' : 'masculina')} gender={v.gender} />) : <Text fz="sm" c="dimmed">No hay voces uruguayas en el catálogo del servicio.</Text>}</Stack>
          </Card>
          <Card withBorder radius="lg" padding="lg">
            <Group gap="sm" mb="sm"><ThemeIcon variant="light" color="grape"><IconMicrophone2 size={16} /></ThemeIcon><Text fw={700}>Instaladas (Piper · offline)</Text><Badge variant="light" color="grape" ml="auto">{inst.length}</Badge></Group>
            <Stack gap={8}>{inst.length ? inst.map(v => <VoiceCard key={v.key} vkey={v.key} flag="💾" title={v.key} subtitle="Piper local" gender="f" sizeMb={v.size_mb} onRemove={() => ask({ title: 'Eliminar voz', message: 'Se eliminará la voz «' + v.key + '» del servicio. ¿Continuar?', confirmLabel: 'Eliminar', color: 'red', icon: <IconTrash size={22} />, onConfirm: () => removeVoice(v.key) })} />) : <Text fz="sm" c="dimmed">Ninguna voz Piper instalada.</Text>}</Stack>
          </Card>
        </Stack>
      </SimpleGrid>
      <Card withBorder radius="lg" padding="lg">
        <Group gap="sm" mb="sm"><Text fz={20}>🌎</Text><Text fw={700}>Otras de Latinoamérica · Edge (online)</Text><Badge variant="light" color="blue" ml="auto">{otherEdge.length}</Badge></Group>
        <Text size="xs" c="dimmed" mb="sm">Voces neuronales de Microsoft (gratis, requieren internet). Clic para escuchar; la estrella la fija por defecto.</Text>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={8}>{otherEdge.map(v => <VoiceCard key={v.key} vkey={v.key} flag={v.flag} title={v.name} subtitle={v.country + ' · ' + (v.gender === 'f' ? 'femenina' : 'masculina')} gender={v.gender} />)}</SimpleGrid>
      </Card>
      <Card withBorder radius="lg" padding="lg">
        <Text fw={700} mb="sm">Catálogo Piper (descargar para uso offline)</Text>
        <Table><Table.Tbody>{cat.map(c => (
          <Table.Tr key={c.key}><Table.Td><Text fw={600} fz="sm">{c.label}</Text><Text fz="xs" c="dimmed" ff="monospace">{c.key}</Text></Table.Td>
            <Table.Td ta="right">{c.installed ? <Badge color="teal" variant="light" leftSection={<IconCheck size={12} />}>Instalada</Badge> :
              <Button size="compact-sm" variant="light" leftSection={<IconDownload size={14} />} loading={busy === 'inst' + c.key} onClick={() => ask({ title: 'Instalar voz', message: 'Se descargará e instalará la voz «' + c.label + '» en el contenedor (puede tardar). ¿Continuar?', confirmLabel: 'Instalar', color: 'blue', icon: <IconDownload size={22} />, onConfirm: () => install(c.key) })}>Instalar</Button>}</Table.Td></Table.Tr>))}
        </Table.Tbody></Table>
      </Card>
    </Stack>
  );

  const panelEngine = (
    <Stack gap="lg">
      {/* Monitoreo */}
      <div>
        <Group gap={8} mb="sm"><ThemeIcon variant="light" color="teal" size={26} radius="md"><IconGauge size={15} /></ThemeIcon><Text fw={700}>Monitoreo del servicio</Text></Group>
        {!voz?.ok ? <Alert color="red" variant="light" icon={<IconInfoCircle size={18} />}>No se pudo contactar el servicio de voz en {url}. Verificá el contenedor pbxng-voz.</Alert> : <>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} mb="md">
            <Card withBorder radius="md" padding="sm"><Group gap="xs" wrap="nowrap"><ThemeIcon variant="light" color="grape" size={36} radius="md"><IconClock size={18} /></ThemeIcon><div><Text size="xs" c="dimmed">Uptime</Text><Text fw={700} fz="sm">{fmtUp(m.uptime_s)}</Text></div></Group></Card>
            <Card withBorder radius="md" padding="sm"><Group gap="xs" wrap="nowrap"><ThemeIcon variant="light" color="cyan" size={36} radius="md"><IconCpu size={18} /></ThemeIcon><div><Text size="xs" c="dimmed">Núcleos</Text><Text fw={700} fz="sm">{m.ncpu}</Text></div></Group></Card>
            <Card withBorder radius="md" padding="sm"><Group gap="xs" wrap="nowrap"><ThemeIcon variant="light" color="blue" size={36} radius="md"><IconMicrophone2 size={18} /></ThemeIcon><div><Text size="xs" c="dimmed">Síntesis (TTS)</Text><Text fw={700} fz="sm">{st.tts || 0} · {st.tts_avg_ms || 0}ms</Text></div></Group></Card>
            <Card withBorder radius="md" padding="sm"><Group gap="xs" wrap="nowrap"><ThemeIcon variant="light" color="teal" size={36} radius="md"><IconWaveSine size={18} /></ThemeIcon><div><Text size="xs" c="dimmed">Transcripción (STT)</Text><Text fw={700} fz="sm">{st.stt || 0} · {st.stt_avg_ms || 0}ms</Text></div></Group></Card>
            <Card withBorder radius="md" padding="sm"><div><Text size="xs" c="dimmed">Whisper</Text><Text fw={700} fz="sm">{voz.whisper}</Text></div></Card>
            <Card withBorder radius="md" padding="sm"><div><Text size="xs" c="dimmed">Voz por defecto</Text><Text fw={700} fz="sm" truncate>{voz.default_voice}</Text></div></Card>
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Spark data={hist.map(x => x.cpu)} color="#06b6d4" label="CPU del contenedor" unit="%" value={m.cpu_pct} />
            <Spark data={hist.map(x => x.mem)} color="#2f74e6" label="Memoria" unit="%" value={(m.mem_used_mb || 0) + '/' + (m.mem_total_mb || 0) + 'MB'} />
          </SimpleGrid>
        </>}
      </div>
      <Divider />
      {/* Configuración */}
      <div>
        <Group gap={8} mb="sm"><ThemeIcon variant="light" color="blue" size={26} radius="md"><IconSettings size={15} /></ThemeIcon><Text fw={700}>Configuración</Text></Group>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <Card withBorder radius="lg" padding="lg">
            <Text fw={600} mb="md">Conexión y velocidad</Text>
            <TextInput label="URL del servicio" value={url} onChange={e => setUrl(e.currentTarget.value)} leftSection={<IconServer2 size={15} />} mb="md" />
            <Text size="sm" fw={500}>Velocidad de habla</Text><Text size="xs" c="dimmed" mb={10}>Menor = más rápido · 1.0 = normal</Text>
            <Slider min={0.7} max={1.4} step={0.05} value={parseFloat(speed) || 1.0} onChange={v => setSpeed(String(v))} marks={[{ value: 0.8, label: 'rápido' }, { value: 1.0, label: 'normal' }, { value: 1.3, label: 'lento' }]} mb="lg" />
            <Group justify="flex-end"><Button leftSection={<IconDeviceFloppy size={16} />} loading={busy === 'basics'} onClick={saveBasics}>Guardar</Button></Group>
          </Card>
          <Card withBorder radius="lg" padding="lg">
            <Text fw={600} mb="md">Motor de IA (reinicia el servicio)</Text>
            <Select label="Modelo Whisper (STT)" description="Más grande = más preciso pero más lento/pesado" data={(cfg.models || ['tiny','base','small','medium']).map(x => ({ value: x, label: x }))} value={cfg.whisper} onChange={v => setCfg(c => ({ ...c, whisper: v }))} mb="md" />
            <Select label="Voz por defecto (TTS)" searchable data={[{ group: 'Uruguay · Edge', items: uy.map(v => ({ value: v.key, label: v.name })) }, { group: 'Local · Piper', items: inst.map(v => ({ value: v.key, label: v.key })) }, { group: 'Latinoamérica · Edge', items: otherEdge.map(v => ({ value: v.key, label: v.country + ' · ' + v.name })) }]} value={cfg.default_voice} onChange={v => setCfg(c => ({ ...c, default_voice: v }))} mb="lg" />
            <Alert variant="light" color="orange" mb="md" icon={<IconInfoCircle size={16} />}>Cambiar el modelo descarga ~140MB (base) o ~1.5GB (medium) la primera vez y reinicia el servicio.</Alert>
            <Group justify="flex-end"><Button color="grape" leftSection={<IconReload size={16} />} loading={busy === 'engine'} onClick={() => ask({ title: 'Aplicar configuración del motor', message: 'Cambiar el modelo Whisper o la voz por defecto reinicia el servicio (puede tardar si descarga el modelo). ¿Continuar?', confirmLabel: 'Aplicar y reiniciar', color: 'grape', icon: <IconReload size={22} />, onConfirm: () => saveEngine() })}>Aplicar y reiniciar</Button></Group>
          </Card>
        </SimpleGrid>
        <Card withBorder radius="lg" padding="lg" mt="md">
          <Group justify="space-between"><div><Text fw={600}>Reinicio del servicio</Text><Text size="xs" c="dimmed">Reinicia el microservicio de voz (TTS/STT) del contenedor</Text></div>
            <Button color="red" variant="light" leftSection={<IconReload size={16} />} loading={busy === 'restart'} onClick={() => ask({ title: 'Reiniciar servicio de voz', message: 'Se reiniciará el microservicio de voz (TTS/STT). Las llamadas con IA en curso pueden cortarse. ¿Continuar?', confirmLabel: 'Reiniciar', color: 'red', icon: <IconReload size={22} />, onConfirm: () => restart() })}>Reiniciar servicio</Button></Group>
        </Card>
      </div>
    </Stack>
  );

  const panelSys = (
    <Stack gap="md">
      <Alert color="teal" variant="light" icon={<IconInfoCircle size={16} />} title="Voz coherente en toda la central">
        Genera los audios del sistema (buzón de voz, números de extensión, errores, conferencias y colas) con una sola voz, para que toda la PBX suene igual. Los originales de Asterisk quedan respaldados y se pueden restaurar cuando quieras.
      </Alert>
      <Card withBorder radius="lg" padding="lg">
        <Group align="flex-end" gap="sm" wrap="wrap">
          <Select label="Voz del sistema" data={[{ group: 'Uruguay · Edge', items: uy.map(v => ({ value: v.key, label: v.name })) }, { group: 'Latinoamérica · Edge', items: otherEdge.map(v => ({ value: v.key, label: v.country + ' · ' + v.name })) }, { group: 'Local · Piper', items: inst.map(v => ({ value: v.key, label: v.key })) }]} value={spVoice} onChange={setSpVoice} searchable w={280} />
          <Button leftSection={<IconSparkles size={16} />} loading={!!spProg} onClick={() => ask({ title: 'Generar todos los audios', message: 'Se generarán y desplegarán todos los audios del sistema con la voz ' + spVoice + '. Los originales de Asterisk quedan respaldados.', confirmLabel: 'Generar todos', color: 'teal', icon: <IconSparkles size={22} />, onConfirm: () => spGenerate() })}>Generar todos</Button>
          <Button variant="light" leftSection={<IconSparkles size={16} />} loading={!!spProg} onClick={() => ask({ title: 'Generar solo los dígitos', message: 'Se generarán los números (0-29, decenas, centenas y auxiliares) con la voz ' + spVoice + '.', confirmLabel: 'Generar dígitos', color: 'teal', icon: <IconSparkles size={22} />, onConfirm: () => spGenerate(sp.filter(x => x.category === 'digitos').map(x => x.name)) })}>Solo dígitos</Button>
          <Button variant="default" color="red" leftSection={<IconArrowBackUp size={16} />} loading={busy === 'revert'} onClick={() => ask({ title: 'Restaurar audios originales', message: 'Se restaurarán los sonidos de fábrica de Asterisk y se perderá la voz personalizada en los prompts generados. ¿Continuar?', confirmLabel: 'Restaurar originales', color: 'red', icon: <IconArrowBackUp size={22} />, onConfirm: () => spRevert() })}>Restaurar originales</Button>
          {!sp.length && <Button variant="light" onClick={spSeed} loading={busy === 'seed'}>Cargar catálogo</Button>}
        </Group>
        {spProg && <><Progress mt="md" value={spProg.total ? Math.round(spProg.done * 100 / spProg.total) : 0} animated striped /><Text size="xs" c="dimmed" mt={4}>Generando {spProg.done} / {spProg.total}…</Text></>}
      </Card>
      <Card withBorder radius="lg" padding="lg">
        <Group justify="space-between" mb="sm">
          <Group gap="xs"><Text fw={600}>Audios del sistema</Text><Badge variant="light" color="teal">{sp.filter(x => x.has_audio).length} / {sp.length} con voz</Badge></Group>
          <TextInput placeholder="Buscar…" value={spFilter} onChange={e => setSpFilter(e.currentTarget.value)} w={220} />
        </Group>
        <ScrollArea h={460}>
          <Table stickyHeader highlightOnHover verticalSpacing={4}>
            <Table.Thead><Table.Tr><Table.Th>Nombre</Table.Th><Table.Th>Texto</Table.Th><Table.Th>Categoría</Table.Th><Table.Th>Estado</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {sp.filter(x => !spFilter || x.name.toLowerCase().includes(spFilter.toLowerCase()) || (x.text || '').toLowerCase().includes(spFilter.toLowerCase())).map(x => (
                <Table.Tr key={x.name}>
                  <Table.Td><Text fz="xs" ff="monospace" fw={600}>{x.name}</Text></Table.Td>
                  <Table.Td style={{ minWidth: 300 }}><TextInput size="xs" defaultValue={x.text} onBlur={e => spSaveText(x.name, e.currentTarget.value)} variant="unstyled" /></Table.Td>
                  <Table.Td><Badge size="xs" variant="light" color="gray">{x.category}</Badge></Table.Td>
                  <Table.Td>{x.deployed_at ? <Badge size="xs" color="teal" variant="light">activo</Badge> : x.has_audio ? <Badge size="xs" color="yellow" variant="light">generado</Badge> : <Badge size="xs" color="gray" variant="light">original</Badge>}</Table.Td>
                  <Table.Td><Group gap={4} justify="flex-end" wrap="nowrap">
                    <Tooltip label="Escuchar"><ActionIcon variant="subtle" disabled={!x.has_audio} onClick={() => spPlay(x.name)}><IconVolume size={16} /></ActionIcon></Tooltip>
                    <Tooltip label="Regenerar con la voz elegida"><ActionIcon variant="subtle" color="teal" loading={!!spProg} onClick={() => ask({ title: 'Regenerar audio', message: 'Se regenerará «' + x.name + '» con la voz ' + spVoice + ' y se desplegará en Asterisk.', confirmLabel: 'Regenerar', color: 'teal', icon: <IconRefresh size={22} />, onConfirm: () => spGenerate([x.name]) })}><IconRefresh size={15} /></ActionIcon></Tooltip>
                  </Group></Table.Td>
                </Table.Tr>))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        <audio ref={spRef} style={{ display: 'none' }} />
      </Card>
    </Stack>
  );

  const panelLogs = (
    <Card withBorder radius="lg" padding="lg">
      <Group justify="space-between" mb="sm"><Text fw={600}>Logs del servicio</Text><Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={loadLogs}>Cargar logs</Button></Group>
      <ScrollArea h={480}><Code block style={{ fontSize: 11.5, lineHeight: 1.5 }}>{logs || 'Tocá «Cargar logs» para ver la salida del servicio.'}</Code></ScrollArea>
    </Card>
  );

  const confirmModal = (
    <Modal opened={!!confirmCfg} onClose={() => setConfirmCfg(null)} centered radius="lg" size="sm" withCloseButton={false} overlayProps={{ blur: 3, backgroundOpacity: 0.45 }}>
      <Stack gap="md" align="center" ta="center" py="xs">
        <ThemeIcon size={58} radius="xl" variant="light" color={confirmCfg?.color || 'teal'}>{confirmCfg?.icon || <IconAlertTriangle size={26} />}</ThemeIcon>
        <div><Text fw={800} fz="lg">{confirmCfg?.title}</Text><Text c="dimmed" fz="sm" mt={6}>{confirmCfg?.message}</Text></div>
        <Group grow w="100%" mt="xs">
          <Button variant="default" onClick={() => setConfirmCfg(null)}>Cancelar</Button>
          <Button color={confirmCfg?.color || 'teal'} onClick={doConfirm}>{confirmCfg?.confirmLabel || 'Confirmar'}</Button>
        </Group>
      </Stack>
    </Modal>
  );

  const statusChip = (
    <Group gap="sm" mb="md" justify="space-between">
      <Group gap={8}><ThemeIcon variant="light" color={voz?.ok ? 'teal' : 'red'} size={28} radius="md"><IconPlugConnected size={16} /></ThemeIcon><div><Text fw={700} fz="sm" lh={1}>Servicio de voz</Text><Text fz={11} c="dimmed">Piper (TTS) + faster-whisper (STT) + Edge neural</Text></div></Group>
      <Group gap="xs"><Badge variant="light" color={voz?.ok ? 'teal' : 'red'} leftSection={<IconBolt size={12} />}>{voz?.ok ? 'En línea · ' + voz.latency_ms + 'ms' : 'Sin conexión'}</Badge>
        <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => { loadVoz(); loadVoices(); }}>Recargar</Button></Group>
    </Group>
  );

  // Modo embebido en /ia-voz: una sola sección, sin header ni tabs propias.
  if (section) {
    const map = { voices: panelVoices, engine: panelEngine, sys: panelSys, logs: panelLogs };
    return <Stack gap={0}>{statusChip}{map[section] || panelVoices}{confirmModal}</Stack>;
  }

  // Modo standalone (/voz): header + tabs agrupadas.
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconWaveSine size={24} />} title="Procesamiento de Voz IA" subtitle="Contenedor pbxng-voz · Piper (TTS) + faster-whisper (STT) + Edge neural" color="teal"
        right={<><Badge size="lg" variant="light" color={voz?.ok ? 'teal' : 'red'} leftSection={<IconBolt size={13} />}>{voz?.ok ? 'En línea · ' + voz.latency_ms + 'ms' : 'Sin conexión'}</Badge>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => { loadVoz(); loadVoices(); }}>Recargar</Button></>} />
      <Tabs defaultValue="voices" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="voices" leftSection={<IconMicrophone2 size={16} />}>Voces</Tabs.Tab>
          <Tabs.Tab value="sys" leftSection={<IconVolume size={16} />}>Audios del sistema</Tabs.Tab>
          <Tabs.Tab value="engine" leftSection={<IconSettings size={16} />}>Motor</Tabs.Tab>
          <Tabs.Tab value="logs" leftSection={<IconFileText size={16} />}>Logs</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="voices">{panelVoices}</Tabs.Panel>
        <Tabs.Panel value="sys">{panelSys}</Tabs.Panel>
        <Tabs.Panel value="engine">{panelEngine}</Tabs.Panel>
        <Tabs.Panel value="logs">{panelLogs}</Tabs.Panel>
      </Tabs>
      {confirmModal}
    </Stack>
  );
}
