'use client';
/* SystemOverview - la foto de la infraestructura: cada nodo con sus recursos, sus interfaces
   de red y sus servicios. No solo el core: tambien el borde (SBC + rtpengine + TURN) y la IA. */
import { Card, Group, Text, Stack, Badge, Progress, SimpleGrid, ThemeIcon, Table, Tooltip, Divider, RingProgress, Box } from '@mantine/core';
import { usePoll } from './api';
import { IconServer2, IconShieldLock, IconCpu, IconDeviceSdCard, IconNetwork, IconDatabase, IconMicrophone2, IconMailbox, IconRobot, IconCircleFilled, IconArrowDown, IconArrowUp, IconAlertTriangle, IconPlugConnected } from '@tabler/icons-react';
import Slot from './Slot';
import { fmtBytes, fmtUptime, estadoNodo, metricasClonadas } from './fmt';

const tone = (p) => (p == null ? 'gray' : p >= 90 ? 'red' : p >= 75 ? 'orange' : p >= 50 ? 'yellow' : 'teal');
const ICON = { core: IconServer2, edge: IconShieldLock, ai: IconRobot };

/* `sinMedir` no es lo mismo que `pct == null`: es «hay un número, pero no es de este
 * nodo». Se dibuja la barra vacía y el detalle dice por qué, en vez de mostrar el valor
 * con una aclaración chica al lado —un número puesto igual que los buenos se lee como
 * bueno—. */
function Metric({ label, pct, detail, icon, sinMedir }) {
  const p = sinMedir ? null : pct;
  return (
    <Box style={{ flex: 1, minWidth: 0 }}>
      <Group justify="space-between" mb={4} wrap="nowrap">
        <Group gap={5} wrap="nowrap">{icon}<Text size="xs" c="dimmed">{label}</Text></Group>
        <Text size="xs" fw={700} c={sinMedir ? 'dimmed' : undefined}>{p == null ? '—' : <><Slot value={p} />%</>}</Text>
      </Group>
      <Progress value={p || 0} color={tone(p)} radius="xl" size="sm" animated={p >= 90} />
      <Text size="10px" c={sinMedir ? 'orange' : 'dimmed'} mt={3} truncate>{(sinMedir ? 'no es de este nodo' : detail) || ' '}</Text>
    </Box>
  );
}

/* `clonado` = este nodo reporta la MISMA memoria total, los mismos vCPU y el mismo
 * uptime que otro nodo distinto (ver `metricasClonadas()` en fmt.js). Eso quiere decir
 * que su agente está leyendo la máquina de abajo, así que CPU, memoria y uptime no son
 * de este nodo y no se dibujan como propios. El disco sí: sale del sistema de archivos
 * del contenedor, que es lo único que ahí adentro está separado de verdad. */
function NodeCard({ n, clonado }) {
  const Icon = ICON[n.role] || IconServer2;
  /* El veredicto lo arma `estadoNodo()` de fmt.js, hermano de `estadoInfra()`: que la
   * tarjeta no vuelva a inventar su propia lectura de «está vivo» es justamente el
   * punto —dos pantallas interpretando por su cuenta terminan diciendo cosas distintas
   * del mismo nodo—. */
  const inf = estadoNodo(n);
  const dp = n.disk ? n.disk.pct : null;
  return (
    <Card withBorder radius="lg" padding="md" shadow="sm" style={{ opacity: inf.medido ? 1 : .65 }}>
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={40} radius="md" variant="light" color={inf.medido ? (n.role === 'edge' ? 'red' : n.role === 'ai' ? 'teal' : 'pbx') : 'gray'}><Icon size={21} /></ThemeIcon>
          <div style={{ minWidth: 0 }}>
            <Text fw={700} size="sm" truncate>{n.name}</Text>
            {/* Los vCPU salen de la misma lectura contaminada que la memoria: si el nodo
                está clonado, no se escriben al lado del host como si fueran suyos. */}
            <Text size="xs" c="dimmed" ff="monospace">{n.host || '—'}{n.ncpu && !clonado ? ` · ${n.ncpu} vCPU` : ''}</Text>
          </div>
        </Group>
        <Badge variant="light" color={inf.color} leftSection={<IconCircleFilled size={7} />}>{inf.texto}</Badge>
      </Group>

      {/* Sin medición no se dibuja NADA: ni barras en cero (que se leen como «ocioso»)
          ni los chips de servicios en verde, que era el «EN LÍNEA» de adorno. Queda sólo
          la frase que dice por qué no se sabe. */}
      {!inf.medido ? (
        <Group gap={8} wrap="nowrap" align="flex-start">
          <ThemeIcon size={26} radius="md" variant="light" color="gray"><IconAlertTriangle size={14} /></ThemeIcon>
          <Text size="xs" c="dimmed">{inf.detalle}</Text>
        </Group>
      ) : (
        <>
          <Group gap="md" align="flex-start" wrap="nowrap">
            <Metric label="CPU" pct={n.cpu_pct} icon={<IconCpu size={13} opacity={.6} />} sinMedir={clonado}
              detail={n.load != null ? 'carga ' + Number(n.load).toFixed(2) : ''} />
            <Metric label="Memoria" pct={n.mem_pct} icon={<IconPlugConnected size={13} opacity={.6} />} sinMedir={clonado}
              detail={n.mem_total_mb ? `${(n.mem_used_mb / 1024).toFixed(1)} / ${(n.mem_total_mb / 1024).toFixed(1)} GB` : ''} />
            <Metric label="Disco" pct={dp} icon={<IconDeviceSdCard size={13} opacity={.6} />}
              detail={n.disk ? `${fmtBytes(n.disk.used)} de ${fmtBytes(n.disk.total)} · libre ${fmtBytes(n.disk.free)}` : 'no reportado'} />
          </Group>

          <Divider my="sm" />
          <Group justify="space-between">
            <Group gap={5}>
              {(n.services || []).map(s => <Badge key={s} size="xs" variant="dot" color="teal">{s}</Badge>)}
            </Group>
            {/* Un uptime clonado es el del hipervisor: «activo hace 36 días» sobre un
                contenedor que se reinició hoy es exactamente la mentira a evitar. */}
            <Text size="xs" c={clonado ? 'orange' : 'dimmed'}>
              {clonado ? 'uptime: no se pudo medir' : (n.uptime_s ? 'activo hace ' + fmtUptime(n.uptime_s) : '')}
            </Text>
          </Group>
        </>
      )}
    </Card>
  );
}

/* `data` viene de afuera cuando la pantalla que nos monta YA está encuestando
 * /system/overview (el Resumen lo hace): así hay UN solo pedido por pestaña en vez de
 * dos con cadencias distintas. Sin `data` este componente sigue siendo autónomo, con
 * `usePoll` para que se frene con la pestaña en segundo plano (antes era un
 * `setInterval` de 8 s que seguía corriendo con el navegador minimizado). */
export default function SystemOverview({ data, error }) {
  const propio = usePoll(data === undefined ? '/system/overview' : null, 30000);
  const d = data === undefined ? propio.data : data;
  /* El error viaja junto con los datos: si lo mandó la pantalla que nos monta, es el
   * suyo; si encuestamos nosotros, el nuestro. Sin esto, un `/system/overview` que
   * falla dejaba la grilla vacía y una grilla vacía se lee como «no hay nodos», que es
   * otra afirmación sin medición. */
  const err = data === undefined ? propio.error : error;

  const nodes = (d && d.nodes) || [];
  const st = (d && d.storage) || {};
  const ifaces = nodes.flatMap(n => (n.ifaces || []).map(i => ({ ...i, node: n.name, nodeId: n.id })));
  const caidos = nodes.filter(n => !estadoNodo(n).medido);
  const discoLleno = nodes.filter(n => n.disk && n.disk.pct >= 85);
  /* Nodos distintos que reportan exactamente la misma memoria, los mismos vCPU y el
   * mismo uptime AL SEGUNDO. En la central real eso pasó con tres agentes a la vez: los
   * tres devolvían los 35 GB, los 12 vCPU y los 36 días del hipervisor, porque
   * `/proc/meminfo`, `/proc/uptime` y `os.cpu_count()` no están namespaceados y adentro
   * de un contenedor devuelven la máquina de abajo. El panel no lo puede arreglar —eso
   * es de los agentes—, pero sí puede dejar de presentar cuatro tarjetas iguales como si
   * fueran cuatro máquinas. */
  const { grupos: clonados, ids: idsClonados } = metricasClonadas(nodes);

  return (
    <Stack gap="md">
      {(caidos.length > 0 || discoLleno.length > 0) && (
        <Card withBorder radius="lg" padding="sm" style={{ borderColor: 'var(--mantine-color-orange-4)', background: 'var(--mantine-color-orange-light)' }}>
          <Group gap={8}>
            <ThemeIcon size={28} radius="md" variant="light" color="orange"><IconAlertTriangle size={16} /></ThemeIcon>
            <Text size="sm">
              {caidos.length > 0 && <b>No se pudo medir {caidos.map(n => n.name).join(', ')}: su agente no contestó. </b>}
              {discoLleno.length > 0 && <>Disco al límite en <b>{discoLleno.map(n => `${n.name} (${n.disk.pct}%)`).join(', ')}</b>: revisá las grabaciones.</>}
            </Text>
          </Group>
        </Card>
      )}

      {/* Va arriba de las tarjetas y con el mismo peso que una caída, no en un tooltip:
          el que mira tiene que enterarse ANTES de leer los números, porque el problema es
          que los números se ven perfectos. */}
      {clonados.length > 0 && (
        <Card withBorder radius="lg" padding="sm" style={{ borderColor: 'var(--mantine-color-red-4)', background: 'var(--mantine-color-red-light)' }}>
          <Group gap={8} wrap="nowrap" align="flex-start">
            <ThemeIcon size={28} radius="md" variant="light" color="red"><IconAlertTriangle size={16} /></ThemeIcon>
            <div>
              <Text size="sm" fw={700}>Estos nodos están reportando la misma máquina</Text>
              <Text size="sm">
                {clonados.map(g => g.nodos.map(x => x.name).join(' · ')).join(' / ')} devuelven la misma
                memoria total, los mismos vCPU y el mismo uptime al segundo. Dos máquinas que arrancaron
                por separado no coinciden al segundo: lo que están leyendo sus agentes es el servidor
                físico que las hospeda, no cada contenedor. Por eso esos tres valores aparecen como no
                medidos en las tarjetas. El disco sí es de cada nodo: se mide sobre su propio sistema de
                archivos, que es lo único que adentro de un contenedor está separado de verdad.
              </Text>
            </div>
          </Group>
        </Card>
      )}

      {nodes.length === 0 ? (
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap={8} wrap="nowrap">
            <ThemeIcon size={28} radius="md" variant="light" color={err ? 'red' : 'gray'}><IconServer2 size={16} /></ThemeIcon>
            <Text size="sm" c={err ? 'red' : 'dimmed'}>
              {err ? 'No se pudo leer el inventario de nodos: ' + err.message : 'Leyendo el inventario de nodos…'}
            </Text>
          </Group>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
          {nodes.map(n => <NodeCard key={n.id} n={n} clonado={idsClonados.has(n.id)} />)}
        </SimpleGrid>
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="sm" mb="md">
            <ThemeIcon size={34} radius="md" variant="light" color="indigo"><IconNetwork size={18} /></ThemeIcon>
            <div><Text fw={700}>Interfaces de red</Text><Text size="xs" c="dimmed">Todas las placas de todos los nodos, con su tráfico acumulado</Text></div>
          </Group>
          {ifaces.length === 0 ? <Text c="dimmed" size="sm" ta="center" py="md">Sin datos de interfaces.</Text> :
            <Table.ScrollContainer minWidth={480}>
              <Table verticalSpacing="xs" highlightOnHover>
                <Table.Thead><Table.Tr>
                  <Table.Th>Nodo</Table.Th><Table.Th>Interfaz</Table.Th><Table.Th>Dirección</Table.Th>
                  <Table.Th>Estado</Table.Th><Table.Th>Recibido</Table.Th><Table.Th>Enviado</Table.Th>
                </Table.Tr></Table.Thead>
                <Table.Tbody>
                  {ifaces.map((i, k) => (
                    <Table.Tr key={k}>
                      <Table.Td><Text size="xs" c="dimmed">{i.node}</Text></Table.Td>
                      <Table.Td><Text size="sm" fw={600} ff="monospace">{i.name}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{(i.addrs || []).join(' · ') || '—'}</Text></Table.Td>
                      <Table.Td><Badge size="xs" variant="light" color={/up/i.test(i.state) ? 'teal' : 'gray'}>{i.state || '—'}</Badge></Table.Td>
                      <Table.Td><Group gap={4} wrap="nowrap"><IconArrowDown size={12} color="var(--mantine-color-teal-6)" /><Text size="xs">{fmtBytes(i.rx_bytes)}</Text></Group></Table.Td>
                      <Table.Td><Group gap={4} wrap="nowrap"><IconArrowUp size={12} color="var(--mantine-color-blue-6)" /><Text size="xs">{fmtBytes(i.tx_bytes)}</Text></Group></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>}
        </Card>

        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group gap="sm" mb="md">
            <ThemeIcon size={34} radius="md" variant="light" color="grape"><IconDeviceSdCard size={18} /></ThemeIcon>
            <div><Text fw={700}>Uso de espacio</Text><Text size="xs" c="dimmed">Qué se está comiendo el disco</Text></div>
          </Group>
          {st.disk && (
            <Group align="center" gap="lg" mb="md" wrap="nowrap">
              <RingProgress size={112} thickness={11} roundCaps
                sections={[{ value: st.disk.pct, color: tone(st.disk.pct) }]}
                label={<div style={{ textAlign: 'center' }}><Text fw={800} fz="lg" lh={1}><Slot value={st.disk.pct} />%</Text><Text fz={10} c="dimmed">usado</Text></div>} />
              <Stack gap={6} style={{ flex: 1 }}>
                <Group justify="space-between"><Text size="xs" c="dimmed">Total</Text><Text size="xs" fw={700}>{fmtBytes(st.disk.total)}</Text></Group>
                <Group justify="space-between"><Text size="xs" c="dimmed">Ocupado</Text><Text size="xs" fw={700}>{fmtBytes(st.disk.used)}</Text></Group>
                <Group justify="space-between"><Text size="xs" c="dimmed">Libre</Text><Text size="xs" fw={700} c={st.disk.pct >= 85 ? 'red' : undefined}>{fmtBytes(st.disk.free)}</Text></Group>
              </Stack>
            </Group>
          )}
          <Divider mb="sm" />
          <Stack gap={10}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={8}><ThemeIcon size={26} radius="md" variant="light" color="red"><IconMicrophone2 size={14} /></ThemeIcon><Text size="sm">Grabaciones</Text></Group>
              <Tooltip label={st.recordings ? st.recordings.files + ' archivos' : 'sin datos'}>
                <Text size="sm" fw={700}>{st.recordings ? fmtBytes(st.recordings.bytes) : '—'}</Text>
              </Tooltip>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={8}><ThemeIcon size={26} radius="md" variant="light" color="orange"><IconMailbox size={14} /></ThemeIcon><Text size="sm">Buzones de voz</Text></Group>
              <Tooltip label={st.voicemail ? st.voicemail.files + ' archivos' : 'sin datos'}>
                <Text size="sm" fw={700}>{st.voicemail ? fmtBytes(st.voicemail.bytes) : '—'}</Text>
              </Tooltip>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={8}><ThemeIcon size={26} radius="md" variant="light" color="blue"><IconDatabase size={14} /></ThemeIcon><Text size="sm">Base de datos</Text></Group>
              <Tooltip label={st.db && st.db.ok ? `${st.db.cdr} llamadas en el CDR · ${st.db.conns} conexiones` : 'sin datos'}>
                <Text size="sm" fw={700}>{st.db && st.db.ok ? fmtBytes(st.db.bytes) : '—'}</Text>
              </Tooltip>
            </Group>
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
