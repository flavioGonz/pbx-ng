'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { AppShell, Group, NavLink, Text, Badge, ScrollArea, Box, Tooltip, ActionIcon, useMantineColorScheme, useComputedColorScheme } from '@mantine/core';
import {
  IconLayoutDashboard, IconDeviceAnalytics, IconUsers, IconArrowsLeftRight,
  IconApps, IconHistory, IconTerminal2, IconBuilding, IconSettings, IconShieldLock, IconUsersGroup, IconShieldCheck, IconMicrophone2, IconHeadphones, IconArrowDownLeft, IconArrowUpRight, IconArrowsSplit, IconRoute,
} from '@tabler/icons-react';
import { useLive } from './useLive';
import { useAuth, logout } from './auth';
import { Menu, Avatar, UnstyledButton } from '@mantine/core';
import { IconLogout, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconSun, IconMoon, IconRobot, IconWorldShare, IconBell, IconDeviceLandlinePhone } from '@tabler/icons-react';

function Logo() {
  return (
    <svg width="34" height="34" viewBox="0 0 48 48" fill="none">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#557bd7" /><stop offset="1" stopColor="#143196" /></linearGradient></defs>
      <path d="M24 2 L42 9 V25 C42 36 34 43 24 46 C14 43 6 36 6 25 V9 Z" fill="url(#g)" />
      <text x="24" y="29" textAnchor="middle" fontFamily="Inter,sans-serif" fontWeight="800" fontSize="15" fill="#fff">IES</text>
    </svg>
  );
}
const groups = [
  { label: 'Operación', items: [
    { href: '/', label: 'Resumen', icon: IconLayoutDashboard },
    { href: '/wallboard', label: 'Wallboard', icon: IconDeviceAnalytics },
    { href: '/monitor', label: 'Llamadas en vivo', icon: IconHeadphones },
  ] },
  { label: 'Telefonía', items: [
    { href: '/internos', label: 'Internos', icon: IconUsers },
    { href: '/telefonos', label: 'Teléfonos', icon: IconDeviceLandlinePhone },
    { href: '/troncales', label: 'Troncales', icon: IconArrowsLeftRight },
    { href: '/rutas', label: 'Rutas', icon: IconRoute },
    { href: '/ivr', label: 'IVR', icon: IconArrowsSplit },
    { href: '/ai-agents', label: 'Agentes IA', icon: IconRobot },
    { href: '/click-to-call', label: 'Click-to-Call', icon: IconWorldShare },
    { href: '/aplicaciones', label: 'Aplicaciones', icon: IconApps },
    { href: '/historial', label: 'Historial', icon: IconHistory },
    { href: '/grabaciones', label: 'Grabaciones', icon: IconMicrophone2 },
  ] },
  { label: 'Sistema', items: [
    { href: '/dialplan', label: 'Dialplan', icon: IconTerminal2 },
    { href: '/empresas', label: 'Empresas', icon: IconBuilding },
    { href: '/usuarios', label: 'Usuarios', icon: IconUsersGroup },
    { href: '/seguridad', label: 'Seguridad', icon: IconShieldCheck },
    { href: '/notificaciones', label: 'Notificaciones', icon: IconBell },
    { href: '/sbc', label: 'SBC / Kamailio', icon: IconShieldLock },
    { href: '/configuracion', label: 'Configuración', icon: IconSettings },
  ] },
];
export default function Shell({ children }) {
  const path = usePathname();
  const [rail, setRail] = useState(false);
  useEffect(() => { try { setRail(localStorage.getItem('pbxng_rail') === '1'); } catch (_) {} }, []);
  const toggleRail = () => setRail(v => { const n = !v; try { localStorage.setItem('pbxng_rail', n ? '1' : '0'); } catch (_) {} return n; });
  if (path && (path.startsWith('/phone') || path.startsWith('/enroll') || path.startsWith('/call') || path === '/login')) return children;
  const { connected, snap } = useLive();
  const { user } = useAuth();
  const time = snap ? new Date(snap.ts).toLocaleTimeString('es-UY') : '—';
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('dark');
  const toggleScheme = () => setColorScheme(scheme === 'dark' ? 'light' : 'dark');
  return (
    <AppShell header={{ height: 64 }} navbar={{ width: rail ? 76 : 266, breakpoint: 'sm' }} padding="lg">
      <AppShell.Header>
        <Group h="100%" px="lg" justify="space-between">
          <Group gap="sm">
            <Tooltip label={rail ? 'Expandir menú' : 'Contraer menú'} position="right">
              <ActionIcon variant="subtle" color="gray" size="lg" onClick={toggleRail}>{rail ? <IconLayoutSidebarLeftExpand size={20} /> : <IconLayoutSidebarLeftCollapse size={20} />}</ActionIcon>
            </Tooltip>
            <Logo />
            <div><Text fw={700} size="md" lh={1.1}>PBX-NG</Text><Text size="xs" c="dimmed" lh={1.1}>Comunicaciones unificadas</Text></div>
          </Group>
          <Group gap="md">
            <Badge size="lg" radius="md" variant="light" color={connected ? 'teal' : 'gray'} ff="monospace"
              leftSection={<span className="pbx-pip pbx-pulse" style={{ background: connected ? 'var(--mantine-color-teal-6)' : 'var(--mantine-color-gray-5)' }} />}>
              {time}
            </Badge>
            <Tooltip label={scheme === 'dark' ? 'Modo claro' : 'Modo oscuro'}>
              <ActionIcon variant="subtle" color="gray" size="lg" onClick={toggleScheme}>{scheme === 'dark' ? <IconSun size={19} /> : <IconMoon size={19} />}</ActionIcon>
            </Tooltip>
            <Menu shadow="md" width={180} position="bottom-end">
              <Menu.Target>
                <UnstyledButton><Group gap={8}><Avatar size={32} radius="xl" color="pbx" variant="filled">{(user?.name || 'A')[0]}</Avatar>
                  <div style={{ lineHeight: 1.1 }}><Text size="sm" fw={600}>{user?.name || 'Admin'}</Text><Text size="xs" c="dimmed">{user?.role || ''}</Text></div></Group></UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user?.username}</Menu.Label>
                <Menu.Item leftSection={<IconLogout size={15} />} color="red" onClick={logout}>Cerrar sesión</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p={rail ? 8 : 'sm'}>
        <ScrollArea>
          {groups.map(g => (
            <Box key={g.label} mb="sm">
              {!rail && <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" py={6} style={{ letterSpacing: '.06em' }}>{g.label}</Text>}
              {rail && <Box my={6} mx="auto" style={{ width: 22, height: 1, background: 'rgba(120,130,150,.18)' }} />}
              {g.items.map(it => {
                const active = it.href === '/' ? path === '/' : path.startsWith(it.href);
                const Icon = it.icon;
                const link = <NavLink key={it.href} component={Link} href={it.href} label={rail ? undefined : it.label}
                  leftSection={<Icon size={20} stroke={1.7} />} active={active} variant="light" mb={2}
                  style={{ borderRadius: 10, justifyContent: rail ? 'center' : undefined }}
                  styles={rail ? { body: { display: 'none' }, section: { marginRight: 0 } } : undefined} />;
                return rail ? <Tooltip key={it.href} label={it.label} position="right" withArrow>{link}</Tooltip> : link;
              })}
            </Box>
          ))}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main><div className="pbx-anim" key={path}>{children}</div></AppShell.Main>
    </AppShell>
  );
}
