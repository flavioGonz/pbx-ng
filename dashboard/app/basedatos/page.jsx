'use client';
import dynamic from 'next/dynamic';
import { Stack } from '@mantine/core';
import { IconDatabase } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
const DbConsole = dynamic(() => import('../DbConsole'), { ssr: false });
export default function BaseDatosPage() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconDatabase size={24} />} title="Base de datos" subtitle="PostgreSQL - Realtime (ARA) + CDR + configuración" color="cyan" />
      <DbConsole />
    </Stack>
  );
}
