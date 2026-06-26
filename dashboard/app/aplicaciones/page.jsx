'use client';
import { useEffect, useState } from 'react';
import { Stack, Title, Text, Tabs, Card, Group, Button, Table, Badge, ThemeIcon } from '@mantine/core';
import { IconList, IconHeadset, IconUsersGroup, IconBroadcast, IconUsers, IconMail, IconAsterisk, IconDownload, IconRobot, IconTag, IconHash, IconKey, IconWorld, IconCpu, IconUser, IconLock } from '@tabler/icons-react';
import QueuePanel from '../QueuePanel';
import CrudPanel from '../CrudPanel';
import { toast } from '../notify';

function FeatureCodes() {
  const codes = [
    { code: '*43', name: 'Prueba de eco', desc: 'Repite tu voz para verificar el audio' },
    { code: '*44', name: 'Prueba de audio (ES)', desc: 'Reproduce un mensaje en español' },
    { code: '*65', name: 'Decir mi número', desc: 'Locuta el número del interno' },
    { code: '*97', name: 'Mi buzón de voz', desc: 'Entra al buzón del interno que llama' },
    { code: '*98', name: 'Buzón de otro', desc: 'Pide número de buzón y PIN' },
    { code: '600', name: 'Eco (alias)', desc: 'Igual que *43' },
  ];
  return (
    <Card withBorder radius="lg" padding="lg" shadow="sm">
      <Group justify="space-between" mb="md">
        <Group gap="xs"><Text fw={600}>Códigos de función</Text><Badge variant="light" color="teal">Integrados</Badge></Group>
      </Group>
      <Text size="xs" c="dimmed" mb="sm">Atajos que cualquier interno puede marcar (audios en español). Vienen activos en el plan de marcado interno.</Text>
      <Table striped highlightOnHover verticalSpacing="sm">
        <Table.Thead><Table.Tr><Table.Th>Código</Table.Th><Table.Th>Función</Table.Th><Table.Th>Descripción</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{codes.map(f => (
          <Table.Tr key={f.code}>
            <Table.Td><Badge variant="light" color="pbx" ff="monospace" leftSection={<IconAsterisk size={11} />}>{f.code}</Badge></Table.Td>
            <Table.Td fw={600}>{f.name}</Table.Td>
            <Table.Td c="dimmed" fz="sm">{f.desc}</Table.Td>
          </Table.Tr>
        ))}</Table.Tbody>
      </Table>
    </Card>
  );
}

export default function Aplicaciones() {
  return (
    <Stack gap="lg">
      <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-orange-5),var(--mantine-color-orange-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'orange.5', to: 'orange.8', deg: 135 }}><IconList size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Aplicaciones de llamada</Title><Text c="dimmed" size="sm">Colas, grupos, paging, conferencias, buzones, códigos y AI IVR · dialplan en realtime</Text></div></div>
      <Tabs defaultValue="colas" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="colas" leftSection={<IconHeadset size={16} />}>Colas</Tabs.Tab>
          <Tabs.Tab value="rg" leftSection={<IconUsersGroup size={16} />}>Ring Groups</Tabs.Tab>
          <Tabs.Tab value="paging" leftSection={<IconBroadcast size={16} />}>Paging</Tabs.Tab>
          <Tabs.Tab value="conf" leftSection={<IconUsers size={16} />}>Conferencias</Tabs.Tab>
          <Tabs.Tab value="vm" leftSection={<IconMail size={16} />}>Buzones</Tabs.Tab>
          <Tabs.Tab value="codes" leftSection={<IconAsterisk size={16} />}>Códigos</Tabs.Tab>
          <Tabs.Tab value="ai" leftSection={<IconRobot size={16} />}>AI IVR</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="colas"><QueuePanel /></Tabs.Panel>
        <Tabs.Panel value="rg">
          <CrudPanel icon={<IconUsersGroup size={18} />} color="teal" title="Ring Groups" subtitle="Timbran varios internos a la vez" idKey="name" fetchUrl="/backend/api/ringgroups" createUrl="/backend/api/ringgroups" deleteUrl={(r) => '/backend/api/ringgroups/' + r.name}
            columns={[{ key: 'name', label: 'Nombre', mono: true, icon: <IconTag size={13} /> }, { key: 'label', label: 'Etiqueta' }, { key: 'access_exten', label: 'Acceso', icon: <IconHash size={13} /> }, { key: 'members', label: 'Internos', icon: <IconUsers size={13} /> }, { key: 'strategy', label: 'Estrategia' }]}
            fields={[
              { name: 'name', label: 'Nombre', required: true, icon: <IconTag size={15} />, placeholder: 'soporte', description: 'Identificador del grupo. Ej: soporte, ventas.' },
              { name: 'label', label: 'Etiqueta', icon: <IconTag size={15} />, description: 'Texto descriptivo opcional. Ej: Equipo de Soporte.' },
              { name: 'access_exten', label: 'Número de acceso', required: true, icon: <IconHash size={15} />, placeholder: '8500', description: 'Número que se marca para timbrar al grupo. Ej: 8500.' },
              { name: 'members', label: 'Internos (separados por coma)', required: true, icon: <IconUsers size={15} />, placeholder: '1001,1002,1003', description: 'Internos que suenan a la vez. Ej: 1001,1002,1003.' },
            ]} emptyText="Sin ring groups." />
        </Tabs.Panel>
        <Tabs.Panel value="paging">
          <CrudPanel icon={<IconBroadcast size={18} />} color="orange" title="Paging / Intercom" subtitle="Aviso por altavoz a un grupo (auto-respuesta)" idKey="name" fetchUrl="/backend/api/paging" createUrl="/backend/api/paging" deleteUrl={(r) => '/backend/api/paging/' + r.name}
            columns={[{ key: 'name', label: 'Nombre', mono: true, icon: <IconTag size={13} /> }, { key: 'label', label: 'Etiqueta' }, { key: 'access_exten', label: 'Acceso', icon: <IconHash size={13} /> }, { key: 'members', label: 'Internos', icon: <IconUsers size={13} /> }]}
            fields={[
              { name: 'name', label: 'Nombre', required: true, icon: <IconTag size={15} />, placeholder: 'piso1', description: 'Identificador del grupo de paging. Ej: piso1.' },
              { name: 'label', label: 'Etiqueta', icon: <IconTag size={15} />, description: 'Texto descriptivo opcional. Ej: Planta baja.' },
              { name: 'access_exten', label: 'Número de acceso', required: true, icon: <IconHash size={15} />, placeholder: '7001', description: 'Número que se marca para hablar por altavoz al grupo. Ej: 7001.' },
              { name: 'members', label: 'Internos (separados por coma)', required: true, icon: <IconUsers size={15} />, placeholder: '1001,1002', description: 'Internos que reciben el aviso con auto-respuesta. Ej: 1001,1002.' },
            ]} emptyText="Sin grupos de paging." />
        </Tabs.Panel>
        <Tabs.Panel value="conf">
          <CrudPanel icon={<IconUsers size={18} />} color="grape" title="Salas de conferencia" subtitle="ConfBridge · PIN opcional" idKey="name" fetchUrl="/backend/api/conferences" createUrl="/backend/api/conferences" deleteUrl={(r) => '/backend/api/conferences/' + r.name}
            columns={[{ key: 'name', label: 'Nombre', mono: true, icon: <IconTag size={13} /> }, { key: 'label', label: 'Etiqueta' }, { key: 'access_exten', label: 'Acceso', icon: <IconHash size={13} /> }, { key: 'pin', label: 'PIN' }]}
            fields={[
              { name: 'name', label: 'Nombre', required: true, icon: <IconTag size={15} />, placeholder: 'sala1', description: 'Identificador de la sala. Ej: sala1, directorio.' },
              { name: 'label', label: 'Etiqueta', icon: <IconTag size={15} />, description: 'Texto descriptivo opcional. Ej: Reunión semanal.' },
              { name: 'access_exten', label: 'Número de acceso', required: true, icon: <IconHash size={15} />, placeholder: '9001', description: 'Número que se marca para entrar a la sala. Ej: 9001.' },
              { name: 'pin', label: 'PIN (opcional)', icon: <IconLock size={15} />, placeholder: '1234', description: 'Clave para ingresar a la sala. Dejalo vacío para sala abierta. Ej: 1234.' },
            ]} emptyText="Sin salas de conferencia." />
        </Tabs.Panel>
        <Tabs.Panel value="vm">
          <CrudPanel icon={<IconMail size={18} />} color="indigo" title="Buzones de voz" subtitle="Marcá *97 desde el interno para escuchar mensajes" idKey="mailbox" fetchUrl="/backend/api/mailboxes" createUrl="/backend/api/mailboxes" deleteUrl={(r) => '/backend/api/mailboxes/' + r.mailbox}
            columns={[{ key: 'mailbox', label: 'Buzón', mono: true }, { key: 'fullname', label: 'Nombre' }, { key: 'email', label: 'Email' }]}
            fields={[
              { name: 'mailbox', label: 'Buzón (interno)', required: true, icon: <IconHash size={15} />, placeholder: '1001', description: 'Número del interno dueño del buzón. Ej: 1001.' },
              { name: 'password', label: 'PIN', type: 'password', required: true, icon: <IconKey size={15} />, description: 'Clave para escuchar los mensajes marcando *97. Ej: 1234.' },
              { name: 'fullname', label: 'Nombre completo', icon: <IconUser size={15} />, description: 'Titular del buzón. Ej: Juan Pérez.' },
              { name: 'email', label: 'Email', icon: <IconMail size={15} />, description: 'Para recibir los mensajes por correo (opcional). Ej: juan@empresa.com.' },
            ]} emptyText="Sin buzones." />
        </Tabs.Panel>
                <Tabs.Panel value="codes"><FeatureCodes /></Tabs.Panel>
        <Tabs.Panel value="ai">
          <CrudPanel title="Agentes de IVR con IA" subtitle="Bots de voz · STT → LLM → TTS (integración de IA pendiente de conectar)" idKey="id" fetchUrl="/backend/api/ai-agents" createUrl="/backend/api/ai-agents" deleteUrl={(r) => '/backend/api/ai-agents/' + r.id}
            columns={[
              { key: 'name', label: 'Agente', mono: false },
              { key: 'exten', label: 'Acceso', render: (r) => <Badge variant="light" color="pbx" ff="monospace">{r.exten}</Badge> },
              { key: 'provider', label: 'Proveedor', render: (r) => <Badge variant="dot" color="grape">{r.provider}/{r.model}</Badge> },
              { key: 'voice', label: 'Voz' },
              { key: 'enabled', label: 'Estado', render: (r) => <Badge variant="light" color={r.enabled !== false ? 'teal' : 'gray'}>{r.enabled !== false ? 'Activo' : 'Inactivo'}</Badge> },
            ]}
            fields={[
              { name: 'name', label: 'Nombre del agente', required: true, placeholder: 'Recepción IA' },
              { name: 'exten', label: 'Número de acceso', required: true, placeholder: '9000' },
              { name: 'greeting', label: 'Audio de saludo inicial', placeholder: 'demo-congrats' },
              { name: 'system_prompt', label: 'Instrucciones del agente (system prompt)', type: 'textarea', placeholder: 'Sos la recepción de IES. Atendé con cordialidad, identificá el motivo de la llamada y derivá al área correcta…' },
              { name: 'voice', label: 'Voz (idioma/acento)', placeholder: 'es-ES' },
              { name: 'provider', label: 'Proveedor', type: 'select', data: [{ value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }, { value: 'google', label: 'Google' }, { value: 'local', label: 'Local / self-hosted' }] },
              { name: 'model', label: 'Modelo', placeholder: 'gpt-4o-mini' },
              { name: 'enabled', label: 'Activo', type: 'switch' },
            ]} emptyText="Sin agentes de IA. Creá uno y asignale un número; la voz se conectará a la IA en el siguiente paso." />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
