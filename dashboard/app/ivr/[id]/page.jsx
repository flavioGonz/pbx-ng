'use client';
import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Stack, Loader, Center } from '@mantine/core';
import { IconArrowsSplit } from '@tabler/icons-react';
import PageHeader from '../../PageHeader';
import IvrDesigner from '../../IvrDesigner';
import { useApi } from '../../api';
import { toast } from '../../notify';

export default function EditIvr() {
  const router = useRouter();
  const { id } = useParams();
  // No hay GET /ivr/:id: se pide la lista y se busca el que corresponde.
  const { data: list, error, cargando } = useApi('/ivr');
  useEffect(() => { if (error) toast(error.message, 'bad'); }, [error]);
  const ivr = (Array.isArray(list) ? list : []).find(x => String(x.id) === String(id)) || null;
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconArrowsSplit size={24} />} title={ivr ? 'Editar IVR - ' + ivr.name : 'Editar IVR'} subtitle="Disenador visual de menu de voz" color="grape" />
      {cargando ? <Center py="xl"><Loader /></Center> : <IvrDesigner embedded ivr={ivr} onClose={() => router.push('/ivr')} onSaved={() => {}} />}
    </Stack>
  );
}
