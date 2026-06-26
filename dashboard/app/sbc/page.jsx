'use client';
import { Stack } from '@mantine/core';
import { IconRouteAltLeft } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import SbcConsole from '../SbcConsole';

export default function SbcPage() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconRouteAltLeft size={24} />} title="SBC - Kamailio" subtitle="Session Border Controller - configuracion, seguridad y flujo de llamadas" color="grape" />
      <SbcConsole inline />
    </Stack>
  );
}
