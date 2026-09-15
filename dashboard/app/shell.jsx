'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { AppShell, Group, NavLink, Text, Badge, ScrollArea, Box, Tooltip, ActionIcon, Collapse, useMantineColorScheme, useComputedColorScheme, Menu, Avatar, UnstyledButton, Divider, Alert, Skeleton } from '@mantine/core';
import {
  IconSitemap, IconServer2, IconDatabase, IconRouteAltLeft, IconDatabaseExport, IconNetwork,
  IconLayoutDashboard, IconDeviceAnalytics, IconUsers, IconArrowsLeftRight,
  IconApps, IconHistory, IconTerminal2, IconBuilding, IconSettings, IconShieldLock, IconUsersGroup, IconShieldCheck, IconMicrophone2, IconHeadphones, IconArrowsSplit, IconRoute, IconHeadset, IconBroadcast, IconMail, IconAsterisk, IconReportAnalytics, IconCpu,
  IconLogout, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconSun, IconMoon, IconRobot, IconWorldShare, IconBell, IconDeviceLandlinePhone, IconWaveSine, IconChevronRight, IconPhoneCall, IconClockHour4, IconAdjustmentsCog, IconMap2, IconCertificate, IconBook, IconDatabaseOff, IconDoorEnter, IconAddressBook } from '@tabler/icons-react';
import { useLive } from './useLive';
import { useAuth, esAdmin, SUP_OK, logout } from './auth';
import PbxLogo from './PbxLogo';
import ErrorBoundary from './ErrorBoundary';
import { NightModeChip } from './NightMode';

/* Cada cuánto se consulta /backend/health cuando el socket está caído. Con el socket
 * vivo no hace falta: el snapshot ya trae health.db y llega cada 15 s como mucho. */
const HEALTH_POLL_MS = 30000;

/* ¿La base de datos está sin responder? Fuente única para el banner del shell:
 *  - socket conectado → lo dice el último snapshot (`health.db`), sin pedir nada más;
 *  - socket caído → se pregunta a GET /backend/health (503 o `db:false` = caída).
 * Si la API no contesta en absoluto no se cambia el estado: eso ya lo cuenta el
 * indicador OFFLINE, y "base caída" sería un diagnóstico inventado. */
function useDbCaida(snap, connected) {
  const [caida, setCaida] = useState(false);
  useEffect(() => {
    if (!connected || !snap || !snap.health) return;
    setCaida(snap.health.db === false);
  }, [snap, connected]);
  useEffect(() => {
    if (connected) return;
    let vivo = true;
    const consultar = () => fetch('/backend/health', { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!vivo) return;
        setCaida(r.status === 503 || !!(j && j.db === false));
      })
      .catch(() => {});
    consultar();
    const iv = setInterval(consultar, HEALTH_POLL_MS);
    return () => { vivo = false; clearInterval(iv); };
  }, [connected]);
  return caida;
}

function Logo({ logo, name }) {
  if (logo) return <img src={logo} alt="" style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: 8 }} />;
  return <PbxLogo size={32} />;
}
/* El Resumen no pertenece a ningún grupo: es la portada. Estaba metido dentro de
 * "Telefonía", que es de lo que se queja cualquiera que mire el menú dos veces. */
const inicio = { href: '/', label: 'Resumen', icon: IconLayoutDashboard };
/* El «inicio» de un supervisor no es el Resumen (que es de admin) sino su propia pantalla,
 * y necesita estar en el menú por una razón muy concreta: entrando a /cdr o a /salas, sin
 * este ítem no había NINGÚN link de vuelta a /supervisor —el único camino era cerrar
 * sesión—. `/supervisor` se dibuja sin este shell (tiene su propio encabezado a pantalla
 * completa), así que acá sólo aparece el link. */
const inicioSup = { href: '/supervisor', label: 'Panel de supervisión', icon: IconHeadphones };

/* Los grupos siguen UN criterio, dicho en una línea cada uno. Antes "Telefonía"
 * mezclaba infraestructura (Topología, Red) con enrutamiento y con reportes (CDR),
 * y "Sistema" era un cajón de once cosas sin relación entre sí.
 *
 *   Telefonía      el camino que recorre una llamada: de dónde entra, por dónde sale.
 *   Aplicaciones   lo que la central le ofrece a quien la usa.
 *   Operación      el día a día de quien atiende: ver, medir, y los aparatos.
 *   Sistema        cómo está armado el equipo.
 *   Mantenimiento  cómo se lo cuida: seguridad, respaldos, avisos, documentación.
 *
 * Topología ya no está: es una pantalla de SBC-NG. Los dos son productos distintos y
 * el menú de uno no tiene por qué describir al otro. */
const groups = [
  { label: 'Telefonía', icon: IconPhoneCall, items: [
    { href: '/internos', label: 'Extensiones', icon: IconUsers },
    { href: '/troncales', label: 'Troncales', icon: IconDeviceLandlinePhone },
    { href: '/rutas', label: 'Rutas', icon: IconRoute },
    { href: '/horarios', label: 'Horarios y modo noche', icon: IconClockHour4 },
    { href: '/ivr', label: 'IVR', icon: IconArrowsSplit },
    { href: '/dialplan', label: 'Dialplan', icon: IconTerminal2 },
  ] },
  { label: 'Aplicaciones', icon: IconApps, items: [
    { href: '/aplicaciones/colas', label: 'Colas', icon: IconHeadset },
    { href: '/aplicaciones/rg', label: 'Ring Groups', icon: IconUsersGroup },
    { href: '/aplicaciones/paging', label: 'Paging', icon: IconBroadcast },
    { href: '/salas', label: 'Salas de reunión', icon: IconUsers },
    { href: '/aplicaciones/vm', label: 'Buzones', icon: IconMail },
    { href: '/funciones', label: 'Aparcado · Captura · MoH', icon: IconAsterisk },
    { href: '/aplicaciones/codes', label: 'Códigos', icon: IconAsterisk },
    { href: '/aplicaciones/ai', label: 'AI IVR', icon: IconRobot },
    { href: '/ia-voz', label: 'IA & Voz', icon: IconMicrophone2 },
    { href: '/click-to-call', label: 'Click-to-Call', icon: IconWorldShare },
  ] },
  /* Portería (módulo `intercom`). Este grupo es la razón de que exista el agente `porteria`:
   * las dos pantallas estaban enteras y con datos vivos en una central real, pero NUNCA
   * estuvieron en el menú —la única forma de llegar era escribir la URL a mano—. Son dos y
   * van juntas porque una sola no alcanza: «Portería» es la pared de video y «Clientes» es
   * donde se dan de alta los porteros RTSP, los espacios y las personas autorizadas. Con el
   * módulo apagado el grupo entero desaparece (el `filter` de más abajo esconde un grupo sin
   * ítems visibles), y eso apaga el VIDEO: el screen-pop del panel de agente
   * (`/api/clients/lookup`) sigue funcionando igual, ver CONTRATOS §3 «Portería». */
  { label: 'Portería', icon: IconDoorEnter, items: [
    { href: '/intercom', label: 'Portería', icon: IconDoorEnter },
    { href: '/clientes', label: 'Clientes', icon: IconAddressBook },
  ] },
  { label: 'Operación', icon: IconDeviceAnalytics, items: [
    { href: '/monitor', label: 'Llamadas en vivo', icon: IconHeadphones },
    { href: '/wallboard', label: 'Wallboard', icon: IconDeviceAnalytics },
    { href: '/cdr', label: 'CDR', icon: IconHistory },
    { href: '/reportes', label: 'Reportes de call center', icon: IconReportAnalytics },
    { href: '/mapa', label: 'Mapa', icon: IconMap2 },
    { href: '/telefonos', label: 'Teléfonos', icon: IconDeviceLandlinePhone },
  ] },
  { label: 'Sistema', icon: IconAdjustmentsCog, items: [
    { href: '/sistema', label: 'Sistema', icon: IconCpu },
    { href: '/red', label: 'Red', icon: IconNetwork },
    { href: '/sbc', label: 'SBC-NG (conexión)', icon: IconRouteAltLeft },
    { href: '/empresas', label: 'Empresas', icon: IconBuilding },
    { href: '/usuarios', label: 'Usuarios', icon: IconUsersGroup },
    { href: '/configuracion', label: 'Configuración', icon: IconSettings },
  ] },
  { label: 'Mantenimiento', icon: IconShieldCheck, items: [
    { href: '/seguridad', label: 'Seguridad', icon: IconShieldCheck },
    { href: '/certificados', label: 'Certificados TLS', icon: IconCertificate },
    { href: '/notificaciones', label: 'Notificaciones', icon: IconBell },
    { href: '/respaldos', label: 'Respaldos', icon: IconDatabaseExport },
    { href: '/basedatos', label: 'Base de datos', icon: IconDatabase },
    { href: '/manuales', label: 'Manuales', icon: IconBook },
  ] },
];

export default function Shell({ children }) {
  const path = usePathname();
  const [rail, setRail] = useState(false);
  const [abiertos, setAbiertos] = useState([]);  // acordeón: máximo 2 grupos abiertos a la vez (como el SBC)
  const [mods, setMods] = useState({});
  /* Los modulos solo se piden con sesion de PANEL. En /login o /phone no hay JWT de
   * panel y el parche de fetch mandaba el token del softphone (scope 'phone'), que la
   * API rechaza con 403 para esta ruta: ruido en consola en cada carga del login. */
  useEffect(() => {
    let tienePanel = false; try { tienePanel = !!localStorage.getItem('pbxng_jwt'); } catch (_) {}
    if (!tienePanel) return;
    fetch('/backend/api/modules').then((r) => (r.ok ? r.json() : null)).then((m) => { if (m) setMods(m); }).catch(() => {});
  }, [path]);
  const { user } = useAuth();
  /* Ruta del menú → id del módulo que la enciende. El id de Portería es `intercom` (así lo
   * conocen el perfil del compose y el reconciliador), aunque la etiqueta diga «Portería». */
  const MOD_MAP = { '/click-to-call': 'clicktocall', '/notificaciones': 'push', '/telefonos': 'autoprov', '/ia-voz': 'ai', '/sbc': 'sbc', '/intercom': 'intercom', '/clientes': 'intercom' };
  /* Menú por rol. La lista de lo que ve un supervisor es `SUP_OK` de `app/auth.jsx`
   * (espejo de control-plane/rbac.js, docs/CONTRATOS.md §2), la MISMA que usa el redirect
   * de esa pantalla: si el menú ofreciera un ítem que el redirect rebota, el supervisor
   * apretaría un botón que lo saca de donde está. Lo que no está en SUP_OK es sólo admin;
   * 'agente' no ve nada porque no tiene ninguna pantalla de este shell (auth.jsx lo manda
   * a /agente).
   *
   * El limbo de `user` (`undefined`, «todavía no sé quién entró», hasta que contesta
   * `GET auth/me`) NO se dibuja: mientras no se sabe el menú es un esqueleto (ver
   * `menuListo` más abajo). Cualquier respuesta que se elija para el limbo le parpadea a
   * alguien —resolverlo como admin le mostraba Troncales, Usuarios y Respaldos al
   * supervisor y lo dejaba apretar un botón que sólo sabe dar 403; resolverlo como no-admin
   * le muestra al admin el menú chico de operación y después le aparece el resto—, así que
   * la única salida sin parpadeo es no ofrecer ítems hasta saber quién entró. `roleOk`
   * igual se queda del lado prudente (CONTRATOS §2) por si alguien lo llama antes. */
  const roleOk = (it) => {
    if (esAdmin(user)) return true;
    if (user && user.role === 'agente') return false;
    return it.href === '/supervisor' || SUP_OK.includes(it.href);
  };
  /* `null` es «no hay sesión» (auth.jsx ya está redirigiendo al login): tampoco hay menú
   * que dibujar, pero no es el limbo y no necesita esqueleto. */
  const menuListo = user !== undefined;
  const visibleItem = (it) => roleOk(it) && (!MOD_MAP[it.href] || mods[MOD_MAP[it.href]] !== false);
  const [brand, setBrand] = useState({ name: 'PBX-NG', subtitle: 'Comunicaciones', logo: '' });
  useEffect(() => { fetch('/backend/api/branding').then((r) => r.json()).then((bb) => { setBrand(bb); if (bb && bb.name && typeof document !== 'undefined') document.title = bb.name; }).catch(() => {}); }, []);
  useEffect(() => { try { setRail(localStorage.getItem('pbxng_rail') === '1'); } catch (_) {} }, []);
  const isActive = (it) => it.href === '/' ? path === '/' : path.startsWith(it.href);
  // por defecto: abrir el grupo que contiene la ruta activa
  useEffect(() => {
    setAbiertos(prev => {
      if (prev.length) return prev;
      const act = groups.filter(g => g.items.some(isActive)).map(g => g.label);
      return [act[0] || 'Telefonía'];
    });
  }, [path]);
  const toggleRail = () => setRail(v => { const n = !v; try { localStorage.setItem('pbxng_rail', n ? '1' : '0'); } catch (_) {} return n; });
  const toggleGroup = (l) => setAbiertos(a => (a.includes(l) ? [] : [l]));

  // Hooks SIEMPRE antes de cualquier return (Rules of Hooks): con el early-return de abajo
  // dejandolos afuera en /phone,/agente,etc. el conteo de hooks cambiaba entre renders
  // (React #300) y rompia la hidratacion (#418/#423). Ahora se llaman incondicionalmente.
  const { snap, connected } = useLive();
  const dbCaida = useDbCaida(snap, connected);
  const { setColorScheme } = useMantineColorScheme();
  /* El esquema real (claro/oscuro) vive en localStorage y solo se conoce en el
   * navegador: en el HTML del servidor siempre es 'dark'. Si el boton de tema se
   * dibuja con el valor del cliente en el PRIMER render, el sol/luna no coincide
   * con lo que mando el servidor -> React #418/#423 en cada carga con modo claro.
   * Hasta que el componente monta se dibuja lo mismo que el servidor. */
  const schemeReal = useComputedColorScheme('dark', { getInitialValueInEffect: true });
  const [montado, setMontado] = useState(false);
  useEffect(() => { setMontado(true); }, []);
  const scheme = montado ? schemeReal : 'dark';
  const toggleScheme = () => setColorScheme(schemeReal === 'dark' ? 'light' : 'dark');

  if (path && (path.startsWith('/phone') || path.startsWith('/enroll') || path.startsWith('/call') || path.startsWith('/agente') || path.startsWith('/supervisor') || path === '/login')) return children;

  const navItem = (it) => {
    const active = isActive(it); const Icon = it.icon;
    const link = <NavLink key={it.href} component={Link} href={it.href} label={rail ? undefined : it.label}
      leftSection={<Icon size={19} stroke={1.7} />} active={active} variant="light" mb={2}
      style={{ borderRadius: 10, justifyContent: rail ? 'center' : undefined }}
      styles={rail ? { body: { display: 'none' }, section: { marginRight: 0 } } : undefined} />;
    return rail ? <Tooltip key={it.href} label={it.label} position="right" withArrow>{link}</Tooltip> : link;
  };

  return (
    <AppShell navbar={{ width: rail ? 76 : 248, breakpoint: 'sm' }} padding="lg">
      <AppShell.Navbar p={rail ? 8 : 'sm'}>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* cabecera del sidebar: logo + contraer */}
          <Group justify="space-between" wrap="nowrap" mb="xs" px={rail ? 0 : 4} style={{ justifyContent: rail ? 'center' : 'space-between' }}>
            {!rail && <Group gap={8} wrap="nowrap"><Logo logo={brand.logo} name={brand.name} /><div><Text fw={800} size="sm" lh={1.05}>{brand.name}</Text><Text size="10px" c="dimmed" lh={1.05}>{brand.subtitle}</Text></div></Group>}
            {rail && <Logo logo={brand.logo} name={brand.name} />}
            {!rail && <Tooltip label="Contraer menú" position="right"><ActionIcon variant="subtle" color="gray" onClick={toggleRail}><IconLayoutSidebarLeftCollapse size={19} /></ActionIcon></Tooltip>}
          </Group>
          {rail && <Tooltip label="Expandir menú" position="right"><ActionIcon variant="subtle" color="gray" mx="auto" mb="xs" onClick={toggleRail}><IconLayoutSidebarLeftExpand size={19} /></ActionIcon></Tooltip>}

          {/* navegación */}
          <ScrollArea style={{ flex: 1, marginTop: 14 }} type="hover">
            {/* Mientras no se sabe quién entró: esqueleto en vez de ítems. Dibujar el menú
              * de un rol y corregirlo cuando contesta `auth/me` es un parpadeo que sufre
              * siempre alguien; el esqueleto no miente y ocupa el mismo alto, así que el
              * menú no salta cuando aparece. */}
            {!menuListo && <Box aria-hidden>
              {[...Array(9)].map((_, i) => (
                <Skeleton key={i} height={rail ? 30 : 32} radius={10} mb={i === 0 ? 10 : 6}
                  width={rail ? 30 : `${88 - (i % 3) * 9}%`} mx={rail ? 'auto' : undefined} />
              ))}
            </Box>}
            {/* La portada, suelta y siempre arriba: no es un ítem de "Telefonía". */}
            {menuListo && visibleItem(inicio) && <Box mb={10}>{navItem(inicio)}</Box>}
            {menuListo && !esAdmin(user) && user && user.role === 'supervisor' && <Box mb={10}>{navItem(inicioSup)}</Box>}
            {menuListo && groups.filter(g => g.items.some(visibleItem)).map(g => {
              const opened = rail ? true : abiertos.includes(g.label);
              const GIcon = g.icon;
              return (
                <Box key={g.label} mb={6}>
                  {!rail ? (
                    <UnstyledButton onClick={(e) => { const el = e.currentTarget; toggleGroup(g.label); setTimeout(() => { try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {} }, 70); }} style={{ width: '100%', borderRadius: 8, padding: '5px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Group gap={7}><GIcon size={14} stroke={1.8} style={{ opacity: .7 }} /><Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '.06em' }}>{g.label}</Text></Group>
                      <IconChevronRight size={14} style={{ opacity: .6, transform: opened ? 'rotate(90deg)' : 'none', transition: 'transform .18s' }} />
                    </UnstyledButton>
                  ) : <Box my={6} mx="auto" style={{ width: 22, height: 1, background: 'rgba(120,130,150,.18)' }} />}
                  {rail ? g.items.filter(visibleItem).map(navItem) : <Collapse in={opened}><Box mt={2}>{g.items.filter(visibleItem).map(navItem)}</Box></Collapse>}
                </Box>
              );
            })}
          </ScrollArea>

          {/* pie: estado + tema + usuario */}
          <Box pt="xs" mt="xs" style={{ borderTop: '1px solid rgba(120,130,150,.16)' }}>
            <Group justify={rail ? 'center' : 'space-between'} wrap="nowrap" gap={6}>
              {/* El modo noche se mira mucho más seguido de lo que se cambia: el chip lo
                * muestra sin entrar a ninguna pantalla. Se dibuja para admin Y supervisor
                * porque `GET /nightmode` es SUP en rbac.js: es exactamente el «el supervisor
                * ve si la central está abierta o cerrada» del contrato, y ahora que entra al
                * shell hay dónde mostrárselo. Al agente no: no llega nunca a este shell. En el
                * limbo de `user` no se dibuja —lado prudente— y ante un 403 `NightModeChip`
                * no pinta nada, así que en el peor caso no se ve, no molesta. */}
              {!rail && user && user.role !== 'agente' && <NightModeChip />}
              {!rail && <Tooltip label={connected ? 'Conexión en vivo activa' : 'Sin conexión en vivo'}><Badge size="sm" radius="sm" variant="light" color={connected ? 'teal' : 'gray'} leftSection={<span className="pbx-pip pbx-pulse" style={{ background: connected ? 'var(--mantine-color-teal-6)' : 'var(--mantine-color-gray-5)' }} />}>{connected ? 'En vivo' : 'Offline'}</Badge></Tooltip>}
              <Tooltip label={scheme === 'dark' ? 'Modo claro' : 'Modo oscuro'} position="top"><ActionIcon variant="subtle" color="gray" onClick={toggleScheme}>{scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}</ActionIcon></Tooltip>
            </Group>
            <Menu shadow="md" width={200} position="top-start" withArrow>
              <Menu.Target>
                <UnstyledButton mt={8} style={{ width: '100%', borderRadius: 10, padding: rail ? 6 : '7px 8px', display: 'flex', alignItems: 'center', justifyContent: rail ? 'center' : 'flex-start', gap: 9, background: 'rgba(120,130,150,.08)' }}>
                  <Avatar size={rail ? 30 : 34} radius="xl" color="pbx" variant="filled">{(user?.name || 'A')[0]}</Avatar>
                  {!rail && <div style={{ lineHeight: 1.15, minWidth: 0, flex: 1 }}><Text size="sm" fw={600} truncate>{user?.name || 'Admin'}</Text><Text size="xs" c="dimmed" truncate>{user?.role || ''}</Text></div>}
                  {!rail && <IconChevronRight size={15} style={{ opacity: .5 }} />}
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user?.username || 'sesión'}</Menu.Label>
                <Menu.Item leftSection={<IconLogout size={15} />} color="red" onClick={logout}>Cerrar sesión</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Box>
        </div>
      </AppShell.Navbar>
      <AppShell.Main>
        {/* Estado degradado: Asterisk sigue cursando llamadas (realtime con caché y el
          * dialplan cargado), pero todo lo que el panel guarda pasa por Postgres. Se
          * avisa arriba del contenido y no por toast para que no se pierda a los 5 s. */}
        {dbCaida && (
          <Alert color="red" variant="light" radius="md" mb="md" icon={<IconDatabaseOff size={18} />}
            title="Base de datos sin respuesta">
            La central sigue atendiendo llamadas pero el panel no puede guardar cambios.
          </Alert>
        )}
        {/* La barrera va DENTRO de Main: si una pantalla revienta, el menú queda en pie. */}
        <ErrorBoundary resetKey={path}><div className="pbx-anim" key={path}>{children}</div></ErrorBoundary>
      </AppShell.Main>
    </AppShell>
  );
}
