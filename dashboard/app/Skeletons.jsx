'use client';
import { Loader, Center } from '@mantine/core';

// Loader unificado para toda la app (reemplaza los skeletons).
function Spin({ h }) {
  return <Center mih={h} w="100%" py="md"><Loader size="md" color="pbx" type="bars" /></Center>;
}
export function TableSkeleton() { return <Spin h={220} />; }
export function CardsSkeleton() { return <Spin h={90} />; }
export function CardSkeleton() { return <Spin h={140} />; }
