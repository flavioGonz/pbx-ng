'use client';
import dynamic from 'next/dynamic';
import { Stack } from '@mantine/core';
import { IconServer2 } from '@tabler/icons-react';
import PageHeader from '../PageHeader';
const AsteriskConsole = dynamic(() => import('../AsteriskConsole'), { ssr: false });
/* La captura de paquetes vivía dentro de `SipLadder.jsx`, que quedó sin ningún
 * importador cuando se rediseñó /troncales: el componente seguía en el repo, los cinco
 * endpoints `/api/capture/*` seguían vivos en la API, y no había UNA pantalla desde
 * donde llegar. O sea: diagnóstico pagado y no entregado, justo el que necesita alguien
 * que no sabe telefonía. Se lo cuelga acá, que es la pantalla del núcleo, en vez de
 * borrar la funcionalidad. Es un botón con su modal: no cambia el resto de la página. */
const PcapCapture = dynamic(() => import('../PcapCapture'), { ssr: false });
export default function AsteriskPage() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconServer2 size={24} />} title="Asterisk" subtitle="Nucleo de comunicaciones - estado, red, dialplan y seguridad" color="blue"
        right={<PcapCapture />} />
      <AsteriskConsole />
    </Stack>
  );
}
