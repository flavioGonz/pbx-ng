/* ModulesPanel.jsx - activar/desactivar modulos (PBX modular) */
'use client';
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, Switch, ThemeIcon, Badge, Alert } from '@mantine/core';
import { IconShieldLock, IconArrowsLeftRight, IconWaveSine, IconRobot, IconWorldShare, IconBell, IconDeviceLandlinePhone, IconInfoCircle, IconHeadset } from '@tabler/icons-react';
import { toast } from './notify';

const MODS = [
  { id: 'callcenter', label: 'Call Center (Agentes y Supervisores)', desc: 'Habilita los paneles de Agente y Supervisor y sus roles en el login: softphone WebRTC integrado, colas, CDR propio, cambio de clave, y escucha/susurro/irrupción para supervisores.', icon: IconHeadset },
  { id: 'sbc', label: 'SBC-NG (Kamailio)', desc: 'Borde SIP: seguridad perimetral, dispatcher y rtpengine. Apaga/enciende el servicio kamailio en el CT107.', infra: true, icon: IconShieldLock },
  { id: 'turn', label: 'TURN / STUN (Turn-NG)', desc: 'Relay de medios WebRTC para clientes detrás de NAT. Apaga/enciende el servidor TURN en el CT106.', infra: true, icon: IconArrowsLeftRight },
  { id: 'voz', label: 'Voz IA (TTS / STT)', desc: 'Síntesis y reconocimiento de voz del IVR conversacional (CT108).', infra: true, icon: IconWaveSine },
  { id: 'wsbridge', label: 'Bridge WebRTC (cliente WSS)', desc: 'Permite CONECTAR la PBX a troncales WebRTC remotas (Grandstream y otras) como cliente WSS. Corre en el edge junto al SBC. Necesario para troncales WebRTC salientes.', infra: true, icon: IconWorldShare },
  { id: 'ai', label: 'Agentes IA & Voz', desc: 'Recepcionista IA y pipeline conversacional. Oculta la sección IA & Voz.', icon: IconRobot },
  { id: 'clicktocall', label: 'Click-to-Call', desc: 'Llamadas web públicas por enlace o QR, sin registro.', icon: IconWorldShare },
  { id: 'push', label: 'Notificaciones Push', desc: 'Push RFC 8599 a la PWA y móviles.', icon: IconBell },
  { id: 'autoprov', label: 'Auto-aprovisionamiento', desc: 'Provisión automática de teléfonos físicos por MAC.', icon: IconDeviceLandlinePhone },
];

export default function ModulesPanel() {
  const [mods, setMods] = useState(null); const [busy, setBusy] = useState('');
  async function load() { try { setMods(await fetch('/backend/api/modules').then((r) => r.json())); } catch (_) {} }
  useEffect(() => { load(); }, []);
  async function toggle(id, en) {
    setBusy(id); setMods((m) => ({ ...m, [id]: en }));
    const r = await fetch('/backend/api/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, enabled: en }) }).then((x) => x.json()).catch(() => ({ error: 1 }));
    setBusy('');
    if (r.error) { toast('No se pudo cambiar el módulo', 'bad'); load(); return; }
    const svcNote = r.svc && r.svc.error ? ' (servicio: ' + r.svc.error + ')' : (r.svc && r.svc.queued ? ' (servicio en cola)' : '');
    toast((en ? 'Módulo activado' : 'Módulo desactivado') + svcNote, 'ok');
  }
  if (!mods) return <Text c="dimmed" size="sm">Cargando módulos…</Text>;
  return (
    <Stack gap="md">
      <Alert color="blue" icon={<IconInfoCircle size={16} />} variant="light" title="PBX modular">Activá solo lo que uses. Los módulos de infraestructura (marcados como «servicio») además prenden o apagan el servicio en su contenedor. El núcleo (Asterisk, base de datos y API) siempre permanece activo. Al desactivar un módulo se oculta de la interfaz y de la topología.</Alert>
      {MODS.map((m) => { const I = m.icon; const on = mods[m.id] !== false; return (
        <Card key={m.id} withBorder radius="md" padding="md">
          <Group justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap"><ThemeIcon size={40} radius="md" variant="light" color={on ? 'teal' : 'gray'}><I size={20} /></ThemeIcon>
              <div><Group gap={6}><Text fw={700}>{m.label}</Text>{m.infra && <Badge size="xs" variant="light" color="grape">servicio</Badge>}{!on && <Badge size="xs" variant="light" color="gray">inactivo</Badge>}</Group><Text size="xs" c="dimmed" maw={520}>{m.desc}</Text></div>
            </Group>
            <Switch size="lg" checked={on} disabled={busy === m.id} onChange={(e) => toggle(m.id, e.currentTarget.checked)} onLabel="ON" offLabel="OFF" />
          </Group>
        </Card>); })}
    </Stack>
  );
}
