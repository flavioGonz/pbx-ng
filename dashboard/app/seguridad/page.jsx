'use client';
/* ============================================================================
 *  Seguridad — la puerta de la central.
 *
 *  Todo lo que golpea el 5060 de Asterisk desde internet pasa por acá: escaneos de
 *  sipvicious, registros a fuerza bruta, INVITEs a números caros. Asterisk canta cada
 *  intento por AMI (SecurityEvent), la API cuenta fallos por IP y banea con nftables
 *  en el host (agente de Asterisk :8092). Esta pantalla muestra a quién frenamos y
 *  permite soltarlo si fue un falso positivo.
 *
 *  Clon funcional y visual del módulo de seguridad del SBC-NG, adaptado: sin helper
 *  ../api (fetch directo como el resto del panel), socket de PBX-NG (sala 'security'),
 *  sin solapa "Motores" (no hay Docker que reiniciar desde acá) y con el estado del
 *  firewall (nftables / agente) visible en el encabezado.
 * ==========================================================================*/
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Card, Group, Text, Badge, Table, Stack, Button, Skeleton, ThemeIcon, TextInput,
  SimpleGrid, Tooltip, Code, Timeline, Tabs, NumberInput, Switch, Alert, Divider,
  Select, ActionIcon, SegmentedControl, Progress, Grid, Box, Anchor, Modal,
} from '@mantine/core';
import {
  IconShieldCheck, IconSearch, IconAlertTriangle, IconBan, IconActivity,
  IconAdjustments, IconDeviceFloppy, IconPlayerPlay, IconWorld,
  IconList, IconPlus, IconTrash, IconRobot, IconCheck, IconFlame,
  IconMapPin, IconLockOff, IconShieldX, IconRadar2, IconWaveSine, IconKey, IconUserOff,
  IconHandStop, IconServer2, IconExternalLink, IconInfoCircle, IconShieldOff, IconLock,
} from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import LiveLog from '../LiveLog';
import AttackGlobe from '../AttackGlobe';
import { TableSkeleton } from '../Skeletons';
import Slot from '../Slot';
import { getSocket } from '../useLive';
import { useAuth } from '../auth';
import { toast, toastPromise } from '../notify';

/* ── Mini capa de API local (el panel no tiene helper común): fetch al mismo origen,
 *    el Bearer lo pone auth.jsx, y un error HTTP se vuelve Error con el `error` del JSON
 *    para que los toasts digan algo útil y no "HTTP 500". ─────────────────────────── */
async function api(path, opts = {}) {
  const r = await fetch('/backend/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (_) { d = { error: txt }; }
  if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
  return d;
}

/* GET con recarga periódica (ms = 0: sólo una vez). El refresco "en vivo" lo dispara
 * además el socket; el intervalo es el reconciliado por si se perdió un evento. */
function usePoll(path, ms = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(true);
  const vivo = useRef(true);
  const recargar = useCallback(async () => {
    try { const d = await api(path); if (vivo.current) { setData(d); setError(null); } }
    catch (e) { if (vivo.current) setError(e); }
    finally { if (vivo.current) setCargando(false); }
  }, [path]);
  useEffect(() => {
    vivo.current = true; setCargando(true); recargar();
    if (!ms) return () => { vivo.current = false; };
    const t = setInterval(recargar, ms);
    return () => { vivo.current = false; clearInterval(t); };
  }, [path, ms, recargar]);
  return { data, error, cargando, recargar };
}

const SkelFilas = ({ filas = 6 }) => (
  <div>{Array.from({ length: filas }).map((_, i) => <Skeleton key={i} h={44} radius="md" mb={8} />)}</div>
);

/* ── Ajustes de la central: los umbrales con los que se defiende ─────────── */
function Ajustes() {
  const { data, cargando, error, recargar } = usePoll('/security/settings', 0);
  const [s, setS] = useState(null);
  const [sucio, setSucio] = useState(false);
  useEffect(() => { if (data && !sucio) setS(data); }, [data, sucio]);
  if (error && !s) return <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>No se pudieron leer los ajustes: {error.message}</Alert>;
  // `s` se llena en el useEffect, o sea después del render en que `cargando` se apaga.
  if (cargando || !s) return <SkelFilas filas={6} />;

  const set = (k, v) => { setSucio(true); setS((x) => ({ ...x, [k]: v })); };

  const guardar = () => toastPromise(
    api('/security/settings', { method: 'PUT', body: s }).then(() => { setSucio(false); recargar(); }),
    { loading: 'Guardando…', success: 'Guardado. Los límites de PJSIP entran al aplicar.', error: (e) => e.message });
  const aplicar = () => toastPromise(
    api('/security/apply', { method: 'POST' }).then(recargar),
    { loading: 'Recargando PJSIP…', success: 'Umbrales aplicados', error: (e) => e.message });

  return (
    <Card p="lg" className="pbx-tabin">
      <Group justify="space-between" mb="md">
        <div>
          <Text fw={700}>Defensa de la central</Text>
          <Text size="sm" c="dimmed">Qué tiene que hacer alguien para que lo bloqueemos, y por cuánto tiempo.</Text>
        </div>
        <Group gap="sm">
          <Button variant="default" leftSection={<IconDeviceFloppy size={16} />} onClick={guardar} disabled={!sucio}>Guardar</Button>
          <Button color="orange" leftSection={<IconPlayerPlay size={16} />} onClick={aplicar}>Aplicar</Button>
        </Group>
      </Group>

      {/* Sólo los umbrales que la API y Asterisk REALMENTE usan. Si un control no mueve
          nada abajo, no va en la pantalla. */}
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: '.04em' }}>Bloqueo por IP (nftables)</Text>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        <NumberInput label="Fallos permitidos" description="Claves erradas o cuentas inexistentes que tolera una IP…" min={1}
                     value={s.max_fallos} onChange={(v) => set('max_fallos', v)} />
        <NumberInput label="…en esta ventana (s)" description="…antes de bloquearla en el firewall del host" min={1}
                     value={s.ventana_s} onChange={(v) => set('ventana_s', v)} />
        <NumberInput label="Duración del bloqueo (s)" description="Cuánto queda afuera. 3600 = una hora." min={60}
                     value={s.ban_s} onChange={(v) => set('ban_s', v)} />
        <NumberInput label="Permanente tras N bloqueos" description="Bloqueos en 24 h que vuelven permanente el siguiente. 0 = nunca." min={0}
                     value={s.ban_permanente_tras} onChange={(v) => set('ban_permanente_tras', v)} />
      </SimpleGrid>

      <Divider my="md" />

      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: '.04em' }}>Pedidos sin identificar (PJSIP)</Text>
      <Text size="xs" c="dimmed" mb="sm">
        Asterisk corta por su cuenta a quien manda pedidos que no matchean ningún endpoint (típico de un escáner probando
        extensiones). Van a <Code>pjsip-security.conf</Code> como <Code>unidentified_request_*</Code>; se toman al aplicar.
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        <NumberInput label="Pedidos sin identificar" description="Cuántos tolera Asterisk de una misma IP…" min={1}
                     value={s.unidentified_count} onChange={(v) => set('unidentified_count', v)} />
        <NumberInput label="…en este período (s)" description="…antes de ignorarla como atacante" min={1}
                     value={s.unidentified_period} onChange={(v) => set('unidentified_period', v)} />
        <NumberInput label="Limpieza (s)" description="Cada cuánto olvida a las IPs que dejaron de insistir" min={1}
                     value={s.unidentified_prune} onChange={(v) => set('unidentified_prune', v)} />
      </SimpleGrid>

      <Divider my="md" />

      <Stack gap="sm">
        <Switch label="Bloquear escáneres a la primera" checked={!!s.escaneres}
                onChange={(e) => set('escaneres', e.currentTarget.checked)}
                description="Quien prueba cuentas inexistentes en serie (sipvicious, friendly-scanner y compañía) se bloquea sin esperar a que llene la ventana de fallos. Saca el 90 % del ruido de fondo de internet." />
        <Switch label="Avisar por correo" checked={!!s.alertar} onChange={(e) => set('alertar', e.currentTarget.checked)}
                description="Manda un correo por cada bloqueo y cuando se detecta un ataque en curso (usa las alertas configuradas en Configuración → Alertas)." />
      </Stack>

      <Alert variant="light" color="pbx" radius="md" mt="md" icon={<IconInfoCircle size={16} />}>
        Aplicar recarga PJSIP sin cortar llamadas: los umbrales de bloqueo por IP entran al guardar; los de pedidos sin
        identificar, al aplicar.
      </Alert>
    </Card>
  );
}

/* ── Listas: al que ya conocemos ───────────────────────────────────────────────
 *
 *  El contador de fallos frena al que INSISTE (muchos intentos en pocos segundos).
 *  La lista NEGRA frena al que ya conocemos, en el firewall del host y sin vencimiento:
 *  no necesita que el atacante haga ruido. La lista BLANCA gana siempre: es la válvula
 *  de escape para cuando un teléfono real (una sucursal, un proveedor) quedó del lado
 *  equivocado de una regla.
 * ==========================================================================*/
function Listas({ soc, recargarSoc, admin }) {
  const { data, cargando, error, recargar } = usePoll('/security/whitelist', 0);
  const [ip, setIp] = useState('');
  const [nota, setNota] = useState('');
  const [lista, setLista] = useState('negra');

  if (error && !data) return <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>No se pudo leer la lista blanca: {error.message}</Alert>;
  if (cargando) return <SkelFilas filas={6} />;
  const blancas = data || [];
  const negras = ((soc && soc.bloqueos) || []).filter((b) => b.permanent);

  const agregar = () => {
    const v = ip.trim();
    if (!v) { toast('Falta la IP', 'warn'); return; }
    if (lista === 'blanca') {
      return toastPromise(
        api('/security/whitelist', { method: 'POST', body: { ip: v, note: nota.trim() || undefined } })
          .then(() => { setIp(''); setNota(''); recargar(); recargarSoc(); }),
        { loading: 'Agregando…', success: `${v} con pase libre`, error: (e) => e.message });
    }
    return toastPromise(
      api('/security/block', { method: 'POST', body: { ip: v, permanent: true, reason: nota.trim() || 'lista negra (manual)' } })
        .then(() => { setIp(''); setNota(''); recargarSoc(); }),
      { loading: 'Bloqueando…', success: `${v} bloqueada en el firewall`, error: (e) => e.message });
  };

  const sacarBlanca = (v) => toastPromise(
    // La IP va en la query y no en el body: un DELETE con body lo pierden algunos proxies,
    // y en la ruta (/whitelist/:ip) un CIDR con barra no entra.
    api('/security/whitelist?ip=' + encodeURIComponent(v), { method: 'DELETE' }).then(() => { recargar(); recargarSoc(); }),
    { loading: 'Sacando…', success: `${v} vuelve a estar sujeta a bloqueo`, error: (e) => e.message });
  const sacarNegra = (v) => toastPromise(
    api('/security/unblock', { method: 'POST', body: { ip: v } }).then(recargarSoc),
    { loading: 'Soltando…', success: `${v} desbloqueada`, error: (e) => e.message });

  const tabla = (fs, vacio, onSacar, campo) => (
    <Table highlightOnHover verticalSpacing="xs" fz="sm">
      <Table.Thead>
        <Table.Tr><Table.Th w={170}>IP / red</Table.Th><Table.Th>{campo}</Table.Th>{admin && <Table.Th w={50} />}</Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {fs.map((f) => (
          <Table.Tr key={f.ip}>
            <Table.Td><Code fz="11px">{f.ip}</Code></Table.Td>
            <Table.Td><Text fz="xs" c="dimmed" truncate maw={260}>{f.note || f.reason || '—'}{f.country ? ` · ${f.country}` : ''}</Text></Table.Td>
            {admin && (
              <Table.Td>
                <ActionIcon variant="subtle" color="red" onClick={() => onSacar(f.ip)}><IconTrash size={15} /></ActionIcon>
              </Table.Td>
            )}
          </Table.Tr>
        ))}
        {fs.length === 0 && (
          <Table.Tr><Table.Td colSpan={3}><Text size="sm" c="dimmed" ta="center" py="md">{vacio}</Text></Table.Td></Table.Tr>
        )}
      </Table.Tbody>
    </Table>
  );

  return (
    <Stack gap="lg">
      <Alert variant="light" color="pbx" radius="lg" icon={<IconRobot size={18} />}>
        La lista negra se aplica <b>en el firewall del host</b> (nftables), antes de que Asterisk procese nada: es la
        defensa más barata que tiene la central. La <b>lista blanca gana siempre</b> — es la válvula de escape para
        cuando un teléfono real queda del lado equivocado de una regla. Los cambios entran solos: no hay que aplicar nada.
      </Alert>

      {admin && (
        <Card p="lg" className="pbx-fade-in">
          <Group gap={9} mb="md">
            <ThemeIcon size={30} radius="md" variant="light" color="red"><IconPlus size={17} /></ThemeIcon>
            <Text fw={700}>Agregar a una lista</Text>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 4 }} spacing="md" style={{ alignItems: 'end' }}>
            <TextInput label="IP o red" description={lista === 'blanca' ? 'IP (1.2.3.4) o rango CIDR (1.2.3.0/24)' : 'Una IPv4 pública'} placeholder="203.0.113.5"
                       value={ip} onChange={(e) => setIp(e.currentTarget.value)} />
            <TextInput label="Nota" description="Para acordarse por qué" placeholder="opcional"
                       value={nota} onChange={(e) => setNota(e.currentTarget.value)} />
            <div>
              <Text size="sm" fw={500} mb={2}>Lista</Text>
              <Text size="xs" c="dimmed" mb={6}>Negra bloquea; blanca deja pasar</Text>
              <SegmentedControl fullWidth value={lista} onChange={setLista}
                data={[{ label: 'Negra', value: 'negra' }, { label: 'Blanca', value: 'blanca' }]} />
            </div>
            <Button leftSection={<IconPlus size={16} />} color={lista === 'blanca' ? 'teal' : 'red'} onClick={agregar}>Agregar</Button>
          </SimpleGrid>
          <Text size="xs" c="dimmed" mt="sm">
            {lista === 'blanca'
              ? 'Nunca se bloquea, aunque falle la clave mil veces. Si estaba bloqueada, se suelta al agregarla.'
              : 'Bloqueo permanente en el firewall del host, sin importar qué mande.'}
          </Text>
        </Card>
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Card p={0} className="pbx-fade-in">
          <Group p="lg" pb="xs" gap={9}>
            <ThemeIcon size={28} radius="md" variant="light" color="red"><IconBan size={15} /></ThemeIcon>
            <Text fw={700}>Lista negra</Text>
            <Badge size="sm" variant="light" color="red">{negras.length}</Badge>
            <Text size="xs" c="dimmed">bloqueos permanentes</Text>
          </Group>
          {tabla(negras, 'La lista negra está vacía: hoy no hay bloqueos permanentes.', sacarNegra, 'Motivo')}
        </Card>

        <Card p={0} className="pbx-fade-in">
          <Group p="lg" pb="xs" gap={9}>
            <ThemeIcon size={28} radius="md" variant="light" color="teal"><IconCheck size={15} /></ThemeIcon>
            <Text fw={700}>Lista blanca</Text>
            <Badge size="sm" variant="light" color="teal">{blancas.length}</Badge>
          </Group>
          {tabla(blancas, 'Nadie tiene pase libre. Está bien: la lista blanca es la excepción, no la norma.', sacarBlanca, 'Nota')}
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

/* ── SOC — el centro de operaciones de seguridad de la central ─────────────── */
const sevColor = (sv) => ({ crit: 'red', warn: 'orange', info: 'pbx' }[sv] || 'gray');

/* Bandera como IMAGEN (flagcdn) y no emoji: Windows/Chrome no tiene glifos de banderas
   y el emoji se ve como el código de país (US, CA…). La imagen se ve en todos lados. */
function Flag({ cc, size = 20 }) {
  const c = (cc || '').toLowerCase();
  const w = size, h = Math.round(size * 0.72);
  const box = { width: w, height: h, minWidth: w, flex: `0 0 ${w}px`, borderRadius: 3, display: 'inline-block', verticalAlign: 'middle' };
  if (!/^[a-z]{2}$/.test(c)) return <span style={{ ...box, background: 'var(--mantine-color-gray-2)' }} />;
  return (
    <img src={`https://flagcdn.com/${c}.svg`} alt={cc} width={w} height={h}
      style={{ ...box, objectFit: 'cover', boxShadow: '0 0 0 1px rgba(0,0,0,.12)' }}
      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
  );
}

/* Motivo del bloqueo: cada tipo de detección con su ícono, color y una explicación
   simple en tooltip. Clasifica por palabras clave del `reason` que escribe la API. */
const MOTIVOS = [
  { re: /flood|avalancha|rate|too many|session ?limit|load/i, key: 'flood', color: 'red', Icon: IconWaveSine, label: 'Flood / abuso de tráfico', desc: 'Mandó muchísimos pedidos en poco tiempo (inundación). Se lo frenó para proteger la central.' },
  { re: /scan|escáner|escaner|friendly|sipvicious|sipcli|vicious|serie|unidentified/i, key: 'escaner', color: 'grape', Icon: IconRadar2, label: 'Escáner / sonda maliciosa', desc: 'Herramienta de escaneo probando extensiones en serie (tipo sipvicious). Se bloqueó a la primera.' },
  { re: /clave|password|auth|cred|nonce|challenge/i, key: 'auth', color: 'yellow', Icon: IconKey, label: 'Clave errada', desc: 'Intentó registrarse repetidas veces con una clave inválida (fuerza bruta).' },
  { re: /cuenta|account|inexistente/i, key: 'cuenta', color: 'orange', Icon: IconUserOff, label: 'Cuenta inexistente', desc: 'Probó cuentas que no existen en la central (adivinando extensiones).' },
  { re: /\bacl\b|no permitid|not allowed|transporte|transport/i, key: 'acl', color: 'blue', Icon: IconHandStop, label: 'Rechazado por ACL', desc: 'Llegó desde una red o con un transporte que el endpoint no permite.' },
  { re: /geo|país|pais|country|vetado/i, key: 'geo', color: 'blue', Icon: IconWorld, label: 'País bloqueado', desc: 'La IP viene de un país que tenés vetado en el filtro por país.' },
  { re: /lista negra|manual/i, key: 'manual', color: 'gray', Icon: IconLock, label: 'Bloqueo manual', desc: 'Lo bloqueó alguien desde el panel.' },
];
function motivoInfo(reason) {
  const r = String(reason || '');
  for (const m of MOTIVOS) if (m.re.test(r)) return m;
  return { key: 'ban', color: 'gray', Icon: IconBan, label: 'Bloqueo genérico', desc: 'IP en la lista de bloqueo de la central.' };
}
function Motivo({ reason }) {
  const m = motivoInfo(reason);
  const Ic = m.Icon;
  return (
    <Tooltip multiline w={240} withArrow position="top" color="dark"
      label={<div><Text fw={700} size="xs">{m.label}</Text><Text size="11px" mt={2} style={{ opacity: .85 }}>{m.desc}</Text></div>}>
      <Group gap={7} wrap="nowrap" style={{ cursor: 'help' }}>
        <ThemeIcon size={24} radius="md" variant="light" color={m.color}><Ic size={14} /></ThemeIcon>
        <Text fz="xs" c="dimmed" truncate maw={110}>{reason || m.label}</Text>
      </Group>
    </Tooltip>
  );
}

/* ISP: nombre del proveedor como link (ficha de la IP) + logo del proveedor.
   El logo sale del favicon del dominio conocido; si no lo conocemos, un ícono. */
const ISP_DOM = {
  ovh: 'ovh.com', softlayer: 'softlayer.com', digitalocean: 'digitalocean.com', amazon: 'aws.amazon.com',
  aws: 'aws.amazon.com', google: 'google.com', microsoft: 'azure.microsoft.com', azure: 'azure.microsoft.com',
  hetzner: 'hetzner.com', leaseweb: 'leaseweb.com', contabo: 'contabo.com', linode: 'linode.com',
  akamai: 'akamai.com', vultr: 'vultr.com', cloudflare: 'cloudflare.com', m247: 'm247.com', psychz: 'psychz.net',
  routerhosting: 'routerhosting.com', cloudzy: 'cloudzy.com', frantech: 'frantech.ca', buyvm: 'frantech.ca',
  oneprovider: 'oneprovider.com', hostinger: 'hostinger.com', godaddy: 'godaddy.com', namecheap: 'namecheap.com',
  scaleway: 'scaleway.com', online: 'scaleway.com', gcore: 'gcore.com', choopa: 'choopa.com',
  'digital ocean': 'digitalocean.com', tencent: 'tencentcloud.com', alibaba: 'alibabacloud.com', huawei: 'huaweicloud.com',
  telefonica: 'telefonica.com', antel: 'antel.com.uy', movistar: 'movistar.com.uy', claro: 'claro.com.uy',
  comcast: 'comcast.com', verizon: 'verizon.com', 'at&t': 'att.com', 'level 3': 'lumen.com', lumen: 'lumen.com',
};
function ispDom(name) {
  const s = ` ${String(name || '').toLowerCase()} `;
  for (const k in ISP_DOM) if (s.includes(k)) return ISP_DOM[k];
  return null;
}
function ISP({ name, ip }) {
  if (!name) return <Text fz="xs" c="dimmed">—</Text>;
  const dom = ispDom(name);
  const href = ip ? `https://ipinfo.io/${ip}` : null;
  const logo = dom
    ? <img src={`https://www.google.com/s2/favicons?domain=${dom}&sz=32`} alt="" width={16} height={16}
        style={{ borderRadius: 3, flex: '0 0 16px' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
    : <ThemeIcon size={18} radius="sm" variant="light" color="gray"><IconServer2 size={11} /></ThemeIcon>;
  const inner = (
    <Group gap={6} wrap="nowrap">
      {logo}
      <Text fz="xs" truncate maw={150}>{name}</Text>
      {href && <IconExternalLink size={11} style={{ opacity: .5, flex: '0 0 11px' }} />}
    </Group>
  );
  if (!href) return inner;
  return (
    <Tooltip label={`Ver ficha de ${ip} en ipinfo.io`} withArrow position="top">
      <Anchor href={href} target="_blank" rel="noopener noreferrer" underline="hover" c="inherit">{inner}</Anchor>
    </Tooltip>
  );
}

const vence = (b) => {
  if (b.permanent) return 'permanente';
  if (!b.expires_at) return '—';
  const left = Math.round((new Date(b.expires_at).getTime() - Date.now()) / 1000);
  if (left <= 0) return 'venciendo';
  if (left < 60) return `en ${left} s`;
  if (left < 3600) return `en ${Math.round(left / 60)} min`;
  if (left < 86400) return `en ${(left / 3600).toFixed(left % 3600 ? 1 : 0)} h`;
  return `en ${Math.round(left / 86400)} d`;
};

function SOC({ data, error, recargar, admin }) {
  const [q, setQ] = useState('');
  const [ban, setBan] = useState(null);   // objetivo de baneo: {tipo:'ip'|'pais', ...}
  const [enviando, setEnviando] = useState(false);
  if (error && !data) return <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>No se pudo leer el estado de seguridad: {error.message}</Alert>;
  if (!data) return <TableSkeleton />;

  const bloqueos = (data.bloqueos || []).filter((b) =>
    !q || `${b.ip} ${b.country || ''} ${b.isp || ''}`.toLowerCase().includes(q.toLowerCase()));
  const maxPais = Math.max(1, ...(data.top_paises || []).map((p) => p.n));

  const desbloquear = (ip) => toastPromise(
    api('/security/unblock', { method: 'POST', body: { ip } }).then(recargar),
    { loading: `Soltando ${ip}…`, success: `${ip} desbloqueada`, error: (e) => e.message });

  const confirmarBan = async () => {
    if (!ban) return;
    setEnviando(true);
    try {
      if (ban.tipo === 'ip') {
        await toastPromise(
          api('/security/block', { method: 'POST', body: { ip: ban.ip, permanent: true, reason: 'baneo manual (desde SOC)' } }).then(recargar),
          { loading: `Baneando ${ban.ip}…`, success: `${ban.ip} bloqueada en el firewall`, error: (e) => e.message });
      } else {
        await toastPromise(
          api('/security/geoblock/add', { method: 'POST', body: { cc: ban.cc, nombre: ban.country } }).then(recargar),
          { loading: `Bloqueando ${ban.country}…`, success: `${ban.country} agregado al filtro por país`, error: (e) => e.message });
      }
      setBan(null);
    } catch (_) { /* el toast ya lo dijo */ } finally { setEnviando(false); }
  };

  const evLabel = (kind) => ({ bloqueo: 'Bloqueo', desbloqueo: 'Desbloqueo', ataque: 'Ataque', geo: 'País', ajustes: 'Ajustes', motor: 'PJSIP', fallo: 'Fallos' }[kind] || kind);

  return (
    <Stack gap="lg">
      {/* 3 columnas: De dónde vienen · Línea de tiempo (en el medio) · Los más insistentes */}
      <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="lg">
        {/* Top países con banderas + banear país */}
        <Card p="lg" className="pbx-fade-in">
          <Group gap={9} mb="md">
            <ThemeIcon size={30} radius="md" variant="light" color="grape"><IconMapPin size={17} /></ThemeIcon>
            <Text fw={700}>De dónde vienen los ataques</Text>
          </Group>
          {(data.top_paises || []).length === 0
            ? <Text size="sm" c="dimmed" ta="center" py="md">Sin bloqueos todavía. Bien: nadie insistió lo suficiente.</Text>
            : (
              <Stack gap="sm" mah={330} style={{ overflowY: 'auto', paddingRight: 6 }}>
                {(data.top_paises || []).map((p) => (
                  <div key={p.pais}>
                    <Group justify="space-between" mb={3} wrap="nowrap">
                      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}><Flag cc={p.cc} size={20} /><Text size="sm" fw={600} truncate>{p.pais}</Text></Group>
                      <Group gap={4} wrap="nowrap">
                        <Badge size="sm" variant="light" color="red">{p.n}</Badge>
                        {admin && p.cc && (
                          <Tooltip label={`Bloquear todo ${p.pais}`}>
                            <ActionIcon size="sm" variant="subtle" color="red" onClick={() => setBan({ tipo: 'pais', cc: p.cc, country: p.pais })}><IconBan size={15} /></ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </Group>
                    <Progress value={(p.n / maxPais) * 100} color="red" size="sm" radius="xl" />
                  </div>
                ))}
              </Stack>
            )}
        </Card>

        {/* Línea de tiempo de seguridad (columna del medio) */}
        <Card p="lg" className="pbx-fade-in">
          <Group gap={9} mb="md">
            <ThemeIcon size={30} radius="md" variant="light" color="pbx"><IconActivity size={17} /></ThemeIcon>
            <Text fw={700}>Línea de tiempo de seguridad</Text>
          </Group>
          {(data.eventos || []).length === 0
            ? <Text size="sm" c="dimmed" ta="center" py="md">Sin eventos de seguridad todavía.</Text>
            : (
              <Box mah={340} style={{ overflowY: 'auto' }}>
              <Timeline active={-1} bulletSize={18} lineWidth={2}>
                {(data.eventos || []).slice(0, 40).map((e) => {
                  const d = (e.detail && typeof e.detail === 'object') ? e.detail : {};
                  return (
                    <Timeline.Item key={e.id}
                      bullet={<span style={{ width: 8, height: 8, borderRadius: 999, background: `var(--mantine-color-${sevColor(e.severity)}-6)`, display: 'block' }} />}
                      title={<Group gap={6}><Badge size="xs" variant="light" color={sevColor(e.severity)}>{evLabel(e.kind)}</Badge>
                              {d.cc && <Flag cc={d.cc} size={16} />}
                              {d.ip && <Text span ff="monospace" size="xs">{d.ip}</Text>}
                              {(d.pais || d.country) && <Text span size="xs" c="dimmed">{d.pais || d.country}</Text>}</Group>}>
                      <Text size="xs" c="dimmed">
                        {d.motivo || d.reason || d.msg || d.texto || (typeof e.detail === 'string' ? e.detail : '')}
                      </Text>
                      <Text size="10px" c="dimmed" mt={2}>{new Date(e.created_at).toLocaleString('es-UY')}</Text>
                    </Timeline.Item>
                  );
                })}
              </Timeline>
            </Box>
            )}
        </Card>

        {/* Top atacantes + banear IP (tercera columna) */}
        <Card p="lg" className="pbx-fade-in">
          <Group gap={9} mb="md">
            <ThemeIcon size={30} radius="md" variant="light" color="red"><IconFlame size={17} /></ThemeIcon>
            <Text fw={700}>Los más insistentes</Text>
            <Text size="xs" c="dimmed">ordenados por golpes</Text>
          </Group>
          {(data.top_atacantes || []).length === 0
            ? <Text size="sm" c="dimmed" ta="center" py="md">Nadie golpeando ahora mismo.</Text>
            : (
              <Box mah={330} style={{ overflowY: 'auto' }}>
              <Table verticalSpacing="xs" fz="sm">
                <Table.Tbody>
                  {(data.top_atacantes || []).map((b) => (
                    <Table.Tr key={b.ip}>
                      <Table.Td w={28}><Flag cc={b.cc} size={20} /></Table.Td>
                      <Table.Td ff="monospace" fw={650}>{b.ip}</Table.Td>
                      <Table.Td><Badge size="sm" variant="light" color="orange">{b.hits}</Badge></Table.Td>
                      <Table.Td w={40}>
                        {admin && !b.permanent && (
                          <Tooltip label={`Bloquear ${b.ip} para siempre`}>
                            <ActionIcon size="sm" variant="subtle" color="red"
                              onClick={() => setBan({ tipo: 'ip', ip: b.ip, cc: b.cc, country: b.country, isp: b.isp })}><IconBan size={15} /></ActionIcon>
                          </Tooltip>
                        )}
                        {b.permanent && <Tooltip label="Bloqueo permanente"><ThemeIcon size="sm" variant="light" color="gray"><IconLock size={12} /></ThemeIcon></Tooltip>}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              </Box>
            )}
        </Card>
      </SimpleGrid>

      {/* Bloqueos activos */}
      <Card p={0} className="pbx-fade-in">
        <Group p="lg" pb="sm" justify="space-between">
          <Group gap={9}>
            <ThemeIcon size={30} radius="md" variant="light" color="red"><IconBan size={17} /></ThemeIcon>
            <Text fw={700}>Bloqueos activos</Text>
            <Badge size="sm" variant="light" color="gray">{bloqueos.length}</Badge>
          </Group>
          <TextInput size="xs" placeholder="Buscar IP, país o ISP…" leftSection={<IconSearch size={14} />}
                     value={q} onChange={(e) => setQ(e.currentTarget.value)} w={240} />
        </Group>
        <Table.ScrollContainer minWidth={900}>
        <Table highlightOnHover verticalSpacing="sm" fz="sm" stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={40} /><Table.Th>IP</Table.Th><Table.Th>País</Table.Th>
              <Table.Th>ISP</Table.Th><Table.Th>Motivo</Table.Th><Table.Th>Golpes</Table.Th>
              <Table.Th>Bloqueada</Table.Th><Table.Th>Vence</Table.Th>{admin && <Table.Th w={50} />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {bloqueos.map((b) => (
              <Table.Tr key={b.ip}>
                <Table.Td><Flag cc={b.cc} size={20} /></Table.Td>
                <Table.Td ff="monospace" fw={650}>{b.ip}</Table.Td>
                <Table.Td fz="xs">{b.country || '—'}</Table.Td>
                <Table.Td><ISP name={b.isp} ip={b.ip} /></Table.Td>
                <Table.Td><Motivo reason={b.reason} /></Table.Td>
                <Table.Td><Badge size="sm" variant="light" color={b.hits > 3 ? 'red' : 'orange'}>{b.hits || 1}</Badge></Table.Td>
                <Table.Td fz="xs" c="dimmed">{b.blocked_at ? new Date(b.blocked_at).toLocaleString('es-UY') : '—'}</Table.Td>
                <Table.Td fz="xs">
                  {b.permanent
                    ? <Badge size="xs" variant="light" color="gray" leftSection={<IconLock size={10} />}>permanente</Badge>
                    : <Text fz="xs" c="dimmed">{vence(b)}</Text>}
                </Table.Td>
                {admin && (
                  <Table.Td>
                    <Tooltip label="Desbloquear (soltar del firewall)">
                      <ActionIcon variant="subtle" color="teal" onClick={() => desbloquear(b.ip)}><IconLockOff size={16} /></ActionIcon>
                    </Tooltip>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
            {bloqueos.length === 0 && (
              <Table.Tr><Table.Td colSpan={9}>
                <Stack align="center" py="xl" gap={6}>
                  <ThemeIcon size={44} radius="xl" variant="light" color="teal"><IconShieldCheck size={22} /></ThemeIcon>
                  <Text fw={600}>Ninguna IP bloqueada</Text>
                  <Text size="sm" c="dimmed">La central está tranquila. Cuando alguien insista, va a aparecer acá con su bandera.</Text>
                </Stack>
              </Table.Td></Table.Tr>
            )}
          </Table.Tbody>
        </Table>
        </Table.ScrollContainer>
      </Card>

      {/* Modal de confirmación de baneo (IP o país entero) */}
      <Modal opened={!!ban} onClose={() => !enviando && setBan(null)} centered radius="lg" size="md"
        withCloseButton={false} overlayProps={{ backgroundOpacity: 0.55, blur: 3 }}>
        {ban && (
          <Stack gap="md" p="xs">
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon size={52} radius="xl" variant="light" color="red">
                {ban.tipo === 'ip' ? <IconBan size={26} /> : <IconWorld size={26} />}
              </ThemeIcon>
              <div>
                <Text fw={800} fz="lg">{ban.tipo === 'ip' ? 'Bloquear esta IP' : 'Bloquear el país entero'}</Text>
                <Text size="sm" c="dimmed">
                  {ban.tipo === 'ip'
                    ? 'La IP entra al firewall del host (nftables) y Asterisk no la ve más. Sin vencimiento.'
                    : 'Toda IP que venga de ese país se bloquea al primer intento (filtro por país).'}
                </Text>
              </div>
            </Group>

            <Card withBorder radius="md" p="md" bg="light-dark(var(--mantine-color-gray-0),var(--mantine-color-dark-6))">
              <Group gap="sm" wrap="nowrap">
                <Flag cc={ban.cc} size={26} />
                {ban.tipo === 'ip'
                  ? <div style={{ minWidth: 0 }}>
                      <Text ff="monospace" fw={700}>{ban.ip}</Text>
                      <Text size="xs" c="dimmed" truncate>{ban.country || '—'}{ban.isp ? ` · ${ban.isp}` : ''}</Text>
                    </div>
                  : <div><Text fw={700}>{ban.country}</Text><Text size="xs" c="dimmed">código {ban.cc}</Text></div>}
              </Group>
            </Card>

            {ban.tipo === 'pais' && (
              <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
                Se aplica al toque: las IPs de ese país que ya se vieron pasan a bloqueadas.
              </Alert>
            )}

            <Group justify="flex-end" gap="sm" mt="xs">
              <Button variant="default" onClick={() => setBan(null)} disabled={enviando}>Cancelar</Button>
              <Button color="red" leftSection={<IconBan size={16} />} loading={enviando} onClick={confirmarBan}>
                {ban.tipo === 'ip' ? 'Bloquear IP' : 'Bloquear país'}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

/* ── Filtro por país: bloquea (o permite sólo) países enteros al primer intento ── */
const PAISES = [
  ['CN', 'China'], ['RU', 'Rusia'], ['IN', 'India'], ['US', 'Estados Unidos'], ['BR', 'Brasil'],
  ['DE', 'Alemania'], ['NL', 'Países Bajos'], ['GB', 'Reino Unido'], ['FR', 'Francia'], ['UA', 'Ucrania'],
  ['TR', 'Turquía'], ['VN', 'Vietnam'], ['ID', 'Indonesia'], ['IR', 'Irán'], ['PK', 'Pakistán'],
  ['RO', 'Rumania'], ['PL', 'Polonia'], ['KR', 'Corea del Sur'], ['JP', 'Japón'], ['CA', 'Canadá'],
  ['MX', 'México'], ['AR', 'Argentina'], ['CL', 'Chile'], ['CO', 'Colombia'], ['PE', 'Perú'],
  ['ES', 'España'], ['IT', 'Italia'], ['PT', 'Portugal'], ['SE', 'Suecia'], ['CH', 'Suiza'],
  ['SG', 'Singapur'], ['HK', 'Hong Kong'], ['TW', 'Taiwán'], ['TH', 'Tailandia'], ['MY', 'Malasia'],
  ['PH', 'Filipinas'], ['ZA', 'Sudáfrica'], ['NG', 'Nigeria'], ['EG', 'Egipto'], ['MA', 'Marruecos'],
  ['SA', 'Arabia Saudita'], ['AE', 'Emiratos Árabes'], ['IL', 'Israel'], ['AU', 'Australia'], ['NZ', 'Nueva Zelanda'],
  ['BG', 'Bulgaria'], ['CZ', 'Chequia'], ['HU', 'Hungría'], ['GR', 'Grecia'], ['RS', 'Serbia'],
  ['MD', 'Moldavia'], ['BY', 'Bielorrusia'], ['KZ', 'Kazajistán'], ['LT', 'Lituania'], ['LV', 'Letonia'],
  ['UY', 'Uruguay'], ['PY', 'Paraguay'], ['BO', 'Bolivia'], ['EC', 'Ecuador'], ['VE', 'Venezuela'],
];
const PMAP = Object.fromEntries(PAISES);

function GeoBlock({ admin }) {
  const { data, cargando, error, recargar } = usePoll('/security/geoblock', 0);
  const [sel, setSel] = useState(null);
  const [modo, setModo] = useState(null);   // 'bloquear' | 'permitir'
  useEffect(() => { if (data && sel === null) setSel((data.paises || []).map((p) => p.cc)); }, [data, sel]);
  useEffect(() => { if (data && modo === null) setModo(data.modo || 'bloquear'); }, [data, modo]);
  const modoEff = modo || 'bloquear';
  const allow = modoEff === 'permitir';
  const nombre = (cc) => PMAP[cc] || (((data && data.paises) || []).find((p) => p.cc === cc) || {}).nombre || cc;
  const guardarYAplicar = () => {
    const paises = (sel || []).map((cc) => ({ cc, nombre: nombre(cc) }));
    toastPromise(
      api('/security/geoblock', { method: 'PUT', body: { paises, modo: modoEff } })
        .then(() => api('/security/geoblock/apply', { method: 'POST' }))
        .then(recargar),
      { loading: 'Aplicando filtro por país…', success: 'Filtro por país aplicado', error: (e) => e.message });
  };
  if (error && !data) return <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>No se pudo leer el filtro por país: {error.message}</Alert>;
  return (
    <Card p="lg" className="pbx-fade-in">
      <Group gap={9} mb="sm">
        <ThemeIcon size={30} radius="md" variant="light" color="pbx"><IconWorld size={17} /></ThemeIcon>
        <div><Text fw={700}>Filtro por país</Text><Text size="xs" c="dimmed">Decidí qué países pueden hablar SIP con la central. La IP se ubica al primer intento y, si el país no pasa, va al firewall.</Text></div>
      </Group>
      {cargando && !data ? <Skeleton height={140} radius="md" /> : (
        <>
          <SegmentedControl fullWidth mb="md" value={modoEff} onChange={setModo} disabled={!admin}
            data={[
              { value: 'bloquear', label: 'Lista negra — bloquear estos países' },
              { value: 'permitir', label: 'Lista blanca — permitir solo estos' },
            ]} />
          <Alert color={allow ? 'teal' : 'red'} variant="light" mb="md" p="xs" icon={<IconInfoCircle size={15} />}>
            {allow
              ? <>Solo entra el SIP de los países de la lista. <b>Todo el resto se bloquea</b> al primer intento. Las IPs que no se pueden ubicar (y las redes privadas) se dejan pasar para no bloquear por error.</>
              : <>Toda IP de los países de la lista se bloquea al primer intento y aparece con su bandera en el Centro de operaciones.</>}
          </Alert>
          {admin && (
            <Select
              label={allow ? 'Agregar país permitido' : 'Agregar país a bloquear'}
              placeholder="Buscá un país…"
              searchable clearable maxDropdownHeight={300}
              data={PAISES.filter(([cc]) => !(sel || []).includes(cc)).map(([cc, n]) => ({ value: cc, label: n }))}
              renderOption={({ option }) => <Group gap={8} wrap="nowrap"><Flag cc={option.value} size={18} /><span>{option.label}</span></Group>}
              value={null}
              onChange={(cc) => { if (cc) setSel([...(sel || []), cc]); }}
            />
          )}
          <Group mt="md" gap="xs">
            {(sel || []).length === 0
              ? <Text size="sm" c="dimmed">{allow ? 'Ningún país permitido todavía (lista blanca vacía = nadie filtrado).' : 'Ningún país bloqueado.'}</Text>
              : (sel || []).map((cc) => (
                <Badge key={cc} size="lg" variant="light" color={allow ? 'teal' : 'red'} pl={5}
                  leftSection={<Flag cc={cc} size={15} />}
                  rightSection={admin ? <ActionIcon size="xs" variant="transparent" color={allow ? 'teal' : 'red'} onClick={() => setSel((sel || []).filter((x) => x !== cc))}><IconTrash size={12} /></ActionIcon> : null}>
                  {nombre(cc)}
                </Badge>
              ))}
          </Group>
          {admin && (
            <Group justify="flex-end" mt="lg">
              <Button leftSection={<IconDeviceFloppy size={16} />} onClick={guardarYAplicar} color={allow ? 'teal' : undefined}>Guardar y aplicar</Button>
            </Group>
          )}
        </>
      )}
    </Card>
  );
}

/* Alarma "bajo ataque": aparece cuando el ritmo de eventos de seguridad en el último
   minuto pasa el umbral (lo calcula la API en /api/security). Roja, pulsante, con el
   ritmo, cuántas IPs y el que más golpea. Las defensas ya están actuando; esto es el aviso. */
function AtaqueBanner({ a }) {
  return (
    <Card p="md" radius="md" className="atk-banner" style={{
      background: 'linear-gradient(100deg, rgba(240,68,56,.16), rgba(240,68,56,.06))',
      border: '1px solid var(--mantine-color-red-5)', overflow: 'hidden', position: 'relative' }}>
      <style jsx global>{`
        @keyframes atkPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(240,68,56,.45); } 50% { box-shadow: 0 0 0 6px rgba(240,68,56,0); } }
        @keyframes atkBlink { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
        .atk-banner { animation: atkPulse 1.6s ease-in-out infinite; }
        .atk-ic { animation: atkBlink 1s ease-in-out infinite; }
      `}</style>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="md" wrap="nowrap">
          <ThemeIcon size={46} radius="xl" color="red" variant="filled" className="atk-ic"><IconAlertTriangle size={26} /></ThemeIcon>
          <div>
            <Group gap={8}>
              <Text fw={900} fz="lg" c="red.7" style={{ letterSpacing: .4 }}>BAJO ATAQUE</Text>
              <Badge color="red" variant="filled" size="sm">EN VIVO</Badge>
            </Group>
            <Text size="sm" c="dimmed">
              La central está recibiendo un flujo anómalo: <b>{a.golpes_min}</b> eventos/min{a.ips > 0 ? <> desde <b>{a.ips}</b> IP{a.ips === 1 ? '' : 's'}</> : ''}.
              Las mitigaciones (contador de fallos + bloqueo en nftables) están actuando.
            </Text>
          </div>
        </Group>
        {a.top_ip && (
          <Card p="xs" radius="md" withBorder bg="light-dark(var(--mantine-color-red-0),rgba(240,68,56,.08))" style={{ flexShrink: 0 }}>
            <Text size="10px" c="dimmed" tt="uppercase" fw={700}>El que más golpea</Text>
            <Text ff="monospace" fw={700} c="red.7">{a.top_ip}</Text>
            <Text size="10px" c="dimmed">{a.top_ip_golpes} golpe(s) en 60 s</Text>
          </Card>
        )}
      </Group>
    </Card>
  );
}

/* Estado del enforcement en el encabezado: que la base diga "bloqueada" no sirve de
   nada si el firewall del host no lo aplicó. Se muestra siempre, verde o naranja. */
function EnforcementBadge({ e }) {
  if (!e) return null;
  if (e.nft) return <Badge size="lg" variant="light" color="teal" leftSection={<IconShieldCheck size={14} />}>firewall activo · nftables</Badge>;
  return (
    <Tooltip label={e.motivo || 'sin detalle'} multiline w={280}>
      <Badge size="lg" variant="light" color="orange" leftSection={<IconShieldOff size={14} />}>
        {e.agente ? 'sin nftables' : 'agente sin respuesta'}
      </Badge>
    </Tooltip>
  );
}

export default function Seguridad() {
  const { user } = useAuth();
  const admin = !!user && user.role === 'admin';
  const { data, error, recargar } = usePoll('/security', 8000);
  const k = (data && data.kpis) || {};
  const enf = data && data.enforcement;
  // Vivo por socket.io: cuando la central canta un evento, refrescamos el SOC (KPIs,
  // mapa, listas) con un pequeño debounce — así se ve al instante sin geolocalizar por
  // evento. La sala 'security' la pide el LiveLog (mismo socket compartido).
  const recRef = useRef(recargar); recRef.current = recargar;
  useEffect(() => {
    const s = getSocket(); if (!s) return;
    let t = null;
    const onEv = () => { if (!t) t = setTimeout(() => { t = null; if (recRef.current) recRef.current(); }, 1500); };
    s.on('sec:ev', onEv);
    return () => { if (t) clearTimeout(t); s.off('sec:ev', onEv); };
  }, []);
  return (
    <Stack gap="lg">
      <PageHeader
        icon={<IconShieldCheck size={24} />}
        color="red"
        title="Seguridad · SOC"
        subtitle="Quién intentó entrar a la central, desde dónde, y qué lo frenó"
        right={<EnforcementBadge e={enf} />}
      />
      {enf && !enf.nft && (
        <Alert color="orange" variant="light" radius="lg" icon={<IconAlertTriangle size={18} />}
               title="Los bloqueos se registran pero no se aplican en el firewall">
          {enf.agente
            ? <>nftables no está disponible en el host de Asterisk{enf.motivo ? <>: <Code>{enf.motivo}</Code></> : '.'} Las IPs quedan anotadas y se aplican solas cuando el firewall vuelva.</>
            : <>El agente de Asterisk no responde{enf.motivo ? <>: <Code>{enf.motivo}</Code></> : '.'} Revisá que el contenedor de Asterisk esté arriba y que la API llegue a su puerto <Code>:8092</Code>.</>}
        </Alert>
      )}
      {data && data.ataque && data.ataque.activo && <AtaqueBanner a={data.ataque} />}
      {/* Registro en vivo (izquierda) + mapa de ataques en vivo (derecha) */}
      <Grid gutter="lg" align="stretch">
        <Grid.Col span={{ base: 12, lg: 8 }}><LiveLog /></Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}><AttackGlobe paises={(data && data.top_paises) || []} bloqueos={(data && data.bloqueos) || []} geoblock={(data && data.geoblock) || null} kpis={k} /></Grid.Col>
      </Grid>
      <Tabs defaultValue="soc" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="soc" leftSection={<IconShieldX size={15} />}>Centro de operaciones</Tabs.Tab>
          {admin && <Tabs.Tab value="ajustes" leftSection={<IconAdjustments size={15} />}>Ajustes de la central</Tabs.Tab>}
          <Tabs.Tab value="listas" leftSection={<IconList size={15} />}>Listas negras/blancas</Tabs.Tab>
          <Tabs.Tab value="geo" leftSection={<IconWorld size={15} />}>Filtro por país</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="soc"><SOC data={data} error={error} recargar={recargar} admin={admin} /></Tabs.Panel>
        {admin && <Tabs.Panel value="ajustes"><Ajustes /></Tabs.Panel>}
        <Tabs.Panel value="listas"><Listas soc={data} recargarSoc={recargar} admin={admin} /></Tabs.Panel>
        <Tabs.Panel value="geo"><GeoBlock admin={admin} /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
