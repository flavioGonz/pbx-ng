'use client';
/* CDR — registro de llamadas + grabaciones + almacenamiento, todo en una sección.
 * Fusión de las antiguas "Historial" y "Grabaciones" bajo una sola barra de tabs. */
import { useState } from 'react';
import { Stack, Tabs, ThemeIcon, Title, Text, Group } from '@mantine/core';
import { IconPhone, IconMicrophone2, IconCloud, IconListDetails } from '@tabler/icons-react';
import Historial from '../historial/page';
import Grabaciones from '../grabaciones/page';

export default function Cdr() {
  const [tab, setTab] = useState('llamadas');
  return (
    <Stack gap="lg">
      <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-cyan-5),var(--mantine-color-cyan-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'cyan.5', to: 'cyan.8', deg: 135 }}><IconListDetails size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>CDR</Title><Text c="dimmed" size="sm">Registro de llamadas, grabaciones y almacenamiento</Text></div></div>
      <Tabs value={tab} onChange={setTab} variant="pills" radius="md">
        <Tabs.List>
          <Tabs.Tab value="llamadas" leftSection={<IconPhone size={16} />}>Llamadas</Tabs.Tab>
          <Tabs.Tab value="grabaciones" leftSection={<IconMicrophone2 size={16} />}>Grabaciones</Tabs.Tab>
          <Tabs.Tab value="almacenamiento" leftSection={<IconCloud size={16} />}>Almacenamiento</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === 'llamadas' && <Historial embedded />}
      {tab === 'grabaciones' && <Grabaciones embedded section="list" />}
      {tab === 'almacenamiento' && <Grabaciones embedded section="cfg" />}
    </Stack>
  );
}
