'use client';
import dynamic from 'next/dynamic';
const SbcFlow = dynamic(() => import('../SbcFlow'), { ssr: false });
export default function TopologiaPage() {
  return (
    <div style={{ margin: 'calc(var(--mantine-spacing-lg) * -1)' }}>
      <SbcFlow fullBleed />
    </div>
  );
}
