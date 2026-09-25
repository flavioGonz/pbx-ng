'use client';
/* ============================================================================
 *  IA & Voz › Nube: los proveedores que están FUERA de la central.
 *
 *  POR QUÉ ESTA PANTALLA EXISTE SEPARADA DEL MOTOR LOCAL: son dos cosas que se parecen
 *  —las dos «hacen voz»— y que no se parecen en nada donde importa. El contenedor
 *  `pbxng-voz` corre en el mismo fierro: no se paga por minuto, no sale a internet y
 *  sigue andando con el enlace caído. Un modelo de la nube es lo contrario en los tres
 *  puntos. Tenerlos mezclados hacía imposible contestar dos preguntas que se hacen a
 *  diario: «si se corta internet, ¿el portero sigue atendiendo?» y «¿esto qué me cuesta?».
 *
 *  La clave se carga acá y NO vuelve nunca al panel: el backend contesta `__SET__` y
 *  listo. Lo que sí vuelve es lo útil — qué modelos sirve esta cuenta.
 * ==========================================================================*/
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, Button, Badge, ThemeIcon, PasswordInput, TextInput, Alert, Code, SimpleGrid, Divider, Anchor, Tooltip } from '@mantine/core';
import { IconKey, IconDeviceFloppy, IconInfoCircle, IconRefresh, IconWorld, IconCoin, IconShieldLock, IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { IcoNube, IcoCerebro } from './IaIcons';
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

  const vozAvos = (modelos?.modelos || []).filter(m => /realtime|^gpt-live/.test(m));
  const otros = (modelos?.modelos || []).filter(m => !/realtime|^gpt-live/.test(m));

  return (
    <Stack gap="lg">
      <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />}>
        Todo lo de esta pestaña <b>sale de la central</b>: el audio de la llamada viaja al proveedor, se paga por minuto y
        deja de funcionar si se corta el enlace. Lo que corre en tu servidor —Whisper y las voces Piper— vive en
        <b> Motor local</b>, y sigue andando sin internet.
      </Alert>

      <Card withBorder radius="lg" padding="lg">
        <Group justify="space-between" wrap="nowrap" mb="md">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color={keySet ? 'violet' : 'gray'} size={42} radius="md"><IcoNube size={24} activo={keySet} /></ThemeIcon>
            <div>
              <Text fw={700}>OpenAI</Text>
              <Text size="xs" c="dimmed">Voz a voz (GPT-Live / Realtime) y el pipeline de tres pasos</Text>
            </div>
          </Group>
          <Badge variant="light" size="lg" color={keySet ? 'teal' : 'gray'} leftSection={keySet ? <IconCircleCheck size={13} /> : <IconAlertTriangle size={13} />}>
            {keySet ? 'Clave cargada' : 'Sin clave · los agentes caen a modo demo'}
          </Badge>
        </Group>

        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <div>
            <Group align="flex-end" gap="sm">
              <PasswordInput label="Clave de API" description="Se guarda en la central y no vuelve a mostrarse"
                placeholder={keySet ? '•••••••••• (guardada)' : 'sk-...'} value={keyVal}
                onChange={e => setKeyVal(e.currentTarget.value)} style={{ flex: 1 }} leftSection={<IconKey size={15} />} />
              <Button leftSection={<IconDeviceFloppy size={16} />} loading={keySaving} disabled={!keyVal}
                onClick={() => guardar('openai_api_key', keyVal, setKeySaving)}>Guardar</Button>
            </Group>
            <Group gap={6} mt={8} wrap="nowrap">
              <IconShieldLock size={13} style={{ opacity: .5, flexShrink: 0 }} />
              <Text size="xs" c="dimmed">Si alguna vez compartiste esta clave por chat o correo, rotala en tu panel de OpenAI: una clave filtrada se usa desde cualquier lado y la factura es tuya.</Text>
            </Group>
          </div>
          <div>
            <Group align="flex-end" gap="sm">
              <TextInput label="Endpoint alternativo" description="Vacío = OpenAI. Se usa para Azure o un proxy propio"
                placeholder="wss://mi-recurso.openai.azure.com/…" value={base}
                onChange={e => setBase(e.currentTarget.value)} style={{ flex: 1 }} leftSection={<IconWorld size={15} />} />
              <Button variant="default" leftSection={<IconDeviceFloppy size={16} />} loading={baseSaving}
                onClick={() => guardar('realtime_url', base, setBaseSaving)}>Guardar</Button>
            </Group>
            <Text size="xs" c="dimmed" mt={8}>Cambiar de proveedor no tiene que ser una actualización de la central: por eso esto es un ajuste.</Text>
          </div>
        </SimpleGrid>
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Group justify="space-between" mb="sm">
          <Group gap="sm">
            <ThemeIcon variant="light" color="grape" size={34} radius="md"><IcoCerebro size={20} activo={!!vozAvos.length} /></ThemeIcon>
            <div>
              <Text fw={700}>Modelos que sirve tu cuenta</Text>
              <Text size="xs" c="dimmed">Consultado al proveedor con la clave cargada, no una lista escrita en el código</Text>
            </div>
          </Group>
          <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} loading={cargando} onClick={cargarModelos}>Actualizar</Button>
        </Group>

        {!modelos ? <Text size="sm" c="dimmed">Consultando…</Text>
          : !modelos.ok ? <Alert variant="light" color={keySet ? 'orange' : 'gray'} icon={<IconAlertTriangle size={16} />}>{modelos.error || 'No se pudo consultar.'}</Alert>
            : <>
              <Text size="sm" fw={600} mb={6}>Voz a voz <Text span size="xs" c="dimmed" fw={400}>· los que puede usar un agente</Text></Text>
              {vozAvos.length
                ? <Group gap={6} mb="md">{vozAvos.map(m => <Tooltip key={m} label="Pegalo en el campo Modelo del agente"><Code style={{ cursor: 'default' }}>{m}</Code></Tooltip>)}</Group>
                : <Alert variant="light" color="orange" mb="md" icon={<IconAlertTriangle size={16} />}>
                    Tu cuenta no lista ningún modelo de voz a voz. Suele ser el nivel de uso o la verificación de la organización, y se habilita
                    en el panel de OpenAI — no acá. Mientras tanto los agentes atienden en modo demo.
                  </Alert>}
              {otros.length ? <>
                <Divider my="sm" />
                <Text size="xs" c="dimmed" mb={6}>Otros modelos de audio ({otros.length})</Text>
                <Group gap={6}>{otros.slice(0, 12).map(m => <Code key={m}>{m}</Code>)}</Group>
              </> : null}
              <Text size="xs" c="dimmed" mt="md">
                De {modelos.total} modelos en la cuenta. La prueba de conexión de cada agente es la que confirma que uno anda de verdad:
                abrir la sesión y que el modelo hable son dos cosas distintas.
              </Text>
            </>}
      </Card>

      <Card withBorder radius="lg" padding="lg">
        <Group gap="sm" mb="sm">
          <ThemeIcon variant="light" color="yellow" size={34} radius="md"><IconCoin size={19} /></ThemeIcon>
          <div><Text fw={700}>Qué se paga</Text><Text size="xs" c="dimmed">Para que nadie se entere por la factura</Text></div>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
          <div><Text size="sm" fw={600}>Por minuto de conversación</Text><Text size="xs" c="dimmed">Una sesión de voz a voz se cobra mientras está abierta, hable o escuche. Por eso el tope de <b>llamadas simultáneas</b> de cada cola es, sobre todo, un tope de gasto.</Text></div>
          <div><Text size="sm" fw={600}>Cada prueba de conexión</Text><Text size="xs" c="dimmed">Abre una sesión real de unos segundos. Es centavos, pero no es gratis: por eso hay un candado de una prueba cada 5 s.</Text></div>
          <div><Text size="sm" fw={600}>El modo demo no cuesta nada</Text><Text size="xs" c="dimmed">Vosk + reglas + voz local, todo adentro del fierro. Sirve para probar el recorrido de la llamada sin gastar.</Text></div>
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt="md">
          Los precios los publica cada proveedor y cambian: mirá <Anchor href="https://openai.com/api/pricing/" target="_blank" rel="noreferrer" size="xs">su página de precios</Anchor> antes de dejar esto prendido en un cliente.
        </Text>
      </Card>
    </Stack>
  );
}
