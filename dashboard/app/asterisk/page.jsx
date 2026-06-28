'use client';
import dynamic from 'next/dynamic';
import { Stack } from '@mantine/core';
import { IconServer2 } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
const AsteriskConsole = dynamic(() => import('../AsteriskConsole'), { ssr: false });
export default function AsteriskPage() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconServer2 size={24} />} title="Asterisk" subtitle="Nucleo de comunicaciones - estado, red, dialplan y seguridad" color="blue" />
      <AsteriskConsole />
    </Stack>
  );
}
