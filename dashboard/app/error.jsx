'use client';
/* error.jsx del App Router: Next lo monta como boundary de cada segmento de página
 * (queda DENTRO del layout, así que el shell y el menú siguen en pantalla). Complementa
 * a ErrorBoundary.jsx: éste atrapa lo que pasa en el render del segmento (incluida la
 * carga del chunk de la página), aquél lo que se rompe dentro del contenido ya montado.
 * `reset()` vuelve a intentar renderizar el segmento sin recargar todo. */
import { Card, Stack, Group, Text, Button, Code, ThemeIcon } from '@mantine/core';
import { IconBug, IconRefresh } from '@tabler/icons-react';

export default function Error({ error, reset }) {
  const msg = (error && (error.message || String(error))) || 'Error desconocido';
  return (
    <Card withBorder radius="md" p="lg" maw={640} mx="auto" mt="xl">
      <Stack gap="sm">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={40} radius="md" variant="light" color="red"><IconBug size={22} /></ThemeIcon>
          <div>
            <Text fw={700}>Algo se rompió en esta pantalla</Text>
            <Text fz="sm" c="dimmed">El resto del panel sigue funcionando. Podés reintentar o ir a otra sección desde el menú.</Text>
          </div>
        </Group>
        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg}</Code>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={() => reset()}>Reintentar</Button>
          <Button leftSection={<IconRefresh size={16} />} onClick={() => { try { location.reload(); } catch (_) {} }}>Recargar</Button>
        </Group>
      </Stack>
    </Card>
  );
}
