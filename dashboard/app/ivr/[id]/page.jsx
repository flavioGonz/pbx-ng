'use client';
import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Stack, Loader, Center } from '@mantine/core';
import { IconArrowsSplit } from '@tabler/icons-react';
import PageHeader from '../../PageHeader';
import IvrDesigner from '../../IvrDesigner';

export default function EditIvr() {
  const router = useRouter();
  const { id } = useParams();
  const [ivr, setIvr] = useState(null); const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch('/backend/api/ivr').then(r => r.json()).then(list => {
      const found = (Array.isArray(list) ? list : []).find(x => String(x.id) === String(id));
      setIvr(found || null); setLoading(false);
    }).catch(() => setLoading(false));
  }, [id]);
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconArrowsSplit size={24} />} title={ivr ? 'Editar IVR - ' + ivr.name : 'Editar IVR'} subtitle="Disenador visual de menu de voz" color="grape" />
      {loading ? <Center py="xl"><Loader /></Center> : <IvrDesigner embedded ivr={ivr} onClose={() => router.push('/ivr')} onSaved={() => {}} />}
    </Stack>
  );
}
