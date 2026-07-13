/* AlertsPanel.jsx — alertas por correo: reglas, umbrales, destinatarios e historial */
'use client';
import { useEffect, useState } from 'react';
import { Card, Group, Text, Switch, TextInput, NumberInput, Button, Badge, Stack, ThemeIcon, Divider, Table, Loader, Center, Tooltip, ActionIcon, Collapse } from '@mantine/core';
import { IconBellRinging, IconDeviceFloppy, IconSend, IconChevronDown, IconShieldLock, IconLogin, IconPhoneOff, IconServerBolt, IconCurrencyDollar, IconHeadset, IconMail, IconRefresh } from '@tabler/icons-react';
import { toast } from './notify';

const META = {
  'security.attack':     { icon: <IconShieldLock size={17} />, color: 'red',    title: 'Estamos bajo ataque', desc: 'Ráfaga de intentos de registro fallidos. Una sola alerta agrupada, no un mail por IP.' },
  'security.ban':        { icon: <IconShieldLock size={17} />, color: 'orange', title: 'IP bloqueada', desc: 'El firewall (fail2ban) bloqueó una o más IPs. Incluye país e ISP.' },
  'auth.login':          { icon: <IconLogin size={17} />,      color: 'blue',   title: 'Inicio de sesión al panel', desc: 'Aviso al entrar al panel. Recomendado: solo desde una IP nueva.' },
  'auth.login_failed':   { icon: <IconLogin size={17} />,      color: 'red',    title: 'Intentos fallidos al panel', desc: 'Varios intentos de acceso fallidos: posible fuerza bruta.' },
  'trunk.down':          { icon: <IconPhoneOff size={17} />,   color: 'red',    title: 'Troncal caída / recuperada', desc: 'Si la troncal se cae, dejás de recibir llamadas. Avisa también al recuperarse.' },
  'service.down':        { icon: <IconServerBolt size={17} />, color: 'red',    title: 'Servicio caído', desc: 'Base de datos, ARI o AMI sin conexión.' },
  'extension.offline':   { icon: <IconPhoneOff size={17} />,   color: 'orange', title: 'Interno crítico desregistrado', desc: 'Avisa si un interno clave (ej. recepción) se cae.' },
  'fraud.long_call':     { icon: <IconCurrencyDollar size={17} />, color: 'grape', title: 'Llamada saliente muy larga', desc: 'Primer síntoma habitual de fraude telefónico.' },
  'fraud.after_hours':   { icon: <IconCurrencyDollar size={17} />, color: 'grape', title: 'Pico de salientes fuera de horario', desc: 'El patrón clásico: ráfaga de llamadas de madrugada.' },
  'fraud.international': { icon: <IconCurrencyDollar size={17} />, color: 'grape', title: 'Llamada internacional', desc: 'Avisa por destinos internacionales no permitidos.' },
  'queue.no_agents':     { icon: <IconHeadset size={17} />,    color: 'yellow', title: 'Cola sin agentes', desc: 'En horario laboral no hay nadie para atender la cola.' },
  'digest.daily':        { icon: <IconMail size={17} />,       color: 'teal',   title: 'Resumen diario', desc: 'Llamadas de ayer, perdidas, top internos, bloqueos y buzones.' },
};
const PARAMS = {
  'security.attack':   [['failed', 'Intentos fallidos'], ['window_min', 'Ventana (min)']],
  'auth.login_failed': [['attempts', 'Intentos'], ['window_min', 'Ventana (min)']],
  'extension.offline': [['exts', 'Internos (csv)'], ['minutes', 'Tras N min']],
  'fraud.long_call':   [['minutes', 'Duración (min)']],
  'fraud.after_hours': [['calls', 'Llamadas'], ['window_min', 'Ventana (min)'], ['from_hour', 'Desde (hora)'], ['to_hour', 'Hasta (hora)']],
  'fraud.international': [['prefixes', 'Prefijos (csv)'], ['allow', 'Permitidos (csv)']],
  'queue.no_agents':   [['from_hour', 'Desde (hora)'], ['to_hour', 'Hasta (hora)']],
  'digest.daily':      [['hour', 'Hora de envío']],
};

export default function AlertsPanel() {
  const [rules, setRules] = useState(null);
  const [to, setTo] = useState('');
  const [open, setOpen] = useState({});
  const [busy, setBusy] = useState('');
  const [hist, setHist] = useState([]);

  async function load() {
    try {
      const d = await fetch('/backend/api/alerts/rules').then(r => r.json());
      setRules(d.rules || []); setTo(d.default_to || '');
      setHist(await fetch('/backend/api/alerts/history').then(r => r.json()).catch(() => []));
    } catch (_) { setRules([]); }
  }
  useEffect(() => { load(); }, []);

  const upd = (ev, patch) => setRules(rs => rs.map(r => r.event === ev ? { ...r, ...patch } : r));

  // el interruptor guarda solo: un toggle que no persiste parece roto
  async function toggle(r, on) {
    upd(r.event, { enabled: on });
    setBusy(r.event);
    const res = await fetch('/backend/api/alerts/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...r, enabled: on }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setBusy('');
    if (res.error) { upd(r.event, { enabled: !on }); toast('No se pudo guardar', 'bad'); return; }
    toast((META[r.event]?.title || r.event) + (on ? ': activada' : ': desactivada'), on ? 'ok' : 'info');
  }
  const updParam = (ev, k, v) => setRules(rs => rs.map(r => r.event === ev ? { ...r, params: { ...(r.params || {}), [k]: v } } : r));

  async function saveTo() {
    await fetch('/backend/api/alerts/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_to: to }) });
    toast('Destinatario por defecto guardado', 'ok');
  }
  async function save(r) {
    setBusy(r.event);
    const res = await fetch('/backend/api/alerts/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setBusy('');
    if (res.error) { toast('No se pudo guardar', 'bad'); return; }
    toast((META[r.event]?.title || r.event) + ': guardado', 'ok');
  }
  async function test(ev) {
    setBusy(ev + ':test');
    const res = await fetch('/backend/api/alerts/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: ev }) }).then(x => x.json()).catch(() => ({ error: 'red' }));
    setBusy('');
    toast(res.error ? res.error : 'Alerta de prueba enviada', res.error ? 'bad' : 'ok');
    load();
  }

  if (!rules) return <Center mih={240}><Loader color="orange" /></Center>;

  return (
    <Stack gap="lg">
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between">
          <Group gap="sm">
            <ThemeIcon size={40} radius="md" variant="light" color="orange"><IconBellRinging size={22} /></ThemeIcon>
            <div>
              <Text fw={800} lh={1.1}>Alertas por correo</Text>
              <Text size="xs" c="dimmed">Usa el SMTP de la empresa. El interruptor guarda al instante; el botón de abajo es para umbrales y destinatarios propios.</Text>
            </div>
          </Group>
          <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={load}>Refrescar</Button>
        </Group>
        <Group mt="md" align="flex-end">
          <TextInput style={{ flex: 1 }} label="Destinatarios por defecto" description="Separá varios con coma. Cada alerta puede tener los suyos propios."
            placeholder="alertas@empresa.com, guardia@empresa.com" value={to} onChange={e => setTo(e.target.value)} />
          <Button leftSection={<IconDeviceFloppy size={16} />} onClick={saveTo}>Guardar</Button>
        </Group>
      </Card>

      {rules.map(r => {
        const m = META[r.event] || { icon: <IconBellRinging size={17} />, color: 'gray', title: r.event, desc: '' };
        const ps = PARAMS[r.event] || [];
        const isOpen = !!open[r.event];
        return (
          <Card key={r.event} withBorder radius="md" padding="md">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="nowrap">
                <ThemeIcon size={34} radius="md" variant="light" color={m.color}>{m.icon}</ThemeIcon>
                <div>
                  <Group gap={8}>
                    <Text fw={700} size="sm">{m.title}</Text>
                    <Badge size="xs" variant="light" ff="monospace" color="gray">{r.event}</Badge>
                  </Group>
                  <Text size="xs" c="dimmed">{m.desc}</Text>
                </div>
              </Group>
              <Group gap="xs" wrap="nowrap">
                <Tooltip label="Enviar una alerta de prueba"><ActionIcon variant="light" loading={busy === r.event + ':test'} onClick={() => test(r.event)}><IconSend size={16} /></ActionIcon></Tooltip>
                <Switch size="md" color="teal" checked={!!r.enabled} disabled={busy === r.event} onChange={e => toggle(r, e.currentTarget.checked)} />
                <ActionIcon variant="subtle" onClick={() => setOpen(o => ({ ...o, [r.event]: !isOpen }))}><IconChevronDown size={16} style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: '.15s' }} /></ActionIcon>
              </Group>
            </Group>

            <Collapse in={isOpen}>
              <Divider my="sm" />
              <Group grow align="flex-end" mb="xs">
                <TextInput size="xs" label="Destinatarios" placeholder="(usa los de arriba)" value={r.recipients || ''} onChange={e => upd(r.event, { recipients: e.target.value })} />
                <NumberInput size="xs" label="No repetir antes de (min)" min={0} value={Number(r.throttle_min ?? 15)} onChange={v => upd(r.event, { throttle_min: Number(v) || 0 })} />
              </Group>
              {ps.length > 0 && (
                <Group grow align="flex-end">
                  {ps.map(([k, label]) => {
                    const val = (r.params || {})[k];
                    const isNum = typeof val === 'number' || /hour|min|calls|attempts|failed|minutes/.test(k);
                    return isNum
                      ? <NumberInput key={k} size="xs" label={label} value={Number(val ?? 0)} onChange={v => updParam(r.event, k, Number(v) || 0)} />
                      : <TextInput key={k} size="xs" label={label} value={val ?? ''} onChange={e => updParam(r.event, k, e.target.value)} />;
                  })}
                </Group>
              )}
              {r.event === 'auth.login' && (
                <Switch mt="sm" size="sm" label="Avisar solo cuando entra desde una IP nueva"
                  description="Recomendado: si avisás de todos los logins, el correo se vuelve ruido y dejás de leerlo."
                  checked={(r.params || {}).only_new_ip !== false}
                  onChange={e => updParam(r.event, 'only_new_ip', e.currentTarget.checked)} />
              )}
              <Group justify="flex-end" mt="sm">
                <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={busy === r.event} onClick={() => save(r)}>Guardar umbrales</Button>
              </Group>
            </Collapse>
          </Card>
        );
      })}

      <Card withBorder radius="md" padding="md">
        <Text fw={700} mb="sm">Últimas alertas enviadas</Text>
        {hist.length === 0 ? <Text size="sm" c="dimmed">Todavía no se envió ninguna alerta.</Text> : (
          <Table striped verticalSpacing="xs">
            <Table.Thead><Table.Tr><Table.Th>Fecha</Table.Th><Table.Th>Evento</Table.Th><Table.Th>Título</Table.Th><Table.Th>Destino</Table.Th><Table.Th ta="center">Estado</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {hist.map(h => (
                <Table.Tr key={h.id}>
                  <Table.Td fz="xs">{new Date(h.created_at).toLocaleString('es-UY')}</Table.Td>
                  <Table.Td><Badge size="xs" variant="light" ff="monospace" color={h.severity === 'crit' ? 'red' : h.severity === 'warn' ? 'orange' : 'blue'}>{h.event}</Badge></Table.Td>
                  <Table.Td fz="xs">{h.title}</Table.Td>
                  <Table.Td fz="xs" c="dimmed">{h.to_addr || '—'}</Table.Td>
                  <Table.Td ta="center">{h.sent ? <Badge size="xs" color="teal" variant="light">enviada</Badge> : <Tooltip label={h.err || 'error'}><Badge size="xs" color="red" variant="light">falló</Badge></Tooltip>}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
