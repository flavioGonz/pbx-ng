'use client';
import { useEffect, useState, Fragment } from 'react';
import { Stack, Title, Text, Card, Group, Button, Table, Badge, TextInput, ActionIcon, Tooltip, Select, Switch, PasswordInput, SimpleGrid, ThemeIcon, Tabs, Divider } from '@mantine/core';
import { IconRefresh, IconSearch, IconTrash, IconDownload, IconDeviceFloppy, IconCloud, IconServer, IconFolder, IconMicrophone2, IconWaveSine, IconDatabase, IconSettings, IconClock, IconUser, IconPlayerPlay, IconPlayerPause } from '@tabler/icons-react';
import { TableSkeleton } from '../Skeletons';
import { toast } from '../notify';
import RecordingPlayer from '../RecordingPlayer';
import Slot from '../Slot';
import MiniWave from '../MiniWave';

const fmtSize = (b) => !b ? '—' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
const fmtDur = (s) => { s = s || 0; return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const STG = { local: ['gray', 'Local', IconFolder], s3: ['blue', 'S3', IconCloud], nas: ['teal', 'NAS', IconServer] };


const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;
export default function Grabaciones() {
  const [list, setList] = useState([]); const [loading, setLoading] = useState(true); const [q, setQ] = useState('');
  const [cfg, setCfg] = useState(null); const [savingCfg, setSavingCfg] = useState(false); const [playId, setPlayId] = useState(null);
  async function load() { try { const d = await fetch('/backend/api/recordings').then(r => r.json()); setList(Array.isArray(d) ? d : []); } catch (_) { setList([]); } setLoading(false); }
  async function loadCfg() { try { setCfg(await fetch('/backend/api/recordings/config').then(r => r.json())); } catch (_) {} }
  useEffect(() => { load(); loadCfg(); const t = setInterval(load, 12000); return () => clearInterval(t); }, []);
  async function del(id) { if (!confirm('¿Eliminar esta grabación?')) return; await fetch('/backend/api/recordings/' + id, { method: 'DELETE' }); toast('Grabación eliminada', 'info'); load(); }
  async function saveCfg() {
    setSavingCfg(true);
    const r = await fetch('/backend/api/recordings/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setSavingCfg(false);
    toast(r.error ? 'Error al guardar' : 'Configuración guardada', r.error ? 'bad' : 'ok'); loadCfg();
  }
  const setC = (k, v) => setCfg(c => ({ ...c, [k]: v }));
  const fl = list.filter(r => !q || (r.ext || '').includes(q) || (r.filename || '').includes(q) || (r.src || '').includes(q) || (r.dst || '').includes(q));
  const totalBytes = list.reduce((a, r) => a + (r.bytes || 0), 0);
  const totalDur = list.reduce((a, r) => a + (r.duration || 0), 0);
  const onCloud = list.filter(r => r.storage !== 'local').length;
  const kpis = [
    { k: 'Grabaciones', v: list.length, icon: IconWaveSine, c: 'pbx' },
    { k: 'Almacenado', v: fmtSize(totalBytes), icon: IconDatabase, c: 'violet' },
    { k: 'Duración total', v: fmtDur(totalDur), icon: IconClock, c: 'teal' },
    { k: 'En NAS / S3', v: onCloud, icon: IconCloud, c: 'blue' },
  ];

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-grape-5),var(--mantine-color-grape-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'grape.5', to: 'grape.8', deg: 135 }}><IconMicrophone2 size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Grabaciones</Title><Text c="dimmed" size="sm">Audio de llamadas · almacenamiento local, NAS o S3</Text></div></div>
        <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>Actualizar</Button>
      </Group>

      {loading ? <SimpleGrid cols={{ base: 2, sm: 4 }}>{Array.from({ length: 4 }).map((_, i) => <Card key={i} withBorder radius="lg" padding="lg"><Group><ThemeIcon size={44} radius="md" variant="light" color="gray" /><div><Text fw={800} fz={24}>—</Text></div></Group></Card>)}</SimpleGrid> :
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          {kpis.map(x => (
            <Card key={x.k} withBorder radius="lg" padding="lg" shadow="sm"><Group><ThemeIcon size={44} radius="md" variant="light" color={x.c}><x.icon size={22} /></ThemeIcon>
              <div><Text fw={800} fz={22} lh={1.1}>{typeof x.v === 'number' ? <Slot value={x.v} /> : x.v}</Text><Text size="sm" c="dimmed">{x.k}</Text></div></Group></Card>
          ))}
        </SimpleGrid>}

      <Tabs defaultValue="list" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="list" leftSection={<IconMicrophone2 size={16} />}>Grabaciones</Tabs.Tab>
          <Tabs.Tab value="cfg" leftSection={<IconSettings size={16} />}>Almacenamiento</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="list">
          <Card withBorder radius="lg" padding="lg" shadow="sm">
            <Group justify="space-between" mb="md">
              <Text fw={600}>{fl.length} grabaciones</Text>
              <TextInput placeholder="Buscar extensión / archivo" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={250} />
            </Group>
            {loading ? <TableSkeleton rows={6} cols={6} /> :
              fl.length === 0 ? <Text c="dimmed" ta="center" py="xl">{list.length ? 'Sin resultados.' : 'Aún no hay grabaciones. Iniciá una desde el softphone (botón Grabar).'}</Text> :
                <Table.ScrollContainer minWidth={740}>
                  <Table striped highlightOnHover verticalSpacing="sm">
                    <Table.Thead><Table.Tr><Th icon={<IconClock size={13} />}>Fecha</Th><Th icon={<IconUser size={13} />}>Extensión</Th><Th icon={<IconClock size={13} />}>Duración</Th><Th icon={<IconDatabase size={13} />}>Tamaño</Th><Th icon={<IconServer size={13} />}>Almac.</Th><Th icon={<IconWaveSine size={13} />}>Audio</Th><Th icon={<IconWaveSine size={13} />}>Reproducir</Th><Table.Th /></Table.Tr></Table.Thead>
                    <Table.Tbody>{fl.map(r => {
                      const [col, lbl, Ic] = STG[r.storage] || STG.local;
                      return (
                        <Fragment key={r.id}>
                        <Table.Tr>
                          <Table.Td>{r.started_at ? new Date(r.started_at).toLocaleString('es-UY') : '—'}</Table.Td>
                          <Table.Td><Group gap={6}><ThemeIcon size="sm" radius="xl" variant="light" color="pbx"><IconWaveSine size={13} /></ThemeIcon><Text ff="monospace" fw={600}>{r.ext || '—'}</Text></Group></Table.Td>
                          <Table.Td><Badge variant="light" color="gray">{fmtDur(r.duration)}</Badge></Table.Td>
                          <Table.Td>{fmtSize(r.bytes)}</Table.Td>
                          <Table.Td><Badge variant="light" color={col} leftSection={<Ic size={12} />}>{lbl}</Badge></Table.Td>
                          <Table.Td><MiniWave recId={r.id} /></Table.Td><Table.Td><Button size="compact-xs" variant={playId === r.id ? 'filled' : 'light'} color="teal" leftSection={playId === r.id ? <IconPlayerPause size={13} /> : <IconPlayerPlay size={13} />} onClick={() => setPlayId(playId === r.id ? null : r.id)}>{playId === r.id ? 'Cerrar' : 'Reproducir'}</Button></Table.Td>
                          <Table.Td ta="right"><Group gap={4} justify="flex-end">
                            <Tooltip label="Descargar"><ActionIcon variant="subtle" component="a" href={'/backend/api/recordings/' + r.id + '/audio'} download><IconDownload size={17} /></ActionIcon></Tooltip>
                            <Tooltip label="Eliminar"><ActionIcon variant="subtle" color="red" onClick={() => del(r.id)}><IconTrash size={17} /></ActionIcon></Tooltip>
                          </Group></Table.Td>
                        </Table.Tr>
                        {playId === r.id && <Table.Tr><Table.Td colSpan={8} style={{ background: 'var(--mantine-color-default-hover)' }}><RecordingPlayer recId={r.id} src={'/backend/api/recordings/' + r.id + '/audio'} label={'Extensión ' + (r.ext || '?')} /></Table.Td></Table.Tr>}
                        </Fragment>
                      );
                    })}</Table.Tbody>
                  </Table>
                </Table.ScrollContainer>}
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="cfg">
          <Card withBorder radius="lg" padding="lg" shadow="sm">
            <Group gap="sm" mb="md"><ThemeIcon variant="light" color="pbx"><IconCloud size={18} /></ThemeIcon><Text fw={600}>Destino de almacenamiento</Text></Group>
            {!cfg ? <TableSkeleton rows={3} cols={2} /> :
              <Stack gap="sm">
                <Group grow align="flex-end">
                  <Select label="Destino" value={cfg.backend || 'local'} onChange={v => setC('backend', v)} data={[{ value: 'local', label: 'Local (en el servidor)' }, { value: 'nas', label: 'NAS (carpeta montada)' }, { value: 's3', label: 'S3 / compatible (MinIO)' }]} />
                  <Switch label="Subir automáticamente" checked={!!cfg.auto_upload} onChange={e => setC('auto_upload', e.currentTarget.checked)} />
                  <Switch label="Conservar copia local" checked={cfg.retain_local !== false} onChange={e => setC('retain_local', e.currentTarget.checked)} />
                </Group>
                {cfg.backend === 'nas' &&
                  <TextInput label="Ruta del NAS (montada en el server de Asterisk)" placeholder="/mnt/nas/grabaciones" value={cfg.nas_path || ''} onChange={e => setC('nas_path', e.target.value)} />}
                {cfg.backend === 's3' &&
                  <><Divider label="Credenciales S3" labelPosition="left" />
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                      <TextInput label="Endpoint (vacío = AWS)" placeholder="https://s3.amazonaws.com o MinIO" value={cfg.s3_endpoint || ''} onChange={e => setC('s3_endpoint', e.target.value)} />
                      <TextInput label="Región" placeholder="us-east-1" value={cfg.s3_region || ''} onChange={e => setC('s3_region', e.target.value)} />
                      <TextInput label="Bucket" value={cfg.s3_bucket || ''} onChange={e => setC('s3_bucket', e.target.value)} />
                      <TextInput label="Prefijo" placeholder="recordings/" value={cfg.s3_prefix || ''} onChange={e => setC('s3_prefix', e.target.value)} />
                      <TextInput label="Access Key" value={cfg.s3_key || ''} onChange={e => setC('s3_key', e.target.value)} />
                      <PasswordInput label="Secret Key" placeholder={cfg.has_secret ? '•••••• (guardado)' : ''} value={cfg.s3_secret || ''} onChange={e => setC('s3_secret', e.target.value)} />
                    </SimpleGrid></>}
                <Group justify="flex-end"><Button leftSection={<IconDeviceFloppy size={16} />} loading={savingCfg} onClick={saveCfg}>Guardar configuración</Button></Group>
              </Stack>}
          </Card>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
