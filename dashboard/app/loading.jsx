'use client';
/* loading.jsx del App Router: lo que se ve mientras Next trae el chunk de la página.
 * Mismo loader que usa el resto del panel (Skeletons.jsx) para que la espera no cambie
 * de aspecto entre "cargando la pantalla" y "cargando los datos". */
import { Center, Loader, Stack, Text } from '@mantine/core';

export default function Loading() {
  return (
    <Center mih={240} w="100%" py="xl">
      <Stack align="center" gap={8}>
        <Loader size="md" color="pbx" type="bars" />
        <Text fz="sm" c="dimmed">Cargando…</Text>
      </Stack>
    </Center>
  );
}
