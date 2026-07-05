/* AsteriskConsole.jsx - consola del nucleo Asterisk (Nucleo / Red / Dialplan / Seguridad) */
'use client';
import { useEffect, useState } from 'react';
import { Tabs, Stack, Group, Text, Badge, Card, SimpleGrid, ThemeIcon, Table, Loader, Center, TextInput, NumberInput, Button, MultiSelect, Alert } from '@mantine/core';
import { IconServer2, IconActivity, IconNetwork, IconTerminal2, IconShieldLock, IconPlugConnected, IconBolt, IconInfoCircle, IconRouter, IconDeviceLandlinePhone, IconDeviceFloppy, IconTrash, IconUsers, IconCircleCheck, IconCircleX, IconRoute } from '@tabler/icons-react';
import { useLive } from './useLive';
import RoutesPanel from './RoutesPanel';
import Dialplan from './dialplan/page';
import Rutas from './rutas/page';
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
    <Tabs defaultValue="core" variant="pills" radius="md" keepMounted={false}>
      <Tabs.List mb="md">
        <Tabs.Tab value="core" leftSection={<IconActivity size={16} />}>Núcleo</Tabs.Tab>
        <Tabs.Tab value="ext" leftSection={<IconUsers size={16} />}>Internos</Tabs.Tab>
        <Tabs.Tab value="trunk" leftSection={<IconDeviceLandlinePhone size={16} />}>Troncal SBC</Tabs.Tab>
        <Tabs.Tab value="net" leftSection={<IconNetwork size={16} />}>Red</Tabs.Tab>
        <Tabs.Tab value="dialplan" leftSection={<IconTerminal2 size={16} />}>Dialplan</Tabs.Tab>
        <Tabs.Tab value="rutas" leftSection={<IconRoute size={16} />}>Rutas</Tabs.Tab>
        <Tabs.Tab value="sec" leftSection={<IconShieldLock size={16} />}>Seguridad</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="core">
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
      </Tabs.Panel>


      <Tabs.Panel value="ext">
        <Card withBorder radius="md" padding="md" mb="md" style={{ background: 'var(--mantine-color-blue-light)' }}>
          <Group gap="xs" mb={4}><IconUsers size={16} /><Text fw={700} size="sm">Verificación de internos</Text></Group>
          <Text size="sm" c="dimmed">Cruza los internos definidos en la base contra su estado real en Asterisk (registrado / offline, contacto, IP, RTT, vía). Gestión completa en Telefonía → Internos.</Text>
        </Card>
        {(() => {
          const isReg = (e) => !!e.ip || (e.status && !/offline|unavail/i.test(e.status));
          const reg = exts.filter(isReg); const off = exts.filter((e) => !isReg(e)); const web = exts.filter((e) => e.webrtc);
          const viaLabel = { sbc: 'SBC', webrtc: 'WebRTC', direct: 'Directo' };
          return (<Stack gap="md">
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Definidos</Text><Text fw={800} size="xl">{exts.length}</Text></Card>
              <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Registrados</Text><Text fw={800} size="xl" c="teal">{reg.length}</Text></Card>
              <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">Offline</Text><Text fw={800} size="xl" c={off.length ? 'red' : 'dimmed'}>{off.length}</Text></Card>
              <Card withBorder radius="md" padding="sm"><Text size="xs" c="dimmed">WebRTC</Text><Text fw={800} size="xl" c="grape">{web.length}</Text></Card>
            </SimpleGrid>
            <Card withBorder radius="md" padding="md">
              <Group justify="space-between" mb="sm"><Text fw={700}>Internos definidos ({exts.length})</Text></Group>
              {exts.length === 0 ? <Text c="dimmed" size="sm">Sin internos definidos.</Text> :
              <Table striped highlightOnHover withTableBorder verticalSpacing={6}>
                <Table.Thead><Table.Tr><Table.Th>Interno</Table.Th><Table.Th>Nombre</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Vía</Table.Th><Table.Th>IP</Table.Th><Table.Th>RTT</Table.Th><Table.Th>Tipo</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{exts.map((e) => { const r = isReg(e); return (
                  <Table.Tr key={e.id}>
                    <Table.Td><Text fw={700} ff="monospace">{e.id}</Text></Table.Td>
                    <Table.Td fz="xs">{e.name || '—'}</Table.Td>
                    <Table.Td><Badge size="sm" variant={r ? 'filled' : 'light'} color={r ? 'teal' : 'red'} leftSection={r ? <IconCircleCheck size={12} /> : <IconCircleX size={12} />}>{r ? 'Registrado' : 'Offline'}</Badge></Table.Td>
                    <Table.Td><Badge size="sm" variant="light" color={e.via === 'sbc' ? 'grape' : e.via === 'webrtc' ? 'blue' : 'gray'}>{viaLabel[e.via] || '—'}</Badge></Table.Td>
                    <Table.Td ff="monospace" fz="xs">{e.ip || '—'}</Table.Td>
                    <Table.Td fz="xs">{e.rtt != null ? e.rtt + ' ms' : '—'}</Table.Td>
                    <Table.Td>{e.webrtc ? <Badge size="xs" variant="light" color="blue">WebRTC</Badge> : <Badge size="xs" variant="light" color="gray">SIP</Badge>}{e.video ? <Badge size="xs" variant="light" color="grape" ml={4}>video</Badge> : null}</Table.Td>
                  </Table.Tr>); })}</Table.Tbody>
              </Table>}
            </Card>
          </Stack>);
        })()}
      </Tabs.Panel>

      <Tabs.Panel value="trunk">
        <Alert color="grape" icon={<IconInfoCircle size={16} />} variant="light" title="Troncal interna Asterisk -> SBC" mb="md">El SBC (Kamailio) es quien se registra contra cada proveedor (Antel, etc.). Asterisk habla con UNA sola troncal interna hacia el SBC: las llamadas salientes se envían al SBC y las entrantes llegan desde él. Configurá ese enlace acá.</Alert>
        <Card withBorder radius="md" padding="md" maw={620}>
          <Group justify="space-between" mb="sm"><Text fw={700}>Enlace hacia el SBC</Text>{trunk && (trunk.exists ? <Badge color="teal" variant="light" leftSection={<IconPlugConnected size={12} />}>Configurada</Badge> : <Badge color="gray" variant="light">No configurada</Badge>)}</Group>
          <Stack gap="sm">
            <Group grow><TextInput label="IP del SBC" value={tf.sbc_ip} onChange={(e) => setTf({ ...tf, sbc_ip: e.target.value })} leftSection={<IconRouter size={15} />} description="Kamailio (CT107)" /><NumberInput label="Puerto SIP" value={tf.sbc_port} onChange={(v) => setTf({ ...tf, sbc_port: v })} w={140} /></Group>
            <TextInput label="Contexto entrante" value={tf.context} onChange={(e) => setTf({ ...tf, context: e.target.value })} description="Dónde caen las llamadas que entran desde el SBC" />
            <MultiSelect label="Códecs" data={['ulaw','alaw','g722','g729','opus']} value={tf.codecs} onChange={(v) => setTf({ ...tf, codecs: v })} clearable={false} />
            <Group><Button leftSection={<IconDeviceFloppy size={16} />} loading={tbusy === 'save'} onClick={saveTrunk} color="grape">{trunk && trunk.exists ? 'Actualizar troncal' : 'Crear troncal hacia el SBC'}</Button>{trunk && trunk.exists && <Button variant="light" color="red" leftSection={<IconTrash size={16} />} loading={tbusy === 'del'} onClick={delTrunk}>Eliminar</Button>}</Group>
            <Text size="xs" c="dimmed">Identificación por IP (sin contraseña): Asterisk acepta el tráfico del SBC y le envía las salientes. Para que las troncales del proveedor salgan por aquí, las rutas salientes deben usar esta troncal (to-sbc).</Text>
          </Stack>
        </Card>
      </Tabs.Panel>

      <Tabs.Panel value="net">
        <Card withBorder radius="md" padding="md" mb="md" style={{ background: 'var(--mantine-color-blue-light)' }}><Group gap="xs" mb={4}><IconInfoCircle size={16} /><Text fw={700} size="sm">Red de Asterisk (CT103)</Text></Group><Text size="sm" c="dimmed">Interfaces y rutas estáticas propias del núcleo Asterisk. Son independientes de las del SBC (que se gestionan en SBC-NG → Red).</Text></Card>
        <Card withBorder radius="md" padding="md" mb="md"><Text fw={700} mb="xs">Interfaces / WAN</Text>
          {!net || (net.ifaces || []).length === 0 ? <Text size="sm" c="dimmed">Sin datos del agente.</Text> :
            <Table verticalSpacing={6}><Table.Thead><Table.Tr><Table.Th>Interfaz</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Direcciones</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{net.ifaces.map((fi) => <Table.Tr key={fi.name}><Table.Td><Group gap={6} wrap="nowrap"><IconRouter size={15} color="var(--mantine-color-blue-6)" /><Text ff="monospace" fz="sm">{fi.name}</Text></Group></Table.Td><Table.Td><Badge size="sm" variant="light" color={/UP/i.test(fi.state) ? 'teal' : 'gray'}>{fi.state || '-'}</Badge></Table.Td><Table.Td>{(fi.addrs || []).map((a) => <Text key={a} ff="monospace" fz="xs">{a}</Text>)}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
        </Card>
        <RoutesPanel scope="asterisk" />
      </Tabs.Panel>

      <Tabs.Panel value="dialplan"><Dialplan /></Tabs.Panel>
      <Tabs.Panel value="rutas"><Rutas embedded /></Tabs.Panel>

      <Tabs.Panel value="sec">
        <Card withBorder radius="md" padding="md" mb="md" style={{ background: 'var(--mantine-color-blue-light)' }}><Group gap="xs" mb={4}><IconShieldLock size={16} /><Text fw={700} size="sm">Fail2Ban del núcleo (Asterisk)</Text></Group><Text size="sm" c="dimmed">Jails de Fail2Ban analizando los logs de PJSIP. Gestión completa (whitelist, mapa, política) en Sistema → Seguridad.</Text></Card>
        {!f2b ? <Text size="sm" c="dimmed">Cargando…</Text> : (f2b.jails || []).length === 0 ? <Text size="sm" c="dimmed">Sin jails de Fail2Ban activos.</Text> :
          <Stack gap="sm">{(f2b.jails || []).map((j) => { const bl = Array.isArray(j.banned) ? j.banned : []; return <Card key={j.jail} withBorder radius="md" padding="sm"><Group justify="space-between"><Text fw={700}>{j.jail}</Text><Group gap={6}><Badge variant="light" color="red">{bl.length} baneadas</Badge><Badge variant="light" color="orange">{j.total_failed || 0} intentos</Badge></Group></Group></Card>; })}</Stack>}
      </Tabs.Panel>
    </Tabs>
  );
}
