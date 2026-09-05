'use client';
/* Configuración → SIP.
 *
 * Los ajustes SIP "de central" que en una Grandstream están en PBX Settings → SIP
 * Settings (General, NAT, ToS/RTP, Session Timer, TCP/TLS) más los códecs por defecto
 * y la grabación global (que antes estaba perdida en la lista de internos). Todo sale
 * de /api/sipconf (sólo admin); el backend regenera pbxng.d/{pjsip,rtp}.conf y recarga
 * lo que se puede en caliente. NAT, TLS y el rango RTP piden reinicio de Asterisk: se
 * avisa y se ofrece un reinicio "cuando no haya llamadas". */
import { useEffect, useState } from 'react';
import { Card, Stack, Group, Text, Badge, Button, TextInput, NumberInput, Select, MultiSelect, Switch, Alert, ThemeIcon, Tabs, Table, Code, Divider, TagsInput, Tooltip, Loader } from '@mantine/core';
import { IconDeviceFloppy, IconRefresh, IconNetwork, IconAdjustmentsHorizontal, IconWaveSine, IconClockHour4, IconLock, IconMicrophone2, IconAlertTriangle, IconRotateClockwise, IconPlugConnected, IconInfoCircle, IconMusic } from '@tabler/icons-react';
import { toast } from './notify';

const YN = [{ value: 'yes', label: 'Sí' }, { value: 'no', label: 'No' }];
const TOS = ['cs0', 'cs1', 'cs2', 'cs3', 'cs4', 'cs5', 'cs6', 'cs7', 'af11', 'af21', 'af31', 'af41', 'ef'].map((v) => ({ value: v, label: v.toUpperCase() }));

function Row({ label, hint, children }) {
  // Filas "etiqueta a la izquierda, control a la derecha", al estilo de las centrales de marca.
  return (
    <Group justify="space-between" wrap="nowrap" align="flex-start" py={8} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
      <div style={{ minWidth: 0, flex: 1 }}><Text size="sm" fw={600}>{label}</Text>{hint && <Text size="xs" c="dimmed">{hint}</Text>}</div>
      <div style={{ flex: 'none', width: 'min(360px, 48%)' }}>{children}</div>
    </Group>
  );
}

export default function SipPanel() {
  const [cfg, setCfg] = useState(null);
  const [tab, setTab] = useState('general');
  const [busy, setBusy] = useState('');
  const [restart, setRestart] = useState(false);
  const [applyTimers, setApplyTimers] = useState(false);
  const [applyTos, setApplyTos] = useState(false);
  const set = (sec, k, v) => setCfg((c) => ({ ...c, [sec]: { ...c[sec], [k]: v } }));

  async function load() {
    try { const d = await fetch('/backend/api/sipconf').then((r) => r.json()); if (!d.error) setCfg(d); else toast(d.error, 'bad'); }
    catch (_) { toast('No se pudo leer la configuración SIP', 'bad'); }
  }
  useEffect(() => { load(); }, []);

  async function save() {
    if (!cfg) return;
    setBusy('save');
    const body = { general: cfg.general, nat: cfg.nat, rtp: cfg.rtp, timers: cfg.timers, tls: cfg.tls, codecs: cfg.codecs, apply_timers: applyTimers, apply_tos: applyTos };
    const r = await fetch('/backend/api/sipconf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ error: 'red' }));
    setBusy('');
    if (r.error) { toast('No se pudo guardar', 'bad', { description: r.error }); return; }
    setApplyTimers(false); setApplyTos(false);
    if (r.restart_required) { setRestart(true); toast('Guardado. NAT, TLS o rango RTP cambiaron: hace falta reiniciar Asterisk', 'warn', { duration: 6000 }); }
    else toast('Configuración SIP aplicada' + (r.timers_applied != null ? ' · temporizadores en ' + r.timers_applied + ' endpoints' : ''), 'ok');
    load();
  }
  async function doRestart(now) {
    if (!confirm(now ? '¿Reiniciar Asterisk AHORA? Se cortan todas las llamadas en curso.' : '¿Reiniciar Asterisk cuando no haya llamadas? La central espera a quedar libre y reinicia sola.')) return;
    setBusy('restart');
    const r = await fetch('/backend/api/sipconf/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ now }) }).then((x) => x.json()).catch(() => ({ error: 'red' }));
    setBusy('');
    if (r.error) { toast('No se pudo reiniciar', 'bad', { description: r.error }); return; }
    setRestart(false);
    toast(now ? 'Asterisk reiniciando' : 'Asterisk reiniciará apenas no haya llamadas', 'info');
  }
  async function toggleRecAll(on) {
    setBusy('rec');
    const r = await fetch('/backend/api/extensions/record-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) }).then((x) => x.json()).catch(() => ({ error: 1 }));
    setBusy('');
    if (r.error) { toast('No se pudo cambiar la grabación global', 'bad'); return; }
    setCfg((c) => ({ ...c, record_all: on }));
    toast(on ? 'Grabación global activada: se graban todas las llamadas' : 'Grabación global desactivada', on ? 'warn' : 'ok');
  }

  if (!cfg) return <Group justify="center" py={48}><Loader size="sm" color="pbx" /></Group>;
  const g = cfg.general, n = cfg.nat, r = cfg.rtp, t = cfg.timers, s = cfg.tls, c = cfg.codecs;

  return (
    <Stack gap="md">
      {restart && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} title="Reinicio de Asterisk pendiente">
          <Group justify="space-between">
            <Text size="sm">Los transportes SIP (NAT, TLS) y el rango RTP sólo se aplican al reiniciar. Podés esperar a que no haya llamadas o reiniciar ya.</Text>
            <Group gap="xs"><Button size="xs" color="orange" variant="light" leftSection={<IconRotateClockwise size={14} />} loading={busy === 'restart'} onClick={() => doRestart(false)}>Reiniciar cuando esté libre</Button><Button size="xs" color="red" variant="subtle" onClick={() => doRestart(true)}>Reiniciar ahora</Button></Group>
          </Group>
        </Alert>
      )}

      <Card withBorder radius="lg" padding="md" style={{ background: cfg.record_all ? 'rgba(225,29,72,.05)' : undefined }}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap={12} wrap="nowrap"><ThemeIcon size={40} radius="md" variant="light" color={cfg.record_all ? 'red' : 'gray'}><IconMicrophone2 size={22} /></ThemeIcon>
            <div><Text fw={700}>Grabación global de llamadas</Text><Text fz="sm" c="dimmed">Se graban todas las llamadas de la central, sin importar el interruptor de cada interno.</Text></div></Group>
          <Switch size="lg" color="red" checked={!!cfg.record_all} disabled={busy === 'rec'} onChange={(e) => toggleRecAll(e.currentTarget.checked)} />
        </Group>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Tabs value={tab} onChange={setTab} variant="pills" radius="md">
          <Tabs.List mb="md">
            <Tabs.Tab value="general" leftSection={<IconAdjustmentsHorizontal size={15} />}>General</Tabs.Tab>
            <Tabs.Tab value="nat" leftSection={<IconNetwork size={15} />}>NAT</Tabs.Tab>
            <Tabs.Tab value="rtp" leftSection={<IconWaveSine size={15} />}>RTP / ToS</Tabs.Tab>
            <Tabs.Tab value="timers" leftSection={<IconClockHour4 size={15} />}>Session Timer</Tabs.Tab>
            <Tabs.Tab value="tls" leftSection={<IconLock size={15} />}>TCP / TLS</Tabs.Tab>
            <Tabs.Tab value="codecs" leftSection={<IconMusic size={15} />}>Códecs</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="general">
            <Row label="User-Agent" hint="Lo que la central anuncia en cada mensaje SIP"><TextInput value={g.user_agent} onChange={(e) => set('general', 'user_agent', e.target.value)} /></Row>
            <Row label="Keep-alive (segundos)" hint="CRLF cada tanto en TCP/TLS/WS para que el NAT del teléfono no cierre el flujo. 0 = apagado"><NumberInput value={g.keep_alive_interval} min={0} max={600} onChange={(v) => set('general', 'keep_alive_interval', v)} /></Row>
            <Row label="Max-Forwards" hint="Saltos máximos de un mensaje SIP"><NumberInput value={g.max_forwards} min={1} max={255} onChange={(v) => set('general', 'max_forwards', v)} /></Row>
            <Row label="Realm por defecto" hint="Realm del desafío de autenticación (vacío = asterisk)"><TextInput value={g.default_realm} placeholder="asterisk" onChange={(e) => set('general', 'default_realm', e.target.value)} /></Row>
            <Row label="Timer T1 (ms)" hint="Estimación del RTT SIP. Redes lentas: subirlo"><NumberInput value={g.timer_t1} min={100} max={5000} step={50} onChange={(v) => set('general', 'timer_t1', v)} /></Row>
            <Row label="Timer B (ms)" hint="Cuánto espera un INVITE sin respuesta antes de darlo por fallido"><NumberInput value={g.timer_b} min={1000} max={120000} step={1000} onChange={(v) => set('general', 'timer_b', v)} /></Row>
            <Row label="Revisión de contactos vencidos (s)" hint="Cada cuánto se limpian registros expirados"><NumberInput value={g.contact_expiration_check_interval} min={5} max={600} onChange={(v) => set('general', 'contact_expiration_check_interval', v)} /></Row>
          </Tabs.Panel>

          <Tabs.Panel value="nat">
            <Alert color="blue" variant="light" icon={<IconInfoCircle size={15} />} mb="sm">Se aplica a todos los transportes (UDP, TCP, TLS, WS). Si la central está detrás de un router, poné la IP pública y las redes locales; si tiene IP pública propia o hay un SBC-NG adelante, dejalo vacío.</Alert>
            <Row label="IP externa de señalización" hint="external_signaling_address · IP pública (o dominio) que va en los mensajes SIP"><TextInput value={n.external_signaling_address} placeholder="200.1.2.3" onChange={(e) => set('nat', 'external_signaling_address', e.target.value)} /></Row>
            <Row label="IP externa de medios" hint="external_media_address · IP pública que va en el SDP (audio)"><TextInput value={n.external_media_address} placeholder="200.1.2.3" onChange={(e) => set('nat', 'external_media_address', e.target.value)} /></Row>
            <Row label="Redes locales" hint="local_net · redes donde NO se usa la IP externa. Enter para agregar"><TagsInput value={n.local_net} placeholder="192.168.0.0/16" onChange={(v) => set('nat', 'local_net', v)} splitChars={[',', ' ']} /></Row>
            <Row label="ToS señalización SIP" hint="Marcado DSCP de los paquetes SIP"><Select data={TOS} value={n.tos_sip} onChange={(v) => set('nat', 'tos_sip', v || 'cs3')} /></Row>
          </Tabs.Panel>

          <Tabs.Panel value="rtp">
            <Row label="Inicio del rango RTP" hint="Primer puerto UDP para audio/video (abrirlo en el firewall)"><NumberInput value={r.rtpstart} min={1024} max={65000} onChange={(v) => set('rtp', 'rtpstart', v)} /></Row>
            <Row label="Fin del rango RTP"><NumberInput value={r.rtpend} min={1025} max={65535} onChange={(v) => set('rtp', 'rtpend', v)} /></Row>
            <Row label="Strict RTP" hint="Sólo acepta audio del par que negoció. «seqno» tolera cambios de origen por secuencia"><Select data={[{ value: 'yes', label: 'Sí' }, { value: 'no', label: 'No' }, { value: 'seqno', label: 'Por secuencia (seqno)' }]} value={r.strictrtp} onChange={(v) => set('rtp', 'strictrtp', v || 'yes')} /></Row>
            <Row label="ICE" hint="Necesario para WebRTC"><Select data={YN} value={r.icesupport} onChange={(v) => set('rtp', 'icesupport', v || 'yes')} /></Row>
            <Row label="Servidor STUN" hint="host:puerto · descubre la IP pública para ICE. Vacío = sin STUN"><TextInput value={r.stunaddr} placeholder="stun.l.google.com:19302" onChange={(e) => set('rtp', 'stunaddr', e.target.value)} /></Row>
            <Row label="Timeout DTMF (ms)" hint="Cuánto dura un dígito RFC2833 sin fin explícito"><NumberInput value={r.dtmftimeout} min={100} max={60000} step={100} onChange={(v) => set('rtp', 'dtmftimeout', v)} /></Row>
            <Row label="Checksums UDP en RTP"><Select data={YN} value={r.rtpchecksums} onChange={(v) => set('rtp', 'rtpchecksums', v || 'no')} /></Row>
            <Row label="ToS audio (endpoints)" hint="DSCP del RTP. Marcá «aplicar» para escribirlo en todos los internos y troncales"><Group gap="xs" wrap="nowrap"><Select data={TOS} value={n.tos_audio} onChange={(v) => set('nat', 'tos_audio', v || 'ef')} style={{ flex: 1 }} /><Tooltip label="Aplicar a todos los endpoints al guardar"><Switch checked={applyTos} onChange={(e) => setApplyTos(e.currentTarget.checked)} /></Tooltip></Group></Row>
          </Tabs.Panel>

          <Tabs.Panel value="timers">
            <Alert color="blue" variant="light" icon={<IconInfoCircle size={15} />} mb="sm">Los temporizadores de sesión (RFC 4028) refrescan la llamada cada tanto para detectar llamadas colgadas a medias. Se guardan por endpoint: los internos y troncales nuevos heredan estos valores; para los existentes activá «aplicar a todos».</Alert>
            <Row label="Temporizadores de sesión"><Select data={[{ value: 'yes', label: 'Sí (negociado)' }, { value: 'no', label: 'No' }, { value: 'required', label: 'Obligatorio' }, { value: 'always', label: 'Siempre' }]} value={t.timers} onChange={(v) => set('timers', 'timers', v || 'yes')} /></Row>
            <Row label="Min-SE (s)" hint="Mínimo intervalo aceptado"><NumberInput value={t.timers_min_se} min={90} max={86400} onChange={(v) => set('timers', 'timers_min_se', v)} /></Row>
            <Row label="Session-Expires (s)" hint="Intervalo de refresco propuesto"><NumberInput value={t.timers_sess_expires} min={90} max={86400} onChange={(v) => set('timers', 'timers_sess_expires', v)} /></Row>
            <Row label="Aplicar a todos los internos y troncales" hint="Al guardar, sobrescribe los temporizadores de todos los endpoints existentes"><Switch checked={applyTimers} onChange={(e) => setApplyTimers(e.currentTarget.checked)} /></Row>
          </Tabs.Panel>

          <Tabs.Panel value="tls">
            <Row label="Versión TLS" hint="Método del transporte TLS (5061). Cambia con reinicio"><Select data={[{ value: 'tlsv1_2', label: 'TLS 1.2' }, { value: 'tlsv1_3', label: 'TLS 1.3' }, { value: 'sslv23', label: 'Negociado (sslv23)' }, { value: 'default', label: 'Por defecto de OpenSSL' }]} value={s.method} onChange={(v) => set('tls', 'method', v || 'tlsv1_2')} /></Row>
            <Row label="Cifrados" hint="Lista OpenSSL (vacío = por defecto)"><TextInput value={s.cipher} placeholder="ECDHE-RSA-AES256-GCM-SHA384:..." onChange={(e) => set('tls', 'cipher', e.target.value)} /></Row>
            <Divider my="sm" label="Transportes activos en Asterisk" labelPosition="left" />
            {cfg.transports && cfg.transports.length ? (
              <Table verticalSpacing="xs" fz="sm"><Table.Thead><Table.Tr><Table.Th>Transporte</Table.Th><Table.Th>Protocolo</Table.Th><Table.Th>Escucha</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{cfg.transports.map((x) => <Table.Tr key={x.id}><Table.Td><Code>{x.id}</Code></Table.Td><Table.Td><Badge variant="light" leftSection={<IconPlugConnected size={11} />}>{String(x.protocol).toUpperCase()}</Badge></Table.Td><Table.Td><Code>{x.bind}</Code></Table.Td></Table.Tr>)}</Table.Tbody></Table>
            ) : <Text size="sm" c="dimmed">No se pudo consultar a Asterisk (¿AMI caído?).</Text>}
            <Text size="xs" c="dimmed" mt="sm">Los certificados del transporte TLS se administran en «Proxy / TLS».</Text>
          </Tabs.Panel>

          <Tabs.Panel value="codecs">
            <Alert color="blue" variant="light" icon={<IconInfoCircle size={15} />} mb="sm">Códecs y orden de preferencia para los internos y troncales <b>nuevos</b>. Los existentes conservan los suyos (se editan en cada uno).</Alert>
            <Row label="Audio" hint="En orden de preferencia"><MultiSelect data={cfg.options ? cfg.options.audio : []} value={c.audio} onChange={(v) => set('codecs', 'audio', v)} searchable /></Row>
            <Row label="Video" hint="Sólo para internos con video / WebRTC"><MultiSelect data={cfg.options ? cfg.options.video : []} value={c.video} onChange={(v) => set('codecs', 'video', v)} /></Row>
          </Tabs.Panel>
        </Tabs>

        <Group justify="flex-end" mt="md">
          <Button variant="subtle" leftSection={<IconRefresh size={16} />} onClick={load}>Descartar cambios</Button>
          <Button leftSection={<IconDeviceFloppy size={16} />} loading={busy === 'save'} onClick={save}>Guardar y aplicar</Button>
        </Group>
      </Card>
    </Stack>
  );
}
