'use client';
import { usePathname } from 'next/navigation';
import Toaster from './Toaster';

// Toaster top-center en el panel de escritorio. En la PWA (/phone) usamos avisos nativos.
export default function DesktopToaster() {
  const p = usePathname() || '';
  if (p.startsWith('/phone')) return null;
  return <Toaster />;
}
