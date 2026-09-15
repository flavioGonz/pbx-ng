'use client';
import { useEffect, useMemo, useState, useRef } from 'react';
import { usePoll, useApi } from './api';
import { fmtBytes, fmtUptime, fmtFechaHora, fmtReloj } from './fmt';
import { SimpleGrid, Card, Group, Text, ThemeIcon, Badge, Stack, RingProgress, Progress, Box, Divider, Alert, Grid, Anchor } from '@mantine/core';
import Link from 'next/link';
import Slot from './Slot';
import { IconServer2, IconCpu, IconDatabase, IconDeviceLandlinePhone, IconUsers, IconPhone, IconHeadset, IconUsersGroup, IconClock, IconActivity, IconWorld, IconShieldLock, IconRouteAltLeft, IconCircleFilled, IconDeviceSdCard, IconLayoutDashboard, IconBolt, IconPlugConnected, IconAlertTriangle, IconArrowRight, IconBan, IconPhoneOff } from '@tabler/icons-react';
import PageHeader from './PageHeader';
import AttackGlobe from './AttackGlobe';
import { useLive } from './useLive';

// Gráfico de área inline (CPU + Memoria), sin dependencias
function AreaChart({ cpu, mem, h = 150 }) {
  const w = 320; const n = Math.max(cpu.length, 2);
  const pts = (arr) => arr.map((v, i) => [(i / (n - 1)) * w, h - (Math.max(0, Math.min(100, v)) / 100) * (h - 8) - 4]);
  const line = (p) => p.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
  const area = (p) => p.length ? line(p) + ` L${w} ${h} L0 ${h} Z` : '';
  const cp = pts(cpu.length ? cpu : [0, 0]); const mp = pts(mem.length ? mem : [0, 0]);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: h }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="gcpu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4f7fd9" stopOpacity=".35" /><stop offset="1" stopColor="#4f7fd9" stopOpacity="0" /></linearGradient>
        <linearGradient id="gmem" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b06ad6" stopOpacity=".3" /><stop offset="1" stopColor="#b06ad6" stopOpacity="0" /></linearGradient>
      </defs>
      {[25, 50, 75].map(y => <line key={y} x1="0" x2={w} y1={h - (y / 100) * (h - 8) - 4} y2={h - (y / 100) * (h - 8) - 4} stroke="rgba(120,130,150,.12)" strokeWidth="1" />)}
      <path d={area(mp)} fill="url(#gmem)" /><path d={line(mp)} fill="none" stroke="#b06ad6" strokeWidth="2" />
      <path d={area(cp)} fill="url(#gcpu)" /><path d={line(cp)} fill="none" stroke="#4f7fd9" strokeWidth="2" />
    </svg>
  );
}
function Donut({ value, color, label, center, sub }) {
  return (
    <Stack align="center" gap={4}>
      <RingProgress size={130} thickness={11} roundCaps sections={[{ value, color }]} label={<div style={{ textAlign: 'center' }}><Text fw={800} fz="lg" lh={1}>{center}</Text>{sub && <Text fz={10} c="dimmed">{sub}</Text>}</div>} />
      <Text size="sm" c="dimmed">{label}</Text>
    </Stack>
  );
}
function StatRow({ icon, label, value, color = 'pbx' }) {
  return <Group justify="space-between" wrap="nowrap" py={6} style={{ borderBottom: '1px solid var(--mantine-color-gray-1)' }}>
    <Group gap={8} wrap="nowrap"><ThemeIcon size={26} radius="md" variant="light" color={color}>{icon}</ThemeIcon><Text size="sm" c="dimmed">{label}</Text></Group>
    <Text fw={700} size="sm">{value}</Text></Group>;
}
function Bar({ label, value, total, color = 'pbx' }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return <Box mb="sm"><Group justify="space-between" mb={3}><Text size="sm" c="dimmed">{label}</Text><Text size="sm" fw={600}>{value}{total != null ? ' / ' + total : ''}</Text></Group><Progress value={pct} color={color} radius="xl" size="sm" /></Box>;
}


/* Número grande de arriba. Es lo único que el operador mira de lejos, así que va sin
 * adornos: valor, qué es, y un pie que sólo aparece si dice algo (una troncal caída, un
 * ataque en curso). El color pasa a rojo únicamente cuando hay que hacer algo. */
function KpiVivo({ icon, valor, label, pie, color = 'pbx', alerta = false }) {
  return (
    <Card withBorder radius="lg" padding="md" shadow="sm" style={alerta ? { borderColor: 'var(--mantine-color-red-5)' } : undefined}>
      <Group gap={10} wrap="nowrap" align="flex-start">
        <ThemeIcon size={38} radius="md" variant="light" color={alerta ? 'red' : color}>{icon}</ThemeIcon>
        <div style={{ minWidth: 0 }}>
          <Text fw={800} fz={30} lh={1} c={alerta ? 'red.6' : undefined}><Slot value={valor} /></Text>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700} mt={4} style={{ letterSpacing: '.03em' }}>{label}</Text>
          {pie && <Text size="xs" c={alerta ? 'red.6' : 'dimmed'} mt={2} truncate>{pie}</Text>}
        </div>
      </Group>
    </Card>
  );
}

/* Llamadas en curso. Sale del snapshot del socket (no encuesta nada) y el cronómetro
 * corre en el navegador: un `tick` por segundo que sólo re-dibuja esta tarjeta. La
 * duración se calcula recién después de montar para no romper la hidratación —el
 * servidor no puede saber qué hora es en el navegador (ya nos pasó con el tema). */
function LlamadasVivas({ canales, montado, ahora }) {
  const dur = (c) => {
    if (!montado || !c.started) return null;
    const t = Math.floor((ahora - new Date(c.started).getTime()) / 1000);
    return t >= 0 && t < 86400 ? fmtReloj(t) : null;
  };
  const est = (c) => (c.state === 'Up' ? { t: 'En conversación', col: 'teal' }
    : c.state === 'Ringing' || c.state === 'Ring' ? { t: 'Timbrando', col: 'orange' }
    : { t: c.state || 'En curso', col: 'gray' });
  return (
    <Card withBorder radius="lg" padding="lg" shadow="sm" style={{ height: '100%' }}>
      <Group justify="space-between" mb="sm">
        <Group gap="sm">
          <ThemeIcon size={38} radius="md" variant="light" color={canales.length ? 'teal' : 'gray'}><IconPhone size={20} /></ThemeIcon>
          <div><Text fw={800} lh={1.1}>Llamadas en curso</Text><Text size="xs" c="dimmed">En vivo, por eventos de Asterisk</Text></div>
        </Group>
        <Badge size="lg" variant="light" color={canales.length ? 'teal' : 'gray'}>{canales.length}</Badge>
      </Group>
      {canales.length === 0 ? (
        <Stack align="center" gap={6} py={40}>
          <ThemeIcon size={54} radius="xl" variant="light" color="gray"><IconPhoneOff size={26} /></ThemeIcon>
          <Text size="sm" c="dimmed">Ninguna llamada en este momento.</Text>
          <Text size="xs" c="dimmed">Cuando entre o salga una, aparece acá sola.</Text>
        </Stack>
      ) : (
        <Stack gap={2} mah={330} style={{ overflowY: 'auto' }}>
          {canales.map((c) => {
            const e = est(c); const d = dur(c);
            return (
              <Group key={c.id} justify="space-between" wrap="nowrap" py={9} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
                <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
                  <IconCircleFilled size={9} className={c.state === 'Up' ? 'pbx-pulse' : undefined} color={`var(--mantine-color-${e.col}-6)`} />
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <Text size="sm" fw={650} ff="monospace" truncate>{c.caller || c.ext || '?'}</Text>
                    <IconArrowRight size={13} style={{ opacity: .45, flex: 'none' }} />
                    <Text size="sm" ff="monospace" truncate c="dimmed">{c.connected || '—'}</Text>
                  </Group>
                </Group>
                <Group gap={8} wrap="nowrap">
                  <Badge size="sm" variant="light" color={e.col}>{e.t}</Badge>
                  <Text size="sm" fw={700} ff="monospace" w={62} ta="right">{d || '—'}</Text>
                </Group>
              </Group>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}

export default function Resumen() {
  const { snap, connected } = useLive();
  /* Presupuesto de pedidos de esta pantalla (era ~44 por minuto: /metrics cada 3 s,
   * /asterisk/core cada 6 s, /trunks cada 10 s y el /system/overview propio de
   * SystemOverview cada 8 s). Ahora:
   *   - lo VIVO (canales, extensiones, colas, AMI/ARI/base) llega por el snapshot del
   *     socket: no se encuesta nada de eso;
   *   - /system/overview cada 30 s es la ÚNICA fuente de recursos. Trae lo mismo que
   *     /metrics (su nodo `core` es el mismo `os.*` del host, más `storage.db`), así
   *     que /metrics se fue y SystemOverview ya no encuesta por su cuenta;
   *   - lo que cambia poco (versión del motor, transportes, módulos, troncales,
   *     topología medida) va a 60 s;
   *   - /system son tres comandos AMI y sólo lista módulos: una sola vez.
   * Total en régimen: 2 + 1 + 1 + 1 = 5 pedidos por minuto, y CERO con la pestaña
   * en segundo plano (usePoll se frena solo). Ver "pedido a api" en el informe:
   * con troncales y topología dentro del snapshot esto bajaría a 2 por minuto. */
  const { data: ov } = usePoll('/system/overview', 30000);
  const { data: trunksData } = usePoll('/trunks', 60000);
  const { data: core } = usePoll('/asterisk/core', 60000);
  const { data: sys } = useApi('/system');
  /* Antes era `useApi` (una sola carga): el cartel "Hay componentes caídos" se
   * dibujaba con la medición del momento en que abriste la pestaña y no se
   * enteraba nunca más. Con un minuto de cadencia sigue siendo barato y avisa. */
  const { data: topo } = usePoll('/topology', 60000);
  /* El SOC ya vive en /seguridad; acá se trae lo mismo cada 60 s sólo para el globo y
   * el número de bloqueos. Es el único pedido que se suma (6 por minuto en total) y es
   * el que hace que esta pantalla sirva de verdad: un ataque en curso se ve al entrar,
   * sin tener que acordarse de abrir la otra pestaña. */
  const { data: soc } = usePoll('/security', 60000);
  /* El relay de medios. Va aparte de `/topology` porque la topología sólo mide puertos y
   * un TURN que contesta el puerto puede estar repartiendo una dirección privada —que es
   * exactamente lo que pasaba acá—. Esta sonda hace un Allocate y mira el candidato. */
  const { data: turn } = usePoll('/turn/estado', 60000);
  /* `[]` literal como dependencia de un hook es el bug de React #185 que ya nos comió
   * /troncales dos veces: cada render arma un arreglo nuevo y el efecto se llama solo
   * para siempre. Memoizado, y `npm run check:deps` lo vigila. */
  const trunks = useMemo(() => (Array.isArray(trunksData) ? trunksData : []), [trunksData]);

  /* Cronómetro de las llamadas en curso. Corre en el navegador (un `setInterval` de 1 s)
   * y SÓLO mientras haya una llamada viva: con la central en silencio no hay timer.
   * `montado` evita que el servidor y el navegador calculen duraciones distintas al
   * hidratar —la hidratación ya nos rompió el tema una vez. */
  const [montado, setMontado] = useState(false);
  const [ahora, setAhora] = useState(0);
  const hayCanales = (snap?.channels || []).length > 0;
  useEffect(() => { setMontado(true); setAhora(Date.now()); }, []);
  useEffect(() => {
    if (!hayCanales) return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hayCanales]);

  /* Mismos campos que devolvía /api/metrics, armados desde /system/overview para no
   * pedir dos veces lo mismo (el nodo `core` es el host donde corre la API). Va con
   * `useMemo` y no como objeto suelto porque abajo hay un efecto que agrega un punto
   * al gráfico por cada medición nueva: con una identidad distinta en cada render se
   * llamaría a sí mismo para siempre. */
  const m = useMemo(() => {
    const n = (ov?.nodes || []).find((x) => x.id === 'core');
    if (!n) return null;
    return {
      cpu: n.cpu_pct,
      cores: n.ncpu,
      load: n.load != null ? [n.load] : null,
      uptime: n.uptime_s,
      mem: n.mem_total_mb ? { total: n.mem_total_mb * 1048576, used: n.mem_used_mb * 1048576 } : null,
      disk: n.disk,
      db_size: ov?.storage?.db?.ok ? ov.storage.db.bytes : null,
    };
  }, [ov]);
  const [hist, setHist] = useState({ cpu: [], mem: [] });
  const histRef = useRef({ cpu: [], mem: [] });

  // La serie del gráfico se arma con cada medición que llega: 40 puntos, ahora a 30 s
  // cada uno, o sea ~20 minutos de historia en vez de ~2. Para una tendencia de CPU y
  // memoria alcanza y sobra, y es lo que permite tener un solo poll en la pantalla.
  useEffect(() => {
    if (!m) return;
    const pct = m.mem ? Math.round((m.mem.used / m.mem.total) * 100) : 0;
    histRef.current = { cpu: [...histRef.current.cpu, m.cpu || 0].slice(-40), mem: [...histRef.current.mem, pct].slice(-40) };
    setHist(histRef.current);
  }, [m]);

  const eps = snap?.extensions || [], ch = snap?.channels || [], qs = snap?.queues || [], h = snap?.health || {};
  const online = eps.filter(e => e.status === 'online').length;
  const webrtc = eps.filter(e => e.webrtc).length;
  const diskPct = m?.disk ? Math.round((m.disk.used / m.disk.total) * 100) : 0;
  const memPct = m?.mem ? Math.round((m.mem.used / m.mem.total) * 100) : 0;
  const trAvail = trunks.filter(t => t.status === 'online').length;
  const trSbc = trunks.filter(t => t.status === 'sbc').length;
  const trDown = trunks.filter(t => t.status === 'offline').length;
  const trOther = trunks.length - trAvail - trSbc - trDown;

  // SOC: sólo los cuatro números que se miran de lejos. El detalle está en /seguridad.
  const socK = (soc && soc.kpis) || {};
  const ataque = (soc && soc.ataque) || null;

  const comps = sys?.components || [];

  /* Estado MEDIDO por el backend. Antes esta lista tenia la fila del borde escrita
   * a mano como `ok: true`: literalmente no podia detectar una caida. El 2026-07-21
   * el borde estuvo apagado medio dia y esta pantalla lo mostro verde todo el rato. */
  const medidos = Array.isArray(topo?.componentes) ? topo.componentes : [];
  const bordesExt = Array.isArray(topo?.bordes_externos) ? topo.bordes_externos : [];
  const med = (id) => medidos.find((c) => c.id === id) || null;

  /* Tres estados, no dos. Antes esto era un booleano y "todavia no se" se contaba como
   * "caido": `h = snap?.health || {}` deja h.ari/h.ami/h.db en undefined hasta que llega
   * el primer snapshot del socket, asi que en CADA carga del panel la pantalla acusaba
   * a Asterisk y a la base de datos de estar caidos durante un segundo y despues se
   * arrepentia. Una alarma que grita antes de mirar no la cree nadie.
   *   'ok'      -> medido y responde
   *   'caido'   -> medido y NO responde
   *   'esperando' -> todavia no hay dato; no se muestra ni verde ni rojo */
  const OK = 'ok', CAIDO = 'caido', ESPERANDO = 'esperando';
  const y = (...partes) => (partes.some((p) => p === CAIDO) ? CAIDO
    : partes.some((p) => p === ESPERANDO) ? ESPERANDO : OK);
  const vivo = (v) => (v === undefined || v === null ? ESPERANDO : v ? OK : CAIDO);
  // estado del nodo segun la medicion por puerto del backend (topology). Si el backend
  // todavia no contesto, es 'esperando'; si contesto pero no mide ese nodo, no opina.
  const estMed = (id) => { if (!topo) return ESPERANDO; const c = med(id); return c ? (c.estado === 'ok' ? OK : CAIDO) : null; };
  const estComp = (rx) => { if (!sys) return ESPERANDO; const c = comps.find((x) => rx.test(x.name)); return c ? (c.status === 'down' ? CAIDO : OK) : null; };
  const combinar = (...partes) => y(...partes.filter((p) => p !== null));

  const svcList = [
    { n: 'Asterisk (AMI/ARI)', est: combinar(vivo(h.ari), vivo(h.ami), estMed('asterisk')), ip: topo?.nodes?.asterisk || '-' },
    { n: 'Base de datos', est: combinar(vivo(h.db), estMed('db')), ip: topo?.nodes?.db || '-' },
    /* El relay de medios es de ESTA central (el coturn propio), no del borde. La fila
     * mostraba `TURN_HOST`, que en pbx01 apuntaba al SBC desde que se desconectó: un
     * servicio de otra máquina, dado por «Operativo» porque un puerto contestaba. Ahora
     * el estado sale de la sonda real (`/api/turn/estado`), que hace un Allocate y mira
     * el candidato relay: un TURN que contesta pero reparte una dirección privada es una
     * FALLA, no un OK. */
    { n: 'Relay de medios (TURN)', est: !turn ? ESPERANDO : (turn.corriendo ? OK : CAIDO),
      ip: (turn && turn.host) ? turn.host + ' · ' + turn.origen : '—',
      detalle: (turn && !turn.corriendo && turn.motivo) || '' },
    { n: 'Proxy NPM (TLS/WSS)', est: combinar(estMed('proxy') ?? estComp(/Proxy/i)), ip: topo?.nodes?.npm || '-' },
    // Bordes EXTERNOS: otro producto, con su propio panel. Se listan aparte para que
    // se vea que su caida no es una falla de esta central, pero si le corta la salida.
    // Solo aparecen con el modulo "Conexion a SBC-NG" activo (el backend no los manda si no).
    ...bordesExt.map((b) => ({ n: 'SBC-NG (' + b.nombre + ')', est: b.estado === 'ok' ? OK : CAIDO, ip: b.host, detalle: b.motivo, externo: true })),
  ].map((s) => ({ ...s, ok: s.est === OK }));

  /* Y ademas: no alarmar por un parpadeo. Un reinicio de AMI o un socket que se cae y
   * vuelve dejaba el cartel rojo asomando y desapareciendo. La caida tiene que
   * SOSTENERSE unos segundos para que el cartel salga; se va apenas vuelve. */
  const CONFIRMAR_MS = 6000;
  const caidosAhora = svcList.filter((s) => s.est === CAIDO);
  const firmaCaidos = caidosAhora.map((s) => s.n).sort().join('|');
  const [caidosFirmes, setCaidosFirmes] = useState('');
  useEffect(() => {
    if (!firmaCaidos) { setCaidosFirmes(''); return; }          // se recupero: sale ya
    const t = setTimeout(() => setCaidosFirmes(firmaCaidos), CONFIRMAR_MS);
    return () => clearTimeout(t);
  }, [firmaCaidos]);
  const caidos = caidosFirmes === firmaCaidos ? caidosAhora : [];

  return (
    <Stack gap="lg">
      <PageHeader icon={<IconLayoutDashboard size={24} />} title="Resumen" subtitle="Estado de la plataforma en tiempo real" color="pbx"
        right={<Badge size="lg" radius="sm" variant="light" color={connected ? 'teal' : 'gray'} leftSection={<IconCircleFilled size={9} className="pbx-pulse" />}>{connected ? 'En vivo' : 'Conectando…'}</Badge>} />

      {/* Lo primero que tiene que ver el operador si algo se cayo. Antes no habia
          nada de esto: el borde podia estar muerto y la pantalla se veia normal. */}
      {caidos.length > 0 && (
        <Alert color="red" variant="light" radius="md" icon={<IconAlertTriangle size={20} />}
          title={caidos.length === 1 ? 'Hay un componente caído' : `Hay ${caidos.length} componentes caídos`}>
          <Stack gap={4}>
            {caidos.map((c) => (
              <Text key={c.n} size="sm">
                <b>{c.n}</b> ({c.ip}){c.detalle ? ' — ' + c.detalle : ' — no responde'}
                {c.externo && <Text span c="dimmed" size="xs"> · es otro producto, se administra en su propio panel</Text>}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      {/* Lo vivo arriba y grande: llamadas en curso a la izquierda, el globo del SOC
          girando a la derecha. Es lo que uno quiere ver al entrar; el inventario de la
          plataforma (núcleo, nodos, módulos) pasó al final, que es donde se consulta. */}
      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Stack gap="lg">
            <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
              <KpiVivo icon={<IconPhone size={20} />} valor={ch.length} label="Llamadas activas" color="teal"
                pie={qs.length ? qs.length + (qs.length === 1 ? ' cola' : ' colas') : null} />
              <KpiVivo icon={<IconHeadset size={20} />} valor={online} label="Extensiones en línea" color="pbx"
                pie={eps.length ? 'de ' + eps.length + (webrtc ? ' · ' + webrtc + ' WebRTC' : '') : null} />
              <KpiVivo icon={<IconDeviceLandlinePhone size={20} />} valor={trAvail} label="Troncales activas" color="grape"
                alerta={trDown > 0}
                pie={trDown > 0 ? trDown + (trDown === 1 ? ' caída' : ' caídas') : 'de ' + trunks.length} />
              <KpiVivo icon={<IconBan size={20} />} valor={socK.bloqueados ?? 0} label="IP bloqueadas" color="orange"
                alerta={!!ataque}
                pie={ataque ? 'Ataque en curso' : (socK.fallos_24h || 0) + ' intentos en 24 h'} />
            </SimpleGrid>
            <LlamadasVivas canales={ch} montado={montado} ahora={ahora} />
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          {/* El mismo globo del SOC, con los mismos datos: no se duplica nada, se mira
              desde acá. El aviso de ataque en curso vive dentro del mapa. */}
          <AttackGlobe paises={(soc && soc.top_paises) || []} bloqueos={(soc && soc.bloqueos) || []}
            geoblock={(soc && soc.geoblock) || null} ataque={ataque} kpis={socK}
            titulo="Ataques en vivo" />
        </Grid.Col>
      </Grid>


      {/* Hardware: espacio y recursos del equipo, que es lo único de la máquina que se mira
          todos los días. El inventario por nodo vive en /sistema. */}
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={600} mb="md">Uso de espacio</Text>
          <SimpleGrid cols={2}>
            <Donut value={diskPct} color={diskPct > 85 ? 'red' : 'pbx'} label="Disco" center={diskPct + '%'} sub={m?.disk ? fmtBytes(m.disk.used) : ''} />
            <Donut value={memPct} color={memPct > 85 ? 'red' : 'grape'} label="Memoria" center={memPct + '%'} sub={m?.mem ? fmtBytes(m.mem.used) : ''} />
          </SimpleGrid>
          <Divider my="sm" />
          <Group justify="space-between"><Text size="xs" c="dimmed">Disco total</Text><Text size="xs" fw={600}>{m?.disk ? fmtBytes(m.disk.total) : '—'}</Text></Group>
          <Group justify="space-between"><Text size="xs" c="dimmed">Base de datos</Text><Text size="xs" fw={600}>{fmtBytes(m?.db_size)}</Text></Group>
        </Card>

        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Text fw={600} mb="md">Uso de recursos</Text>
          <Group align="flex-start" wrap="nowrap" gap="md">
            <Box style={{ flex: 1, minWidth: 0 }}><AreaChart cpu={hist.cpu} mem={hist.mem} /></Box>
            <Stack gap={2} w={92}>
              <Text fw={800} fz={26} lh={1} c="#4f7fd9"><Slot value={m?.cpu ?? 0} />%</Text><Text size="xs" c="dimmed" mb="sm">CPU</Text>
              <Text fw={800} fz={26} lh={1} c="#b06ad6"><Slot value={memPct} />%</Text><Text size="xs" c="dimmed">Memoria</Text>
            </Stack>
          </Group>
          <Group gap="lg" mt="xs"><Group gap={5}><span style={{ width: 10, height: 10, borderRadius: 3, background: '#4f7fd9' }} /><Text size="xs" c="dimmed">CPU ({m?.cores || '?'} cores)</Text></Group><Group gap={5}><span style={{ width: 10, height: 10, borderRadius: 3, background: '#b06ad6' }} /><Text size="xs" c="dimmed">Memoria</Text></Group><Text size="xs" c="dimmed" ml="auto">load {m?.load ? m.load[0].toFixed(2) : '—'}</Text></Group>
        </Card>

      </SimpleGrid>

      {/* Troncales. «Estado del PBX» y «Estado de interfaces» se fueron: repetían los
          números grandes de arriba y la lista de servicios de al lado. Una pantalla que
          dice tres veces lo mismo no informa más, informa peor. */}
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group justify="space-between" mb="md"><Text fw={600}>Troncales</Text><Badge variant="light" color="gray">{trunks.length} total</Badge></Group>
          <Group wrap="nowrap" gap="lg" align="center">
            <RingProgress size={120} thickness={12} roundCaps
              sections={[{ value: trunks.length ? (trAvail / trunks.length) * 100 : 0, color: 'teal' }, { value: trunks.length ? (trSbc / trunks.length) * 100 : 0, color: 'grape' }, { value: trunks.length ? (trDown / trunks.length) * 100 : 0, color: 'red' }]}
              label={<div style={{ textAlign: 'center' }}><Text fw={800} fz="xl" lh={1}>{trunks.length}</Text><Text fz={10} c="dimmed">troncales</Text></div>} />
            <Stack gap={6} style={{ flex: 1 }}>
              <Group justify="space-between"><Group gap={6}><IconCircleFilled size={9} color="var(--mantine-color-teal-6)" /><Text size="sm" c="dimmed">Disponibles</Text></Group><Text fw={700} size="sm">{trAvail}</Text></Group>
              {trSbc > 0 && <Group justify="space-between"><Group gap={6}><IconCircleFilled size={9} color="var(--mantine-color-grape-6)" /><Text size="sm" c="dimmed">Vía SBC-NG</Text></Group><Text fw={700} size="sm">{trSbc}</Text></Group>}
              <Group justify="space-between"><Group gap={6}><IconCircleFilled size={9} color="var(--mantine-color-red-6)" /><Text size="sm" c="dimmed">Caídas</Text></Group><Text fw={700} size="sm">{trDown}</Text></Group>
              <Group justify="space-between"><Group gap={6}><IconCircleFilled size={9} color="var(--mantine-color-gray-5)" /><Text size="sm" c="dimmed">Sin registrar</Text></Group><Text fw={700} size="sm">{trOther}</Text></Group>
            </Stack>
          </Group>
          <Divider my="sm" />
          <Stack gap={4}>
            {trunks.slice(0, 4).map(t => (
              <Group key={t.name} justify="space-between"><Group gap={6}><IconDeviceLandlinePhone size={14} color="var(--mantine-color-gray-6)" /><Text size="sm" truncate maw={150}>{t.name}</Text></Group><IconCircleFilled size={9} color={t.status === 'online' ? 'var(--mantine-color-teal-6)' : t.status === 'sbc' ? 'var(--mantine-color-grape-6)' : t.status === 'offline' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-gray-5)'} /></Group>
            ))}
            {trunks.length === 0 && <Text size="sm" c="dimmed" ta="center" py="sm">Sin troncales configuradas.</Text>}
          </Stack>
        </Card>
        <Card withBorder radius="lg" padding="lg" shadow="sm">
          <Group justify="space-between" mb="md">
            <Text fw={600}>Servicios principales</Text>
            <Anchor component={Link} href="/sistema" size="xs">Ver el sistema en detalle →</Anchor>
          </Group>
          <Stack gap={2}>
            {svcList.map(s => (
              <Group key={s.n} justify="space-between" py={7} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
                <Group gap={8}><ThemeIcon size={28} radius="md" variant="light" color={s.est === CAIDO ? 'red' : s.est === OK ? 'teal' : 'gray'}><IconServer2 size={15} /></ThemeIcon><div><Text size="sm" fw={500} lh={1.1}>{s.n}</Text><Text size="xs" c="dimmed" ff="monospace">{s.ip}</Text></div></Group>
                <Badge variant="light" color={s.est === CAIDO ? 'red' : s.est === OK ? 'teal' : 'gray'}>{s.est === CAIDO ? 'Caído' : s.est === OK ? 'Operativo' : 'Midiendo…'}</Badge>
              </Group>
            ))}
          </Stack>
        </Card>
      </SimpleGrid>

    </Stack>
  );
}
