'use client';
/* La configuración del borde se mudó a su propio producto: SBC-NG. PBX-NG ya no
 * administra el SBC desde acá — solo se conecta a él. Esta ruta quedó como cortesía
 * para cualquier enlace viejo: redirige al panel. */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Center, Stack, Loader, Text } from '@mantine/core';

export default function SbcMoved() {
  const router = useRouter();
  useEffect(() => { const t = setTimeout(() => router.replace('/'), 1800); return () => clearTimeout(t); }, [router]);
  return (
    <Center h="60vh">
      <Stack align="center" gap="sm">
        <Loader />
        <Text fw={600}>El SBC ahora es un producto aparte: SBC-NG</Text>
        <Text size="sm" c="dimmed">PBX-NG se conecta a él, pero ya no lo configura desde acá. Te llevamos al panel…</Text>
      </Stack>
    </Center>
  );
}
