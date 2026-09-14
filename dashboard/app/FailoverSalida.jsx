/* FailoverSalida.jsx — failover de troncal: orden de los respaldos de cada ruta saliente
 * y por cuál está saliendo AHORA.
 *
 * Por qué esto no vive dentro del CrudPanel de rutas salientes: el dato que importa acá
 * es el ORDEN (primero el respaldo bueno, después el caro) y un formulario de alta no
 * sabe reordenar nada. Además la mitad de la pantalla es estado en vivo, no configuración:
 * quien la mira normalmente está tratando de entender por qué las llamadas están saliendo
 * con otro número, y eso se contesta con «la principal no responde», no con un formulario.
 */
'use client';
import { useEffect, useMemo, useState } from 'react';
import { Card, Group, Text, Table, Button, ActionIcon, Tooltip, Modal, Select, Stack, Badge, ThemeIcon, Alert, Divider, NumberInput, Code } from '@mantine/core';
import { IconRouteAltLeft, IconChevronUp, IconChevronDown, IconTrash, IconPlus, IconAlertTriangle, IconShieldLock, IconArrowRight, IconPhoneOff, IconSettings } from '@tabler/icons-react';
import { toast } from './notify';
import { apiPut, usePoll, useApi } from './api';
import { estadoColor } from './fmt';

const SBC = 'to-sbc';

/* Qué se ve por troncal dentro de la cadena. El estado sale del mismo sondeo que muestra
 * la pantalla de Troncales, así que las dos pantallas no pueden contradecirse. */
function Eslabon({ t }) {
  const color = t.en_uso ? estadoColor(t.estado, 'gray') : 'gray';
  return (
    <Tooltip label={(t.rol === 'principal' ? 'Principal' : 'Respaldo') + (t.detalle ? ' · ' + t.detalle : '')} withArrow>
      <Badge
        variant={t.en_uso ? 'filled' : 'light'}
        color={t.en_uso ? color : estadoColor(t.estado, 'gray')}
        leftSection={t.sbc ? <IconShieldLock size={10} /> : null}
        style={{ textTransform: 'none' }}
      >{t.trunk}</Badge>
    </Tooltip>
  );
}

export default function FailoverSalida() {
  /* 30 s, el mínimo de configuración de la política de encuestado (CONTRATOS §2): esto
   * vive dentro de /rutas → Salientes, que es una pantalla de CONFIGURACIÓN, y la lista de
   * cadencia de segundos es cerrada (traza SIP, aparcado, tablero del supervisor). El
   * costo real no es el HTTP: el cache de `failoverStates()` dura 8 s, así que una vuelta
   * de 15 s siempre caía en frío y disparaba el sondeo completo por AMI (`pjsip show
   * registrations` + `pjsip show contacts` + estado de cada troncal) por CADA pestaña
   * abierta. Con 30 s sigue llegando fría, pero a la mitad de seguido; quien está mirando
   * un failover en vivo lo ve igual, porque el dato lo cambia la troncal en minutos, no en
   * segundos. */
  const { data, error, recargar } = usePoll('/routes/outbound/failover', 30000);
  const rutas = Array.isArray(data) ? data : [];
  const { data: trunksData } = useApi('/trunks');
  const [edit, setEdit] = useState(null);        // ruta que se está editando (copia local)
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (error) toast(error.message, 'bad'); }, [error]);

  /* Candidatas a respaldo: todas las troncales menos las de cliente WebRTC (no salen a la
   * calle) y menos las que ya están en la cadena de esta ruta. */
  const candidatas = useMemo(() => {
    const usadas = edit ? [edit.principal].concat(edit.backups) : [];
    return (Array.isArray(trunksData) ? trunksData : [])
      .filter((t) => !['webrtc', 'webrtc-client'].includes(t.kind) && !usadas.includes(t.name))
      .map((t) => ({ value: t.name, label: (t.kind === 'sbc' ? 'SBC-NG · ' : '') + t.name + (t.provider_host ? ' (' + t.provider_host + ')' : '') }));
  }, [trunksData, edit]);

  function mover(i, d) {
    setEdit((e) => {
      const b = e.backups.slice();
      const j = i + d;
      if (j < 0 || j >= b.length) return e;
      [b[i], b[j]] = [b[j], b[i]];
      return { ...e, backups: b };
    });
  }

  async function guardar() {
    setBusy(true);
    try {
      await apiPut('/routes/outbound/' + edit.id, { backups: edit.backups, intento_seg: edit.intento_seg, total_seg: edit.total_seg });
      toast('Respaldos guardados · el dialplan ya quedó escrito', 'ok');
      setEdit(null); recargar();
    } catch (e) { toast(e.message, 'bad'); }
    finally { setBusy(false); }
  }

  /* Salir por una troncal directa cuando la principal es el SBC-NG no es «otra troncal»:
   * el SBC es OTRO producto y es el que normaliza el número, elige operador y filtra. */
  const mezclaSbc = (r) => r.principal === SBC && r.backups.some((b) => b !== SBC);

  return (
    <Card withBorder radius="lg" padding="lg" mt="lg">
      <Group gap={10} wrap="nowrap" mb="md">
        <ThemeIcon size={32} radius="md" variant="light" color="teal"><IconRouteAltLeft size={18} /></ThemeIcon>
        <div>
          <Text fw={700} lh={1.15}>Failover de troncal</Text>
          <Text size="sm" c="dimmed">Si la principal no responde, la llamada sale por el respaldo siguiente. Arrastrá el orden: se intenta de arriba hacia abajo.</Text>
        </div>
      </Group>

      <Alert color="teal" variant="light" radius="md" icon={<IconAlertTriangle size={18} />} mb="md">
        <Text size="sm">
          Se salta a la troncal siguiente cuando el corte es <b>de la troncal</b> (no responde, congestión, 503).
          Si el que corta es el <b>destino</b> —ocupado (486), no contesta o número inexistente— la llamada
          termina ahí: reintentar por otra troncal le haría sonar el teléfono dos veces al destinatario y
          se le cobraría dos veces al cliente.
        </Text>
      </Alert>

      {rutas.length === 0
        ? <Text c="dimmed" ta="center" py="xl">Sin rutas salientes. Creá una arriba y después elegí sus respaldos.</Text>
        : (
          <Table.ScrollContainer minWidth={620}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr>
                <Table.Th>Ruta</Table.Th>
                <Table.Th>Orden de salida</Table.Th>
                <Table.Th>Saliendo ahora por</Table.Th>
                <Table.Th>Tiempos</Table.Th>
                <Table.Th />
              </Table.Tr></Table.Thead>
              <Table.Tbody>
                {rutas.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Text fw={600} size="sm">{r.name || '—'}</Text>
                      <Code>{'_' + r.pattern}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="wrap">
                        {r.cadena.map((t, i) => (
                          <Group key={t.trunk} gap={4} wrap="nowrap">
                            {i > 0 && <IconArrowRight size={12} opacity={0.45} />}
                            <Eslabon t={t} />
                          </Group>
                        ))}
                        {r.backups.length === 0 && <Text size="xs" c="dimmed">sin respaldo</Text>}
                      </Group>
                      {mezclaSbc(r) && <Group gap={5} mt={4} wrap="nowrap"><IconAlertTriangle size={13} color="var(--mantine-color-orange-6)" /><Text size="xs" c="dimmed">Si cae el SBC-NG estas llamadas salen directo al operador, sin su normalización ni su selección de ruta.</Text></Group>}
                    </Table.Td>
                    <Table.Td>
                      {r.sin_salida
                        ? <Badge color="red" variant="light" leftSection={<IconPhoneOff size={11} />}>ninguna responde</Badge>
                        : r.en_uso
                          ? <Badge color={r.en_respaldo ? 'orange' : 'teal'} variant="light" style={{ textTransform: 'none' }}>{r.en_uso}{r.en_respaldo ? ' (respaldo)' : ''}</Badge>
                          : <Text size="xs" c="dimmed">sin llamadas todavía{r.prevista ? ' · saldría por ' + r.prevista : ''}</Text>}
                    </Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{r.intento_seg}s por intento<br />{r.total_seg}s como máximo</Text></Table.Td>
                    <Table.Td ta="right">
                      <Tooltip label="Respaldos y tiempos"><ActionIcon variant="subtle" color="blue" onClick={() => setEdit({ id: r.id, name: r.name, pattern: r.pattern, principal: r.principal, backups: r.backups.slice(), intento_seg: r.intento_seg, total_seg: r.total_seg })}><IconSettings size={17} /></ActionIcon></Tooltip>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}

      <Modal opened={!!edit} onClose={() => setEdit(null)} centered radius="lg" size="lg"
        title={<Group gap="sm"><ThemeIcon size={38} radius="md" variant="light" color="teal"><IconRouteAltLeft size={20} /></ThemeIcon><div><Text fw={800} lh={1.1}>Respaldos de {edit?.name || ('_' + (edit?.pattern || ''))}</Text><Text size="xs" c="dimmed">Se intenta de arriba hacia abajo</Text></div></Group>}>
        {edit && (
          <Stack gap="md">
            <Group gap={8} wrap="nowrap">
              <Badge color="teal" variant="filled" style={{ textTransform: 'none' }}>{edit.principal}</Badge>
              <Text size="sm" c="dimmed">troncal principal (se cambia en la tabla de arriba)</Text>
            </Group>
            <Divider label="Respaldos, en orden" labelPosition="left" />
            {edit.backups.length === 0 && <Text size="sm" c="dimmed">Todavía no hay respaldos: si la principal no responde, la llamada da congestión.</Text>}
            {edit.backups.map((b, i) => (
              <Group key={b} justify="space-between" wrap="nowrap">
                <Group gap={8} wrap="nowrap"><Text size="sm" c="dimmed" w={18}>{i + 1}.</Text><Badge variant="light" color={b === SBC ? 'grape' : 'gray'} leftSection={b === SBC ? <IconShieldLock size={10} /> : null} style={{ textTransform: 'none' }}>{b}</Badge></Group>
                <Group gap={4} wrap="nowrap">
                  <ActionIcon variant="subtle" color="gray" disabled={i === 0} onClick={() => mover(i, -1)}><IconChevronUp size={16} /></ActionIcon>
                  <ActionIcon variant="subtle" color="gray" disabled={i === edit.backups.length - 1} onClick={() => mover(i, 1)}><IconChevronDown size={16} /></ActionIcon>
                  <ActionIcon variant="subtle" color="red" onClick={() => setEdit((e) => ({ ...e, backups: e.backups.filter((x) => x !== b) }))}><IconTrash size={16} /></ActionIcon>
                </Group>
              </Group>
            ))}
            <Select placeholder="Agregar una troncal de respaldo" data={candidatas} value={null} searchable clearable
              leftSection={<IconPlus size={15} />} disabled={edit.backups.length >= 5}
              description={edit.backups.length >= 5 ? 'Máximo cinco respaldos: más que eso no entra en el tiempo que espera quien llama.' : 'Podés elegir hasta cinco.'}
              onChange={(v) => { if (v) setEdit((e) => ({ ...e, backups: e.backups.concat([v]) })); }} />
            <Divider label="Cuánto espera quien llama" labelPosition="left" />
            <Group grow align="flex-start">
              <NumberInput label="Por intento (s)" min={5} max={120} value={edit.intento_seg} onChange={(v) => setEdit((e) => ({ ...e, intento_seg: +v || 20 }))}
                description="Cuánto timbra cada troncal antes de pasar a la siguiente." />
              <NumberInput label="Tope total (s)" min={5} max={300} value={edit.total_seg} onChange={(v) => setEdit((e) => ({ ...e, total_seg: +v || 45 }))}
                description="Pasado este tiempo se corta con congestión aunque queden respaldos sin probar." />
            </Group>
            <Group justify="flex-end"><Button variant="default" onClick={() => setEdit(null)}>Cancelar</Button><Button onClick={guardar} loading={busy}>Guardar</Button></Group>
          </Stack>
        )}
      </Modal>
    </Card>
  );
}
