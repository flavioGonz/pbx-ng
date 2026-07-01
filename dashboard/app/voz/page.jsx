'use client';
import { useEffect, useRef, useState } from 'react';
import { Stack, Card, Group, Text, Button, Badge, ThemeIcon, SimpleGrid, Tabs, Table, TextInput, Select, Slider, Progress, Divider, ActionIcon, Tooltip, Code, ScrollArea, Alert, Modal } from '@mantine/core';
import { IconWaveSine, IconActivity, IconMicrophone2, IconSettings, IconFileText, IconRefresh, IconCpu, IconDeviceFloppy, IconPlayerPlay, IconDownload, IconTrash, IconClock, IconBolt, IconServer2, IconReload, IconInfoCircle, IconCheck, IconVolume, IconArrowBackUp, IconSparkles, IconAlertTriangle } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

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

export default function VozConsole() {
  const [voz, setVoz] = useState(null); const [hist, setHist] = useState([]);
  const [voices, setVoices] = useState(null); const [cfg, setCfg] = useState({ whisper: 'small', default_voice: '', models: [] });
  const [url, setUrl] = useState(''); const [speed, setSpeed] = useState('1.0');
  const [logs, setLogs] = useState(''); const [busy, setBusy] = useState('');
  const [testText, setTestText] = useState('Hola, gracias por comunicarte con IES. ¿En qué puedo ayudarte?'); const [testVoice, setTestVoice] = useState(''); const audioRef = useRef(null);
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
    try { const c = await fetch('/backend/api/voz/config').then(r => r.json()); setCfg(c); if (!testVoice) setTestVoice(c.default_voice || ''); } catch (_) {}
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
  async function install(key) { setBusy('inst' + key); const r = await fetch('/backend/api/voz/voices/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).then(x => x.json()).catch(() => ({ error: 'red' })); setBusy(''); toast(r.error ? 'Error: ' + r.error : 'Voz instalada', r.error ? 'bad' : 'ok'); loadVoices(); loadVoz(); }
  async function removeVoice(key) { await fetch('/backend/api/voz/voices/' + encodeURIComponent(key), { method: 'DELETE' }); toast('Voz eliminada', 'info'); loadVoices(); loadVoz(); }
  async function testTTS() {
    setBusy('test');
    try {
      const r = await fetch('/backend/api/voz/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: testText, voice: testVoice }) });
      if (!r.ok) { toast('Error generando audio', 'bad'); setBusy(''); return; }
      const blob = await r.blob(); const u = URL.createObjectURL(blob);
      if (audioRef.current) { audioRef.current.src = u; await audioRef.current.play().catch(() => {}); }
    } catch (_) { toast('Error de red', 'bad'); }
    setBusy('');
  }
  async function restart() { setBusy('restart'); await fetch('/backend/api/voz/restart', { method: 'POST' }); toast('Reiniciando servicio…', 'info'); setBusy(''); setTimeout(() => { loadVoz(); loadVoices(); }, 6000); }

  const m = voz?.metrics || {}; const st = voz?.stats || {}; const inst = voices?.installed || []; const cat = voices?.catalog || []; const edge = voices?.edge || [];

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconWaveSine size={24} />} title="Procesamiento de Voz IA" subtitle="Contenedor pbxng-voz · Piper (TTS) + faster-whisper (STT)" color="teal"
        right={<><Badge size="lg" variant="light" color={voz?.ok ? 'teal' : 'red'} leftSection={<IconBolt size={13} />}>{voz?.ok ? 'En línea · ' + voz.latency_ms + 'ms' : 'Sin conexión'}</Badge>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => { loadVoz(); loadVoices(); }}>Recargar</Button></>} />

      <Tabs defaultValue="mon" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="mon" leftSection={<IconActivity size={16} />}>Monitoreo</Tabs.Tab>
          <Tabs.Tab value="voices" leftSection={<IconMicrophone2 size={16} />}>Voces</Tabs.Tab>
          <Tabs.Tab value="cfg" leftSection={<IconSettings size={16} />}>Configuración</Tabs.Tab>
          <Tabs.Tab value="sys" leftSection={<IconVolume size={16} />}>Audios del sistema</Tabs.Tab>
          <Tabs.Tab value="logs" leftSection={<IconFileText size={16} />}>Logs</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="mon">
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
        </Tabs.Panel>

        <Tabs.Panel value="voices">
          <Card withBorder radius="lg" padding="lg" mb="md">
            <Group gap="sm" mb="sm"><ThemeIcon variant="light" color="teal"><IconPlayerPlay size={18} /></ThemeIcon><Text fw={600}>Probar voz</Text></Group>
            <Group align="flex-end" gap="sm">
              <Select label="Voz" data={[{ group: 'Local · Piper', items: inst.map(v => ({ value: v.key, label: v.key })) }, { group: 'Latinoamérica · Edge', items: edge.map(v => ({ value: v.key, label: v.label })) }]} value={testVoice} onChange={setTestVoice} searchable w={300} />
              <TextInput label="Texto" value={testText} onChange={e => setTestText(e.currentTarget.value)} style={{ flex: 1 }} />
              <Button leftSection={<IconPlayerPlay size={16} />} loading={busy === 'test'} onClick={testTTS}>Reproducir</Button>
            </Group>
            <audio ref={audioRef} style={{ display: 'none' }} />
          </Card>
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Card withBorder radius="lg" padding="lg">
              <Text fw={600} mb="sm">Voces instaladas</Text>
              <Table><Table.Tbody>{inst.map(v => (
                <Table.Tr key={v.key}><Table.Td><Text fw={600} fz="sm">{v.key}</Text></Table.Td><Table.Td><Badge variant="light" color="gray">{v.size_mb} MB</Badge></Table.Td>
                  <Table.Td ta="right"><ActionIcon variant="subtle" color="red" disabled={v.key === voices?.default} onClick={() => ask({ title: 'Eliminar voz', message: 'Se eliminará la voz «' + v.key + '» del servicio. ¿Continuar?', confirmLabel: 'Eliminar', color: 'red', icon: <IconTrash size={22} />, onConfirm: () => removeVoice(v.key) })}><IconTrash size={16} /></ActionIcon></Table.Td></Table.Tr>))}
              </Table.Tbody></Table>
            </Card>
            <Card withBorder radius="lg" padding="lg">
              <Text fw={600} mb="sm">Catálogo (descargar)</Text>
              <Table><Table.Tbody>{cat.map(c => (
                <Table.Tr key={c.key}><Table.Td><Text fw={600} fz="sm">{c.label}</Text><Text fz="xs" c="dimmed" ff="monospace">{c.key}</Text></Table.Td>
                  <Table.Td ta="right">{c.installed ? <Badge color="teal" variant="light" leftSection={<IconCheck size={12} />}>Instalada</Badge> :
                    <Button size="compact-sm" variant="light" leftSection={<IconDownload size={14} />} loading={busy === 'inst' + c.key} onClick={() => ask({ title: 'Instalar voz', message: 'Se descargará e instalará la voz «' + c.label + '» en el contenedor (puede tardar). ¿Continuar?', confirmLabel: 'Instalar', color: 'blue', icon: <IconDownload size={22} />, onConfirm: () => install(c.key) })}>Instalar</Button>}</Table.Td></Table.Tr>))}
              </Table.Tbody></Table>
            </Card>
          </SimpleGrid>
          <Card withBorder radius="lg" padding="lg" mt="md">
            <Group gap="sm" mb="sm"><ThemeIcon variant="light" color="grape"><IconWaveSine size={18} /></ThemeIcon><Text fw={600}>Voces Latinoamérica · Edge (online, sin instalar)</Text><Badge variant="light" color="grape">{edge.length} voces</Badge></Group>
            <Text size="xs" c="dimmed" mb="sm">Voces neuronales de Microsoft (gratis, requieren internet). Probalas arriba y elegilas en cada agente o como voz por defecto.</Text>
            <Group gap={6}>{edge.map(v => <Badge key={v.key} variant="light" radius="sm" style={{ cursor: 'pointer' }} onClick={() => setTestVoice(v.key)}>{v.label}</Badge>)}</Group>
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="cfg">
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <Card withBorder radius="lg" padding="lg">
              <Text fw={600} mb="md">Conexión y velocidad</Text>
              <TextInput label="URL del servicio" value={url} onChange={e => setUrl(e.currentTarget.value)} leftSection={<IconServer2 size={15} />} mb="md" />
              <Text size="sm" fw={500}>Velocidad de habla</Text><Text size="xs" c="dimmed" mb={10}>Menor = más rápido · 1.0 = normal</Text>
              <Slider min={0.7} max={1.4} step={0.05} value={parseFloat(speed) || 1.0} onChange={v => setSpeed(String(v))} marks={[{ value: 0.8, label: 'rápido' }, { value: 1.0, label: 'normal' }, { value: 1.3, label: 'lento' }]} mb="lg" />
              <Group justify="flex-end"><Button leftSection={<IconDeviceFloppy size={16} />} loading={busy === 'basics'} onClick={saveBasics}>Guardar</Button></Group>
            </Card>
            <Card withBorder radius="lg" padding="lg">
              <Text fw={600} mb="md">Motor (reinicia el servicio)</Text>
              <Select label="Modelo Whisper (STT)" description="Más grande = más preciso pero más lento/pesado" data={(cfg.models || ['tiny','base','small','medium']).map(x => ({ value: x, label: x }))} value={cfg.whisper} onChange={v => setCfg(c => ({ ...c, whisper: v }))} mb="md" />
              <Select label="Voz por defecto (TTS)" searchable data={[{ group: 'Local · Piper', items: inst.map(v => ({ value: v.key, label: v.key })) }, { group: 'Latinoamérica · Edge (online)', items: edge.map(v => ({ value: v.key, label: v.label })) }]} value={cfg.default_voice} onChange={v => setCfg(c => ({ ...c, default_voice: v }))} mb="lg" />
              <Alert variant="light" color="orange" mb="md" icon={<IconInfoCircle size={16} />}>Cambiar el modelo descarga ~140MB (base) o ~1.5GB (medium) la primera vez y reinicia el servicio.</Alert>
              <Group justify="flex-end"><Button color="grape" leftSection={<IconReload size={16} />} loading={busy === 'engine'} onClick={() => ask({ title: 'Aplicar configuración del motor', message: 'Cambiar el modelo Whisper o la voz por defecto reinicia el servicio (puede tardar si descarga el modelo). ¿Continuar?', confirmLabel: 'Aplicar y reiniciar', color: 'grape', icon: <IconReload size={22} />, onConfirm: () => saveEngine() })}>Aplicar y reiniciar</Button></Group>
            </Card>
          </SimpleGrid>
          <Card withBorder radius="lg" padding="lg" mt="md">
            <Group justify="space-between"><div><Text fw={600}>Acciones</Text><Text size="xs" c="dimmed">Reiniciar el servicio de voz del contenedor</Text></div>
              <Button color="red" variant="light" leftSection={<IconReload size={16} />} loading={busy === 'restart'} onClick={() => ask({ title: 'Reiniciar servicio de voz', message: 'Se reiniciará el microservicio de voz (TTS/STT). Las llamadas con IA en curso pueden cortarse. ¿Continuar?', confirmLabel: 'Reiniciar', color: 'red', icon: <IconReload size={22} />, onConfirm: () => restart() })}>Reiniciar servicio</Button></Group>
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="logs">
          <Card withBorder radius="lg" padding="lg">
            <Group justify="space-between" mb="sm"><Text fw={600}>Logs del servicio</Text><Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={loadLogs}>Cargar logs</Button></Group>
            <ScrollArea h={420}><Code block style={{ fontSize: 11.5, lineHeight: 1.5 }}>{logs || 'Tocá «Cargar logs» para ver la salida del servicio.'}</Code></ScrollArea>
          </Card>
        </Tabs.Panel>
        <Tabs.Panel value="sys">
          <Alert color="teal" variant="light" icon={<IconInfoCircle size={16} />} mb="md" title="Voz coherente en toda la central">
            Genera los audios del sistema (buzón de voz, números de extensión, errores, conferencias y colas) con una sola voz, para que toda la PBX suene igual. Los originales de Asterisk quedan respaldados y se pueden restaurar cuando quieras.
          </Alert>
          <Card withBorder radius="lg" padding="lg" mb="md">
            <Group align="flex-end" gap="sm" wrap="wrap">
              <Select label="Voz del sistema" data={[{ group: 'Latinoamérica · Edge', items: edge.map(v => ({ value: v.key, label: v.label })) }, { group: 'Local · Piper', items: inst.map(v => ({ value: v.key, label: v.key })) }]} value={spVoice} onChange={setSpVoice} searchable w={280} />
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
        </Tabs.Panel>

      </Tabs>
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
    </Stack>
  );
}
