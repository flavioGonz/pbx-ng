'use client';
/* AplicacionesTab — renderiza UNA aplicación de llamada por su clave (para rutas /aplicaciones/<tab>). */
import { Badge } from '@mantine/core';
import { IconUsersGroup, IconBroadcast, IconUsers, IconMail, IconTag, IconHash, IconKey, IconUser, IconLock } from '@tabler/icons-react';
import QueuePanel from './QueuePanel';
/* El catálogo de códigos ya no es una lista escrita a mano acá: lo manda la API y
 * los códigos son editables, así que esta solapa muestra el MISMO componente que
 * /funciones → Códigos de función. */
import FeatureCodes from './FeatureCodes';
import CrudPanel from './CrudPanel';

export default function AplicacionesTab({ tab }) {
  if (tab === 'rg') return (
    <CrudPanel icon={<IconUsersGroup size={18} />} color="teal" title="Ring Groups" subtitle="Timbran varios internos a la vez" idKey="name" fetchUrl="/ringgroups" createUrl="/ringgroups" deleteUrl={(r) => '/ringgroups/' + r.name}
      columns={[{ key: 'name', label: 'Nombre', mono: true, icon: <IconTag size={13} /> }, { key: 'label', label: 'Etiqueta' }, { key: 'access_exten', label: 'Acceso', icon: <IconHash size={13} /> }, { key: 'members', label: 'Internos', icon: <IconUsers size={13} /> }, { key: 'strategy', label: 'Estrategia' }]}
      fields={[
        { name: 'name', label: 'Nombre', required: true, icon: <IconTag size={15} />, placeholder: 'soporte', description: 'Identificador del grupo. Ej: soporte, ventas.' },
        { name: 'label', label: 'Etiqueta', icon: <IconTag size={15} />, description: 'Texto descriptivo opcional. Ej: Equipo de Soporte.' },
        { name: 'access_exten', label: 'Número de acceso', required: true, icon: <IconHash size={15} />, placeholder: '8500', description: 'Número que se marca para timbrar al grupo. Ej: 8500.' },
        { name: 'members', label: 'Internos (separados por coma)', required: true, icon: <IconUsers size={15} />, placeholder: '1001,1002,1003', description: 'Internos que suenan a la vez. Ej: 1001,1002,1003.' },
      ]} emptyText="Sin ring groups." />
  );
  if (tab === 'paging') return (
    <CrudPanel icon={<IconBroadcast size={18} />} color="orange" title="Paging / Intercom" subtitle="Aviso por altavoz a un grupo (auto-respuesta)" idKey="name" fetchUrl="/paging" createUrl="/paging" deleteUrl={(r) => '/paging/' + r.name}
      columns={[{ key: 'name', label: 'Nombre', mono: true, icon: <IconTag size={13} /> }, { key: 'label', label: 'Etiqueta' }, { key: 'access_exten', label: 'Acceso', icon: <IconHash size={13} /> }, { key: 'members', label: 'Internos', icon: <IconUsers size={13} /> }]}
      fields={[
        { name: 'name', label: 'Nombre', required: true, icon: <IconTag size={15} />, placeholder: 'piso1', description: 'Identificador del grupo de paging. Ej: piso1.' },
        { name: 'label', label: 'Etiqueta', icon: <IconTag size={15} />, description: 'Texto descriptivo opcional. Ej: Planta baja.' },
        { name: 'access_exten', label: 'Número de acceso', required: true, icon: <IconHash size={15} />, placeholder: '7001', description: 'Número que se marca para hablar por altavoz al grupo. Ej: 7001.' },
        { name: 'members', label: 'Internos (separados por coma)', required: true, icon: <IconUsers size={15} />, placeholder: '1001,1002', description: 'Internos que reciben el aviso con auto-respuesta. Ej: 1001,1002.' },
      ]} emptyText="Sin grupos de paging." />
  );
  if (tab === 'conf') return (
    <CrudPanel icon={<IconUsers size={18} />} color="grape" title="Salas de conferencia" subtitle="ConfBridge · PIN opcional" idKey="name" fetchUrl="/conferences" createUrl="/conferences" deleteUrl={(r) => '/conferences/' + r.name}
      columns={[{ key: 'name', label: 'Nombre', mono: true, icon: <IconTag size={13} /> }, { key: 'label', label: 'Etiqueta' }, { key: 'access_exten', label: 'Acceso', icon: <IconHash size={13} /> }, { key: 'pin', label: 'PIN' }]}
      fields={[
        { name: 'name', label: 'Nombre', required: true, icon: <IconTag size={15} />, placeholder: 'sala1', description: 'Identificador de la sala. Ej: sala1, directorio.' },
        { name: 'label', label: 'Etiqueta', icon: <IconTag size={15} />, description: 'Texto descriptivo opcional. Ej: Reunión semanal.' },
        { name: 'access_exten', label: 'Número de acceso', required: true, icon: <IconHash size={15} />, placeholder: '9001', description: 'Número que se marca para entrar a la sala. Ej: 9001.' },
        { name: 'pin', label: 'PIN (opcional)', icon: <IconLock size={15} />, placeholder: '1234', description: 'Clave para ingresar a la sala. Dejalo vacío para sala abierta. Ej: 1234.' },
      ]} emptyText="Sin salas de conferencia." />
  );
  if (tab === 'vm') return (
    <CrudPanel icon={<IconMail size={18} />} color="indigo" title="Buzones de voz" subtitle="Marcá *97 desde el interno para escuchar mensajes" idKey="mailbox" fetchUrl="/mailboxes" createUrl="/mailboxes" deleteUrl={(r) => '/mailboxes/' + r.mailbox}
      columns={[{ key: 'mailbox', label: 'Buzón', mono: true }, { key: 'fullname', label: 'Nombre' }, { key: 'email', label: 'Email' }]}
      fields={[
        { name: 'mailbox', label: 'Buzón (interno)', required: true, icon: <IconHash size={15} />, placeholder: '1001', description: 'Número del interno dueño del buzón. Ej: 1001.' },
        { name: 'password', label: 'PIN', type: 'password', required: true, icon: <IconKey size={15} />, description: 'Clave para escuchar los mensajes marcando *97. Ej: 1234.' },
        { name: 'fullname', label: 'Nombre completo', icon: <IconUser size={15} />, description: 'Titular del buzón. Ej: Juan Pérez.' },
        { name: 'email', label: 'Email', icon: <IconMail size={15} />, description: 'Para recibir los mensajes por correo (opcional). Ej: juan@empresa.com.' },
      ]} emptyText="Sin buzones." />
  );
  if (tab === 'codes') return <FeatureCodes />;
  if (tab === 'ai') return (
    <CrudPanel title="Agentes de IVR con IA" subtitle="Bots de voz · STT → LLM → TTS (integración de IA pendiente de conectar)" idKey="id" fetchUrl="/ai-agents" createUrl="/ai-agents" deleteUrl={(r) => '/ai-agents/' + r.id}
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
  );
  return <QueuePanel />;
}
