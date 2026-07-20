'use client';
/* Dialplan — lectura del plan de marcado ACTIVO de Asterisk (estático + realtime).
 * No se hardcodea nada: se lee en vivo con `dialplan show <contexto>` vía el agente.
 * El objetivo acá es EXPLICAR: qué es un contexto, qué hace cada aplicación y cómo
 * se encadenan las prioridades, para que el plan sea legible por un operador. */
import { useEffect, useState } from 'react';
import { Card, Title, Text, Stack, SegmentedControl, Group, Code, Button, Table, Badge, Switch, TextInput, ThemeIcon, Tooltip, Alert } from '@mantine/core';
import { IconRefresh, IconSearch, IconTerminal2, IconRoute, IconHash, IconApps, IconInfoCircle, IconArrowDown, IconBook2 } from '@tabler/icons-react';
import { TableSkeleton } from '../Skeletons';

/* Color por aplicación + explicación en una línea (para el tooltip). */
const APP = {
  Dial:        { c: 'teal',   d: 'Llama a un destino (interno o troncal) y conecta las dos patas de audio.' },
  Hangup:      { c: 'gray',   d: 'Corta la llamada y libera el canal.' },
  NoOp:        { c: 'gray',   d: 'No hace nada; se usa para dejar trazas en el log (depuración).' },
  Answer:      { c: 'blue',   d: 'Contesta la llamada (pasa el canal a "atendido").' },
  Goto:        { c: 'violet', d: 'Salta a otro contexto / extensión / prioridad del plan.' },
  GotoIf:      { c: 'violet', d: 'Salta condicionalmente según una expresión.' },
  Queue:       { c: 'orange', d: 'Encola la llamada hacia un grupo de agentes.' },
  ConfBridge:  { c: 'grape',  d: 'Mete el canal en una sala de conferencia.' },
  Playback:    { c: 'cyan',   d: 'Reproduce un audio y sigue (sin esperar dígitos).' },
  Background:  { c: 'cyan',   d: 'Reproduce un audio esperando que el llamante marque (IVR).' },
  Page:        { c: 'orange', d: 'Megafonía: llama a varios equipos a la vez con auto-respuesta.' },
  VoiceMail:   { c: 'indigo', d: 'Manda la llamada al buzón de voz de una extensión.' },
  VoiceMailMain:{ c: 'indigo',d: 'Entra a la consola del buzón para escuchar mensajes.' },
  Set:         { c: 'blue',   d: 'Fija una variable de canal (CallerID, códecs, temporizadores…).' },
  Authenticate:{ c: 'red',    d: 'Pide una clave antes de continuar.' },
  Wait:        { c: 'gray',   d: 'Espera N segundos.' },
  Bridge:      { c: 'teal',   d: 'Puentea el canal con otro canal existente.' },
  Record:      { c: 'grape',  d: 'Graba audio del canal a un archivo.' },
  MixMonitor:  { c: 'grape',  d: 'Graba la llamada (ambas patas) mientras sigue en curso.' },
  Playtones:   { c: 'cyan',   d: 'Genera tonos (ocupado, control de progreso…).' },
  Congestion:  { c: 'red',    d: 'Devuelve tono/estado de congestión (todas las líneas ocupadas).' },
  Busy:        { c: 'red',    d: 'Devuelve ocupado.' },
};

/* Qué es cada contexto: el "cajón" del plan al que entra un tipo de llamada. */
const CTX = {
  internal:     { label: 'internal',    color: 'teal',   d: 'Lo que marcan tus internos: llamadas entre extensiones y salidas por troncal (rutas de salida).' },
  ivr:          { label: 'ivr',         color: 'cyan',   d: 'Menús de voz: "marque 1 para ventas…". Reproducen audio y ramifican según el dígito.' },
  'from-trunk': { label: 'from-trunk',  color: 'orange', d: 'Lo que llega DESDE afuera (operador o SBC): acá se resuelve a qué interno/DID entra.' },
  default:      { label: 'default',     color: 'gray',   d: 'Contexto por defecto de Asterisk. Suele estar vacío o con reglas de respaldo.' },
};

function parseDialplan(txt) {
  const rows = []; let cur = null;
  for (const line of String(txt).split('\n')) {
    let m = /^\s*'([^']+)'\s*=>\s*(\d+)\.\s*(.+?)\s*(\[[^\]]*\])?\s*$/.exec(line);
    if (m) { cur = m[1]; rows.push({ exten: cur, prio: m[2], call: m[3].trim() }); continue; }
    m = /^\s*(\d+)\.\s*(.+?)\s*(\[[^\]]*\])?\s*$/.exec(line);
    if (m && cur) { rows.push({ exten: '', prio: m[1], call: m[2].trim() }); }
  }
  return rows.map(r => { const a = /^([\w]+)\((.*)\)\s*$/.exec(r.call); return { ...r, app: a ? a[1] : r.call, data: a ? a[2] : '' }; });
}

const Th = ({ icon, children }) => <Table.Th><Group gap={6} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}><span style={{ opacity: .55, display: 'flex' }}>{icon}</span>{children}</Group></Table.Th>;

export default function Dialplan() {
  const [ctx, setCtx] = useState('internal'); const [out, setOut] = useState(''); const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState(false); const [q, setQ] = useState('');
  async function load(c) { setLoading(true); try { const r = await fetch('/backend/api/dialplan?context=' + c).then(x => x.json()); setOut(r.output || r.error || ''); } catch (_) { setOut('Error'); } setLoading(false); }
  useEffect(() => { load(ctx); }, [ctx]);
  const rows = parseDialplan(out);
  const fr = rows.filter(r => !q || (r.exten || '').includes(q) || r.app.toLowerCase().includes(q.toLowerCase()) || (r.data || '').toLowerCase().includes(q.toLowerCase()));
  const exCount = new Set(rows.map(r => r.exten).filter(Boolean)).size;
  const appsUsed = Array.from(new Set(rows.map(r => r.app))).filter(a => APP[a]);
  const info = CTX[ctx] || { d: '' };

  return (
    <Stack gap="lg">
      <div className="pbx-pagehead"><span className="pbx-acc-bar" style={{ background: 'linear-gradient(180deg,var(--mantine-color-cyan-5),var(--mantine-color-cyan-8))' }} /><ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'cyan.5', to: 'cyan.8', deg: 135 }}><IconTerminal2 size={24} /></ThemeIcon><div><Title order={2} lh={1.1}>Dialplan</Title><Text c="dimmed" size="sm">Plan de marcado activo · leído en vivo del núcleo (estático + realtime PostgreSQL)</Text></div></div>

      <Alert variant="light" color="cyan" radius="lg" icon={<IconInfoCircle size={18} />} title="Cómo leer esto">
        <Text size="sm">El plan de marcado es la lógica que decide <b>qué pasa con cada llamada</b>. Se organiza en <b>contextos</b> (cajones según de dónde viene la llamada). Dentro de cada contexto, una <b>extensión</b> (el número o patrón marcado) ejecuta una lista de <b>prioridades</b> en orden: <Code>1 → 2 → 3…</Code>, y cada paso es una <b>aplicación</b> de Asterisk (Dial, Answer, Hangup…). Pasá el mouse por cada aplicación para ver qué hace. Esto es <b>solo lectura</b>: las reglas se generan desde <b>Extensiones</b>, <b>Troncales</b> y <b>Rutas</b> — no se editan a mano.</Text>
      </Alert>

      {/* Selector de contexto con su explicación */}
      <Card withBorder radius="lg" padding="lg" shadow="sm">
        <Group justify="space-between" mb="sm" wrap="wrap">
          <SegmentedControl value={ctx} onChange={setCtx} data={Object.keys(CTX).map(k => ({ label: CTX[k].label, value: k }))} />
          <Group gap="sm">
            {!raw && <TextInput placeholder="Buscar extensión / app / dato" leftSection={<IconSearch size={15} />} value={q} onChange={e => setQ(e.target.value)} w={240} />}
            <Switch label="Texto crudo" checked={raw} onChange={e => setRaw(e.currentTarget.checked)} />
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => load(ctx)}>Recargar</Button>
          </Group>
        </Group>
        <Alert variant="light" color={info.color || 'gray'} radius="md" mb="md" icon={<IconRoute size={16} />}>
          <Group gap={8} wrap="nowrap"><Text size="sm"><b>Contexto <Code>{ctx}</Code>:</b> {info.d}</Text></Group>
          <Group gap={12} mt={6}><Badge variant="light" color={info.color || 'gray'} leftSection={<IconRoute size={12} />}>{exCount} extensiones</Badge><Badge variant="light" color="gray" leftSection={<IconHash size={12} />}>{rows.length} pasos</Badge></Group>
        </Alert>

        {loading ? <TableSkeleton rows={8} cols={4} /> :
          raw ? <Code block style={{ maxHeight: '62vh', overflow: 'auto', fontSize: 12.5, lineHeight: 1.6 }}>{out || 'Sin datos'}</Code> :
            rows.length === 0 ? <Text c="dimmed" ta="center" py="xl">Sin reglas en el contexto “{ctx}”. Se van creando solas al dar de alta extensiones, troncales y rutas.</Text> :
              <Table.ScrollContainer minWidth={640}>
                <Table highlightOnHover verticalSpacing={7} withRowBorders={false}>
                  <Table.Thead><Table.Tr><Th icon={<IconRoute size={13} />}>Extensión / patrón</Th><Th icon={<IconHash size={13} />}>Paso</Th><Th icon={<IconApps size={13} />}>Aplicación</Th><Th icon={<IconTerminal2 size={13} />}>Argumentos</Th></Table.Tr></Table.Thead>
                  <Table.Tbody>{fr.map((r, i) => { const a = APP[r.app]; return (
                    <Table.Tr key={i} style={{ borderTop: r.exten ? '1px solid var(--mantine-color-gray-2)' : 'none' }}>
                      <Table.Td ff="monospace" fw={700} c={r.exten ? undefined : 'dimmed'}>{r.exten ? r.exten : <Group gap={6} wrap="nowrap"><IconArrowDown size={12} style={{ opacity: .4 }} /><Text span fz="xs" c="dimmed">sigue</Text></Group>}</Table.Td>
                      <Table.Td c="dimmed" fz="xs">{r.prio}</Table.Td>
                      <Table.Td>{a ? <Tooltip label={a.d} multiline w={260} withArrow position="top-start"><Badge size="sm" variant="light" color={a.c} style={{ cursor: 'help' }}>{r.app}</Badge></Tooltip> : <Badge size="sm" variant="light" color="blue">{r.app}</Badge>}</Table.Td>
                      <Table.Td ff="monospace" fz="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>{r.data || '—'}</Table.Td>
                    </Table.Tr>
                  ); })}</Table.Tbody>
                </Table>
              </Table.ScrollContainer>}
      </Card>

      {/* Glosario de las aplicaciones que aparecen en este contexto */}
      {!raw && appsUsed.length > 0 && (
        <Card withBorder radius="lg" padding="lg">
          <Group gap={9} mb="sm"><ThemeIcon size={28} radius="md" variant="light" color="cyan"><IconBook2 size={16} /></ThemeIcon><Text fw={700}>Qué hace cada aplicación de este contexto</Text></Group>
          <Stack gap={8}>{appsUsed.map(app => (
            <Group key={app} gap="sm" wrap="nowrap" align="flex-start">
              <Badge size="sm" variant="light" color={APP[app].c} style={{ minWidth: 108, justifyContent: 'flex-start' }}>{app}</Badge>
              <Text size="sm" c="dimmed">{APP[app].d}</Text>
            </Group>
          ))}</Stack>
        </Card>
      )}
    </Stack>
  );
}
