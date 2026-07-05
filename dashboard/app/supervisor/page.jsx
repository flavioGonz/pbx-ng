'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useSoftphone } from '../useSoftphone';
import { useAuth, logout } from '../auth';
import Softphone from '../Softphone';
import ClientesLibreta from '../ClientesLibreta';
import { Card, Text, Group, Badge, Button, ThemeIcon, Stack, ActionIcon, Tooltip, ScrollArea, Table, useComputedColorScheme } from '@mantine/core';
import { IconLogout, IconEar, IconMicrophone, IconUrgent, IconRefresh, IconUsersGroup, IconPhoneOff, IconAddressBook } from '@tabler/icons-react';
import { toast } from '../notify';

export default function SupervisorPanel() {
  const { user } = useAuth();
  const sp = useSoftphone();
  const scheme = useComputedColorScheme('dark', { getInitialValueInEffect: true });
  const dark = scheme === 'dark';
  const [dir, setDir] = useState([]);
  const [pres, setPres] = useState({});
  const [queues, setQueues] = useState([]);
  const [qlive, setQlive] = useState({});
  const [libreta, setLibreta] = useState(false);
  const connectedRef = useRef(false);
  const registered = sp.reg === 'registered';
  const ext = user?.ext;

  useEffect(() => {
    if (connectedRef.current) return; connectedRef.current = true;
    fetch('/backend/api/me/sipcreds').then(r => r.json()).then(d => { if (d && d.ext && d.password) sp.connect(d.ext, d.password, false).catch(() => {}); else toast('Tu usuario no tiene interno asignado', 'bad'); }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    fetch('/backend/api/directory').then(r => r.json()).then(d => Array.isArray(d) && setDir(d)).catch(() => {});
    fetch('/backend/api/presence').then(r => r.json()).then(d => setPres(d || {})).catch(() => {});
    fetch('/backend/api/queues').then(r => r.json()).then(async (qs) => {
      if (!Array.isArray(qs)) return; setQueues(qs);
      const live = {};
      await Promise.all(qs.slice(0, 12).map((q) => fetch('/backend/api/queues/' + encodeURIComponent(q.name) + '/live').then(r => r.json()).then((d) => { live[q.name] = d; }).catch(() => {})));
      setQlive(live);
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  async function spy(target, mode) {
    if (!ext) { toast('Tu usuario no tiene interno para escuchar', 'bad'); return; }
    if (!registered) { toast('Tu softphone aún no está en línea', 'bad'); return; }
    const r = await fetch('/backend/api/calls/spy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sup: ext, target: String(target), mode }) }).then(x => x.json()).catch(() => ({ error: 1 }));
    if (r && r.error) { toast('No se pudo iniciar (' + (r.error === 1 ? 'red' : r.error) + ')', 'bad'); return; }
    toast((mode === 'whisper' ? 'Susurro' : mode === 'barge' ? 'Irrupción' : 'Escucha') + ' → ' + target + '. Atendé tu softphone.', 'ok');
  }
  const st = (e) => { const p = pres[String(e)] || pres[e]; return p === 'inuse' || p === 'busy' ? 'en llamada' : p === 'available' || p === 'not_inuse' ? 'libre' : (p || 'offline'); };
  const stcolor = (s) => s === 'en llamada' ? 'orange' : s === 'libre' ? 'teal' : 'gray';

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(1100px 600px at 85% -15%, rgba(59,130,246,.10), transparent), var(--mantine-color-body)', color: 'var(--mantine-color-text)', padding: 18 }}>
      <Group justify="space-between" mb="lg" wrap="nowrap">
        <Group gap="sm">
          <ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'blue.6', to: 'indigo.8' }}><IconUsersGroup size={24} /></ThemeIcon>
          <div><Text fw={800} fz="lg" lh={1.1}>Panel de Supervisor</Text><Text fz="xs" c="dimmed">{user?.name || user?.username} · interno {ext || '—'}</Text></div>
        </Group>
        <Group gap="xs">
          <Button size="sm" variant="light" color="grape" leftSection={<IconAddressBook size={16} />} onClick={() => setLibreta(true)}>Libreta de clientes</Button>
          <Badge size="lg" variant="dot" color={registered ? 'teal' : 'orange'}>{registered ? 'Softphone en línea' : 'Conectando…'}</Badge>
          {sp.call && <Button size="sm" color="red" variant="light" leftSection={<IconPhoneOff size={16} />} onClick={sp.hangup}>Cortar escucha</Button>}
          <Tooltip label="Salir"><ActionIcon size={38} variant="light" color="red" onClick={logout}><IconLogout size={18} /></ActionIcon></Tooltip>
        </Group>
      </Group>

      <div style={{ display: 'grid', gridTemplateColumns: '330px 1fr 1fr', gap: 18, alignItems: 'start' }}>
        <Card withBorder radius="lg" padding="md" shadow="sm">
          <Text fw={700} mb="xs">Mi softphone</Text>
          <Softphone sp={sp} dark={dark} directory={dir} height={430} />
        </Card>

        <Card withBorder radius="lg" padding="md" shadow="sm">
          <Group justify="space-between" mb="xs"><Text fw={700}>Agentes · escucha / susurro / irrupción</Text><ActionIcon variant="subtle" color="gray" onClick={load}><IconRefresh size={16} /></ActionIcon></Group>
          <ScrollArea h={420}>
            <Table verticalSpacing={7} fz="sm">
              <Table.Thead><Table.Tr><Table.Th>Interno</Table.Th><Table.Th>Nombre</Table.Th><Table.Th>Estado</Table.Th><Table.Th ta="right">Acciones</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{dir.filter((e) => String(e.ext) !== String(ext)).map((e) => { const s = st(e.ext); return (
                <Table.Tr key={e.ext}>
                  <Table.Td ff="monospace" fw={700}>{e.ext}</Table.Td>
                  <Table.Td>{e.name || '—'}</Table.Td>
                  <Table.Td><Badge size="xs" variant="dot" color={stcolor(s)}>{s}</Badge></Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Tooltip label="Escuchar"><ActionIcon size={30} variant="light" color="teal" onClick={() => spy(e.ext, 'listen')}><IconEar size={16} /></ActionIcon></Tooltip>
                      <Tooltip label="Susurrar (solo al agente)"><ActionIcon size={30} variant="light" color="blue" onClick={() => spy(e.ext, 'whisper')}><IconMicrophone size={16} /></ActionIcon></Tooltip>
                      <Tooltip label="Irrumpir (hablar con ambos)"><ActionIcon size={30} variant="light" color="orange" onClick={() => spy(e.ext, 'barge')}><IconUrgent size={16} /></ActionIcon></Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>); })}</Table.Tbody>
            </Table>
          </ScrollArea>
          <Text fz="xs" c="dimmed" mt="xs">Escuchar: oís sin ser notado · Susurrar: solo te oye el agente · Irrupción: entrás a la conversación. Se conecta a TU softphone.</Text>
        </Card>

        <Card withBorder radius="lg" padding="md" shadow="sm">
          <Text fw={700} mb="xs">Colas en vivo</Text>
          <ScrollArea h={440}>
            <Stack gap="md">
              {queues.length === 0 ? <Text c="dimmed" ta="center" py="md">Sin colas configuradas</Text> : queues.map((q) => { const l = qlive[q.name] || {}; const waiting = (l.waiting || l.callers || []).length || 0; const agents = l.agents || l.members || []; return (
                <Card key={q.name} withBorder radius="md" padding="sm">
                  <Group justify="space-between" mb={6}>
                    <Text fw={700}>{q.name}{q.strategy ? <Text span c="dimmed" fz="xs"> · {q.strategy}</Text> : null}</Text>
                    <Group gap={6}><Badge size="sm" variant="light" color={waiting ? 'orange' : 'gray'}>{waiting} en espera</Badge><Badge size="sm" variant="light" color="blue">{agents.length} agentes</Badge></Group>
                  </Group>
                  {agents.length > 0 && <Group gap={6}>{agents.map((a, i) => { const anm = a.name || a.interface || a.ext || a.membername || a; const paused = a.paused || a.pause; return <Badge key={i} size="sm" variant="dot" color={paused ? 'yellow' : 'teal'}>{String(anm).replace('PJSIP/', '')}{paused ? ' (pausa)' : ''}</Badge>; })}</Group>}
                </Card>); })}
            </Stack>
          </ScrollArea>
        </Card>
      </div>

      <ClientesLibreta opened={libreta} onClose={() => setLibreta(false)} />
    </div>
  );
}
