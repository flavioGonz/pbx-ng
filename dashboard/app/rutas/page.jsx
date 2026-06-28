'use client';
import { Stack, Title, Text, Badge, Tabs } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconTag, IconPhoneIncoming, IconArrowsSplit, IconTarget, IconAsterisk, IconDeviceLandlinePhone, IconBackspace, IconPlus, IconId, IconRoute } from '@tabler/icons-react';
import CrudPanel from '../CrudPanel';
import PageHeader from '../PageHeader';
import DidOverview from '../DidOverview';

const destLabel = { interno: 'Interno', ivr: 'IVR', cola: 'Cola', app: 'Aplicación' };

export default function Rutas() {
  return (
    <Stack gap="lg">
      <PageHeader icon={<IconRoute size={24} />} title="Rutas" subtitle="Enrutamiento de llamadas de las troncales · entrantes (DID) y salientes" color="indigo" />
      <Tabs defaultValue="entrantes" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="entrantes" leftSection={<IconArrowDownLeft size={16} />}>Entrantes</Tabs.Tab>
          <Tabs.Tab value="salientes" leftSection={<IconArrowUpRight size={16} />}>Salientes</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="entrantes">
          <DidOverview />
          <CrudPanel title="Rutas entrantes (DID)" subtitle="Número que recibís del operador → destino interno" color="indigo" icon={<IconArrowDownLeft size={18} />}
            idKey="id" fetchUrl="/backend/api/routes/inbound" createUrl="/backend/api/routes/inbound" deleteUrl={(r) => '/backend/api/routes/inbound/' + r.id}
            columns={[
              { key: 'did', label: 'DID / Número', mono: true, icon: <IconPhoneIncoming size={13} /> },
              { key: 'name', label: 'Nombre', icon: <IconTag size={13} /> },
              { key: 'dest_type', label: 'Tipo', icon: <IconArrowsSplit size={13} />, render: (r) => <Badge variant="dot" color="grape">{destLabel[r.dest_type] || r.dest_type}</Badge> },
              { key: 'dest_value', label: 'Destino', mono: true, icon: <IconTarget size={13} /> },
            ]}
            fields={[
              { name: 'did', label: 'DID / Número entrante', required: true, icon: <IconPhoneIncoming size={15} />, placeholder: '59824000000', description: 'El número que te entrega el operador. Ej: 59824000000 (o el formato que envía tu proveedor).' },
              { name: 'name', label: 'Nombre', icon: <IconTag size={15} />, placeholder: 'Línea principal', description: 'Etiqueta para identificar la ruta. Ej: Línea principal, Ventas.' },
              { name: 'dest_type', label: 'Tipo de destino', type: 'select', icon: <IconArrowsSplit size={15} />, description: 'A dónde se manda la llamada entrante.', data: [{ value: 'interno', label: 'Interno' }, { value: 'ivr', label: 'IVR' }, { value: 'cola', label: 'Cola' }, { value: 'app', label: 'Aplicación (nº de acceso)' }] },
              { name: 'dest_value', label: 'Destino', required: true, icon: <IconTarget size={15} />, placeholder: '1001', description: 'Según el tipo: Interno → 1001 · IVR → 9000 · Cola → soporte · Aplicación → su número de acceso.' },
            ]} emptyText="Sin rutas de entrada. Creá una para recibir llamadas de la troncal." />
        </Tabs.Panel>

        <Tabs.Panel value="salientes">
          <CrudPanel title="Rutas salientes" subtitle="Patrón de marcado → troncal (ej: marcar 0 + número)" color="teal" icon={<IconArrowUpRight size={18} />}
            idKey="id" fetchUrl="/backend/api/routes/outbound" createUrl="/backend/api/routes/outbound" deleteUrl={(r) => '/backend/api/routes/outbound/' + r.id}
            columns={[
              { key: 'name', label: 'Nombre', icon: <IconTag size={13} /> },
              { key: 'pattern', label: 'Patrón', icon: <IconAsterisk size={13} />, render: (r) => <Badge variant="light" color="pbx" ff="monospace">_{r.pattern}</Badge> },
              { key: 'trunk', label: 'Troncal', mono: true, icon: <IconDeviceLandlinePhone size={13} /> },
              { key: 'strip', label: 'Quita', icon: <IconBackspace size={13} /> },
              { key: 'prepend', label: 'Antepone', icon: <IconPlus size={13} /> },
              { key: 'callerid', label: 'CallerID', icon: <IconId size={13} /> },
            ]}
            fields={[
              { name: 'name', label: 'Nombre', icon: <IconTag size={15} />, placeholder: 'Salida nacional', description: 'Etiqueta de la regla. Ej: Salida nacional, Celulares.' },
              { name: 'pattern', label: 'Patrón (sin el _)', required: true, icon: <IconAsterisk size={15} />, placeholder: '0X.', description: 'Patrón de marcado de Asterisk. Ej: 0X. = un 0 seguido de uno o más dígitos. X = un dígito 0-9, . = uno o más.' },
              { name: 'trunk', label: 'Troncal', required: true, icon: <IconDeviceLandlinePhone size={15} />, placeholder: 'proveedor-1', description: 'Troncal por la que sale la llamada. Ej: proveedor-1.' },
              { name: 'strip', label: 'Quitar dígitos iniciales', icon: <IconBackspace size={15} />, placeholder: '1', description: 'Cuántos dígitos del principio sacar antes de enviar. Ej: 1 (quita el 0 que marcó el usuario).' },
              { name: 'prepend', label: 'Anteponer (opcional)', icon: <IconPlus size={15} />, placeholder: '+598', description: 'Texto a agregar adelante del número. Ej: +598 o 0.' },
              { name: 'callerid', label: 'CallerID saliente (opcional)', icon: <IconId size={15} />, placeholder: '59824000000', description: 'Número que verá el destinatario. Ej: 59824000000.' },
            ]} emptyText="Sin rutas de salida. Creá una para llamar a números externos." />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
