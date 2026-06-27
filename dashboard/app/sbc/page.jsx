'use client';
import dynamic from 'next/dynamic';
import { Stack } from '@mantine/core';
import { IconRouteAltLeft } from '@tabler/icons-react';
import PageHeader from '../PageHeader';

const SbcConsole = dynamic(() => import('../SbcConsole'), { ssr: false });

export default function SbcPage() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconRouteAltLeft size={24} />} title="SBC - Kamailio" subtitle="Session Border Controller - configuracion, seguridad y flujo de llamadas" color="grape" />
      <SbcConsole inline />
    </Stack>
  );
}
