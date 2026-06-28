/* TrunkEditor.jsx - editor de troncal SIP en wizard por pasos (compartido) */
'use client';
import { useEffect, useState } from 'react';
import { Modal, Stepper, Group, Button, Stack, Text, TextInput, PasswordInput, NumberInput, SegmentedControl, Switch, Select, MultiSelect, TagsInput, ThemeIcon, FileButton, Box } from '@mantine/core';
import { IconDeviceLandlinePhone, IconTag, IconUser, IconWorld, IconHash, IconLock, IconKey, IconPlugConnected, IconWaveSine, IconBroadcast, IconRouteAltLeft, IconPhoto, IconCloud, IconServer2, IconCheck } from '@tabler/icons-react';
import { toast } from './notify';

const CODECS = ['ulaw', 'alaw', 'g722', 'g729', 'opus', 'gsm'];
export const trunkBlank = {
  name: '', kind: 'asterisk', callerid: '', mode: 'register',
  provider_host: '', provider_port: '5060', transport: 'udp',
  username: '', password: '', from_user: '', from_domain: '',
  codecs: ['ulaw', 'alaw'], dtmf_mode: 'rfc4733', nat: true, direct_media: false,
  qualify_frequency: 60, expiration: 3600, retry_interval: 60, context: 'from-trunk',
  outbound_enabled: true, outbound_prefix: '0', outbound_strip: 0, logo: '', dids: [], channels: 0, gateway: '',
};

export default function TrunkEditor({ opened, onClose, initialName, defaultKind, onSaved }) {
  const [f, setF] = useState(trunkBlank);
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const [gwOpts, setGwOpts] = useState([]);
  const editing = !!initialName;
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!opened) return;
    setActive(0);
    fetch('/backend/api/sbc/routes').then((r) => r.json()).then((d) => Array.isArray(d) && setGwOpts(d.map((r) => ({ value: String(r.id), label: (r.note || r.dest) + ' (via ' + (r.gw || r.dev) + ')' })))).catch(() => {});
    if (initialName) {
      (async () => {
        let adv = {}, kind = defaultKind || 'asterisk';
        try { const d = await fetch('/backend/api/trunks/' + encodeURIComponent(initialName) + '/detail').then((r) => r.json()); adv = d.adv || {}; } catch (_) {}
        try { const list = await fetch('/backend/api/trunks').then((r) => r.json()); const me = Array.isArray(list) && list.find((t) => t.name === initialName); if (me && me.kind) kind = me.kind; } catch (_) {}
        setF({ ...trunkBlank, ...adv, name: initialName, kind, password: '', provider_port: String(adv.provider_port || '5060') });
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
    if (!f.name || !f.provider_host) { toast('Nombre y host del proveedor son obligatorios', 'bad'); setActive(f.name ? 1 : 0); return; }
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

  const gwData = [
    { value: '', label: 'Directa (ruta por defecto del SBC)' },
    { value: 'internet', label: 'Internet (WAN) — el proveedor se alcanza por la nube' },
    ...gwOpts,
  ];
  const STEPS = 5;
  const next = () => setActive((a) => Math.min(STEPS - 1, a + 1));
  const prev = () => setActive((a) => Math.max(0, a - 1));

  return (
    <Modal opened={opened} onClose={onClose} centered radius="lg" size={760}
      title={<Group gap="sm"><ThemeIcon size={38} radius="md" variant="light" color="teal"><IconDeviceLandlinePhone size={20} /></ThemeIcon><div><Text fw={800} lh={1.1}>{editing ? 'Configurar troncal' : 'Nueva troncal'}</Text><Text size="xs" c="dimmed">Enlace con tu operador SIP</Text></div></Group>}>
      <Stepper active={active} onStepClick={setActive} size="sm" iconSize={30} mb="lg">
        <Stepper.Step label="General" description="Nombre y logo" icon={<IconTag size={15} />}>
          <Stack gap="md" mt="md">
            <div>
              <Text size="sm" fw={500} mb={4}>¿Dónde vive la troncal?</Text>
              <SegmentedControl fullWidth value={f.kind} onChange={(v) => set('kind', v)} disabled={editing} data={[{ value: 'asterisk', label: 'Asterisk (directo)' }, { value: 'kamailio', label: 'SBC-NG (borde)' }]} />
              <Text size="xs" c="dimmed" mt={6}>{f.kind === 'kamailio' ? 'El registro y la seguridad de la troncal viven en el SBC (Kamailio).' : 'La troncal se registra directo en Asterisk.'}</Text>
            </div>
            <Group grow>
              <TextInput label="Nombre" leftSection={<IconTag size={15} />} placeholder="proveedor-1" value={f.name} onChange={(e) => set('name', e.target.value)} required disabled={editing} description={editing ? 'No se puede cambiar' : 'Identificador único'} />
              <TextInput label="Caller ID saliente" leftSection={<IconUser size={15} />} placeholder='"Empresa" <099...>' value={f.callerid} onChange={(e) => set('callerid', e.target.value)} description="Lo que verá el destino" />
            </Group>
            <Group gap="md" align="center" wrap="nowrap">
              <div style={{ width: 56, height: 56, borderRadius: 12, border: '1px dashed var(--mantine-color-default-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--mantine-color-default-hover)', overflow: 'hidden', flex: 'none' }}>{f.logo ? <img src={f.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 4 }} /> : <IconPhoto size={22} style={{ opacity: .4 }} />}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={500}>Logo del proveedor (PNG)</Text>
                <Text size="xs" c="dimmed">Se muestra en la topología.</Text>
                <Group gap="xs" mt={6}>
                  <FileButton onChange={onLogo} accept="image/png,image/jpeg,image/svg+xml">{(props) => <Button {...props} size="xs" variant="light" leftSection={<IconPhoto size={14} />}>Subir logo</Button>}</FileButton>
                  {f.logo && <Button size="xs" variant="subtle" color="red" onClick={() => set('logo', '')}>Quitar</Button>}
                </Group>
              </div>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="Conexión" description="Host y ruta" icon={<IconPlugConnected size={15} />}>
          <Stack gap="md" mt="md">
            <div>
              <Text size="sm" fw={500} mb={4}>Modo de la troncal</Text>
              <SegmentedControl fullWidth value={f.mode} onChange={(v) => set('mode', v)} data={[{ value: 'register', label: 'Registro (usuario/clave)' }, { value: 'ip', label: 'IP / Peer (sin registro)' }]} />
              <Text size="xs" c="dimmed" mt={6}>{f.mode === 'ip' ? 'El operador autentica por IP; la PBX no se registra.' : 'La PBX se registra con usuario y contraseña (lo más común).'}</Text>
            </div>
            <Group grow>
              <TextInput label="Host del proveedor" leftSection={<IconWorld size={15} />} placeholder="sip.proveedor.com" value={f.provider_host} onChange={(e) => set('provider_host', e.target.value)} required />
              <TextInput label="Puerto" leftSection={<IconHash size={15} />} value={f.provider_port} onChange={(e) => set('provider_port', e.target.value)} w={110} />
              <Select label="Transporte" value={f.transport} onChange={(v) => set('transport', v)} data={[{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }, { value: 'tls', label: 'TLS (cifrado)' }]} w={150} leftSection={<IconPlugConnected size={15} />} />
            </Group>
            <Select label="¿Por dónde se llega a esta troncal?" value={f.gateway || ''} onChange={(v) => set('gateway', v || '')} data={gwData} leftSection={f.gateway === 'internet' ? <IconCloud size={15} /> : <IconRouteAltLeft size={15} />} description="Define cómo se dibuja en la topología: directa, por Internet (nube) o por una ruta estática del SBC." />
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="Auth" description="Credenciales" icon={<IconLock size={15} />}>
          <Stack gap="md" mt="md">
            <Group grow>
              <TextInput label="Usuario" leftSection={<IconUser size={15} />} value={f.username} onChange={(e) => set('username', e.target.value)} description={f.mode === 'ip' ? 'Opcional en modo IP' : 'Usuario SIP del operador'} />
              <PasswordInput label="Contraseña" leftSection={<IconLock size={15} />} placeholder={editing ? '(sin cambios)' : ''} value={f.password} onChange={(e) => set('password', e.target.value)} description={editing ? 'Dejar vacío para no cambiarla' : 'Clave SIP del operador'} />
            </Group>
            <Group grow>
              <TextInput label="From user" leftSection={<IconKey size={15} />} placeholder="(usuario)" value={f.from_user} onChange={(e) => set('from_user', e.target.value)} description="Identidad en el From (si el operador lo exige)" />
              <TextInput label="From domain" leftSection={<IconWorld size={15} />} placeholder="(host del proveedor)" value={f.from_domain} onChange={(e) => set('from_domain', e.target.value)} description="Dominio en el From (por defecto, el host del proveedor)" />
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="Medios" description="Códecs y NAT" icon={<IconWaveSine size={15} />}>
          <Stack gap="md" mt="md">
            <MultiSelect label="Códecs permitidos (en orden de prioridad)" data={CODECS} value={f.codecs} onChange={(v) => set('codecs', v)} leftSection={<IconWaveSine size={15} />} clearable={false} description="Formatos de audio que se ofrecen al proveedor" />
            <Group grow>
              <Select label="DTMF" value={f.dtmf_mode} onChange={(v) => set('dtmf_mode', v)} data={[{ value: 'rfc4733', label: 'RFC 4733 (recomendado)' }, { value: 'inband', label: 'Inband' }, { value: 'info', label: 'SIP INFO' }, { value: 'auto', label: 'Auto' }]} leftSection={<IconBroadcast size={15} />} description="Cómo se envían los tonos del teclado" />
              <NumberInput label="Qualify (s)" value={f.qualify_frequency} onChange={(v) => set('qualify_frequency', v)} min={0} max={300} description="Keepalive al proveedor" />
            </Group>
            <Group gap="xl">
              <Switch label="Detrás de NAT (symmetric RTP)" checked={f.nat} onChange={(e) => set('nat', e.currentTarget.checked)} />
              <Switch label="Direct media (RTP directo)" checked={f.direct_media} onChange={(e) => set('direct_media', e.currentTarget.checked)} />
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label="Números" description="DID y salida" icon={<IconDeviceLandlinePhone size={15} />}>
          <Stack gap="md" mt="md">
            <Group grow align="flex-start">
              <TagsInput label="Números del proveedor (DID)" placeholder="Escribí y Enter" value={f.dids} onChange={(v) => set('dids', v)} description="Números fijos que entrega esta troncal" leftSection={<IconDeviceLandlinePhone size={15} />} />
              <NumberInput label="Canales (capacidad)" value={f.channels} onChange={(v) => set('channels', v)} min={0} max={1000} description="Llamadas simultáneas" w={190} />
            </Group>
            <Group grow>
              <TextInput label="Contexto entrante" value={f.context} onChange={(e) => set('context', e.target.value)} description="Dónde caen las entrantes" />
              {f.mode === 'register' && <NumberInput label="Expiración registro (s)" value={f.expiration} onChange={(v) => set('expiration', v)} min={60} max={7200} />}
            </Group>
            <Box>
              <Switch label="Crear ruta de salida automática" checked={f.outbound_enabled} onChange={(e) => set('outbound_enabled', e.currentTarget.checked)} />
              {f.outbound_enabled && <Group grow mt="xs">
                <TextInput label="Prefijo de salida" value={f.outbound_prefix} onChange={(e) => set('outbound_prefix', e.target.value)} placeholder="0" description="Prefijo + número (vacío = cualquiera)" />
                <NumberInput label="Quitar dígitos" value={f.outbound_strip} onChange={(v) => set('outbound_strip', v)} min={0} max={10} description="Dígitos a quitar antes de enviar" />
              </Group>}
            </Box>
          </Stack>
        </Stepper.Step>
      </Stepper>

      <Group justify="space-between" mt="md">
        <Button variant="default" onClick={prev} disabled={active === 0}>Atrás</Button>
        {active < STEPS - 1
          ? <Button onClick={next} color="teal">Siguiente</Button>
          : <Button onClick={save} loading={saving} color="teal" leftSection={<IconCheck size={16} />}>{editing ? 'Guardar cambios' : 'Crear troncal'}</Button>}
      </Group>
    </Modal>
  );
}
