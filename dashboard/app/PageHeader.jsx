'use client';
import { Group, Title, Text, ThemeIcon } from '@mantine/core';

// Encabezado de página consistente: chip de ícono con color + título + subtítulo + acciones.
export default function PageHeader({ icon, title, subtitle, color = 'pbx', right }) {
  return (
    <Group justify="space-between" align="center" wrap="wrap" gap="sm" mb={2}>
      <div className="pbx-pagehead">
        <span className="pbx-acc-bar" style={{ background: `linear-gradient(180deg, var(--mantine-color-${color}-5), var(--mantine-color-${color}-8))` }} />
        {icon && <ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: `${color}.5`, to: `${color}.8`, deg: 135 }}>{icon}</ThemeIcon>}
        <div><Title order={2} lh={1.1}>{title}</Title>{subtitle && <Text c="dimmed" size="sm">{subtitle}</Text>}</div>
      </div>
      {right && <Group gap="sm">{right}</Group>}
    </Group>
  );
}
