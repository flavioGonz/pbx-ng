'use client';
import { useEffect, useState, Fragment } from 'react';
import { Stack, Title, Text, Card, Group, Button, Table, Badge, TextInput, ActionIcon, Tooltip, Select, Switch, PasswordInput, SimpleGrid, ThemeIcon, Tabs, Divider, SegmentedControl, Code, Collapse, Loader, CopyButton } from '@mantine/core';
import { IconRefresh, IconSearch, IconTrash, IconDownload, IconDeviceFloppy, IconCloud, IconServer, IconFolder, IconMicrophone2, IconWaveSine, IconDatabase, IconSettings, IconClock, IconUser, IconPlayerPlay, IconPlayerPause, IconBrandDebian, IconBrandAws, IconStethoscope, IconCircleCheck, IconCircleX, IconInfoCircle, IconCopy, IconCheck, IconHash } from '@tabler/icons-react';
import { TableSkeleton } from '../Skeletons';
import { toast } from '../notify';
import RecordingPlayer from '../RecordingPlayer';
import MiniWave from '../MiniWave';

const fmtSize = (b) => !b ? '—' : b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
const fmtDur = (s) => { s = s || 0; return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const STG = { local: ['gray', 'Local', IconFolder], s3: ['blue', 'S3', IconCloud], nas: ['teal', 'NAS', IconServer] };
const pctColor = (p) => p >= 90 ? '#dc2626' : p >= 75 ? '#f59e0b' : p >= 50 ? '#eab308' : '#12b76a';

/* Disco/cilindro que se llena según el % usado */
function FillDisk({ pct = 0 }) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const col = pctColor(p);
  const W = 74, topY = 8, botY = 78, ry = 9, cx = 37, rx = 30;
  const bodyH = botY - topY;
  const fillY = botY - bodyH * (p / 100);
  const cid = 'cyl' + p;
  return (
    <svg viewBox={`0 0 ${W} 92`} width="72" height="90" style={{ display: 'block' }}>
      <defs><clipPath id={cid}><path d={`M ${cx - rx} ${topY} a ${rx} ${ry} 0 0 0 ${rx * 2} 0 v ${bodyH} a ${rx} ${ry} 0 0 1 -${rx * 2} 0 Z`} /></clipPath></defs>
      <path d={`M ${cx - rx} ${topY} v ${bodyH} a ${rx} ${ry} 0 0 0 ${rx * 2} 0 v -${bodyH}`} fill="rgba(148,163,184,.08)" stroke="rgba(100,116,139,.45)" strokeWidth="1.6" />
      <rect x={cx - rx} y={fillY} width={rx * 2} height={botY - fillY + ry + 2} fill={col} opacity="0.85" clipPath={`url(#${cid})`} style={{ transition: 'y .7s ease' }} />
      <ellipse cx={cx} cy={topY} rx={rx} ry={ry} fill="rgba(148,163,184,.16)" stroke="rgba(100,116,139,.45)" strokeWidth="1.6" />
      <text x={cx} y={46} textAnchor="middle" fontSize="17" fontWeight="800" fill="var(--mantine-color-text)">{p}%</text>
    </svg>
  );
}

function GaugeCard({ brand, title, sub, color, usage, active, tip }) {
  const BR = { linux: IconBrandDebian, s3: IconBrandAws, nas: IconDatabase };
  const Ic = BR[brand] || IconServer;
  const has = usage && usage.total > 0;
  return (
    <Card withBorder radius="lg" padding="lg" shadow="sm" style={active ? { borderColor: 'var(--mantine-color-' + color + '-5)', boxShadow: '0 0 0 2px var(--mantine-color-' + color + '-1)' } : undefined}>
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <Group gap={9} wrap="nowrap" style={{ minWidth: 0 }}><ThemeIcon size={40} radius="md" variant="light" color={color}><Ic size={22} /></ThemeIcon>
          <div style={{ minWidth: 0 }}><Group gap={6}><Text fw={700} lh={1}>{title}</Text>{active && <Badge size="xs" variant="filled" color={color}>activo</Badge>}</Group><Text fz={11} c="dimmed" truncate>{sub}</Text></div></Group>
        {tip && <Tooltip label={tip} withArrow multiline w={230}><ThemeIcon size={22} radius="xl" variant="subtle" color="gray"><IconInfoCircle size={15} /></ThemeIcon></Tooltip>}
      </Group>
      <Group gap="lg" wrap="nowrap" align="center">
        {has ? <FillDisk pct={usage.pct} /> : <ThemeIcon size={70} radius="md" variant="light" color={color}><Ic size={40} /></ThemeIcon>}
        <div style={{ flex: 1 }}>
          {has ? <>
            <Text fw={800} fz={20} lh={1}>{fmtSize(usage.used)}</Text>
            <Text fz="xs" c="dimmed">de {fmtSize(usage.total)} · libre {fmtSize(usage.avail)}</Text>
          </> : <Text fw={800} fz={18} lh={1}>{usage ? fmtSize(usage.bytes) : '—'}</Text>}
          <Group gap={6} mt={6}><Badge size="xs" variant="light" color={color} leftSection={<IconMicrophone2 size={10} />}>{usage ? (usage.files || 0) : 0} grab.</Badge>{!has && usage && <Badge size="xs" variant="light" color="gray">sin límite fijo</Badge>}</Group>
        </div>
      </Group>
    </Card>
  );
}

/* Diagnóstico de conexión al NAS */
function NasDiag({ cfg }) {
  const [busy, setBusy] = useState(false); const [res, setRes] = useState(null); const [open, setOpen] = useState(false);
  async function run() {
    setBusy(true); setRes(null); setOpen(true);
    try { const d = await fetch('/backend/api/recordings/storage/nastest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nas_type: cfg.nas_type || 'mount', nas_path: cfg.nas_path, nas_server: cfg.nas_server, nas_share: cfg.nas_share, nas_user: cfg.nas_user }) }).then(r => r.json()); setRes(d); }
    catch (_) { setRes({ ok: false, pasos: [{ paso: 'Error', ok: false, detalle: 'no se pudo ejecutar' }] }); }
    setBusy(false);
  }
  return (
    <Card withBorder radius="md" padding="sm" style={{ background: 'rgba(20,184,166,.04)' }}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap={8} wrap="nowrap"><ThemeIcon variant="light" color="teal" radius="md"><IconStethoscope size={16} /></ThemeIcon><div><Text fw={700} fz="sm" lh={1.1}>Diagnóstico del NAS</Text><Text fz={11} c="dimmed">Prueba alcance, montaje y escritura antes de guardar</Text></div></Group>
        <Button size="xs" variant="light" color="teal" leftSection={<IconStethoscope size={14} />} loading={busy} onClick={run}>Probar conexión</Button>
      </Group>
      <Collapse in={open}>
        <Stack gap={6} mt="sm">
          {busy && <Group gap={8}><Loader size="xs" /><Text fz="xs" c="dimmed">Probando el NAS…</Text></Group>}
          {res && res.pasos && res.pasos.map((p, i) => (
            <Group key={i} gap={8} wrap="nowrap" align="flex-start">
              <ThemeIcon size={22} radius="xl" variant="light" color={p.info ? 'blue' : p.ok ? 'teal' : 'red'} style={{ flex: 'none', marginTop: 1 }}>{p.info ? <IconInfoCircle size={13} /> : p.ok ? <IconCircleCheck size={13} /> : <IconCircleX size={13} />}</ThemeIcon>
              <div style={{ minWidth: 0, flex: 1 }}><Text fz="xs" fw={700}>{p.paso}</Text><Text fz="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>{p.detalle}</Text></div>
            </Group>
          ))}
          {res && res.mount_cmd && <Group gap={6} wrap="nowrap" mt={2}><Code style={{ fontSize: 11, flex: 1, wordBreak: 'break-all' }}>{res.mount_cmd}</Code><CopyButton value={res.mount_cmd}>{({ copied, copy }) => <Tooltip label={copied ? 'Copiado' : 'Copiar comando'}><ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy}>{copied ? <IconCheck size={15} /> : <IconCopy size={15} />}</ActionIcon></Tooltip>}</CopyButton></Group>}
        </Stack>
      </Collapse>
    </Card>
  );
}

const Th = ({ icon, children, tip }) => <Table.Th><Tooltip label={tip} disabled={!tip} withArrow><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap', cursor: tip ? 'help' : 'default' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Tooltip></Table.Th>;

export default function Grabaciones({ embedded = false, section = 'list' }) {
  const [list, setList] = useState([]); const [loading, setLoading] = useState(true); const [q, setQ] = useState('');
  const [cfg, setCfg] = useState(null); const [savingCfg, setSavingCfg] = useState(false); const [playId, setPlayId] = useState(null);
  const [usage, setUsage] = useState(null);
  async function load() { try { const d = await fetch('/backend/api/recordings').then(r => r.json()); setList(Array.isArray(d) ? d : []); } catch (_) { setList([]); } setLoading(false); }
  async function loadCfg() { try { setCfg(await fetch('/backend/api/recordings/config').then(r => r.json())); } catch (_) {} }
  async function loadUsage() { try { setUsage(await fetch('/backend/api/recordings/storage/usage').then(r => r.json())); } catch (_) {} }
  useEffect(() => { load(); loadCfg(); loadUsage(); const t = setInterval(() => { load(); loadUsage(); }, 12000); return () => clearInterval(t); }, []);
  async function del(id) { if (!confirm('¿Eliminar esta grabación?')) return; await fetch('/backend/api/recordings/' + id, { method: 'DELETE' }); toast('Grabación eliminada', 'info'); load(); }
  async function saveCfg() {
    setSavingCfg(true);
    const r = await fetch('/backend/api/recordings/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }).then(x => x.json()).catch(() => ({ error: 1 }));
    setSavingCfg(false);
    toast(r.error ? 'Error al guardar' : 'Configuración guardada', r.error ? 'bad' : 'ok'); loadCfg(); loadUsage();
  }
  async function testStore() {
    const r = await fetch('/backend/api/recordings/storage/test', { method: 'POST' }).then(x => x.json()).catch((e) => ({ error: e.message || 1 }));
    toast(r.error ? ('Error: ' + r.error) : (r.msg || 'OK'), r.error ? 'bad' : 'ok');
  }
  const setC = (k, v) => setCfg(c => ({ ...c, [k]: v }));
  const fl = list.filter(r => !q || String(r.id).includes(q) || (r.ext || '').includes(q) || (r.filename || '').includes(q) || (r.src || '').includes(q) || (r.dst || '').includes(q));
  const totalBytes = list.reduce((a, r) => a + (r.bytes || 0), 0);
  const totalDur = list.reduce((a, r) => a + (r.duration || 0), 0);
  const onCloud = list.filter(r => r.storage !== 'local').length;
  const kpis = [
    { k: 'Grabaciones', v: list.length, icon: IconWaveSine, c: 'pbx' },
    { k: 'Almacenado', v: fmtSize(totalBytes), icon: IconDatabase, c: 'violet' },
    { k: 'Duración total', v: fmtDur(totalDur), icon: IconClock, c: 'teal' },
    { k: 'En NAS / S3', v: onCloud, icon: IconCloud, c: 'blue' },
  ];
  const backend = (cfg && cfg.backend) || 'local';

  const kpiRow = (loading ? <SimpleGrid cols={{ base: 2, sm: 4 }}>{Array.from({ length: 4 }).map((_, i) => <Card key={i} withBorder radius="lg" padding="lg"><Group><ThemeIcon size={44} radius="md" variant="light" color="gray" /><div><Text fw={800} fz={24}>—</Text></div></Group></Card>)}</SimpleGrid> :
    <SimpleGrid cols={{ base: 2, sm: 4 }}>
      {kpis.map(x => (<Card key={x.k} withBorder radius="lg" padding="lg" shadow="sm"><Group><ThemeIcon size={44} radius="md" variant="light" color={x.c}><x.icon size={22} /></ThemeIcon><div><Text fw={800} fz={22} lh={1.1}>{x.v}</Text><Text size="sm" c="dimmed">{x.k}</Text></div></Group></Card>))}
    </SimpleGrid>);

  const listPanel = (
    <Card withBorder radius="lg" padding="lg" shadow="sm">
      <Group justify="space-between" mb="md">
        <Text fw={600}>{fl.length} grabaciones</Text>
        <TextInput placeholder="Buscar ID / interno / archivo" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={260} />
      </Group>
      {loading ? <TableSkeleton rows={6} cols={7} /> :
        fl.length === 0 ? <Text c="dimmed" ta="center" py="xl">{list.length ? 'Sin resultados.' : 'Aún no hay grabaciones. Iniciá una desde el softphone (botón Grabar).'}</Text> :
          <Table.ScrollContainer minWidth={820}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead><Table.Tr><Th icon={<IconHash size={13} />} tip="Identificador único de la grabación">ID</Th><Th icon={<IconClock size={13} />}>Fecha</Th><Th icon={<IconUser size={13} />}>Interno</Th><Th icon={<IconClock size={13} />}>Duración</Th><Th icon={<IconDatabase size={13} />}>Tamaño</Th><Th icon={<IconServer size={13} />} tip="Dónde está guardada: Local, NAS o S3">Almac.</Th><Th icon={<IconWaveSine size={13} />}>Audio</Th><Th icon={<IconWaveSine size={13} />}>Reproducir</Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>{fl.map(r => {
                const [col, lbl, Ic] = STG[r.storage] || STG.local;
                return (
                  <Fragment key={r.id}>
                  <Table.Tr>
                    <Table.Td><Badge size="sm" variant="light" color="gray" ff="monospace">#{r.id}</Badge></Table.Td>
                    <Table.Td><Text fz="xs">{r.started_at ? new Date(r.started_at).toLocaleString('es-UY') : '—'}</Text></Table.Td>
                    <Table.Td><Group gap={6}><ThemeIcon size="sm" radius="xl" variant="light" color="pbx"><IconWaveSine size={13} /></ThemeIcon><Text ff="monospace" fw={600}>{r.ext || '—'}</Text></Group></Table.Td>
                    <Table.Td><Badge variant="light" color="gray">{fmtDur(r.duration)}</Badge></Table.Td>
                    <Table.Td>{fmtSize(r.bytes)}</Table.Td>
                    <Table.Td><Tooltip label={'Guardada en ' + lbl} withArrow><Badge variant="light" color={col} leftSection={<Ic size={12} />}>{lbl}</Badge></Tooltip></Table.Td>
                    <Table.Td><MiniWave recId={r.id} /></Table.Td><Table.Td><Button size="compact-xs" variant={playId === r.id ? 'filled' : 'light'} color="teal" leftSection={playId === r.id ? <IconPlayerPause size={13} /> : <IconPlayerPlay size={13} />} onClick={() => setPlayId(playId === r.id ? null : r.id)}>{playId === r.id ? 'Cerrar' : 'Reproducir'}</Button></Table.Td>
                    <Table.Td ta="right"><Group gap={4} justify="flex-end">
                      <Tooltip label="Descargar WAV"><ActionIcon variant="subtle" component="a" href={'/backend/api/recordings/' + r.id + '/audio'} download><IconDownload size={17} /></ActionIcon></Tooltip>
                      <Tooltip label="Eliminar"><ActionIcon variant="subtle" color="red" onClick={() => del(r.id)}><IconTrash size={17} /></ActionIcon></Tooltip>
                    </Group></Table.Td>
                  </Table.Tr>
                  {playId === r.id && <Table.Tr><Table.Td colSpan={9} style={{ background: 'var(--mantine-color-default-hover)' }}><RecordingPlayer recId={r.id} src={'/backend/api/recordings/' + r.id + '/audio'} label={'Grabación #' + r.id + ' · Interno ' + (r.ext || '?')} /></Table.Td></Table.Tr>}
                  </Fragment>
                );
              })}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>}
    </Card>
  );

  const cfgPanel = (cfg &&
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        <GaugeCard brand="linux" title="Local (Linux)" sub={(usage && usage.local && usage.local.path) || '/recordings'} color="gray" usage={usage && usage.local} active={backend === 'local'} tip="Disco del servidor Debian donde Asterisk escribe las grabaciones. Se llena con el uso del sistema." />
        <GaugeCard brand="nas" title="NAS" sub={usage && usage.nas ? (usage.nas.mounted ? usage.nas.path : 'no montado') : (cfg.nas_path || 'sin configurar')} color="teal" usage={usage && usage.nas} active={backend === 'nas'} tip="Almacenamiento en red (NFS/CIFS montado). El % es el llenado del volumen del NAS." />
        <GaugeCard brand="s3" title="S3 / Objetos" sub={cfg.s3_bucket ? (cfg.s3_bucket + (cfg.s3_endpoint ? ' · MinIO' : ' · AWS')) : 'sin configurar'} color="blue" usage={usage && usage.s3} active={backend === 's3'} tip="Bucket S3 / MinIO. Nube de objetos sin límite fijo; se muestra lo consumido." />
      </SimpleGrid>

      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group gap="sm" mb="md"><ThemeIcon variant="light" color="pbx"><IconCloud size={18} /></ThemeIcon><Text fw={600}>Destino de almacenamiento</Text><Tooltip label="Dónde se guardan las grabaciones nuevas. El barrido automático mueve lo local al destino elegido." withArrow multiline w={260}><ThemeIcon size={20} radius="xl" variant="subtle" color="gray"><IconInfoCircle size={14} /></ThemeIcon></Tooltip></Group>
        <Stack gap="md">
          <Group grow align="flex-end">
            <Select label="Destino" value={backend} onChange={v => setC('backend', v)} data={[{ value: 'local', label: 'Local (en el servidor)' }, { value: 'nas', label: 'NAS (en red)' }, { value: 's3', label: 'S3 / compatible (MinIO)' }]} leftSection={backend === 'local' ? <IconBrandDebian size={15} /> : backend === 'nas' ? <IconDatabase size={15} /> : <IconBrandAws size={15} />} />
            <Tooltip label="Sube automáticamente cada grabación nueva al destino elegido" withArrow><Switch label="Subir automáticamente" checked={!!cfg.auto_upload} onChange={e => setC('auto_upload', e.currentTarget.checked)} /></Tooltip>
            <Tooltip label="Deja una copia en el disco local aunque se haya subido (más seguro)" withArrow><Switch label="Conservar copia local" checked={cfg.retain_local !== false} onChange={e => setC('retain_local', e.currentTarget.checked)} /></Tooltip>
          </Group>

          {backend === 'nas' && <>
            <Divider label="Conexión al NAS" labelPosition="left" />
            <div>
              <Text size="sm" fw={500} mb={4}>Cómo se conecta</Text>
              <SegmentedControl fullWidth value={cfg.nas_type || 'mount'} onChange={v => setC('nas_type', v)} data={[{ value: 'mount', label: 'Ruta montada' }, { value: 'nfs', label: 'NFS' }, { value: 'cifs', label: 'CIFS / SMB' }]} />
              <Text size="xs" c="dimmed" mt={6}>{(cfg.nas_type || 'mount') === 'mount' ? 'El NAS ya está montado en el server; sólo indicá la ruta.' : (cfg.nas_type === 'nfs' ? 'Recurso NFS (Linux/NAS). Se monta en el server; el panel genera el comando.' : 'Recurso Windows/SMB. Se monta con usuario y clave; el panel genera el comando.')}</Text>
            </div>
            {(cfg.nas_type || 'mount') !== 'mount' && <Group grow>
              <TextInput label="Servidor NAS (IP o host)" placeholder="192.168.99.50" value={cfg.nas_server || ''} onChange={e => setC('nas_server', e.target.value)} leftSection={<IconServer size={15} />} />
              <TextInput label={cfg.nas_type === 'cifs' ? 'Recurso compartido' : 'Export'} placeholder={cfg.nas_type === 'cifs' ? 'grabaciones' : '/volume1/grabaciones'} value={cfg.nas_share || ''} onChange={e => setC('nas_share', e.target.value)} leftSection={<IconFolder size={15} />} />
            </Group>}
            {cfg.nas_type === 'cifs' && <Group grow>
              <TextInput label="Usuario" value={cfg.nas_user || ''} onChange={e => setC('nas_user', e.target.value)} leftSection={<IconUser size={15} />} />
              <PasswordInput label="Contraseña" placeholder={cfg.has_nas_pass ? '•••••• (guardada)' : ''} value={cfg.nas_pass || ''} onChange={e => setC('nas_pass', e.target.value)} />
            </Group>}
            <TextInput label="Ruta local montada" description="Carpeta del server de Asterisk donde queda montado el NAS" placeholder="/mnt/nas/grabaciones" value={cfg.nas_path || ''} onChange={e => setC('nas_path', e.target.value)} leftSection={<IconFolder size={15} />} />
            <NasDiag cfg={cfg} />
          </>}

          {backend === 's3' && <>
            <Divider label="Credenciales S3" labelPosition="left" />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="Endpoint (vacío = AWS)" placeholder="https://s3.amazonaws.com o MinIO" value={cfg.s3_endpoint || ''} onChange={e => setC('s3_endpoint', e.target.value)} />
              <TextInput label="Región" placeholder="us-east-1" value={cfg.s3_region || ''} onChange={e => setC('s3_region', e.target.value)} />
              <TextInput label="Bucket" value={cfg.s3_bucket || ''} onChange={e => setC('s3_bucket', e.target.value)} />
              <TextInput label="Prefijo" placeholder="recordings/" value={cfg.s3_prefix || ''} onChange={e => setC('s3_prefix', e.target.value)} />
              <TextInput label="Access Key" value={cfg.s3_key || ''} onChange={e => setC('s3_key', e.target.value)} />
              <PasswordInput label="Secret Key" placeholder={cfg.has_secret ? '•••••• (guardado)' : ''} value={cfg.s3_secret || ''} onChange={e => setC('s3_secret', e.target.value)} />
            </SimpleGrid>
          </>}

          <Group justify="space-between">
            {backend !== 'local' ? <Button variant="light" leftSection={<IconStethoscope size={16} />} onClick={testStore}>Probar destino</Button> : <span />}
            <Button leftSection={<IconDeviceFloppy size={16} />} loading={savingCfg} onClick={saveCfg}>Guardar configuración</Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );

  if (embedded) {
    if (section === 'cfg') return cfgPanel || <TableSkeleton rows={3} cols={2} />;
    return <Stack gap="lg">{kpiRow}{listPanel}</Stack>;
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-grape-5),var(--mantine-color-grape-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'grape.5', to: 'grape.8', deg: 135 }}><IconMicrophone2 size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Grabaciones</Title><Text c="dimmed" size="sm">Audio de llamadas · almacenamiento local, NAS o S3</Text></div></div>
        <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => { load(); loadUsage(); }}>Actualizar</Button>
      </Group>
      {kpiRow}
      <Tabs defaultValue="list" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="list" leftSection={<IconMicrophone2 size={16} />}>Grabaciones</Tabs.Tab>
          <Tabs.Tab value="cfg" leftSection={<IconSettings size={16} />}>Almacenamiento</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="list">{listPanel}</Tabs.Panel>
        <Tabs.Panel value="cfg">{cfgPanel}</Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
