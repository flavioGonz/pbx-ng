'use client';
/* ============================================================================
 *  Certificados TLS — Let's Encrypt (ACME) sin proxy adelante.
 *
 *  La central puede tener su propio certificado válido (panel HTTPS, WSS del
 *  softphone, SIP/TLS) aunque no haya un proxy inverso adelante. Dos formas de
 *  validar el dominio, elegibles según la red:
 *   · HTTP-01 → Let's Encrypt pega al puerto 80 de este equipo (caso sin proxy).
 *   · DNS-01  → se crea un registro TXT vía la API del DNS (sirve detrás de NAT).
 *  Sólo administradores.
 * ==========================================================================*/
import { useState, useEffect } from 'react';
import {
  Card, Group, Text, Badge, Stack, Button, TextInput, PasswordInput, Select,
  SegmentedControl, ThemeIcon, Alert, Divider, RingProgress, Code, Collapse, Loader, Title,
} from '@mantine/core';
import {
  IconCertificate, IconWorldWww, IconServer, IconMail, IconRefresh, IconRosetteDiscountCheck,
  IconInfoCircle, IconShieldLock, IconAlertTriangle, IconTerminal2, IconDeviceFloppy, IconWorldBolt,
} from '@tabler/icons-react';
import { toast } from '../notify';

const fmtFecha = (t) => t ? new Date(t).toLocaleDateString('es-UY', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';

function saludCert(dias) {
  if (dias === null || dias === undefined) return { color: 'gray', label: '—', pct: 0 };
  if (dias <= 0) return { color: 'red', label: 'Vencido', pct: 100 };
  if (dias <= 10) return { color: 'red', label: `${dias} días`, pct: Math.min(100, (90 - dias) / 90 * 100) };
  if (dias <= 25) return { color: 'orange', label: `${dias} días`, pct: (90 - dias) / 90 * 100 };
  return { color: 'teal', label: `${dias} días`, pct: (90 - dias) / 90 * 100 };
}

async function jget(url, opts) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (_) { d = { error: t }; }
  if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
  return d;
}

export default function Certificados() {
  const [cargando, setCargando] = useState(true);
  const [denegado, setDenegado] = useState(false);
  const [cert, setCert] = useState(null);
  const [f, setF] = useState({ domain: '', email: '', method: 'http', dns_provider: '', dns_creds: {} });
  const [provs, setProvs] = useState([]);
  const [tieneCreds, setTieneCreds] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  const [log, setLog] = useState('');
  const [verLog, setVerLog] = useState(false);

  async function cargar() {
    try {
      const d = await jget('/backend/api/acme');
      const c = d.config || {};
      setF((prev) => ({ ...prev, domain: c.domain || '', email: c.email || '', method: c.method || 'http', dns_provider: c.dns_provider || '' }));
      setProvs(c.proveedores || []);
      setTieneCreds(!!c.tiene_dns_creds);
      setCert(d.cert || { emitido: false });
    } catch (e) {
      if (String(e.message).includes('administrador') || String(e.message).includes('403')) setDenegado(true);
      else toast(e.message, 'bad');
    } finally { setCargando(false); }
  }
  useEffect(() => { cargar(); }, []);

  const provActual = provs.find((p) => p.id === f.dns_provider);

  async function guardar() {
    if (!f.domain.trim()) return toast('Ingresá el dominio (ej: pbx.tuempresa.com).', 'bad');
    if (!f.email.trim()) return toast('Ingresá el email de la cuenta ACME.', 'bad');
    setGuardando(true);
    try {
      const creds = {};
      if (f.method === 'dns' && provActual) for (const v of provActual.vars) if (f.dns_creds[v]) creds[v] = f.dns_creds[v];
      await jget('/backend/api/acme/config', { method: 'POST', body: JSON.stringify({
        domain: f.domain.trim(), email: f.email.trim(), method: f.method,
        dns_provider: f.dns_provider, ...(Object.keys(creds).length ? { dns_creds: creds } : {}),
      }) });
      toast('Configuración guardada.', 'ok');
      await cargar();
    } catch (e) { toast(e.message, 'bad'); }
    finally { setGuardando(false); }
  }

  async function emitir(renovar) {
    setEmitiendo(true); setLog(''); setVerLog(false);
    try {
      const r = await jget(renovar ? '/backend/api/acme/renew' : '/backend/api/acme/issue', { method: 'POST' });
      if (r.salida) { setLog(r.salida); setVerLog(!r.ok); }
      if (r.ok) toast(renovar ? 'Certificado renovado.' : 'Certificado emitido correctamente.', 'ok');
      else { toast(r.error || 'No se pudo emitir el certificado.', 'bad'); setVerLog(true); }
      await cargar();
    } catch (e) { toast(e.message, 'bad'); }
    finally { setEmitiendo(false); }
  }

  const Header = () => (
    <div className="pbx-pagehead">
      <span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-teal-5),var(--mantine-color-teal-8))' }} />
      <ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'teal.5', to: 'teal.8', deg: 135 }}><IconCertificate size={24} /></ThemeIcon>
      <div><Title order={2} lh={1.1}>Certificados TLS</Title><Text c="dimmed" size="sm">Let&apos;s Encrypt · sin proxy</Text></div>
    </div>
  );

  if (denegado) {
    return (
      <Stack gap="lg"><Header />
        <Alert color="orange" icon={<IconShieldLock size={18} />} title="Sólo administradores">
          La gestión de certificados está reservada a usuarios con rol administrador.
        </Alert>
      </Stack>
    );
  }

  const salud = saludCert(cert && cert.dias_restantes);

  return (
    <Stack gap="lg">
      <Header />
      {cargando ? <Group justify="center" py="xl"><Loader /></Group> : (<>
        <Card withBorder radius="lg" p="lg" shadow="sm">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Group gap="md" wrap="nowrap">
              <RingProgress size={92} thickness={9} roundCaps
                sections={[{ value: cert && cert.emitido ? salud.pct : 0, color: salud.color }]}
                label={<Group justify="center">
                  <ThemeIcon size={40} radius="xl" variant="light" color={cert && cert.emitido ? salud.color : 'gray'}>
                    {cert && cert.emitido ? <IconRosetteDiscountCheck size={24} /> : <IconCertificate size={22} />}
                  </ThemeIcon>
                </Group>} />
              <div>
                <Text fw={700} size="lg">{cert && cert.emitido ? (cert.cn || f.domain || 'Certificado activo') : 'Sin certificado'}</Text>
                {cert && cert.emitido ? (
                  <Group gap={8} mt={4}>
                    <Badge variant="light" color={salud.color} size="lg" leftSection={<IconShieldLock size={13} />}>{salud.label}</Badge>
                    <Text size="sm" c="dimmed">vence el {fmtFecha(cert.vence)}</Text>
                  </Group>
                ) : (
                  <Text size="sm" c="dimmed" mt={4} maw={460}>Todavía no emitiste un certificado. Configurá el dominio abajo y presioná <b>Emitir certificado</b>.</Text>
                )}
              </div>
            </Group>
            {cert && cert.emitido && (
              <Button variant="light" leftSection={<IconRefresh size={16} />} loading={emitiendo} onClick={() => emitir(true)}>Renovar ahora</Button>
            )}
          </Group>
        </Card>

        <Card withBorder radius="lg" p="lg" shadow="sm">
          <Text fw={700} mb={4}>Configuración</Text>
          <Text size="sm" c="dimmed" mb="md">El dominio tiene que apuntar (DNS) a la IP pública de esta central.</Text>
          <Group grow align="flex-start">
            <TextInput label="Dominio" placeholder="pbx.tuempresa.com" leftSection={<IconWorldWww size={16} />}
              value={f.domain} onChange={(e) => setF({ ...f, domain: e.currentTarget.value })} />
            <TextInput label="Email de la cuenta ACME" placeholder="ti@tuempresa.com" leftSection={<IconMail size={16} />}
              value={f.email} onChange={(e) => setF({ ...f, email: e.currentTarget.value })}
              description="Let's Encrypt lo usa para avisarte si un cert está por vencer." />
          </Group>

          <Text size="sm" fw={600} mt="lg" mb={6}>Cómo probamos que el dominio es tuyo</Text>
          <SegmentedControl fullWidth value={f.method} onChange={(v) => setF({ ...f, method: v })}
            data={[
              { value: 'http', label: (<Group gap={6} justify="center" wrap="nowrap"><IconWorldBolt size={15} /><span>HTTP-01 (puerto 80)</span></Group>) },
              { value: 'dns', label: (<Group gap={6} justify="center" wrap="nowrap"><IconServer size={15} /><span>DNS-01 (API del DNS)</span></Group>) },
            ]} />

          {f.method === 'http' ? (
            <Alert mt="md" color="blue" variant="light" icon={<IconInfoCircle size={18} />} title="HTTP-01 · el caso sin proxy">
              Let&apos;s Encrypt va a pegar a <Code>http://{f.domain || 'tu-dominio'}/.well-known/acme-challenge/…</Code> en el
              puerto <b>80</b>. Ese puerto tiene que llegar a esta central (sin un proxy ni otro servicio ocupándolo).
            </Alert>
          ) : (
            <Stack gap="sm" mt="md">
              <Alert color="grape" variant="light" icon={<IconInfoCircle size={18} />} title="DNS-01 · detrás de NAT o proxy">
                La central crea un registro TXT en tu DNS por la API del proveedor. No necesita el puerto 80. Cargá las
                credenciales; se guardan en el equipo y sólo se usan al emitir.
              </Alert>
              <Select label="Proveedor de DNS" placeholder="Elegí tu proveedor" leftSection={<IconServer size={16} />}
                value={f.dns_provider} onChange={(v) => setF({ ...f, dns_provider: v || '', dns_creds: {} })}
                data={provs.map((p) => ({ value: p.id, label: p.label }))} />
              {provActual && (
                <Group grow align="flex-start">
                  {provActual.vars.map((v) => (
                    <PasswordInput key={v} label={v} placeholder={tieneCreds ? '•••••••• (guardada)' : v}
                      value={f.dns_creds[v] || ''} onChange={(e) => setF({ ...f, dns_creds: { ...f.dns_creds, [v]: e.currentTarget.value } })} />
                  ))}
                </Group>
              )}
            </Stack>
          )}

          <Divider my="lg" />
          <Group justify="space-between">
            <Button variant="default" leftSection={<IconDeviceFloppy size={16} />} loading={guardando} onClick={guardar}>Guardar configuración</Button>
            <Button color="teal" leftSection={<IconCertificate size={16} />} loading={emitiendo} onClick={() => emitir(false)}>
              {cert && cert.emitido ? 'Re-emitir certificado' : 'Emitir certificado'}
            </Button>
          </Group>

          {log && (<>
            <Button variant="subtle" size="xs" mt="md" leftSection={<IconTerminal2 size={14} />} onClick={() => setVerLog((v) => !v)}>
              {verLog ? 'Ocultar' : 'Ver'} salida de acme.sh
            </Button>
            <Collapse in={verLog}>
              <Code block mt="sm" style={{ maxHeight: 260, overflow: 'auto', fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{log}</Code>
            </Collapse>
          </>)}
        </Card>

        <Alert color="gray" variant="light" icon={<IconAlertTriangle size={18} />}>
          El certificado se instala en la central y se <b>renueva solo</b> (una vez al día se revisa si está por vencer).
          Si hay un proxy inverso adelante, lo normal es que el certificado lo maneje el proxy — esta pantalla es para cuando <b>no</b> lo hay.
        </Alert>
      </>)}
    </Stack>
  );
}
