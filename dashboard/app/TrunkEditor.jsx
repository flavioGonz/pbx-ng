/* TrunkEditor.jsx — el cajón de configuración de una troncal SIP.
 *
 * ANTES ERA UN MODAL CON UN STEPPER DE 5 PASOS. El stepper obliga a un orden que la
 * troncal no tiene: quien vuelve a tocar una troncal ya creada casi siempre va a UNA cosa
 * (cambiar la clave, agregar un DID, sacar un códec) y tenía que pasar por los pasos
 * anteriores o adivinar en cuál estaba. Las solapas dicen de entrada qué contiene cada
 * bloque y se salta directo. Además el cajón deja la topología a la izquierda mientras se
 * edita, y el botón de guardar queda fijo abajo en lugar de irse con el scroll.
 */
'use client';
import { useEffect, useState } from 'react';
import { Group, Button, Stack, Text, TextInput, PasswordInput, NumberInput, SegmentedControl, Switch, Select, MultiSelect, TagsInput, ThemeIcon, FileButton, Box, CopyButton, ActionIcon, Tooltip, Card, SimpleGrid, Loader, Collapse, Alert, Badge } from '@mantine/core';
import { IconDeviceLandlinePhone, IconTag, IconUser, IconWorld, IconHash, IconLock, IconKey, IconPlugConnected, IconWaveSine, IconPhoto, IconServer2, IconCheck, IconCopy, IconStethoscope, IconCircleCheck, IconCircleX, IconInfoCircle, IconBroadcast, IconPlus, IconPencil } from '@tabler/icons-react';
import DrawerNG, { BloqueNG } from './DrawerNG';
import { IcoTroncal, IcoConexion, IcoLlave, IcoLatencia, IcoRegistro, IcoPersona } from './IconosNG';
import { toast } from './notify';

const CopyField = ({ label, value }) => (
  <TextInput label={label} value={value} readOnly styles={{ input: { fontFamily: 'monospace' } }} rightSection={<CopyButton value={value}>{({ copied, copy }) => <Tooltip label={copied ? 'Copiado' : 'Copiar'}><ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy}>{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}</ActionIcon></Tooltip>}</CopyButton>} />
);

const CODECS = ['ulaw', 'alaw', 'g722', 'g729', 'opus', 'gsm'];
const TYPES = [
  { value: 'asterisk', label: 'SIP · Directa', desc: 'Se registra directo en Asterisk', icon: IconServer2, color: '#1d4ed8' },
  { value: 'webrtc', label: 'WebRTC (WSS)', desc: 'SIP sobre WebSocket + DTLS-SRTP', icon: IconWaveSine, color: '#0e9488' },
];
export const trunkBlank = {
  name: '', kind: 'asterisk', callerid: '', mode: 'register',
  provider_host: '', provider_port: '5060', transport: 'udp',
  username: '', password: '', from_user: '', from_domain: '',
  codecs: ['ulaw', 'alaw'], dtmf_mode: 'rfc4733', nat: true, direct_media: false,
  qualify_frequency: 60, expiration: 3600, retry_interval: 60, context: 'from-trunk',
  outbound_enabled: true, outbound_prefix: '0', outbound_strip: 0, logo: '', dids: [], channels: 0, gateway: '',
};

const rttColor = (r) => r == null ? 'gray' : r < 80 ? 'teal' : r < 200 ? 'yellow' : 'red';

/* El encabezado del cajón contesta la primera pregunta de cualquiera que abre una troncal:
 * «¿esto está arriba?». El estado sale de lo mismo que pinta la topología (`pjsip show
 * registrations` / el qualify de Asterisk) y la latencia es el RTT del OPTIONS contra el
 * operador: mide la señalización, no el audio de las llamadas. */
function EstadoTroncal({ t }) {
  if (!t) return null;
  const up = t.status === 'online';
  const rtt = t.rtt;
  const nivel = rtt == null ? 0 : rtt < 80 ? 3 : rtt < 200 ? 2 : 1;
  return (
    <Group gap={8} wrap="nowrap" style={{ flex: 'none' }}>
      {rtt != null && (
        <Tooltip withArrow multiline w={250}
          label="Ida y vuelta de la señalización que mide la central contra el operador (OPTIONS). Por debajo de 80 ms es sano; por encima de 200 ms el enlace está sufriendo. No mide el audio de las llamadas.">
          <Badge variant="light" color={rttColor(rtt)} style={{ cursor: 'help' }} leftSection={<IcoLatencia s={12} nivel={nivel} />}>
            {Math.round(rtt)} ms
          </Badge>
        </Tooltip>
      )}
      <Tooltip withArrow label={t.detail || (up ? 'La troncal responde' : 'La troncal no responde')}>
        <Badge variant={up ? 'light' : 'outline'} color={up ? 'teal' : 'gray'} style={{ cursor: 'help' }} leftSection={<IcoRegistro s={12} vivo={up} />}>
          {up ? 'Conectada' : 'Caída'}
        </Badge>
      </Tooltip>
    </Group>
  );
}

/* ── Diagnóstico animado (pre-conexión) ─────────────────────────────────── */
function DiagBlock({ f, wmode }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  async function run() {
    setBusy(true); setRes(null); setOpen(true);
    const body = f.kind === 'webrtc'
      ? (wmode === 'client' ? { kind: 'webrtc-client', remote_url: f.remote_url } : { kind: 'webrtc', mode: 'register' })
      : { kind: f.kind, mode: f.mode, provider_host: f.provider_host, provider_port: f.provider_port, transport: f.transport };
    try { const d = await fetch('/backend/api/trunks/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()); setRes(d); }
    catch (_) { setRes({ ok: false, pasos: [{ paso: 'Error', ok: false, detalle: 'no se pudo ejecutar el diagnóstico' }] }); }
    setBusy(false);
  }
  const canRun = f.kind === 'webrtc' ? (wmode === 'client' ? !!f.remote_url : true) : !!f.provider_host;
  const wserver = f.kind === 'webrtc' && wmode === 'server';
  return (
    <Card withBorder radius="md" padding="sm" style={{ background: 'rgba(37,99,235,.03)' }}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap={8} wrap="nowrap"><ThemeIcon variant="light" color="blue" radius="md"><IconStethoscope size={16} /></ThemeIcon><div><Text fw={700} fz="sm" lh={1.1}>Diagnóstico</Text><Text fz={11} c="dimmed">{wserver ? 'La troncal servidor se prueba cuando el remoto se conecta' : 'Probá el enlace antes de guardar (DNS, ruta, SIP, NAT)'}</Text></div></Group>
        <Button size="xs" variant="light" leftSection={<IconStethoscope size={14} />} loading={busy} disabled={!canRun || wserver} onClick={run}>Probar troncal</Button>
      </Group>
      <Collapse in={open}>
        <Stack gap={6} mt="sm">
          {busy && <Group gap={8}><Loader size="xs" /><Text fz="xs" c="dimmed">Diagnosticando el enlace…</Text></Group>}
          {res && res.pasos && res.pasos.map((p, i) => (
            <Group key={i} gap={8} wrap="nowrap" align="flex-start" className="diag-row" style={{ animationDelay: (i * 60) + 'ms' }}>
              <ThemeIcon size={22} radius="xl" variant="light" color={p.info ? 'blue' : p.ok ? 'teal' : 'red'} style={{ flex: 'none', marginTop: 1 }}>
                {p.info ? <IconInfoCircle size={13} /> : p.ok ? <IconCircleCheck size={13} /> : <IconCircleX size={13} />}
              </ThemeIcon>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6} wrap="nowrap"><Text fz="xs" fw={700}>{p.paso}</Text>{p.ms != null && p.ms > 0 && <Text fz={10} c="dimmed" ff="monospace">{p.ms}ms</Text>}</Group>
                <Text fz="xs" c="dimmed">{p.detalle}</Text>
              </div>
            </Group>
          ))}
          {res && !busy && <Group gap={6} mt={4}><ThemeIcon size={20} radius="xl" variant="light" color={res.ok ? 'teal' : 'orange'}>{res.ok ? <IconCircleCheck size={12} /> : <IconInfoCircle size={12} />}</ThemeIcon><Text fz="xs" fw={600} c={res.ok ? 'teal' : 'orange'}>{res.ok ? 'El enlace responde: podés guardar con confianza.' : 'Revisá lo marcado. Algunos operadores igual funcionan al registrar.'}</Text></Group>}
        </Stack>
      </Collapse>
      <style jsx>{`.diag-row{ animation: diagIn .32s ease both; } @keyframes diagIn{ from{ opacity:0; transform: translateX(-6px);} to{ opacity:1; transform:none;} }`}</style>
    </Card>
  );
}

export default function TrunkEditor({ opened, onClose, initialName, defaultKind, onSaved, vivo = null }) {
  const [f, setF] = useState(trunkBlank);
  const [solapa, setSolapa] = useState('identidad');
  const [saving, setSaving] = useState(false);
  const [wr, setWr] = useState(null);
  const [wmode, setWmode] = useState('server');
  const editing = !!initialName;
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!opened) return;
    setSolapa('identidad'); setWr(null); setWmode('server');
    if (initialName) {
      (async () => {
        let adv = {}, kind = defaultKind || 'asterisk';
        let det = {}; try { det = await fetch('/backend/api/trunks/' + encodeURIComponent(initialName) + '/detail').then((r) => r.json()); adv = det.adv || {}; } catch (_) {}
        try { const list = await fetch('/backend/api/trunks').then((r) => r.json()); const me = Array.isArray(list) && list.find((t) => t.name === initialName); if (me && me.kind) kind = me.kind; } catch (_) {}
        if (kind === 'webrtc' || kind === 'webrtc-client') { setWmode(kind === 'webrtc-client' ? 'client' : 'server'); setF({ ...trunkBlank, name: initialName, kind: 'webrtc', username: det.username || '', remote_url: det.remote_url || '', callerid: (det.adv && det.adv.note) || '', password: '' }); } else { setF({ ...trunkBlank, ...adv, name: initialName, kind, password: '', provider_port: String(adv.provider_port || '5060') }); }
      })();
    } else { setF({ ...trunkBlank, kind: defaultKind || 'asterisk' }); }
  }, [opened, initialName, defaultKind]);

  async function onLogo(file) {
    if (!file) return;
    try {
      const img = new Image(); const url = URL.createObjectURL(file);
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const max = 128, sc = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      set('logo', cv.toDataURL('image/png')); URL.revokeObjectURL(url);
    } catch (_) { toast('No se pudo procesar el logo', 'bad'); }
  }

  async function save() {
    if (f.kind === 'webrtc') {
      if (wmode === 'client') {
        if (!f.name || !f.remote_url || !f.username || (!editing && !f.password)) { toast('Nombre, URL WSS remota, usuario y contraseña son obligatorios', 'bad'); return; }
        setSaving(true);
        const body = { name: f.name, kind: 'webrtc-client', remote_url: f.remote_url, username: f.username, note: f.callerid || '' };
        if (f.password) body.password = f.password;
        const url = editing ? '/backend/api/trunks/' + encodeURIComponent(f.name) : '/backend/api/trunks';
        const r = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ error: 'red' }));
        setSaving(false);
        if (r.error) { toast('Error: ' + r.error, 'bad'); return; }
        toast(editing ? 'Troncal WebRTC (cliente) actualizada' : 'Troncal WebRTC (cliente) creada — el bridge la conectará', 'ok'); if (onSaved) onSaved(); onClose();
        return;
      }
      if (!f.name || (!editing && !f.password)) { toast('Nombre y contraseña son obligatorios', 'bad'); return; }
      setSaving(true);
      const body = { name: f.name, kind: 'webrtc', username: f.username || f.name, note: f.callerid || '' };
      if (f.password) body.password = f.password;
      const url = editing ? '/backend/api/trunks/' + encodeURIComponent(f.name) : '/backend/api/trunks';
      const r = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ error: 'red' }));
      setSaving(false);
      if (r.error) { toast('Error: ' + r.error, 'bad'); return; }
      if (editing) { toast('Troncal WebRTC actualizada', 'ok'); if (onSaved) onSaved(); onClose(); return; }
      setWr({ link: r.link || ('wss://' + (typeof window !== 'undefined' ? window.location.host : '') + '/ws'), username: r.username || f.username || f.name, password: f.password });
      toast('Troncal WebRTC creada', 'ok'); if (onSaved) onSaved();
      return;
    }
    if (!f.name) { toast('El nombre de la troncal es obligatorio', 'bad'); setSolapa('identidad'); return; }
    if (!f.provider_host) { toast('Falta el host del proveedor', 'bad'); setSolapa('enlace'); return; }
    setSaving(true);
    const url = editing ? '/backend/api/trunks/' + encodeURIComponent(f.name) : '/backend/api/trunks';
    const body = { ...f, provider_port: +f.provider_port || 5060 };
    if (editing && !f.password) delete body.password;
    const r = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ error: 'red' }));
    setSaving(false);
    if (r.error) { toast('Error: ' + r.error, 'bad'); return; }
    toast(editing ? 'Troncal actualizada' : 'Troncal ' + (r.created || f.name) + ' creada', 'ok');
    onClose(); if (onSaved) onSaved();
  }

  const T = TYPES.find((x) => x.value === f.kind) || TYPES[0];

  /* El selector de tipo sólo existe al crear: cambiarle el tipo a una troncal viva sería
   * rehacerla (otro endpoint, otro transporte, otras credenciales). Editando se muestra
   * cuál es, en frío. */
  const selectorTipo = editing ? (
    <Card withBorder radius="md" padding="sm">
      <Group gap="xs" wrap="nowrap">
        {(() => { const I = T.icon; return <ThemeIcon variant="light" radius="md" style={{ color: T.color, background: T.color + '1a' }}><I size={16} /></ThemeIcon>; })()}
        <div style={{ minWidth: 0 }}>
          <Text fw={700} fz="sm" lh={1.15}>{T.label}</Text>
          <Text fz={11} c="dimmed">{T.desc} · el tipo no se cambia después de crearla</Text>
        </div>
      </Group>
    </Card>
  ) : (
    <BloqueNG icon={<IcoTroncal s={16} />} titulo="Tipo de troncal"
      ayuda="Cómo se establece el enlace con el otro extremo. Define el transporte y las credenciales, y no se puede cambiar después.">
      <SimpleGrid cols={2} spacing="sm">
        {TYPES.map((t) => { const I = t.icon; const on = f.kind === t.value; return (
          <Card key={t.value} withBorder radius="md" padding="md" onClick={() => set('kind', t.value)}
            style={{ cursor: 'pointer', transition: 'all .15s', borderColor: on ? t.color : undefined, borderWidth: on ? 2 : 1, background: on ? t.color + '10' : undefined }}>
            <ThemeIcon size={40} radius="md" variant="light" style={{ color: t.color, background: t.color + '1a' }} mb={8}><I size={22} /></ThemeIcon>
            <Text fw={700} fz="sm" lh={1.1}>{t.label}</Text>
            <Text fz={11} c="dimmed" mt={2}>{t.desc}</Text>
          </Card>
        ); })}
      </SimpleGrid>
    </BloqueNG>
  );

  /* ── WebRTC: una sola solapa, porque hay cuatro campos y nada que separar ── */
  const solapaWebrtc = {
    value: 'identidad', label: 'WebRTC', icon: <IconWaveSine size={15} />,
    contenido: (
      <>
        {selectorTipo}
        {wmode === 'client' && <Alert color="orange" variant="light">Troncal WebRTC <b>cliente</b> heredada: el bridge cliente-WSS vivía en el SBC embebido y hoy se administra en SBC-NG. Esta troncal ya no registra desde la central.</Alert>}
        {wmode === 'client' ? (
          <BloqueNG icon={<IcoConexion s={16} />} titulo="Enlace remoto"
            ayuda="PBX-NG se conecta a una troncal WebRTC remota (el enlace WSS que genera la UCM u otra PBX-NG). Hoy ese bridge cliente-WSS es parte de SBC-NG.">
            <Group grow>
              <TextInput label="Nombre" leftSection={<IconTag size={15} />} placeholder="webrtc-out-ies" value={f.name} onChange={(e) => set('name', e.target.value)} disabled={editing} required />
              <TextInput label="Usuario (remoto)" leftSection={<IconUser size={15} />} value={f.username} onChange={(e) => set('username', e.target.value)} required />
            </Group>
            <TextInput label="URL WSS remota" leftSection={<IconWorld size={15} />} placeholder="wss://peer.dominio/ws" value={f.remote_url || ''} onChange={(e) => set('remote_url', e.target.value)} required description="El enlace WSS que te dio el otro extremo (UCM, PBX-NG, etc.)" />
            <PasswordInput label="Contraseña (remoto)" leftSection={<IconLock size={15} />} value={f.password} onChange={(e) => set('password', e.target.value)} required={!editing} placeholder={editing ? '(sin cambios)' : ''} />
            <DiagBlock f={f} wmode={wmode} />
          </BloqueNG>
        ) : (!wr ? (
          <BloqueNG icon={<IcoLlave s={16} />} titulo="Credenciales del enlace"
            ayuda="Troncal WebRTC estándar (SIP sobre WSS + DTLS-SRTP). El extremo remoto se conecta a tu enlace WSS con estas credenciales; Asterisk termina el DTLS-SRTP y hace el puente al resto de la central.">
            <Group grow>
              <TextInput label="Nombre" leftSection={<IconTag size={15} />} placeholder="webrtc-ies" value={f.name} onChange={(e) => set('name', e.target.value)} disabled={editing} required />
              <TextInput label="Usuario" leftSection={<IconUser size={15} />} placeholder="(por defecto = nombre)" value={f.username} onChange={(e) => set('username', e.target.value)} />
            </Group>
            <PasswordInput label="Contraseña" leftSection={<IconLock size={15} />} value={f.password} onChange={(e) => set('password', e.target.value)} required={!editing} placeholder={editing ? '(sin cambios)' : ''} description="La usa el extremo remoto para registrarse por WSS" />
            <TextInput label="Nota / Caller ID (opcional)" leftSection={<IconUser size={15} />} value={f.callerid} onChange={(e) => set('callerid', e.target.value)} />
          </BloqueNG>
        ) : (
          <BloqueNG icon={<IconCheck size={16} />} titulo="Troncal WebRTC lista"
            ayuda="Pegá estos tres datos en el otro extremo. Es SIP-over-WSS (RFC 7118) + DTLS-SRTP: compatible con Grandstream, navegadores y otra PBX-NG. El estado pasa a «conectada» cuando el remoto se registra.">
            <CopyField label="Enlace WSS (servidor SIP)" value={wr.link} />
            <Group grow>
              <CopyField label="Usuario" value={wr.username} />
              <CopyField label="Contraseña" value={wr.password} />
            </Group>
          </BloqueNG>
        ))}
      </>
    ),
  };

  /* ── SIP directa: cinco solapas, una por pregunta ─────────────────────── */
  const solapasSip = [
    {
      value: 'identidad', label: 'Identidad', icon: <IconTag size={15} />,
      contenido: (
        <>
          {selectorTipo}
          <BloqueNG icon={<IconTag size={16} />} titulo="Quién es esta troncal"
            ayuda="El nombre identifica la troncal en todo el sistema (rutas, reportes, topología). El Caller ID es lo que ve el destino cuando salís por acá.">
            <Group grow>
              <TextInput label="Nombre" leftSection={<IconTag size={15} />} placeholder="proveedor-1" value={f.name} onChange={(e) => set('name', e.target.value)} required disabled={editing} description={editing ? 'No se puede cambiar' : 'Identificador único'} />
              <TextInput label="Caller ID saliente" leftSection={<IconUser size={15} />} placeholder='"Empresa" <099...>' value={f.callerid} onChange={(e) => set('callerid', e.target.value)} description="Lo que verá el destino" />
            </Group>
          </BloqueNG>
          <BloqueNG icon={<IconPhoto size={16} />} titulo="Logo del proveedor"
            ayuda="Se muestra en el diagrama de topología. PNG, JPG o SVG; se reduce a 128 px automáticamente.">
            <Group gap="md" align="center" wrap="nowrap">
              <div style={{ width: 56, height: 56, borderRadius: 12, border: '1px dashed var(--mantine-color-default-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--mantine-color-default-hover)', overflow: 'hidden', flex: 'none' }}>{f.logo ? <img src={f.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 4 }} /> : <IconPhoto size={22} style={{ opacity: .4 }} />}</div>
              <Group gap="xs">
                <FileButton onChange={onLogo} accept="image/png,image/jpeg,image/svg+xml">{(props) => <Button {...props} size="xs" variant="light" leftSection={<IconPhoto size={14} />}>Subir logo</Button>}</FileButton>
                {f.logo && <Button size="xs" variant="subtle" color="red" onClick={() => set('logo', '')}>Quitar</Button>}
              </Group>
            </Group>
          </BloqueNG>
        </>
      ),
    },
    {
      value: 'enlace', label: 'Enlace', icon: <IcoConexion s={15} />,
      contenido: (
        <>
          <BloqueNG icon={<IcoConexion s={16} />} titulo="Cómo se conecta"
            ayuda="En modo Registro la central se anuncia al operador con usuario y clave (lo más común). En modo IP el operador te reconoce por dirección y la central no se registra.">
            <SegmentedControl fullWidth value={f.mode} onChange={(v) => set('mode', v)} data={[{ value: 'register', label: 'Registro (usuario/clave)' }, { value: 'ip', label: 'IP / Peer (sin registro)' }]} />
            <Text size="xs" c="dimmed">{f.mode === 'ip' ? 'El operador autentica por IP; la PBX no se registra.' : 'La PBX se registra con usuario y contraseña (lo más común).'}</Text>
            <Group grow>
              <TextInput label="Host del proveedor" leftSection={<IconWorld size={15} />} placeholder="sip.proveedor.com" value={f.provider_host} onChange={(e) => set('provider_host', e.target.value)} required />
              <TextInput label="Puerto" leftSection={<IconHash size={15} />} value={f.provider_port} onChange={(e) => set('provider_port', e.target.value)} w={110} />
              <Select label="Transporte" value={f.transport} onChange={(v) => set('transport', v)} data={[{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }, { value: 'tls', label: 'TLS (cifrado)' }]} w={150} leftSection={<IconPlugConnected size={15} />} />
            </Group>
          </BloqueNG>
          <DiagBlock f={f} wmode={wmode} />
        </>
      ),
    },
    {
      value: 'auth', label: 'Credenciales', icon: <IcoLlave s={15} />,
      contenido: (
        <>
          <BloqueNG icon={<IcoLlave s={16} />} titulo="Usuario y contraseña SIP"
            ayuda={editing ? 'La contraseña no se muestra nunca. Dejala vacía para no cambiarla.' : 'Las credenciales que te dio el operador para registrar la troncal.'}>
            <Group grow>
              <TextInput label="Usuario" leftSection={<IconUser size={15} />} value={f.username} onChange={(e) => set('username', e.target.value)} description={f.mode === 'ip' ? 'Opcional en modo IP' : 'Usuario SIP del operador'} />
              <PasswordInput label="Contraseña" leftSection={<IconLock size={15} />} placeholder={editing ? '(sin cambios)' : ''} value={f.password} onChange={(e) => set('password', e.target.value)} description={editing ? 'Dejar vacío para no cambiarla' : 'Clave SIP del operador'} />
            </Group>
          </BloqueNG>
          <BloqueNG icon={<IconKey size={16} />} titulo="Identidad en el From"
            ayuda="Sólo si el operador exige un From distinto del usuario o del host. Si no te lo pidieron, dejalo vacío: los valores por defecto son los correctos.">
            <Group grow>
              <TextInput label="From user" leftSection={<IconKey size={15} />} placeholder="(usuario)" value={f.from_user} onChange={(e) => set('from_user', e.target.value)} />
              <TextInput label="From domain" leftSection={<IconWorld size={15} />} placeholder="(host del proveedor)" value={f.from_domain} onChange={(e) => set('from_domain', e.target.value)} />
            </Group>
          </BloqueNG>
        </>
      ),
    },
    {
      value: 'medios', label: 'Medios', icon: <IconWaveSine size={15} />,
      contenido: (
        <>
          <BloqueNG icon={<IconWaveSine size={16} />} titulo="Códecs y tonos"
            ayuda="Los códecs se ofrecen al operador en este orden. ulaw/alaw son los seguros; opus y g722 dan mejor calidad si el operador los acepta.">
            <MultiSelect label="Códecs permitidos (en orden de prioridad)" data={CODECS} value={f.codecs} onChange={(v) => set('codecs', v)} leftSection={<IconWaveSine size={15} />} clearable={false} />
            <Group grow>
              <Select label="DTMF" value={f.dtmf_mode} onChange={(v) => set('dtmf_mode', v)} data={[{ value: 'rfc4733', label: 'RFC 4733 (recomendado)' }, { value: 'inband', label: 'Inband' }, { value: 'info', label: 'SIP INFO' }, { value: 'auto', label: 'Auto' }]} leftSection={<IconBroadcast size={15} />} description="Cómo se envían los tonos del teclado" />
              <NumberInput label="Qualify (s)" value={f.qualify_frequency} onChange={(v) => set('qualify_frequency', v)} min={0} max={300} description="Keepalive al proveedor" />
            </Group>
          </BloqueNG>
          <BloqueNG icon={<IconPlugConnected size={16} />} titulo="NAT y camino del audio"
            ayuda="Con la central detrás de un router, «symmetric RTP» es lo que hace que el audio vuelva por donde salió. Direct media saca a la central del medio: más eficiente, pero rara vez funciona con NAT."><Group gap="xl">
              <Switch label="Detrás de NAT (symmetric RTP)" checked={f.nat} onChange={(e) => set('nat', e.currentTarget.checked)} />
              <Switch label="Direct media (RTP directo)" checked={f.direct_media} onChange={(e) => set('direct_media', e.currentTarget.checked)} />
            </Group>
          </BloqueNG>
        </>
      ),
    },
    {
      value: 'numeros', label: 'Números', icon: <IconDeviceLandlinePhone size={15} />,
      contenido: (
        <>
          <BloqueNG icon={<IconDeviceLandlinePhone size={16} />} titulo="Números entrantes"
            ayuda="Los DID que entrega esta troncal y dónde caen las llamadas que llegan por ella.">
            <Group grow align="flex-start">
              <TagsInput label="Números del proveedor (DID)" placeholder="Escribí y Enter" value={f.dids} onChange={(v) => set('dids', v)} leftSection={<IconDeviceLandlinePhone size={15} />} />
              <NumberInput label="Canales (capacidad)" value={f.channels} onChange={(v) => set('channels', v)} min={0} max={1000} description="Llamadas simultáneas" w={190} />
            </Group>
            <Group grow>
              <TextInput label="Contexto entrante" value={f.context} onChange={(e) => set('context', e.target.value)} description="Dónde caen las entrantes" />
              {f.mode === 'register' && <NumberInput label="Expiración registro (s)" value={f.expiration} onChange={(v) => set('expiration', v)} min={60} max={7200} />}
            </Group>
          </BloqueNG>
          <BloqueNG icon={<IconHash size={16} />} titulo="Ruta de salida"
            ayuda="Crea la regla que manda las salientes por esta troncal. El prefijo es lo que se marca para elegirla; «quitar dígitos» lo saca antes de enviar el número al operador.">
            <Switch label="Crear ruta de salida automática" checked={f.outbound_enabled} onChange={(e) => set('outbound_enabled', e.currentTarget.checked)} />
            {f.outbound_enabled && <Group grow>
              <TextInput label="Prefijo de salida" value={f.outbound_prefix} onChange={(e) => set('outbound_prefix', e.target.value)} placeholder="0" description="Prefijo + número (vacío = cualquiera)" />
              <NumberInput label="Quitar dígitos" value={f.outbound_strip} onChange={(v) => set('outbound_strip', v)} min={0} max={10} description="Dígitos a quitar antes de enviar" />
            </Group>}
          </BloqueNG>
          <DiagBlock f={f} wmode={wmode} />
        </>
      ),
    },
  ];

  const esWebrtc = f.kind === 'webrtc';
  const up = !!(vivo && vivo.status === 'online');

  return (
    <DrawerNG
      opened={opened} onClose={onClose} ancho={680}
      color={esWebrtc ? 'teal' : 'pbx'}
      icono={<IcoTroncal s={24} vivo={up} />}
      titulo={editing ? 'Troncal ' + initialName : 'Nueva troncal'}
      subtitulo={editing
        ? (esWebrtc ? 'SIP sobre WSS + DTLS-SRTP' : ((f.provider_host || 'sin host') + ':' + (f.provider_port || '5060') + ' · ' + String(f.transport || 'udp').toUpperCase()))
        : 'Enlace con tu operador SIP o con otra central'}
      estado={editing ? <EstadoTroncal t={vivo} /> : null}
      solapa={solapa} onSolapa={setSolapa}
      solapas={esWebrtc ? [solapaWebrtc] : solapasSip}
      pie={
        <Group justify="space-between">
          <Button variant="subtle" color="gray" onClick={onClose}>{wr ? 'Cerrar' : 'Cancelar'}</Button>
          {wr
            ? <Button onClick={onClose} color="teal" leftSection={<IconCheck size={16} />}>Listo</Button>
            : <Button onClick={save} loading={saving} leftSection={editing ? <IconPencil size={16} /> : <IconPlus size={16} />}>
              {editing ? 'Guardar cambios' : (esWebrtc ? 'Crear troncal WebRTC' : 'Crear troncal')}
            </Button>}
        </Group>
      }
    />
  );
}
