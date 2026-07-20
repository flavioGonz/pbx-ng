'use client';
import { Stack } from '@mantine/core';
import { IconNetwork } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import AstNet from '../AstNet';
import NetMode from '../NetMode';

export default function Red() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconNetwork size={24} />} title="Red del núcleo" subtitle="Modo de red, interfaces, diagnóstico y rutas" color="blue" />
      {/* Modo router/switch primero: define cómo se para la central en la red, y el
          resto (IPs, rutas) se entiende a partir de eso. */}
      <NetMode />
      <AstNet />
    </Stack>
  );
}
