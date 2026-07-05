/* PcapCapture.jsx - navaja de diagnóstico: captura de paquetes (pcap) en SBC o Asterisk */
'use client';
import { useState, useEffect, useRef } from 'react';
import { Button, Modal, Group, Stack, Text, SegmentedControl, NumberInput, Badge, ActionIcon, Tooltip, Table, ThemeIcon, Card } from '@mantine/core';
import { IconWaveSine, IconPlayerPlay, IconPlayerStop, IconDownload, IconTrash, IconRefresh } from '@tabler/icons-react';
import { toast } from './notify';

const PRESETS = [{ label: 'SIP (5060)', value: 'sip' }, { label: 'SIP + RTP', value: 'siprtp' }, { label: 'Todo', value: 'all' }];
const STCOL = { pending: 'gray', running: 'blue', done: 'teal', error: 'red', stopping: 'orange' };
const fmtSize = (b) => (b > 1e6 ? (b / 1048576).toFixed(1) + ' MB' : b > 1e3 ? (b / 1024).toFixed(0) + ' KB' : (b || 0) + ' B');

export default function PcapCapture() {
  const [open, setOpen] = useState(false);
  const [node, setNode] = useState('sbc');
  const [preset, setPreset] = useState('sip');
  const [dur, setDur] = useState(30);
  const [starting, setStarting] = useState(false);
  const [list, setList] = useState([]);
  const timer = useRef(null);

  const load = async () => { try { const d = await fetch('/backend/api/capture/list').then((r) => r.json()); if (Array.isArray(d)) setList(d); } catch (_) {} };
  useEffect(() => { if (open) { load(); timer.current = setInterval(load, 2000); } return () => clearInterval(timer.current); }, [open]);

  const start = async () => {
    setStarting(true);
    try {
      const r = await fetch('/backend/api/capture/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node, preset, duration: dur }) }).then((x) => x.json());
      if (r.error) toast('Error: ' + r.error, 'bad'); else toast('Captura iniciada en ' + node + ' · ' + dur + 's', 'ok');
      load();
    } catch (_) { toast('Error al iniciar', 'bad'); }
    setStarting(false);
  };
  const stop = async (id) => { try { await fetch('/backend/api/capture/' + id + '/stop', { method: 'POST' }); } catch (_) {} load(); };
  const del = async (id) => { try { await fetch('/backend/api/capture/' + id, { method: 'DELETE' }); } catch (_) {} load(); };
  const dl = (id) => { window.open('/backend/api/capture/' + id + '/download', '_blank'); };

  return (
    <>
      <Tooltip label="Captura de paquetes (.pcap para Wireshark)"><Button size="xs" variant="light" color="grape" leftSection={<IconWaveSine size={14} />} onClick={() => setOpen(true)}>PCAP</Button></Tooltip>
      <Modal opened={open} onClose={() => setOpen(false)} size="xl" radius="lg" overlayProps={{ blur: 3, backgroundOpacity: 0.45 }}
        title={<Group gap="sm"><ThemeIcon size={40} radius="md" variant="light" color="grape"><IconWaveSine size={20} /></ThemeIcon><div><Text fw={800} lh={1.1}>Captura de paquetes</Text><Text size="xs" c="dimmed">Navaja de diagnóstico · genera un .pcap listo para Wireshark</Text></div></Group>}>
        <Stack gap="md">
          <Card withBorder radius="md" padding="md">
            <Text size="sm" fw={600} mb={8}>Nueva captura</Text>
            <Group align="flex-end" gap="md" wrap="wrap">
              <div><Text size="xs" c="dimmed" mb={4}>Dónde capturar</Text><SegmentedControl value={node} onChange={setNode} data={[{ label: 'SBC (Kamailio)', value: 'sbc' }, { label: 'Asterisk', value: 'asterisk' }]} /></div>
              <div><Text size="xs" c="dimmed" mb={4}>Qué</Text><SegmentedControl value={preset} onChange={setPreset} data={PRESETS} /></div>
              <NumberInput label="Duración (s)" value={dur} onChange={(v) => setDur(v || 30)} min={3} max={300} w={110} />
              <Button loading={starting} onClick={start} leftSection={<IconPlayerPlay size={16} />} color="grape">Iniciar</Button>
            </Group>
            <Text size="xs" c="dimmed" mt={8}>SIP = solo señalización (5060). SIP + RTP = incluye audio. Todo = todo el tráfico UDP del nodo. La captura corre en el nodo elegido y queda disponible abajo.</Text>
          </Card>

          <Group justify="space-between">
            <Text size="sm" fw={600}>Capturas ({list.length})</Text>
            <Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} onClick={load}>Refrescar</Button>
          </Group>
          <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
            <Table.Thead><Table.Tr><Table.Th>Archivo</Table.Th><Table.Th>Nodo</Table.Th><Table.Th>Estado</Table.Th><Table.Th>Tamaño</Table.Th><Table.Th>Fecha</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>{list.length === 0 ?
              <Table.Tr><Table.Td colSpan={6}><Text c="dimmed" ta="center" py="md">Sin capturas todavía. Iniciá una arriba.</Text></Table.Td></Table.Tr> :
              list.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td ff="monospace" fz="xs" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.filename}</Table.Td>
                  <Table.Td><Badge size="xs" variant="light" color={c.node === 'sbc' ? 'grape' : 'blue'}>{c.node}</Badge></Table.Td>
                  <Table.Td><Badge size="xs" variant="light" color={STCOL[c.status] || 'gray'}>{c.status}{c.status === 'running' ? '…' : ''}</Badge>{c.error && <Text fz="10px" c="red" lineClamp={1} maw={180}>{c.error}</Text>}</Table.Td>
                  <Table.Td>{c.status === 'done' ? fmtSize(c.size) : '—'}</Table.Td>
                  <Table.Td fz="xs">{c.created_at ? new Date(c.created_at).toLocaleString() : '—'}</Table.Td>
                  <Table.Td ta="right"><Group gap={4} justify="flex-end" wrap="nowrap">
                    {(c.status === 'running' || c.status === 'pending') && <Tooltip label="Detener"><ActionIcon size="sm" variant="light" color="orange" onClick={() => stop(c.id)}><IconPlayerStop size={14} /></ActionIcon></Tooltip>}
                    {c.status === 'done' && <Tooltip label="Descargar .pcap"><ActionIcon size="sm" variant="light" color="teal" onClick={() => dl(c.id)}><IconDownload size={14} /></ActionIcon></Tooltip>}
                    <Tooltip label="Borrar"><ActionIcon size="sm" variant="subtle" color="red" onClick={() => del(c.id)}><IconTrash size={14} /></ActionIcon></Tooltip>
                  </Group></Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
          </Table>
        </Stack>
      </Modal>
    </>
  );
}
