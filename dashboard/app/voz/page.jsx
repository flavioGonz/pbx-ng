'use client';
import { useEffect, useRef, useState } from 'react';
import { Stack, Card, Group, Text, Button, Badge, ThemeIcon, SimpleGrid, Tabs, Table, TextInput, Select, Slider, Progress, Divider, ActionIcon, Tooltip, Code, ScrollArea, Alert } from '@mantine/core';
import { IconWaveSine, IconActivity, IconMicrophone2, IconSettings, IconFileText, IconRefresh, IconCpu, IconDeviceFloppy, IconPlayerPlay, IconDownload, IconTrash, IconClock, IconBolt, IconServer2, IconReload, IconInfoCircle, IconCheck } from '@tabler/icons-react';
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
  const [url, setUrl] = useState('http://172.26.20.219:8080'); const [speed, setSpeed] = useState('1.0');
  const [logs, setLogs] = useState(''); const [busy, setBusy] = useState('');
  const [testText, setTestText] = useState('Hola, gracias por comunicarte con IES. ¿En qué puedo ayudarte?'); const [testVoice, setTestVoice] = useState(''); const audioRef = useRef(null);

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
  useEffect(() => { loadVoz(); loadVoices(); loadCfg(); const t = setInterval(loadVoz, 4000); return () => clearInterval(t); }, []);

  async function saveBasics() { setBusy('basics'); const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voz_url: url, voz_length_scale: speed }) }).then(x => x.json()).catch(() => ({ error: 1 })); setBusy(''); toast(r.error ? 'Error' : 'Guardado', r.error ? 'bad' : 'ok'); }
  async function saveEngine() {
    if (!confirm('Cambiar el modelo/voz reinicia el servicio (puede tardar si descarga el modelo). ¿Continuar?')) return;
    setBusy('engine'); const r = await fetch('/backend/api/voz/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ whisper: cfg.whisper, default_voice: cfg.default_voice }) }).then(x => x.json()).catch(() => ({ error: 1 })); setBusy('');
    toast(r.error ? 'Error: ' + r.error : 'Aplicado · reiniciando servicio…', r.error ? 'bad' : 'ok');
  }
  async function install(key) { setBusy('inst' + key); const r = await fetch('/backend/api/voz/voices/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).then(x => x.json()).catch(() => ({ error: 'red' })); setBusy(''); toast(r.error ? 'Error: ' + r.error : 'Voz instalada', r.error ? 'bad' : 'ok'); loadVoices(); loadVoz(); }
  async function removeVoice(key) { if (!confirm('¿Eliminar la voz ' + key + '?')) return; await fetch('/backend/api/voz/voices/' + encodeURIComponent(key), { method: 'DELETE' }); toast('Voz eliminada', 'info'); loadVoices(); loadVoz(); }
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
  async function restart() { if (!confirm('¿Reiniciar el servicio de voz?')) return; setBusy('restart'); await fetch('/backend/api/voz/restart', { method: 'POST' }); toast('Reiniciando servicio…', 'info'); setBusy(''); setTimeout(() => { loadVoz(); loadVoices(); }, 6000); }

  const m = voz?.metrics || {}; const st = voz?.stats || {}; const inst = voices?.installed || []; const cat = voices?.catalog || [];

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
              <Select label="Voz" data={inst.map(v => ({ value: v.key, label: v.key }))} value={testVoice} onChange={setTestVoice} w={220} />
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
                  <Table.Td ta="right"><ActionIcon variant="subtle" color="red" disabled={v.key === voices?.default} onClick={() => removeVoice(v.key)}><IconTrash size={16} /></ActionIcon></Table.Td></Table.Tr>))}
              </Table.Tbody></Table>
            </Card>
            <Card withBorder radius="lg" padding="lg">
              <Text fw={600} mb="sm">Catálogo (descargar)</Text>
              <Table><Table.Tbody>{cat.map(c => (
                <Table.Tr key={c.key}><Table.Td><Text fw={600} fz="sm">{c.label}</Text><Text fz="xs" c="dimmed" ff="monospace">{c.key}</Text></Table.Td>
                  <Table.Td ta="right">{c.installed ? <Badge color="teal" variant="light" leftSection={<IconCheck size={12} />}>Instalada</Badge> :
                    <Button size="compact-sm" variant="light" leftSection={<IconDownload size={14} />} loading={busy === 'inst' + c.key} onClick={() => install(c.key)}>Instalar</Button>}</Table.Td></Table.Tr>))}
              </Table.Tbody></Table>
            </Card>
          </SimpleGrid>
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
              <Select label="Voz por defecto (TTS)" data={inst.map(v => ({ value: v.key, label: v.key }))} value={cfg.default_voice} onChange={v => setCfg(c => ({ ...c, default_voice: v }))} mb="lg" />
              <Alert variant="light" color="orange" mb="md" icon={<IconInfoCircle size={16} />}>Cambiar el modelo descarga ~140MB (base) o ~1.5GB (medium) la primera vez y reinicia el servicio.</Alert>
              <Group justify="flex-end"><Button color="grape" leftSection={<IconReload size={16} />} loading={busy === 'engine'} onClick={saveEngine}>Aplicar y reiniciar</Button></Group>
            </Card>
          </SimpleGrid>
          <Card withBorder radius="lg" padding="lg" mt="md">
            <Group justify="space-between"><div><Text fw={600}>Acciones</Text><Text size="xs" c="dimmed">Reiniciar el servicio de voz del contenedor</Text></div>
              <Button color="red" variant="light" leftSection={<IconReload size={16} />} loading={busy === 'restart'} onClick={restart}>Reiniciar servicio</Button></Group>
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="logs">
          <Card withBorder radius="lg" padding="lg">
            <Group justify="space-between" mb="sm"><Text fw={600}>Logs del servicio</Text><Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={loadLogs}>Cargar logs</Button></Group>
            <ScrollArea h={420}><Code block style={{ fontSize: 11.5, lineHeight: 1.5 }}>{logs || 'Tocá «Cargar logs» para ver la salida del servicio.'}</Code></ScrollArea>
          </Card>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
