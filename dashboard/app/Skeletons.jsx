'use client';
import { Skeleton, Group, Stack, Card, SimpleGrid } from '@mantine/core';

export function TableSkeleton({ rows = 6, cols = 5 }) {
  return (
    <Stack gap={10} p="xs">
      {Array.from({ length: rows }).map((_, r) => (
        <Group key={r} gap="md" wrap="nowrap">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} height={18} radius="sm" style={{ flex: c === 0 ? 0.7 : 1 }} />
          ))}
        </Group>
      ))}
    </Stack>
  );
}
export function CardsSkeleton({ count = 4, height = 78, cols = { base: 2, sm: 4 } }) {
  return <SimpleGrid cols={cols}>{Array.from({ length: count }).map((_, i) => <Skeleton key={i} height={height} radius="lg" />)}</SimpleGrid>;
}
export function CardSkeleton({ height = 120 }) { return <Card withBorder radius="lg" p="lg"><Skeleton height={height} radius="md" /></Card>; }
