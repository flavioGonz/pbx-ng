'use client';
/* IA & Voz — una sola barra de navegación (sin tabs anidadas). Cada sección es un
 * panel independiente; la consola de voz se renderiza por `section`. */
import { useState } from 'react';
import { Tabs } from '@mantine/core';
import { IconRobot, IconMicrophone2, IconVolume, IconSettings, IconFileText } from '@tabler/icons-react';
import AiAgents from '../ai-agents/page';
import VozConsole from '../voz/page';

export default function IaVoz() {
  const [tab, setTab] = useState('agents');
  return (
    <>
      <Tabs value={tab} onChange={setTab} variant="pills" radius="md">
        <Tabs.List mb="md">
          <Tabs.Tab value="agents" leftSection={<IconRobot size={16} />}>Agentes IA</Tabs.Tab>
          <Tabs.Tab value="voices" leftSection={<IconMicrophone2 size={16} />}>Voces</Tabs.Tab>
          <Tabs.Tab value="sys" leftSection={<IconVolume size={16} />}>Audios del sistema</Tabs.Tab>
          <Tabs.Tab value="engine" leftSection={<IconSettings size={16} />}>Motor</Tabs.Tab>
          <Tabs.Tab value="logs" leftSection={<IconFileText size={16} />}>Logs</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === 'agents' ? <AiAgents /> : <VozConsole section={tab} />}
    </>
  );
}
