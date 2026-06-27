'use client';
import { Tabs } from '@mantine/core';
import { IconRobot, IconWaveSine } from '@tabler/icons-react';
import AiAgents from '../ai-agents/page';
import VozConsole from '../voz/page';

export default function IaVoz() {
  return (
    <Tabs defaultValue="agents" variant="pills" radius="md" keepMounted={false}>
      <Tabs.List mb="md">
        <Tabs.Tab value="agents" leftSection={<IconRobot size={16} />}>Agentes IA</Tabs.Tab>
        <Tabs.Tab value="voice" leftSection={<IconWaveSine size={16} />}>Voz (TTS / STT)</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="agents"><AiAgents /></Tabs.Panel>
      <Tabs.Panel value="voice"><VozConsole /></Tabs.Panel>
    </Tabs>
  );
}
