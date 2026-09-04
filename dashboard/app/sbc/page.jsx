'use client';
/* Conexión a SBC-NG.
 *
 * SBC-NG es OTRO producto (borde SIP: seguridad perimetral, troncales del operador,
 * LCR, anclaje de medios) con su propio panel. PBX-NG funciona completo sin él.
 * Acá sólo se configura la CONEXIÓN: a qué dirección le habla Asterisk, por qué
 * transporte, y si el saliente sale por ahí. Todo lo demás del borde se administra
 * en el panel de SBC-NG. */
import { useEffect, useState } from 'react';
import { Card, Stack, Group, Text, Badge, Button, TextInput, Select, MultiSelect, Switch, Alert, ThemeIcon, SimpleGrid, Divider, Anchor, Code } from '@mantine/core';
import { IconRouteAltLeft, IconPlugConnected, IconPlugConnectedX, IconInfoCircle, IconExternalLink, IconBolt, IconDeviceFloppy, IconRefresh, IconShieldCheck } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

const CODECS = ['ulaw', 'alaw', 'g722', 'opus', 'g729'];

export default function SbcLinkPage() {
  const [link, setLink] = useState(null);
  const [mods, setMods] = useState(null);
  const [f, setF] = useState({ host: '', port: '5060', transport: 'udp', context: 'from-trunk', codecs: ['ulaw', 'alaw', 'g722'], panel_url: '', create_route: true });
  const [busy, setBusy] = useState('');
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  async function load() {
    try {
      const d = await fetch('/backend/api/sbc-link').then((r) => r.json());
      setLink(d);
      if (d && d.configured) setF((s) => ({ ...s, host: d.host || '', port: String(d.port || 5060), transport: d.transport || 'udp', context: d.context || 'from-trunk', codecs: d.codecs || s.codecs, panel_url: d.panel_url || '' }));
      else if (d) setF((s) => ({ ...s, panel_url: d.panel_url || '' }));
    } catch (_) {}
    try { setMods(await fetch('/backend/api/modules').then((r) => r.json())); } catch (_) {}
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  async function toggleModule(en) {
    setBusy('mod');
    const r = await fetch('/backend/api/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'sbc', enabled: en }) }).then((x) => x.json()).catch(() => ({ error: 1 }));
    setBusy('');
    if (r.error) { toast('No se pudo cambiar el módulo', 'bad'); return; }
    toast(en ? 'Módulo activado: la central usará el SBC-NG cuando esté configurado' : 'Módulo desactivado: la central opera sin SBC', 'ok');
    load();
  }
  async function save() {
    if (!f.host.trim()) { toast('La dirección del SBC-NG es obligatoria', 'bad'); return; }
    setBusy('save');
    const r = await fetch('/backend/api/sbc-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, port: +f.port || 5060 }) }).then((x) => x.json()).catch(() => ({ error: 'red' }));
    setBusy('');
    if (r.error) { toast('Error: ' + r.error, 'bad'); return; }
    toast('Conexión al SBC-NG guardada' + (r.ruta_creada ? ' · ruta saliente «marca 0» creada' : ''), 'ok');
    load();
  }
  async function disconnect() {
    const n = link && link.rutas_salientes ? link.rutas_salientes : 0;
    if (!confirm('¿Desconectar el SBC-NG?\n\nSe borra la troncal fija hacia el SBC' + (n ? ' y ' + n + ' ruta(s) saliente(s) que salían por él' : '') + '. La central sigue funcionando con sus troncales de operador directas.')) return;
    setBusy('del');
    const r = await fetch('/backend/api/sbc-link', { method: 'DELETE' }).then((x) => x.json()).catch(() => ({ error: 'red' }));
    setBusy('');
    if (r.error) { toast('Error: ' + r.error, 'bad'); return; }
    toast('SBC-NG desconectado. La central opera sin borde.', 'ok');
    load();
  }

  const enabled = mods ? mods.sbc !== false : !!(link && link.enabled);
  const configured = !!(link && link.configured);
  const vivo = link && link.estado ? link.estado.vivo : null;
  const stColor = !configured ? 'gray' : vivo ? 'teal' : 'red';
  const stLabel = !configured ? 'Sin configurar' : vivo ? 'Conectado' : 'No responde';

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconRouteAltLeft size={24} />} title="Conexión a SBC-NG" subtitle="Borde SIP opcional · otro producto, con su propio panel" color="grape"
        right={<Group gap="xs"><Badge size="lg" variant="light" color={enabled ? 'teal' : 'gray'}>{enabled ? 'Módulo activo' : 'Módulo inactivo'}</Badge>{enabled && <Badge size="lg" variant="light" color={stColor} leftSection={<IconBolt size={12} />}>{stLabel}</Badge>}</Group>} />

      <Alert color="grape" variant="light" icon={<IconInfoCircle size={16} />} title="PBX-NG funciona completa sin SBC">
        Sin SBC-NG, los internos, el WebRTC y las troncales del operador van directo a Asterisk. Si hay un SBC-NG adelante,
        acá se configura únicamente la <b>conexión</b> (a qué dirección le habla la central). Las troncales del operador,
        el ruteo por costo, la seguridad perimetral y el anclaje de medios <b>se administran en el panel de SBC-NG</b>.
      </Alert>

      <Card withBorder radius="lg" padding="lg">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={44} radius="md" variant="light" color={enabled ? 'grape' : 'gray'}><IconRouteAltLeft size={24} /></ThemeIcon>
            <div>
              <Text fw={700}>Módulo «Conexión a SBC-NG»</Text>
              <Text size="xs" c="dimmed" maw={640}>Apagado: el panel no muestra ningún borde y el ruteo saliente usa las troncales directas. Encendido: el SBC-NG aparece en la topología y en el resumen, se mide su estado y las rutas salientes nuevas salen por él.</Text>
            </div>
          </Group>
          <Switch size="lg" onLabel="ON" offLabel="OFF" checked={enabled} disabled={busy === 'mod' || !mods} onChange={(e) => toggleModule(e.currentTarget.checked)} />
        </Group>
      </Card>

      {enabled && (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
          <Card withBorder radius="lg" padding="lg">
            <Group gap="xs" mb="md"><IconPlugConnected size={18} /><Text fw={700}>Dirección del SBC-NG</Text></Group>
            <Stack gap="sm">
              <Group grow align="flex-start">
                <TextInput label="IP o host del SBC-NG" placeholder="192.168.99.113" value={f.host} onChange={(e) => set('host', e.target.value)} required description="La interfaz del SBC-NG que mira hacia la central (LAN)" />
                <TextInput label="Puerto SIP" value={f.port} onChange={(e) => set('port', e.target.value)} w={120} />
                <Select label="Transporte" value={f.transport} onChange={(v) => set('transport', v || 'udp')} data={[{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }, { value: 'tls', label: 'TLS' }]} w={140} />
              </Group>
              <Group grow align="flex-start">
                <TextInput label="Contexto de entrada" value={f.context} onChange={(e) => set('context', e.target.value)} description="Dónde caen las llamadas que llegan desde el SBC" />
                <MultiSelect label="Códecs" data={CODECS} value={f.codecs} onChange={(v) => set('codecs', v.length ? v : ['ulaw'])} />
              </Group>
              <TextInput label="URL del panel de SBC-NG (opcional)" placeholder="https://sbc.midominio.com" value={f.panel_url} onChange={(e) => set('panel_url', e.target.value)} leftSection={<IconExternalLink size={15} />} description="Para abrirlo desde la topología con un clic" />
              {!configured && <Switch label="Crear la ruta saliente «marca 0 + número → SBC-NG» si la central todavía no tiene rutas" checked={f.create_route} onChange={(e) => set('create_route', e.currentTarget.checked)} />}
              <Group mt="xs">
                <Button leftSection={<IconDeviceFloppy size={16} />} loading={busy === 'save'} onClick={save} color="grape">{configured ? 'Guardar cambios' : 'Conectar SBC-NG'}</Button>
                <Button variant="subtle" leftSection={<IconRefresh size={16} />} onClick={load}>Refrescar</Button>
                {configured && <Button variant="light" color="red" leftSection={<IconPlugConnectedX size={16} />} loading={busy === 'del'} onClick={disconnect}>Desconectar</Button>}
              </Group>
            </Stack>
          </Card>

          <Card withBorder radius="lg" padding="lg">
            <Group gap="xs" mb="md"><IconShieldCheck size={18} /><Text fw={700}>Estado de la conexión</Text></Group>
            {!configured ? <Text size="sm" c="dimmed">Todavía no hay un SBC-NG conectado. Ingresá su dirección y guardá.</Text> : (
              <Stack gap={6}>
                <Group justify="space-between"><Text size="sm" c="dimmed">Estado (medido)</Text><Badge variant="light" color={stColor}>{stLabel}{link.estado && link.estado.ms != null ? ' · ' + link.estado.ms + ' ms' : ''}</Badge></Group>
                {link.estado && link.estado.motivo && <Group justify="space-between"><Text size="sm" c="dimmed">Motivo</Text><Text size="sm">{link.estado.motivo}</Text></Group>}
                <Group justify="space-between"><Text size="sm" c="dimmed">Troncal fija en Asterisk</Text><Code>{link.name}</Code></Group>
                <Group justify="space-between"><Text size="sm" c="dimmed">Destino</Text><Code>{link.host}:{link.port} · {String(link.transport || 'udp').toUpperCase()}</Code></Group>
                <Group justify="space-between"><Text size="sm" c="dimmed">Rutas salientes que salen por el SBC</Text><Badge variant="light" color="blue">{link.rutas_salientes}</Badge></Group>
                {link.panel_url && <Group justify="space-between"><Text size="sm" c="dimmed">Panel de SBC-NG</Text><Anchor href={link.panel_url} target="_blank" size="sm">{link.panel_url}</Anchor></Group>}
                <Divider my="xs" />
                <Text size="xs" c="dimmed">El SBC-NG debe tener a esta central como destino (dispatcher) y aceptar SIP desde <Code>{'{IP de Asterisk}'}</Code>. Las troncales del operador se dan de alta en el panel de SBC-NG, no acá.</Text>
              </Stack>
            )}
          </Card>
        </SimpleGrid>
      )}
    </Stack>
  );
}
