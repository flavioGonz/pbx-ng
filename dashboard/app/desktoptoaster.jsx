'use client';
import { usePathname } from 'next/navigation';
import { Toaster } from 'sileo';

// Un unico Toaster (sileo) para todo el panel. En la PWA (/phone) usamos avisos nativos.
export default function DesktopToaster() {
  const p = usePathname() || '';
  if (p.startsWith('/phone')) return null;
  return <Toaster position="top-center" theme="system" offset={{ top: 18 }} />;
}
