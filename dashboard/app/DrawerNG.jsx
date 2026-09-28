'use client';
/* ============================================================================
 *  El panel lateral de configuración, que reemplaza a las ventanas modales.
 *
 *  POR QUÉ UN CAJÓN Y NO UN MODAL. Un modal centrado tapa la pantalla que uno estaba
 *  mirando y, cuando el formulario crece, se convierte en una caja con scroll propio en el
 *  medio de la nada: se pierde de vista qué se estaba editando y hay que cerrarlo para
 *  volver a mirar la lista. El cajón entra por el costado, deja la tabla a la izquierda, y
 *  tiene el alto de la ventana — que es lo que un formulario de configuración necesita.
 *
 *  Tres partes fijas, siempre en el mismo lugar:
 *    · el ENCABEZADO dice qué se está editando y su estado de verdad (registrado, en vivo);
 *    · las SOLAPAS parten la configuración en bloques que se entienden solos;
 *    · el PIE con las acciones queda pegado abajo — el botón de guardar no se va con el
 *      scroll, que es el error clásico del formulario largo dentro de un modal.
 * ==========================================================================*/
import { Drawer, Group, Text, ThemeIcon, Tabs, ScrollArea, Box, Stack } from '@mantine/core';

export default function DrawerNG({
  opened, onClose,
  icono, color = 'pbx',
  titulo, subtitulo,
  estado = null,          // lo que va arriba a la derecha: el estado real, no un adorno
  solapas = [],           // [{ value, label, icon, contenido }]
  solapa, onSolapa,
  pie = null,
  ancho = 640,
}) {
  const unica = solapas.length <= 1;
  const activa = solapa || (solapas[0] && solapas[0].value);
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size={ancho} padding={0}
      overlayProps={{ blur: 2, backgroundOpacity: 0.45 }} withCloseButton={false}
      styles={{ body: { height: '100%', display: 'flex', flexDirection: 'column' } }}>
      <Box p="md" pb={unica ? 'md' : 0} className="ng-drawer-head">
        <Group justify="space-between" wrap="nowrap" mb={unica ? 0 : 'sm'} align="flex-start">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            {icono ? <ThemeIcon size={46} radius="md" variant="light" color={color}>{icono}</ThemeIcon> : null}
            <div style={{ minWidth: 0 }}>
              <Text fw={800} fz="lg" lh={1.12} truncate>{titulo}</Text>
              {subtitulo ? <Text size="xs" c="dimmed" lh={1.3}>{subtitulo}</Text> : null}
            </div>
          </Group>
          {estado}
        </Group>
        {!unica && (
          <Tabs value={activa} onChange={onSolapa} variant="default">
            <Tabs.List>
              {solapas.map(s => (
                <Tabs.Tab key={s.value} value={s.value} leftSection={s.icon}>{s.label}</Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
        )}
      </Box>

      <ScrollArea style={{ flex: 1 }} p="md">
        <Stack gap="md" className="ng-tab" key={activa}>
          {(solapas.find(s => s.value === activa) || {}).contenido}
        </Stack>
      </ScrollArea>

      {pie ? <Box p="md" className="ng-drawer-pie">{pie}</Box> : null}
    </Drawer>
  );
}

/* Un bloque dentro de una solapa: título, una línea que explica para qué sirve, y el
 * contenido. La línea de explicación NO es decorativa — es la diferencia entre un campo
 * que alguien se anima a tocar y uno que queda como estaba «por las dudas». */
export function BloqueNG({ icon, titulo, ayuda, children, derecha = null }) {
  return (
    <div>
      <Group justify="space-between" wrap="nowrap" mb={ayuda ? 2 : 8} align="flex-start">
        <Group gap={8} wrap="nowrap">
          {icon ? <span style={{ opacity: .6, display: 'flex' }}>{icon}</span> : null}
          <Text fw={700} size="sm">{titulo}</Text>
        </Group>
        {derecha}
      </Group>
      {ayuda ? <Text size="xs" c="dimmed" mb={10} ml={icon ? 28 : 0}>{ayuda}</Text> : null}
      <Stack gap="sm">{children}</Stack>
    </div>
  );
}
