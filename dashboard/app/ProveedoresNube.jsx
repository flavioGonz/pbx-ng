'use client';
/* ============================================================================
 *  IA & Voz › Nube: todo lo que está FUERA de la central, en una pantalla.
 *
 *  POR QUÉ EXISTE SEPARADA DEL MOTOR LOCAL: son dos cosas que se parecen —las dos «hacen
 *  voz»— y que no se parecen en nada donde importa. El contenedor `pbxng-voz` corre en el
 *  mismo fierro: no se paga por minuto, no sale a internet y sigue andando con el enlace
 *  caído. Un proveedor de la nube es lo contrario en los tres puntos.
 *
 *  POR QUÉ ESTÁ APRETADA: acá no se «lee», se decide. Tres decisiones —qué clave, qué
 *  modelo, qué voz— que antes ocupaban tres pantallas de scroll y obligaban a recordar lo
 *  de arriba mientras se miraba lo de abajo. Ahora entra todo en una: dos columnas
 *  arriba, las voces con scroll PROPIO abajo (la lista crece adentro de su tarjeta, no
 *  contra la página) y el detalle de costos plegado, porque se lee una vez.
 *
 *  La clave se carga acá y NO vuelve nunca al panel: el backend contesta `__SET__`.
 * ==========================================================================*/
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, Button, Badge, ThemeIcon, PasswordInput, TextInput, Alert, Code, SimpleGrid, Anchor, Tooltip, ScrollArea, Accordion, Loader } from '@mantine/core';
import { IconKey, IconDeviceFloppy, IconRefresh, IconWorld, IconCoin, IconShieldLock, IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { IcoNube, IcoCerebro } from './IaIcons';
import VocesNube from './VocesNube';
import { toast } from './notify';

export default function ProveedoresNube() {
  const [keySet, setKeySet] = useState(false);
  const [keyVal, setKeyVal] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [base, setBase] = useState('');
  const [baseSaving, setBaseSaving] = useState(false);
  const [modelos, setModelos] = useState(null);
  const [cargando, setCargando] = useState(false);

  async function cargar() {
    try {
      const s = await fetch('/backend/api/settings').then(r => r.json());
      setKeySet(s.openai_api_key === '__SET__');
      if (s.realtime_url) setBase(s.realtime_url);
    } catch (_) {}
  }
  async function cargarModelos() {
    setCargando(true);
    try { setModelos(await fetch('/backend/api/ai-agents/modelos').then(r => r.json())); }
    catch (_) { setModelos({ ok: false, error: 'no se pudo consultar', modelos: [] }); }
    setCargando(false);
  }
  useEffect(() => { cargar().then(cargarModelos); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  async function guardar(campo, valor, setLoading) {
    setLoading(true);
    const r = await fetch('/backend/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [campo]: valor }) })
      .then(x => x.json()).catch(() => ({ error: 1 }));
    setLoading(false);
    if (r.error) { toast('No se pudo guardar', 'bad'); return; }
    toast('Guardado', 'ok');
    if (campo === 'openai_api_key') setKeyVal('');
    await cargar(); cargarModelos();
  }

  const vozAvoz = (modelos?.modelos || []).filter(m => /realtime|^gpt-live/.test(m));
  const otros = (modelos?.modelos || []).filter(m => !/realtime|^gpt-live/.test(m));

  return (
    <Stack gap="md">
      {/* ── Fila 1: las dos mitades de «conectar con el proveedor» ─────────── */}
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Card withBorder radius="lg" padding="md">
          <Group justify="space-between" wrap="nowrap" mb="sm">
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon variant="light" color={keySet ? 'violet' : 'gray'} size={38} radius="md"><IcoNube size={21} activo={keySet} /></ThemeIcon>
              <div>
                <Text fw={700} fz="sm" lh={1.2}>OpenAI</Text>
                <Text fz={11} c="dimmed">Voz a voz (GPT-Live / Realtime) y el pipeline de tres pasos</Text>
              </div>
            </Group>
            <Badge variant="light" color={keySet ? 'teal' : 'gray'} leftSection={keySet ? <IconCircleCheck size={12} /> : <IconAlertTriangle size={12} />}>
              {keySet ? 'Conectado' : 'Sin clave'}
            </Badge>
          </Group>

          <Group align="flex-end" gap="xs" mb="xs">
            <PasswordInput size="sm" label="Clave de API" style={{ flex: 1 }} leftSection={<IconKey size={14} />}
              placeholder={keySet ? '•••••••••• (guardada)' : 'sk-...'} value={keyVal} onChange={e => setKeyVal(e.currentTarget.value)} />
            <Button size="sm" leftSection={<IconDeviceFloppy size={15} />} loading={keySaving} disabled={!keyVal}
              onClick={() => guardar('openai_api_key', keyVal, setKeySaving)}>Guardar</Button>
          </Group>
          <Group align="flex-end" gap="xs">
            <TextInput size="sm" label="Endpoint alternativo" style={{ flex: 1 }} leftSection={<IconWorld size={14} />}
              placeholder="Vacío = OpenAI · Azure o un proxy propio" value={base} onChange={e => setBase(e.currentTarget.value)} />
            <Button size="sm" variant="default" leftSection={<IconDeviceFloppy size={15} />} loading={baseSaving}
              onClick={() => guardar('realtime_url', base, setBaseSaving)}>Guardar</Button>
          </Group>

          <Group gap={6} mt="sm" wrap="nowrap">
            <IconShieldLock size={13} style={{ opacity: .5, flexShrink: 0 }} />
            <Text fz={11} c="dimmed">La clave se guarda en la central y no vuelve a mostrarse. Si alguna vez la compartiste por chat o correo, rotala: se usa desde cualquier lado y la factura es tuya.</Text>
          </Group>
        </Card>

        <Card withBorder radius="lg" padding="md">
          <Group justify="space-between" wrap="nowrap" mb="sm">
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon variant="light" color="grape" size={38} radius="md"><IcoCerebro size={21} activo={!!vozAvoz.length} /></ThemeIcon>
              <div>
                <Text fw={700} fz="sm" lh={1.2}>Modelos de tu cuenta</Text>
                <Text fz={11} c="dimmed">Preguntados al proveedor, no una lista escrita en el código</Text>
              </div>
            </Group>
            <Tooltip label="Volver a preguntar"><Button size="compact-sm" variant="subtle" loading={cargando} onClick={cargarModelos}><IconRefresh size={15} /></Button></Tooltip>
          </Group>

          {!modelos ? <Group justify="center" py="md"><Loader size="sm" /></Group>
            : !modelos.ok ? <Alert variant="light" color={keySet ? 'orange' : 'gray'} p="xs" icon={<IconAlertTriangle size={15} />}><Text fz={11}>{modelos.error || 'No se pudo consultar.'}</Text></Alert>
              : <>
                <Text fz={11} fw={600} c="dimmed" mb={4}>VOZ A VOZ · los que puede usar un agente</Text>
                {vozAvoz.length
                  ? <ScrollArea.Autosize mah={92} type="auto"><Group gap={5}>{vozAvoz.map(m => <Code key={m} fz={11}>{m}</Code>)}</Group></ScrollArea.Autosize>
                  : <Alert variant="light" color="orange" p="xs" icon={<IconAlertTriangle size={15} />}>
                      <Text fz={11}>Tu cuenta no lista ninguno. Suele ser el nivel de uso o la verificación de la organización: se habilita en el panel de OpenAI, no acá. Mientras tanto los agentes atienden en modo demo.</Text>
                    </Alert>}
                {otros.length ? <>
                  <Text fz={11} fw={600} c="dimmed" mt="sm" mb={4}>OTROS DE AUDIO ({otros.length})</Text>
                  <ScrollArea.Autosize mah={54} type="auto"><Group gap={5}>{otros.map(m => <Code key={m} fz={10.5}>{m}</Code>)}</Group></ScrollArea.Autosize>
                </> : null}
                <Text fz={10.5} c="dimmed" mt="sm">De {modelos.total} en la cuenta. Que un modelo esté en la lista no garantiza que hable: eso lo confirma la prueba de conexión del agente.</Text>
              </>}
        </Card>
      </SimpleGrid>

      {/* ── Fila 2: las voces, con scroll propio ───────────────────────────── */}
      <VocesNube />

      {/* ── Fila 3: el costo, plegado (se lee una vez) ─────────────────────── */}
      <Accordion variant="contained" radius="lg">
        <Accordion.Item value="costo">
          <Accordion.Control icon={<ThemeIcon variant="light" color="yellow" size={26} radius="md"><IconCoin size={15} /></ThemeIcon>}>
            <Text fz="sm" fw={600}>Qué se paga <Text span fz="xs" c="dimmed" fw={400}>· para que nadie se entere por la factura</Text></Text>
          </Accordion.Control>
          <Accordion.Panel>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
              <div><Text fz="sm" fw={600}>Por minuto de conversación</Text><Text fz={11.5} c="dimmed">Una sesión de voz a voz se cobra mientras está abierta, hable o escuche. Por eso el tope de <b>llamadas simultáneas</b> de cada cola es, sobre todo, un tope de gasto.</Text></div>
              <div><Text fz="sm" fw={600}>Cada prueba de conexión</Text><Text fz={11.5} c="dimmed">Abre una sesión real de unos segundos. Son centavos, pero no es gratis: por eso hay un candado de una prueba cada 5 s.</Text></div>
              <div><Text fz="sm" fw={600}>El modo demo no cuesta nada</Text><Text fz={11.5} c="dimmed">Vosk + reglas + voz local, todo adentro del fierro. Sirve para probar el recorrido de la llamada sin gastar.</Text></div>
            </SimpleGrid>
            <Text fz={11} c="dimmed" mt="sm">Los precios los publica cada proveedor y cambian: mirá <Anchor href="https://openai.com/api/pricing/" target="_blank" rel="noreferrer" fz={11}>su página de precios</Anchor> antes de dejar esto prendido en un cliente.</Text>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}
