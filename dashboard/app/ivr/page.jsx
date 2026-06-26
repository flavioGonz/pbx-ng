'use client';
import { Stack, Title, Text } from '@mantine/core';
import { IconArrowsSplit } from '@tabler/icons-react';
import IvrPanel from '../IvrPanel';
import PageHeader from '../PageHeader';

export default function IvrPage() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconArrowsSplit size={24} />} title="IVR" subtitle="Menús de voz · diseñador visual y enrutamiento por dígito" color="grape" />
      <IvrPanel />
    </Stack>
  );
}
