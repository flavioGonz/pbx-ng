'use client';
/* ============================================================================
 *  IA & Voz — una sola barra de navegación (sin tabs anidadas).
 *
 *  EL ORDEN NO ES DECORATIVO. Las pestañas están separadas por DÓNDE CORRE cada cosa,
 *  porque esa es la división que cambia las decisiones:
 *
 *    Agentes      lo que se administra a diario; primero, y sin infraestructura al lado.
 *    Motor local  el contenedor `pbxng-voz` (Whisper + Piper): no se paga por minuto, el
 *                 audio no sale del edificio y sigue andando con el enlace caído.
 *    Nube         OpenAI y las voces Edge: el audio SALE, se factura y depende del enlace.
 *    Audios       los prompts de la central (buzón, números, errores) con una sola voz.
 *    Logs         la salida del servicio.
 *
 *  Antes esto estaba ordenado por función («Voces», «Motor»), y mezclado así no había
 *  forma de contestar dos preguntas que se hacen a diario: «si se corta internet, ¿el
 *  portero sigue atendiendo?» y «¿esto qué me cuesta?».
 * ==========================================================================*/
import { useState } from 'react';
import { Tabs, Group, Text, Badge, ThemeIcon, Stack } from '@mantine/core';
import { IconVolume, IconFileText } from '@tabler/icons-react';
import AiAgents from '../ai-agents/page';
import VozConsole from '../voz/page';
import ProveedoresNube from '../ProveedoresNube';
import { IcoAgente, IcoServidor, IcoNube } from '../IaIcons';

export default function IaVoz() {
  const [tab, setTab] = useState('agents');
  const aqui = (v) => tab === v;

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" color="pink" size={44} radius="md"><IcoAgente size={25} activo /></ThemeIcon>
          <div>
            <Text fw={800} fz="xl" lh={1.1}>IA &amp; Voz</Text>
            <Text size="xs" c="dimmed">Agentes que atienden, y las dos máquinas que los hacen hablar</Text>
          </div>
        </Group>
        <Badge variant="light" color="gray" visibleFrom="sm">
          {tab === 'nube' ? 'Sale a internet · se factura' : tab === 'local' ? 'Corre en tu servidor · sin costo' : 'pbx-ng'}
        </Badge>
      </Group>

      <Tabs value={tab} onChange={setTab} variant="pills" radius="md">
        <Tabs.List mb="md">
          <Tabs.Tab value="agents" leftSection={<IcoAgente size={16} activo={aqui('agents')} />}>Agentes</Tabs.Tab>
          <Tabs.Tab value="local" leftSection={<IcoServidor size={16} activo={aqui('local')} />}>Motor local</Tabs.Tab>
          <Tabs.Tab value="nube" leftSection={<IcoNube size={16} activo={aqui('nube')} />}>Nube</Tabs.Tab>
          <Tabs.Tab value="sys" leftSection={<IconVolume size={16} />}>Audios del sistema</Tabs.Tab>
          <Tabs.Tab value="logs" leftSection={<IconFileText size={16} />}>Logs</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {/* «Nube» es una pantalla propia (proveedor + modelos + voces de Microsoft, todo
          junto y compacto); el resto sigue siendo la consola de voz por sección. */}
      {tab === 'agents' ? <AiAgents />
        : tab === 'nube' ? <ProveedoresNube />
          : <VozConsole section={tab} />}
    </Stack>
  );
}
