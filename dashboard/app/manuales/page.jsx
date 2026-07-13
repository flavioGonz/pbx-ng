'use client';
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, Button, SimpleGrid, ThemeIcon, Badge, Alert } from '@mantine/core';
import { IconBook, IconExternalLink, IconFileTypePdf, IconMarkdown, IconPhotoPlus } from '@tabler/icons-react';
import PageHeader from '../PageHeader';

export default function Manuales() {
  const [meta, setMeta] = useState(null);
  useEffect(() => { fetch('/manuales/index.json').then(r => r.json()).then(setMeta).catch(() => setMeta({ manuals: [] })); }, []);
  const list = (meta && meta.manuals) || [];

  return (
    <Stack>
      <PageHeader icon={<IconBook size={24} />} color="grape" title="Manuales"
        subtitle="Documentación de la plataforma · verlos en pantalla, descargarlos en PDF o bajar el original" />

      <SimpleGrid cols={{ base: 1, md: 3 }}>
        {list.map(m => (
          <Card key={m.id} withBorder radius="lg" padding="lg" shadow="sm">
            <Group gap="sm" mb="xs">
              <ThemeIcon size={46} radius="md" variant="light" style={{ color: m.accent, background: m.accent + '18' }}>
                <span style={{ fontSize: 22 }}>{m.icon}</span>
              </ThemeIcon>
              <div style={{ minWidth: 0 }}>
                <Text fw={700} lh={1.2}>{m.title}</Text>
                <Text size="xs" c="dimmed">{m.subtitle}</Text>
              </div>
            </Group>
            <Badge size="xs" variant="light" color="gray" mb="md">Dirigido a: {m.audience}</Badge>
            <Stack gap={8}>
              <Button component="a" href={`/manuales/${m.id}.html`} target="_blank" leftSection={<IconExternalLink size={16} />} variant="filled" style={{ background: m.accent }}>
                Abrir manual
              </Button>
              <Group grow gap={8}>
                <Button component="a" href={`/manuales/${m.id}.html?print=1`} target="_blank" onClick={() => setTimeout(() => {}, 0)}
                  size="xs" variant="light" leftSection={<IconFileTypePdf size={14} />}>PDF</Button>
                <Button component="a" href={`/manuales/${m.id}.md`} download size="xs" variant="light" leftSection={<IconMarkdown size={14} />}>Markdown</Button>
              </Group>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      <Alert icon={<IconPhotoPlus size={18} />} color="grape" variant="light" radius="md" title="Cómo agregar las capturas de pantalla">
        <Text size="sm">
          Los manuales tienen recuadros que dicen <b>“Imagen pendiente”</b> con la descripción de lo que va en cada uno.
          Guardá la captura con el nombre que indica el recuadro (por ejemplo <code>cfg-06-cola-basico.png</code>) en la carpeta
          <code> docs/manual/img/</code> del repositorio, corré <code>python3 scripts/build-manuals.py</code> y la imagen aparece en su lugar.
        </Text>
      </Alert>

      <Text size="xs" c="dimmed">
        El botón <b>PDF</b> abre el manual y lanza el diálogo de impresión del navegador: elegí “Guardar como PDF”.
        Los manuales están maquetados para imprimirse bien (portada, saltos de página y sin cortar tablas ni imágenes).
      </Text>
    </Stack>
  );
}
