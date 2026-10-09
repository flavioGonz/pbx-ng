/* PcapCapture.jsx - navaja de diagnóstico: captura de paquetes (pcap) en Asterisk. (El borde se captura desde el panel de SBC-NG.) */
'use client';
import { useState, useEffect, useRef } from 'react';
import { Button, Group, Stack, Text, SegmentedControl, NumberInput, Badge, ActionIcon, Tooltip, Table, ThemeIcon, Card } from '@mantine/core';
import { IconWaveSine, IconPlayerPlay, IconPlayerStop, IconDownload, IconTrash, IconRefresh } from '@tabler/icons-react';
import { toast } from './notify';
import DrawerNG from './DrawerNG';
import { api, apiGet, apiPost, apiDel } from './api';

const PRESETS = [{ label: 'SIP (5060)', value: 'sip' }, { label: 'SIP + RTP', value: 'siprtp' }, { label: 'Todo', value: 'all' }];
const STCOL = { pending: 'gray', running: 'blue', done: 'teal', error: 'red', stopping: 'orange' };
const fmtSize = (b) => (b > 1e6 ? (b / 1048576).toFixed(1) + ' MB' : b > 1e3 ? (b / 1024).toFixed(0) + ' KB' : (b || 0) + ' B');

export default function PcapCapture() {
  const [open, setOpen] = useState(false);
  const [node] = useState('asterisk');
  const [preset, setPreset] = useState('sip');
  const [dur, setDur] = useState(30);
  const [starting, setStarting] = useState(false);
  const [list, setList] = useState([]);
  const timer = useRef(null);

  /* La lista se refresca cada 2 s: si un pedido falla no se avisa en cada vuelta (sería
   * un toast cada dos segundos), la tabla se queda con lo último que se vio. */
  const load = async () => { try { const d = await apiGet('/capture/list'); if (Array.isArray(d)) setList(d); } catch (_) {} };
  /* 2 s se justifica: es el progreso de una captura que está corriendo ahora y se la
   * mira para saber cuándo pararla. Sólo con el panel abierto y la pestaña a la vista. */
  useEffect(() => { if (open) { load(); timer.current = setInterval(() => { if (!document.hidden) load(); }, 2000); } return () => clearInterval(timer.current); }, [open]);

  const start = async () => {
    setStarting(true);
    try {
      await apiPost('/capture/start', { node, preset, duration: dur });
      toast('Captura iniciada en ' + node + ' · ' + dur + 's', 'ok');
      load();
    } catch (e) { toast('No se pudo iniciar: ' + e.message, 'bad'); }
    setStarting(false);
  };
  const stop = async (id) => { try { await apiPost('/capture/' + id + '/stop'); } catch (e) { toast(e.message, 'bad'); } load(); };
  const del = async (id) => { try { await apiDel('/capture/' + id); } catch (e) { toast(e.message, 'bad'); } load(); };
  /* La descarga va CON el token: un `window.open` a /api no pasa por el parche de
   * `fetch` de auth.jsx, y la API (deny-by-default) le contestaba 401 al .pcap. */
  const dl = async (c) => {
    try {
      const r = await api('/capture/' + c.id + '/download', { raw: true });
      const u = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = u; a.download = c.filename || ('captura-' + c.id + '.pcap');
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    } catch (e) { toast(e.message, 'bad'); }
  };

  return (
    <>
      <Tooltip label="Captura de paquetes (.pcap para Wireshark)"><Button size="xs" variant="light" color="grape" leftSection={<IconWaveSine size={14} />} onClick={() => setOpen(true)}>PCAP</Button></Tooltip>
      <DrawerNG
        opened={open} onClose={() => setOpen(false)} ancho={820} color="grape"
        icono={<IconWaveSine size={24} />} titulo="Captura de paquetes"
        subtitulo="Navaja de diagnóstico · genera un .pcap listo para Wireshark"
        solapas={[{ value: 'captura', label: 'Captura', contenido: (
          <>
          <Card withBorder radius="md" padding="md">
            <Text size="sm" fw={600} mb={8}>Nueva captura</Text>
            <Group align="flex-end" gap="md" wrap="wrap">
              <div><Text size="xs" c="dimmed" mb={4}>Dónde capturar</Text><SegmentedControl value={node} data={[{ label: 'Asterisk (núcleo)', value: 'asterisk' }]} /></div>
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
                    {c.status === 'done' && <Tooltip label="Descargar .pcap"><ActionIcon size="sm" variant="light" color="teal" onClick={() => dl(c)}><IconDownload size={14} /></ActionIcon></Tooltip>}
                    <Tooltip label="Borrar"><ActionIcon size="sm" variant="subtle" color="red" onClick={() => del(c.id)}><IconTrash size={14} /></ActionIcon></Tooltip>
                  </Group></Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
          </Table>
          </>
        ) }]}
      />
    </>
  );
}
