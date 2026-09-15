/* ModulesPanel.jsx - activar/desactivar modulos (PBX modular)
 *
 * El interruptor dibuja DOS cosas y no son la misma: `GET /api/modules` es lo DESEADO
 * (`pbxng_settings.mod_<id>`, o sea lo que alguien dejó en ON) y, para los módulos de
 * infraestructura, lo que importa es si el servicio CONTESTA. Dibujar sólo lo deseado es
 * exactamente la mentira que originó el release 1.11.0: el switch del TURN en verde y el
 * contenedor coturn inexistente, con siete softphones WebRTC repartidos.
 *
 * Por eso cada módulo `infra` declara `sonda`: el endpoint que mide de verdad. Hoy sólo el
 * TURN tiene uno (`GET /api/turn/estado` → `{deseado, corriendo, motivo, local}`). Los que
 * no lo tienen NO se pintan de verde: dicen «no se puede comprobar», que es la verdad.
 */
'use client';
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, Switch, ThemeIcon, Badge, Alert, Tooltip } from '@mantine/core';
import { IconShieldLock, IconArrowsLeftRight, IconWaveSine, IconRobot, IconWorldShare, IconBell, IconDeviceLandlinePhone, IconInfoCircle, IconHeadset, IconDoorEnter } from '@tabler/icons-react';
import { toast } from './notify';
import { api, apiPost, usePoll } from './api';
import { estadoInfra } from './fmt';

const MODS = [
  { id: 'callcenter', label: 'Call Center (Agentes y Supervisores)', desc: 'Habilita los paneles de Agente y Supervisor y sus roles en el login: softphone WebRTC integrado, colas, CDR propio, cambio de clave, y escucha/susurro/irrupción para supervisores.', icon: IconHeadset },
  { id: 'sbc', label: 'Conexión a SBC-NG', desc: 'SBC-NG es otro producto (borde SIP con su propio panel). Este módulo sólo conecta la central a él: apagado, la PBX opera sola y no muestra ningún borde; encendido, aparece la página «SBC-NG (conexión)» y las rutas salientes nuevas salen por el SBC.', icon: IconShieldLock },
  /* Único módulo con sonda real: `GET /api/turn/estado` hace STUN + Allocate contra el
   * host que la central le reparte a los softphones, así que su badge dice lo que
   * contestó el servidor, no lo que dice la fila de la base. */
  { id: 'turn', label: 'TURN / STUN (coturn)', desc: 'Relay de medios WebRTC para softphones detrás de NAT. Apaga/enciende el servicio coturn del appliance. El origen (propio, del SBC-NG o externo) y la prueba están en la solapa «WebRTC / TURN».', infra: true, sonda: 'turn', icon: IconArrowsLeftRight },
  /* `voz` e `intercom` (más abajo) no tienen todavía un endpoint que mida si el
   * contenedor contesta: `sonda` va sin definir y el badge dice «no se puede comprobar».
   * Inventarles un verde sería repetir el bug del TURN en otro módulo. */
  { id: 'voz', label: 'Voz IA (TTS / STT)', desc: 'Síntesis y reconocimiento de voz del IVR conversacional (contenedor voz).', infra: true, icon: IconWaveSine },
  { id: 'ai', label: 'Agentes IA & Voz', desc: 'Recepcionista IA y pipeline conversacional. Oculta la sección IA & Voz.', icon: IconRobot },
  { id: 'clicktocall', label: 'Click-to-Call', desc: 'Llamadas web públicas por enlace o QR, sin registro.', icon: IconWorldShare },
  { id: 'push', label: 'Notificaciones Push', desc: 'Push RFC 8599 a la PWA y móviles.', icon: IconBell },
  { id: 'autoprov', label: 'Auto-aprovisionamiento', desc: 'Provisión automática de teléfonos físicos por MAC.', icon: IconDeviceLandlinePhone },
  /* El id interno sigue siendo `intercom` aunque la etiqueta diga «Portería»: con ese nombre
   * lo conocen el perfil `intercom` del compose, el reconciliador que prende y apaga go2rtc, y
   * la fila `mod_intercom` que ya existe en las centrales instaladas. Renombrarlo dejaría el
   * switch desconectado del contenedor. Ojo con la letra chica de la descripción: apagar esto
   * apaga el VIDEO, no la ficha del cliente que ve el agente cuando entra una llamada. */
  { id: 'intercom', label: 'Portería', desc: 'Porteros y cámaras RTSP de cada cliente, servidos como video en el panel (go2rtc). Enciende las pantallas «Portería» y «Clientes» del menú. Apagarlo saca el video: el agente sigue viendo la ficha de quien lo llama.', infra: true, icon: IconDoorEnter },
];

export default function ModulesPanel() {
  const [mods, setMods] = useState(null); const [busy, setBusy] = useState('');
  /* El estado medido del TURN es configuración que cambia sola (el servicio se puede
   * caer), pero no se mira segundo a segundo: 30 s, y `usePoll` lo frena con la pestaña
   * de fondo (CONTRATOS §2, política de encuestado). */
  const { data: estTurn, recargar: recargarTurn } = usePoll('/turn/estado', 30000);
  const SONDAS = { turn: estTurn };
  async function load() { try { setMods(await api('/modules')); } catch (e) { toast(e.message, 'bad'); } }
  useEffect(() => { load(); }, []);
  async function toggle(id, en) {
    setBusy(id); setMods((m) => ({ ...m, [id]: en }));
    try {
      const r = await apiPost('/modules', { id, enabled: en });
      const svcNote = r && r.svc && r.svc.error ? ' (servicio: ' + r.svc.error + ')' : (r && r.svc && r.svc.queued ? ' (servicio en cola)' : '');
      toast((en ? 'Módulo activado' : 'Módulo desactivado') + svcNote, 'ok');
      /* Mover el interruptor no prueba nada: el badge tiene que volver a MEDIR. La API ya
       * invalidó su cache al recibir el POST, así que la próxima lectura remide. */
      if (id === 'turn') recargarTurn();
    } catch (e) {
      // El interruptor ya se movió: si el backend lo rechazó hay que releer para no mentir.
      toast(e.message, 'bad'); load();
    } finally { setBusy(''); }
  }
  if (!mods) return <Text c="dimmed" size="sm">Cargando módulos…</Text>;
  return (
    <Stack gap="md">
      <Alert color="blue" icon={<IconInfoCircle size={16} />} variant="light" title="PBX modular">Activá solo lo que uses. Los módulos de infraestructura (marcados como «servicio») además prenden o apagan el servicio en su contenedor. El núcleo (Asterisk, base de datos y API) siempre permanece activo. Al desactivar un módulo se oculta de la interfaz y de la topología.<br />En los módulos «servicio» el interruptor es lo que <b>pediste</b>; abajo de cada uno, cuando hay forma de medirlo, dice lo que el servicio <b>de verdad contesta</b>. Si las dos cosas no coinciden, el que está equivocado es el interruptor.</Alert>
      {MODS.map((m) => {
        const I = m.icon; const on = mods[m.id] !== false;
        /* `estadoInfra` (app/fmt.js) traduce el par deseado/corriendo a una sola frase, y
         * es la MISMA que usa la pantalla de WebRTC / TURN: dos traducciones del mismo par
         * terminan contradiciéndose en la misma central. Sin sonda devuelve «no se puede
         * comprobar», nunca un verde. */
        const inf = m.infra ? estadoInfra(m.sonda ? SONDAS[m.sonda] : null, { deseado: on }) : null;
        /* El icono se pinta con lo MEDIDO cuando hay medición: es lo que mira el ojo antes
         * de leer nada, y era la pieza que mentía. */
        const colorIcono = inf && inf.medido ? inf.color : (on ? 'teal' : 'gray');
        return (
        <Card key={m.id} withBorder radius="md" padding="md">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Group gap="sm" wrap="nowrap" align="flex-start"><ThemeIcon size={40} radius="md" variant="light" color={colorIcono}><I size={20} /></ThemeIcon>
              <div>
                <Group gap={6}><Text fw={700}>{m.label}</Text>{m.infra && <Badge size="xs" variant="light" color="grape">servicio</Badge>}{!on && <Badge size="xs" variant="light" color="gray">inactivo</Badge>}</Group>
                <Text size="xs" c="dimmed" maw={520}>{m.desc}</Text>
                {inf && <Group gap={6} mt={6} wrap="nowrap">
                  <Tooltip label={inf.medido ? 'Estado medido contra el servicio' : 'Este módulo todavía no tiene sonda: el panel no puede afirmar nada'} multiline w={260}>
                    <Badge size="sm" variant={inf.color === 'teal' ? 'filled' : 'light'} color={inf.color}>{inf.texto}</Badge>
                  </Tooltip>
                </Group>}
                {inf && inf.detalle && <Text size="xs" c={inf.color === 'teal' ? 'dimmed' : inf.color} maw={520} mt={4}>{inf.detalle}</Text>}
              </div>
            </Group>
            <Switch size="lg" checked={on} disabled={busy === m.id} onChange={(e) => toggle(m.id, e.currentTarget.checked)} onLabel="ON" offLabel="OFF" />
          </Group>
        </Card>); })}
    </Stack>
  );
}
