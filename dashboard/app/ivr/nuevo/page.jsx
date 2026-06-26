'use client';
import { useRouter } from 'next/navigation';
import { Stack } from '@mantine/core';
import { IconArrowsSplit } from '@tabler/icons-react';
import PageHeader from '../../PageHeader';
import IvrDesigner from '../../IvrDesigner';

export default function NuevoIvr() {
  const router = useRouter();
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconArrowsSplit size={24} />} title="Nuevo IVR" subtitle="Disenador visual de menu de voz" color="grape" />
      <IvrDesigner embedded onClose={() => router.push('/ivr')} onSaved={() => {}} />
    </Stack>
  );
}
