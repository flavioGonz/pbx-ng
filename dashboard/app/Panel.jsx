'use client';
import { Card, Group, Text, ThemeIcon } from '@mantine/core';

// Bloque/sección con header consistente (ícono + título + acciones) y acento lateral opcional.
export default function Panel({ icon, title, subtitle, color = 'pbx', accent = false, right, badge, children, padding = 'lg', ...rest }) {
  return (
    <Card className={accent ? 'pbx-panel-accent' : undefined} style={accent ? { '--acc': `var(--mantine-color-${color}-6)` } : undefined} padding={padding} {...rest}>
      {(title || right) && (
        <Group justify="space-between" mb="md" wrap="nowrap">
          <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
            {icon && <ThemeIcon size={32} radius="md" variant="light" color={color}>{icon}</ThemeIcon>}
            <div style={{ minWidth: 0 }}>
              <Group gap={8} wrap="nowrap"><Text fw={650} truncate>{title}</Text>{badge}</Group>
              {subtitle && <Text size="xs" c="dimmed" truncate>{subtitle}</Text>}
            </div>
          </Group>
          {right && <Group gap="xs" wrap="nowrap">{right}</Group>}
        </Group>
      )}
      {children}
    </Card>
  );
}
