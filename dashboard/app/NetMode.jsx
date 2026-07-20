'use client';
/* ============================================================================
 *  Modo de red del núcleo: ROUTER o SWITCH (mismo concepto que en SBC-NG).
 *
 *  Cambiar el modo puede cortar la conexión con el panel (si te comés la placa por
 *  la que estás entrando). Por eso el flujo es en tres tiempos:
 *    1) elegís el modo y mirás EL PLAN (los comandos exactos, explicados)
 *    2) aplicás — arranca un reloj de rollback
 *    3) confirmás; si no confirmás (porque perdiste el panel), vuelve solo al modo anterior
 * ==========================================================================*/
import { useEffect, useState } from 'react';
import {
  Card, Group, Text, Badge, Stack, Button, Select, Switch, Alert, Code, Progress,
  ThemeIcon, Tooltip, SimpleGrid, Modal, List,
} from '@mantine/core';
import {
  IconRouter, IconTopologyBus, IconAlertTriangle, IconPlayerPlay, IconCheck,
  IconArrowBackUp, IconListCheck, IconInfoCircle,
} from '@tabler/icons-react';
import { toast, toastPromise } from './notify';

async function api(path, opts = {}) {
  const r = await fetch('/backend/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

/* Dibujo simple del modo: dos placas separadas (router) o unidas por un puente (switch). */
function Diagrama({ modo, wan, lan, nat }) {
  const router = modo !== 'switch';
  const C = { wan: '#f59e0b', lan: '#3b82f6', br: '#8b5cf6', line: 'var(--mantine-color-default-border)' };
  return (
    <svg viewBox="0 0 420 150" style={{ width: '100%', maxWidth: 420, height: 'auto' }}>
      <rect x="150" y="45" width="120" height="60" rx="12" fill="rgba(59,130,246,.10)" stroke={C.lan} strokeWidth="2" />
      <text x="210" y="70" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor">PBX-NG</text>
      <text x="210" y="88" textAnchor="middle" fontSize="10" fill="currentColor" opacity=".65">{router ? 'router' : 'switch (puente)'}</text>

      {router ? (
        <>
          <line x1="60" y1="75" x2="150" y2="75" stroke={C.wan} strokeWidth="2.5" />
          <text x="105" y="66" textAnchor="middle" fontSize="10" fill={C.wan} fontWeight="700">WAN {wan || '?'}</text>
          {nat && <text x="105" y="92" textAnchor="middle" fontSize="9" fill="currentColor" opacity=".6">NAT</text>}
          <line x1="270" y1="75" x2="360" y2="75" stroke={C.lan} strokeWidth="2.5" />
          <text x="315" y="66" textAnchor="middle" fontSize="10" fill={C.lan} fontWeight="700">LAN {lan || '?'}</text>
          <circle cx="45" cy="75" r="14" fill="rgba(245,158,11,.15)" stroke={C.wan} strokeWidth="2" />
          <text x="45" y="79" textAnchor="middle" fontSize="9" fill="currentColor">net</text>
          <circle cx="375" cy="75" r="14" fill="rgba(59,130,246,.15)" stroke={C.lan} strokeWidth="2" />
          <text x="375" y="79" textAnchor="middle" fontSize="9" fill="currentColor">LAN</text>
        </>
      ) : (
        <>
          <rect x="40" y="115" width="340" height="22" rx="8" fill="rgba(139,92,246,.12)" stroke={C.br} strokeWidth="2" />
          <text x="210" y="130" textAnchor="middle" fontSize="10" fontWeight="700" fill={C.br}>puente (capa 2) — todas las placas en la misma red</text>
          <line x1="120" y1="105" x2="120" y2="115" stroke={C.br} strokeWidth="2" />
          <line x1="300" y1="105" x2="300" y2="115" stroke={C.br} strokeWidth="2" />
          <line x1="210" y1="105" x2="210" y2="115" stroke={C.br} strokeWidth="2" />
        </>
      )}
    </svg>
  );
}

export default function NetMode() {
  const [d, setD] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [plan, setPlan] = useState(null);
  const [confirmar, setConfirmar] = useState(false);   // modal de aplicar
  const [pend, setPend] = useState(null);      // { vence }
  const [restante, setRestante] = useState(0);

  const cargar = () => api('/net/mode').then((r) => { setD(r); setCfg(r.cfg); setPend(r.pendiente || null); }).catch((e) => toast(e.message, 'bad'));
  useEffect(() => { cargar(); }, []);

  // Reloj del rollback
  useEffect(() => {
    if (!pend) { setRestante(0); return; }
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((pend.vence - Date.now()) / 1000));
      setRestante(s);
      if (s === 0) { setPend(null); cargar(); }
    }, 1000);
    return () => clearInterval(t);
  }, [pend]);

  if (!d || !cfg) return <Card withBorder p="lg" radius="md"><Text size="sm" c="dimmed">Cargando red…</Text></Card>;

  const ifaces = (d.interfaces || []).map((i) => i.name || i.dev).filter(Boolean);
  const opciones = ifaces.map((n) => ({ value: n, label: n }));
  const esSwitch = cfg.modo === 'switch';

  const verPlan = () => api('/net/mode/plan', { method: 'POST', body: cfg })
    .then((r) => setPlan(r.pasos || []))
    .catch((e) => toast(e.message, 'bad'));

  const guardar = () => toastPromise(
    api('/net/mode', { method: 'PUT', body: cfg }).then(cargar),
    { loading: 'Guardando…', success: 'Guardado (todavía no se aplicó)', error: (e) => e.message });

  const aplicarAhora = () => {
    setConfirmar(false);
    toastPromise(
      api('/net/mode/apply', { method: 'POST', body: { confirmar: true, cfg, rollback_seg: 120 } })
        .then((r) => { setPend({ vence: r.confirmar_antes_de }); cargar(); return r; }),
      { loading: 'Aplicando modo de red…', success: 'Aplicado: confirmá antes de que venza el plazo', error: (e) => e.message });
  };
  // Abrir el modal trae el plan, así el operador ve exactamente qué se va a ejecutar
  // en la misma pantalla donde decide. Nadie debería aplicar un cambio de red a ciegas.
  const aplicar = () => {
    setConfirmar(true);
    api('/net/mode/plan', { method: 'POST', body: cfg })
      .then((r) => setPlan(r.pasos || []))
      .catch((e) => { toast(e.message, 'bad'); setConfirmar(false); });
  };

  const confirmarCambio = () => toastPromise(
    api('/net/mode/confirm', { method: 'POST' }).then(() => { setPend(null); cargar(); }),
    { loading: 'Confirmando…', success: 'Confirmado: el modo quedó fijo', error: (e) => e.message });

  const revertir = () => toastPromise(
    api('/net/mode/revert', { method: 'POST' }).then(() => { setPend(null); cargar(); }),
    { loading: 'Volviendo atrás…', success: 'Se volvió al modo anterior', error: (e) => e.message });

  return (
    <Stack gap="md">
      {pend && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />}>
          <Group justify="space-between" wrap="nowrap">
            <div style={{ flex: 1 }}>
              <Text fw={700} size="sm">Cambio aplicado, falta confirmar</Text>
              <Text size="xs" c="dimmed">Si no confirmás, la central vuelve sola al modo anterior en <b>{restante} s</b>. Es la red de seguridad por si perdiste el panel.</Text>
              <Progress value={Math.min(100, (restante / 120) * 100)} color="orange" size="sm" mt={6} />
            </div>
            <Group gap="xs">
              <Button size="compact-sm" color="teal" leftSection={<IconCheck size={14} />} onClick={confirmarCambio}>Confirmar</Button>
              <Button size="compact-sm" variant="default" leftSection={<IconArrowBackUp size={14} />} onClick={revertir}>Volver atrás</Button>
            </Group>
          </Group>
        </Alert>
      )}

      <Card withBorder p="lg" radius="md">
        <Group justify="space-between" mb="md">
          <Group gap={10}>
            <ThemeIcon size={34} radius="md" variant="light" color={esSwitch ? 'violet' : 'blue'}>
              {esSwitch ? <IconTopologyBus size={19} /> : <IconRouter size={19} />}
            </ThemeIcon>
            <div>
              <Text fw={700}>Modo de red del núcleo</Text>
              <Text size="xs" c="dimmed">Cómo se para la central en la red: ruteando entre dos placas o colgada de la red existente</Text>
            </div>
          </Group>
          <Badge size="lg" variant="light" color={esSwitch ? 'violet' : 'blue'}>{esSwitch ? 'SWITCH' : 'ROUTER'}</Badge>
        </Group>

        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <div>
            <Group gap="xs" mb="sm">
              {[['router', 'Router', IconRouter], ['switch', 'Switch', IconTopologyBus]].map(([v, lbl, Ic]) => {
                const on = cfg.modo === v;
                return (
                  <Button key={v} variant={on ? 'filled' : 'default'} color={v === 'switch' ? 'violet' : 'blue'}
                    leftSection={<Ic size={16} />} onClick={() => setCfg({ ...cfg, modo: v })}>{lbl}</Button>
                );
              })}
            </Group>

            {!esSwitch ? (
              <Stack gap="sm">
                <Select label="Placa WAN (hacia internet)" data={opciones} value={cfg.wan_if || null}
                  onChange={(v) => setCfg({ ...cfg, wan_if: v })} placeholder="elegí una placa" searchable />
                <Select label="Placa LAN (hacia la red interna)" data={opciones} value={cfg.lan_if || null}
                  onChange={(v) => setCfg({ ...cfg, lan_if: v })} placeholder="elegí una placa" searchable />
                <Switch label="NAT (enmascarar la LAN al salir)" checked={!!cfg.nat}
                  onChange={(e) => setCfg({ ...cfg, nat: e.currentTarget.checked })} />
                <Switch label="Rutear entre placas (ip_forward)" checked={!!cfg.forward}
                  onChange={(e) => setCfg({ ...cfg, forward: e.currentTarget.checked })} />
              </Stack>
            ) : (
              <Alert variant="light" color="violet" icon={<IconInfoCircle size={16} />}>
                En modo switch las placas marcadas como <b>LAN</b> se unen en el puente <Code>{cfg.bridge || 'br0'}</Code>.
                La central no rutea ni enmascara nada: queda como un equipo más de la red. Hacen falta
                al menos <b>dos placas</b> en el puente.
              </Alert>
            )}
          </div>

          <div>
            <Diagrama modo={cfg.modo} wan={cfg.wan_if} lan={cfg.lan_if} nat={cfg.nat} />
          </div>
        </SimpleGrid>

        <Group mt="lg" gap="sm">
          <Button variant="default" onClick={guardar}>Guardar</Button>
          <Button variant="light" leftSection={<IconListCheck size={16} />} onClick={verPlan}>Ver el plan</Button>
          <Button color="orange" leftSection={<IconPlayerPlay size={16} />} onClick={aplicar} disabled={!!pend}>Aplicar modo</Button>
        </Group>
      </Card>

      {/* Confirmación de aplicar: el cambio de red es el más riesgoso del panel,
          así que el modal muestra a qué modo se va, qué implica y el plan completo. */}
      <Modal opened={confirmar} onClose={() => setConfirmar(false)} centered radius="lg" size="lg"
        withCloseButton={false} overlayProps={{ backgroundOpacity: 0.55, blur: 3 }}>
        <Stack gap="md" p="xs">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={54} radius="xl" variant="light" color="orange"><IconAlertTriangle size={28} /></ThemeIcon>
            <div>
              <Text fw={800} fz="lg">Aplicar modo {esSwitch ? 'SWITCH' : 'ROUTER'}</Text>
              <Text size="sm" c="dimmed">Se van a reconfigurar las placas de red de la central.</Text>
            </div>
          </Group>

          <Card withBorder radius="md" p="md" bg="light-dark(var(--mantine-color-gray-0),var(--mantine-color-dark-6))">
            <Group gap="lg" wrap="nowrap" align="center">
              <ThemeIcon size={44} radius="md" variant="light" color={esSwitch ? 'violet' : 'blue'}>
                {esSwitch ? <IconTopologyBus size={24} /> : <IconRouter size={24} />}
              </ThemeIcon>
              <div style={{ flex: 1, minWidth: 0 }}>
                {esSwitch ? (
                  <>
                    <Text fw={700} size="sm">Puente en capa 2 ({cfg.bridge || 'br0'})</Text>
                    <Text size="xs" c="dimmed">Las placas LAN se unen. La central no rutea ni enmascara: queda como un equipo más de la red.</Text>
                  </>
                ) : (
                  <>
                    <Text fw={700} size="sm">WAN <Code>{cfg.wan_if || '—'}</Code> · LAN <Code>{cfg.lan_if || '—'}</Code></Text>
                    <Text size="xs" c="dimmed">
                      {cfg.nat ? 'Con NAT (enmascara la LAN al salir)' : 'Sin NAT'} · {cfg.forward ? 'rutea entre placas' : 'sin ruteo entre placas'}
                    </Text>
                  </>
                )}
              </div>
            </Group>
          </Card>

          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
            <Text size="sm" fw={600} mb={4}>Esto puede cortar tu conexión con el panel</Text>
            <Text size="xs">
              Si te quedás sin acceso, <b>no hagas nada</b>: la central vuelve sola al modo anterior
              en <b>2 minutos</b>. Si todo sigue funcionando, tocá <b>Confirmar</b> para dejarlo fijo.
            </Text>
          </Alert>

          {plan && plan.length > 0 && (
            <div>
              <Group gap={6} mb={6}>
                <IconListCheck size={15} />
                <Text size="sm" fw={600}>Se van a ejecutar {plan.length} paso(s)</Text>
              </Group>
              <Card withBorder radius="md" p="xs" style={{ maxHeight: 190, overflowY: 'auto' }}>
                <List spacing={6} size="xs" center
                  icon={<ThemeIcon size={16} radius="xl" variant="light" color="gray"><IconCheck size={10} /></ThemeIcon>}>
                  {plan.map((p, i) => (
                    <List.Item key={i}>
                      <Text size="xs" fw={600}>{p.desc}</Text>
                      <Code fz="10px">{p.texto}</Code>
                    </List.Item>
                  ))}
                </List>
              </Card>
            </div>
          )}

          <Group justify="flex-end" gap="sm" mt="xs">
            <Button variant="default" onClick={() => setConfirmar(false)}>Cancelar</Button>
            <Button color="orange" leftSection={<IconPlayerPlay size={16} />} onClick={aplicarAhora}>
              Aplicar modo {esSwitch ? 'switch' : 'router'}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={!!plan && !confirmar} onClose={() => setPlan(null)} title="Lo que se va a ejecutar" size="lg" centered radius="lg">
        <Text size="sm" c="dimmed" mb="sm">
          Estos son los comandos exactos, en orden. Se ejecutan en el contenedor de Asterisk, que es
          el que tiene las placas del equipo. Si uno falla, se corta ahí y te dice cuál fue.
        </Text>
        <List spacing="xs" size="sm">
          {(plan || []).map((p, i) => (
            <List.Item key={i}>
              <Text size="sm" fw={600}>{p.desc}</Text>
              <Code block fz="11px">{p.texto}</Code>
            </List.Item>
          ))}
          {(plan || []).length === 0 && <Text size="sm" c="dimmed">Sin pasos.</Text>}
        </List>
      </Modal>
    </Stack>
  );
}
