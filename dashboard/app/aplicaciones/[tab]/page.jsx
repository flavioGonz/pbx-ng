'use client';
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import AplicacionesTab from '../../AplicacionesTab';

/* La pestaña `ai` ya no existe acá: el agente de IA se administra en IA & Voz. Se redirige
 * en vez de borrar la ruta porque un favorito viejo caería en el panel de Colas —el `return`
 * final de AplicacionesTab—, que es peor que un 404: parece que la pantalla cambió de
 * contenido. */
const MUDADAS = { ai: '/ia-voz' };

export default function Page() {
  const { tab } = useParams();
  const router = useRouter();
  const destino = MUDADAS[tab];
  useEffect(() => { if (destino) router.replace(destino); }, [destino, router]);
  if (destino) return null;
  return <AplicacionesTab tab={tab} />;
}
