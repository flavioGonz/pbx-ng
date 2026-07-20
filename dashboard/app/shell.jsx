'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { AppShell, Group, NavLink, Text, Badge, ScrollArea, Box, Tooltip, ActionIcon, Collapse, useMantineColorScheme, useComputedColorScheme, Menu, Avatar, UnstyledButton, Divider } from '@mantine/core';
import {
  IconSitemap, IconServer2, IconDatabase, IconNetwork,
  IconLayoutDashboard, IconDeviceAnalytics, IconUsers, IconArrowsLeftRight,
  IconApps, IconHistory, IconTerminal2, IconBuilding, IconSettings, IconShieldLock, IconUsersGroup, IconShieldCheck, IconMicrophone2, IconHeadphones, IconArrowsSplit, IconRoute, IconHeadset, IconBroadcast, IconMail, IconAsterisk,
  IconLogout, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconSun, IconMoon, IconRobot, IconWorldShare, IconBell, IconDeviceLandlinePhone, IconWaveSine, IconChevronRight, IconPhoneCall, IconAdjustmentsCog, IconMap2, IconCertificate, IconBook} from '@tabler/icons-react';
import { useLive } from './useLive';
import { useAuth, logout } from './auth';
import PbxLogo from './PbxLogo';

function Logo({ logo, name }) {
  if (logo) return <img src={logo} alt="" style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: 8 }} />;
  return <PbxLogo size={32} />;
}
const groups = [
  { label: 'Telefonía', icon: IconPhoneCall, items: [
    { href: '/', label: 'Resumen', icon: IconLayoutDashboard },
    { href: '/topologia', label: 'Topología', icon: IconSitemap },
    { href: '/red', label: 'Red', icon: IconNetwork },
    { href: '/internos', label: 'Extensiones', icon: IconUsers },
    { href: '/troncales', label: 'Troncales', icon: IconDeviceLandlinePhone },
    { href: '/rutas', label: 'Rutas', icon: IconRoute },
    { href: '/ivr', label: 'IVR', icon: IconArrowsSplit },
    { href: '/ia-voz', label: 'IA & Voz', icon: IconRobot },
    { href: '/click-to-call', label: 'Click-to-Call', icon: IconWorldShare },
    { href: '/cdr', label: 'CDR', icon: IconHistory },
  ] },
  { label: 'Aplicaciones', icon: IconApps, items: [
    { href: '/aplicaciones/colas', label: 'Colas', icon: IconHeadset },
    { href: '/aplicaciones/rg', label: 'Ring Groups', icon: IconUsersGroup },
    { href: '/aplicaciones/paging', label: 'Paging', icon: IconBroadcast },
    { href: '/aplicaciones/conf', label: 'Conferencias', icon: IconUsers },
    { href: '/aplicaciones/vm', label: 'Buzones', icon: IconMail },
    { href: '/aplicaciones/codes', label: 'Códigos', icon: IconAsterisk },
    { href: '/funciones', label: 'Aparcado · Captura · MoH', icon: IconAsterisk },
    { href: '/aplicaciones/ai', label: 'AI IVR', icon: IconRobot },
  ] },
  { label: 'Operación', icon: IconDeviceAnalytics, items: [
    { href: '/telefonos', label: 'Teléfonos', icon: IconDeviceLandlinePhone },
    { href: '/wallboard', label: 'Wallboard', icon: IconDeviceAnalytics },
    { href: '/monitor', label: 'Llamadas en vivo', icon: IconHeadphones },
    { href: '/mapa', label: 'Mapa', icon: IconMap2 },
  ] },
  { label: 'Sistema', icon: IconAdjustmentsCog, items: [
    { href: '/dialplan', label: 'Dialplan', icon: IconTerminal2 },
    { href: '/empresas', label: 'Empresas', icon: IconBuilding },
    { href: '/usuarios', label: 'Usuarios', icon: IconUsersGroup },
    { href: '/basedatos', label: 'Base de datos', icon: IconDatabase },
    { href: '/seguridad', label: 'Seguridad', icon: IconShieldCheck },
    { href: '/certificados', label: 'Certificados TLS', icon: IconCertificate },
    { href: '/notificaciones', label: 'Notificaciones', icon: IconBell },
    { href: '/configuracion', label: 'Configuración', icon: IconSettings },
    { href: '/manuales', label: 'Manuales', icon: IconBook },
  ] },
];

export default function Shell({ children }) {
  const path = usePathname();
  const [rail, setRail] = useState(false);
  const [abiertos, setAbiertos] = useState([]);  // acordeón: máximo 2 grupos abiertos a la vez (como el SBC)
  const [mods, setMods] = useState({});
  useEffect(() => { fetch('/backend/api/modules').then((r) => r.json()).then(setMods).catch(() => {}); }, []);
  const MOD_MAP = { '/click-to-call': 'clicktocall', '/notificaciones': 'push', '/telefonos': 'autoprov', '/ia-voz': 'ai' };
  const visibleItem = (it) => !MOD_MAP[it.href] || mods[MOD_MAP[it.href]] !== false;
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
  const { connected } = useLive();
  const { user } = useAuth();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('dark');
  const toggleScheme = () => setColorScheme(scheme === 'dark' ? 'light' : 'dark');

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
            {groups.map(g => {
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
      <AppShell.Main><div className="pbx-anim" key={path}>{children}</div></AppShell.Main>
    </AppShell>
  );
}
