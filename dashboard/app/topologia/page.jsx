'use client';
import dynamic from 'next/dynamic';
import { Stack } from '@mantine/core';
import { IconSitemap } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
const SbcFlow = dynamic(() => import('../SbcFlow'), { ssr: false });
export default function TopologiaPage() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconSitemap size={24} />} title="Topología" subtitle="Mapa en vivo de la plataforma: SBC, Asterisk, troncales, internos y medios" color="grape" />
      <SbcFlow />
    </Stack>
  );
}
