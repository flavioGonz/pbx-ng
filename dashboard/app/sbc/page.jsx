'use client';
/* Conexión a SBC-NG.
 *
 * SBC-NG es OTRO producto (borde SIP: seguridad perimetral, troncales del operador,
 * LCR, anclaje de medios) con su propio panel. PBX-NG funciona completo sin él.
 * Acá sólo se configura la CONEXIÓN: a qué dirección le habla Asterisk, por qué
 * transporte, y si el saliente sale por ahí. Todo lo demás del borde se administra
 * en el panel de SBC-NG. */
import { useEffect, useRef, useState } from 'react';
import { Card, Stack, Group, Text, Badge, Button, TextInput, Select, MultiSelect, Switch, Alert, ThemeIcon, SimpleGrid, Divider, Anchor, Code } from '@mantine/core';
import { IconRouteAltLeft, IconPlugConnected, IconPlugConnectedX, IconInfoCircle, IconExternalLink, IconBolt, IconDeviceFloppy, IconRefresh, IconShieldCheck } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';
import { apiPost, apiDel, usePoll } from '../api';

const CODECS = ['ulaw', 'alaw', 'g722', 'opus', 'g729'];

export default function SbcLinkPage() {
  const [link, setLink] = useState(null);
  const [mods, setMods] = useState(null);
  const [f, setF] = useState({ host: '', port: '5060', transport: 'udp', context: 'from-trunk', codecs: ['ulaw', 'alaw', 'g722'], panel_url: '', create_route: true });
  const [busy, setBusy] = useState('');
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  /* Cada 8 s: el estado del enlace («vivo», ms) lo mide el backend contra el SBC, así
   * que hay que volver a preguntar. `usePoll` lo pausa con la pestaña oculta. */
  const { data: linkData, error: linkError, recargar: recargarLink } = usePoll('/sbc-link', 30000);
  const { data: modsData, error: modsError, recargar: recargarMods } = usePoll('/modules', 30000);
  const load = () => { recargarLink(); recargarMods(); };

  useEffect(() => {
    if (!linkData) return;
    setLink(linkData);
    const d = linkData;
    if (d.configured) setF((s) => ({ ...s, host: d.host || '', port: String(d.port || 5060), transport: d.transport || 'udp', context: d.context || 'from-trunk', codecs: d.codecs || s.codecs, panel_url: d.panel_url || '' }));
    else setF((s) => ({ ...s, panel_url: d.panel_url || '' }));
  }, [linkData]);
  useEffect(() => { if (modsData) setMods(modsData); }, [modsData]);
  /* Un solo aviso por caída (el poll reintenta cada 8 s); se rearma al volver a responder. */
  const avisado = useRef(false);
  useEffect(() => {
    const e = linkError || modsError;
    if (e && !avisado.current) { avisado.current = true; toast(e.message, 'bad'); }
    if (!e) avisado.current = false;
  }, [linkError, modsError]);

  async function toggleModule(en) {
    setBusy('mod');
    try {
      await apiPost('/modules', { id: 'sbc', enabled: en });
      toast(en ? 'Módulo activado: la central usará el SBC-NG cuando esté configurado' : 'Módulo desactivado: la central opera sin SBC', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
    finally { setBusy(''); load(); }
  }
  async function save() {
    if (!f.host.trim()) { toast('La dirección del SBC-NG es obligatoria', 'bad'); return; }
    setBusy('save');
    try {
      const r = await apiPost('/sbc-link', { ...f, port: +f.port || 5060 }) || {};
      toast('Conexión al SBC-NG guardada' + (r.ruta_creada ? ' · ruta saliente «marca 0» creada' : ''), 'ok');
    } catch (e) { toast('Error: ' + e.message, 'bad'); }
    finally { setBusy(''); load(); }
  }
  async function disconnect() {
    const n = link && link.rutas_salientes ? link.rutas_salientes : 0;
    if (!confirm('¿Desconectar el SBC-NG?\n\nSe borra la troncal fija hacia el SBC' + (n ? ' y ' + n + ' ruta(s) saliente(s) que salían por él' : '') + '. La central sigue funcionando con sus troncales de operador directas.')) return;
    setBusy('del');
    try { await apiDel('/sbc-link'); toast('SBC-NG desconectado. La central opera sin borde.', 'ok'); }
    catch (e) { toast('Error: ' + e.message, 'bad'); }
    finally { setBusy(''); load(); }
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
