/* AsteriskConsole.jsx - consola del nucleo Asterisk (Nucleo / Red / Dialplan / Seguridad) */
'use client';
import { useEffect, useState } from 'react';
import { Tabs, Stack, Group, Text, Badge, Card, SimpleGrid, ThemeIcon, Table, Loader, Center, TextInput, NumberInput, Button, MultiSelect, Alert } from '@mantine/core';
import { IconServer2, IconActivity, IconNetwork, IconTerminal2, IconShieldLock, IconPlugConnected, IconBolt, IconInfoCircle, IconRouter, IconDeviceLandlinePhone, IconDeviceFloppy, IconTrash, IconUsers, IconCircleCheck, IconCircleX, IconRoute } from '@tabler/icons-react';
import { useLive } from './useLive';
import RoutesPanel from './RoutesPanel';
import { toast } from './notify';

export default function AsteriskConsole() {
  const { snap } = useLive();
  const [health, setHealth] = useState(null);
  const [core, setCore] = useState(null); const [net, setNet] = useState(null); const [f2b, setF2b] = useState(null);
  const [exts, setExts] = useState([]); const [trunk, setTrunk] = useState(null); const [tf, setTf] = useState({ sbc_ip: '', sbc_port: 5060, context: 'from-trunk', codecs: ['ulaw', 'alaw', 'g722'] }); const [tbusy, setTbusy] = useState('');
  async function load() { try { setHealth(await fetch('/backend/health').then((r) => r.json())); } catch (_) {} try { setCore(await fetch('/backend/api/asterisk/core').then((r) => r.json())); } catch (_) {} try { setNet(await fetch('/backend/api/asterisk/net').then((r) => r.json())); } catch (_) {}
    try { const tk = await fetch('/backend/api/asterisk/sbc-trunk').then((r) => r.json()); setTrunk(tk); if (tk && tk.exists) setTf((f) => ({ ...f, sbc_ip: (tk.identify && tk.identify.match) || f.sbc_ip, context: (tk.endpoint && tk.endpoint.context) || f.context, codecs: (tk.endpoint && tk.endpoint.allow) ? tk.endpoint.allow.split(',') : f.codecs })); } catch (_) {} }
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, []);
  useEffect(() => { const lf = () => fetch('/backend/api/security').then((r) => r.json()).then(setF2b).catch(() => {}); lf(); const t = setInterval(lf, 8000); return () => clearInterval(t); }, []);
  useEffect(() => { const lf = () => fetch('/backend/api/extensions').then((r) => r.json()).then((d) => Array.isArray(d) && setExts(d)).catch(() => {}); lf(); const t = setInterval(lf, 7000); return () => clearInterval(t); }, []);
  async function saveTrunk() { setTbusy('save'); const r = await fetch('/backend/api/asterisk/sbc-trunk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tf) }).then((x) => x.json()).catch(() => ({ error: 1 })); setTbusy(''); toast(r.error ? 'Error al guardar' : 'Troncal hacia el SBC guardada (pjsip recargado)', r.error ? 'bad' : 'ok'); setTimeout(load, 700); }
  async function delTrunk() { if (!confirm('¿Eliminar la troncal interna hacia el SBC?')) return; setTbusy('del'); await fetch('/backend/api/asterisk/sbc-trunk', { method: 'DELETE' }).catch(() => {}); setTbusy(''); toast('Troncal eliminada', 'info'); setTimeout(load, 700); }
  const ch = (snap && snap.channels) || []; const m = (core && core.metrics) || {};
  const amiUp = health ? !!health.ami : !!(snap && snap.health && snap.health.ami); const ariUp = health ? !!health.ari : !!(snap && snap.health && snap.health.ari);
  const flag = (on, l) => <Badge variant="light" color={on ? 'teal' : 'gray'} size="sm">{l}</Badge>;
  return (
    <div>
        {!core ? <Center mih={360}><Stack align="center" gap="sm"><Loader size="lg" color="blue" /><Text c="dimmed" size="sm">Cargando estado de Asterisk…</Text></Stack></Center> : core.error ? <Card withBorder radius="md" padding="lg"><Text c="red" fw={600}>No se pudo contactar el agente de Asterisk (CT103:8092).</Text></Card> : <Stack gap="lg">
          <Card withBorder radius="md" padding="md"><Group justify="space-between"><Group gap="sm"><ThemeIcon size={40} radius="md" variant="light" color="blue"><IconServer2 size={22} /></ThemeIcon><div><Text fw={800} lh={1.1}>Asterisk PBX</Text><Text size="xs" c="dimmed">{core.version}</Text></div></Group><Badge size="lg" variant="filled" color={amiUp ? 'teal' : 'red'} leftSection={<IconBolt size={12} />}>{amiUp ? 'Operativo' : 'Sin AMI'}</Badge></Group></Card>
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Versión</Text><Text fw={700} size="sm">{core.version || '-'}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Uptime</Text><Text fw={700} size="sm">{core.uptime || '-'}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Canales activos</Text><Text fw={700} size="xl">{ch.length}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Endpoints</Text><Text fw={700} size="xl">{core.endpoints || 0}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">CPU (load)</Text><Text fw={700}>{m.load ?? '-'}</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Memoria</Text><Text fw={700} size="sm">{m.mem_used_mb || 0}/{m.mem_total_mb || 0} MB</Text></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">AMI / ARI</Text><Group gap={4} mt={4}>{flag(amiUp, 'AMI')}{flag(ariUp, 'ARI')}</Group></Card>
            <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Realtime</Text><Text fw={700} size="sm">PostgreSQL (ARA)</Text></Card>
          </SimpleGrid>
          <Card withBorder radius="md" padding="md"><Text fw={700} mb="xs">Transportes PJSIP</Text><Group gap="xs">{(core.transports || []).map((t) => <Badge key={t.id} variant="light" color="blue" leftSection={<IconPlugConnected size={12} />}>{t.id} · {(t.proto || '').toUpperCase()}</Badge>)}</Group></Card>
          <Card withBorder radius="md" padding="md"><Text fw={700} mb="xs">Módulos clave</Text><Group gap="xs">{Object.entries(core.modules || {}).map(([k, v]) => <Badge key={k} variant="light" color={v ? 'teal' : 'red'}>{k}: {v ? 'cargado' : 'no'}</Badge>)}</Group></Card>
        </Stack>}
    </div>
  );
}
