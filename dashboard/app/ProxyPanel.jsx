/* ProxyPanel.jsx - gestion del proxy inverso (Nginx Proxy Manager) + estado TLS */
'use client';
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, TextInput, PasswordInput, Button, ThemeIcon, Badge, Table, Alert, Anchor, Divider, SimpleGrid } from '@mantine/core';
import { IconShieldLock, IconDeviceFloppy, IconPlugConnected, IconRefresh, IconLock, IconExternalLink, IconInfoCircle, IconCertificate } from '@tabler/icons-react';
import { toast } from './notify';

const CERT_ERR = {
  'npm-not-configured': 'Configurá la URL del proxy y guardá.',
  'npm-creds-missing': 'Faltan las credenciales del NPM.',
  'npm-auth-failed': 'No autenticó contra el NPM (revisá usuario/clave/URL).',
  'cert-not-found': 'No hay certificado para el dominio en el NPM.',
  'domain-missing': 'Configurá el dominio de PBX-NG.',
  'host-not-found': 'No hay un host en el NPM para este dominio.',
};

export default function ProxyPanel() {
  const [f, setF] = useState({ npm_url: '', npm_identity: '', domain: '' });
  const [secret, setSecret] = useState(''); const [hasSecret, setHasSecret] = useState(false);
  const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(false);
  const [cert, setCert] = useState(null); const [hosts, setHosts] = useState(null);

  async function loadSettings() {
    try {
      const s = await fetch('/backend/api/settings').then((r) => r.json());
      setF({ npm_url: s.npm_url || '', npm_identity: s.npm_identity || '', domain: s.domain || '' });
      setHasSecret(s.npm_secret === '__SET__');
    } catch (_) {}
  }
  async function loadCert() { try { setCert(await fetch('/backend/api/npm/cert').then((r) => r.json())); } catch (_) { setCert({ error: 'net' }); } }
  async function loadHosts() { try { setHosts(await fetch('/backend/api/npm/hosts').then((r) => r.json())); } catch (_) { setHosts({ error: 'net', items: [] }); } }
  useEffect(() => { loadSettings(); loadCert(); loadHosts(); }, []);

  async function save() {
    setSaving(true);
    const body = { npm_url: f.npm_url.trim(), npm_identity: f.npm_identity.trim(), domain: f.domain.trim() };
    body.npm_secret = secret ? secret : '__SET__'; // __SET__ => el backend conserva el guardado
    const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ error: 1 }));
    setSaving(false);
    if (r.error) { toast('Error al guardar', 'bad'); return; }
    setSecret(''); toast('Proxy guardado', 'ok'); loadSettings();
    await test(true);
  }
  async function test(silent) {
    setTesting(true);
    const r = await fetch('/backend/api/npm/test', { method: 'POST' }).then((x) => x.json()).catch(() => ({ ok: false, error: 'net' }));
    setTesting(false);
    if (r.ok) toast('Conexión OK · ' + (r.hosts || 0) + ' hosts en el proxy', 'ok');
    else if (!silent) toast('Falló: ' + (CERT_ERR[r.error] || r.error || 'error'), 'bad');
    loadCert(); loadHosts();
  }

  const certOk = cert && cert.days_left != null;
  const certColor = certOk ? (cert.days_left < 15 ? 'red' : cert.days_left < 30 ? 'yellow' : 'teal') : 'gray';
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return '—'; } };

  return (
    <Stack gap="md" maw={760}>
      <Card withBorder radius="md" padding="md">
        <Group gap="sm" mb="md"><ThemeIcon size={40} radius="md" variant="light" color="indigo"><IconShieldLock size={20} /></ThemeIcon><div><Text fw={700}>Proxy inverso (Nginx Proxy Manager)</Text><Text size="xs" c="dimmed">Termina TLS/WSS y publica el panel, el softphone WebRTC (/ws) y la señalización. Estas credenciales dejan a PBX-NG leer el estado del certificado y los hosts.</Text></div></Group>
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="URL del NPM" placeholder="http://192.168.99.75:81" value={f.npm_url} onChange={(e) => setF({ ...f, npm_url: e.target.value })} description="Dirección de administración del NPM" />
            <TextInput label="Dominio público" placeholder="pbx01.infratec.com.uy" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} description="Dominio del certificado a monitorear" />
            <TextInput label="Usuario (identity)" placeholder="admin@ejemplo.com" value={f.npm_identity} onChange={(e) => setF({ ...f, npm_identity: e.target.value })} />
            <PasswordInput label="Contraseña" placeholder={hasSecret ? '•••••• (guardada, dejá vacío para mantener)' : 'clave de administración'} value={secret} onChange={(e) => setSecret(e.target.value)} />
          </SimpleGrid>
          <Group>
            <Button onClick={save} loading={saving} leftSection={<IconDeviceFloppy size={16} />} color="indigo">Guardar</Button>
            <Button onClick={() => test(false)} loading={testing} variant="light" leftSection={<IconPlugConnected size={16} />}>Probar conexión</Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="sm">
          <Group gap="sm"><ThemeIcon size={40} radius="md" variant="light" color={certColor}><IconCertificate size={20} /></ThemeIcon><div><Text fw={700}>Certificado TLS</Text><Text size="xs" c="dimmed">{cert && cert.domain ? cert.domain : f.domain || 'dominio no configurado'}</Text></div></Group>
          <Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} onClick={loadCert}>Refrescar</Button>
        </Group>
        {certOk ?
          <Group gap="lg">
            <Badge size="lg" variant="light" color={certColor} leftSection={<IconLock size={13} />}>{cert.days_left} días restantes</Badge>
            <Text size="sm" c="dimmed">Vence el <b>{fmtDate(cert.expires_date)}</b>{cert.provider ? ' · ' + cert.provider : ''}</Text>
          </Group> :
          <Alert variant="light" color="gray" icon={<IconInfoCircle size={18} />}>{(cert && CERT_ERR[cert.error]) || 'Sin datos del certificado. Configurá y probá la conexión.'}</Alert>}
      </Card>

      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="sm">
          <Group gap="sm"><ThemeIcon size={40} radius="md" variant="light" color="blue"><IconExternalLink size={20} /></ThemeIcon><div><Text fw={700}>Host de PBX-NG en el proxy</Text><Text size="xs" c="dimmed">Solo la regla del dominio de PBX-NG (no administra el resto del NPM)</Text></div></Group>
          <Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} onClick={loadHosts}>Refrescar</Button>
        </Group>
        {hosts && hosts.host ?
          <Stack gap="xs">
            <Group gap="xs">
              <Text fw={600}>{(hosts.host.domains || []).join(', ')}</Text>
              {hosts.host.enabled ? <Badge size="sm" variant="light" color="teal">activo</Badge> : <Badge size="sm" variant="light" color="red">deshabilitado</Badge>}
            </Group>
            <Group gap="xs" wrap="wrap">
              <Badge variant="light" color="gray" ff="monospace">→ {hosts.host.forward}</Badge>
              <Badge variant="light" color={hosts.host.ssl ? (hosts.host.ssl_forced ? 'teal' : 'blue') : 'gray'} leftSection={<IconLock size={12} />}>{hosts.host.ssl ? (hosts.host.ssl_forced ? 'TLS forzado' : 'TLS') : 'sin TLS'}</Badge>
              <Badge variant="dot" color={hosts.host.ws ? 'grape' : 'gray'}>{hosts.host.ws ? 'WebSocket ✓' : 'WebSocket ✗'}</Badge>
            </Group>
          </Stack> :
          <Alert variant="light" color="gray" icon={<IconInfoCircle size={18} />}>{(hosts && CERT_ERR[hosts.error]) || 'Sin datos. Guardá las credenciales y el dominio, luego probá la conexión.'}</Alert>}
      </Card>
    </Stack>
  );
}
