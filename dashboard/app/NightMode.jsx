'use client';
/* ============================================================================
 *  Modo noche — lo que el operador cambia a mano cuando cierra antes.
 *
 *  Tres estados: `auto` (manda el horario y los feriados), `abierto` y `cerrado`
 *  (forzados hasta que alguien los saque). El estado que DE VERDAD está rigiendo
 *  ahora lo calcula la API (`estado`), porque es la misma cuenta que hace el
 *  dialplan: si lo calculara el navegador, el panel diría una cosa y la central
 *  haría otra en cuanto el reloj del cliente estuviera corrido.
 *
 *  Se exporta también el chip compacto que va en el pie del menú: es un estado
 *  que conviene ver sin entrar a ninguna pantalla.
 * ==========================================================================*/
import { useEffect, useState } from 'react';
import {
  Card, Group, Text, Badge, SegmentedControl, ThemeIcon, Stack, Tooltip, Skeleton, Alert,
} from '@mantine/core';
import { IconMoonStars, IconSun, IconClockHour4, IconInfoCircle, IconLock } from '@tabler/icons-react';
import { apiPut, usePoll } from './api';
import { toast } from './notify';

/* 60 s: es configuración (la cambia una persona), pero el estado calculado se
 * mueve solo al llegar la hora de cierre, así que tampoco puede quedar congelado.
 * `usePoll` no pide nada con la pestaña en segundo plano. */
const MS = 60000;

const OPCIONES = [
  { value: 'auto', label: 'Automático' },
  { value: 'abierto', label: 'Abierto' },
  { value: 'cerrado', label: 'Cerrado' },
];

export function textoEstado(d) {
  if (!d) return '';
  const abierto = d.estado === 'abierto';
  const base = abierto ? 'Ahora: abierto' : 'Ahora: cerrado';
  if (d.hasta) return base + ' hasta las ' + d.hasta;
  if (d.motivo) return base + ' · ' + d.motivo;
  return base;
}

/* Chip para el menú: sólo lee. Si la API todavía no tiene la ruta (instalación
 * vieja) o el rol no la puede leer, no se dibuja nada en vez de mostrar un error
 * en un lugar donde no se puede hacer nada al respecto. */
export function NightModeChip() {
  const { data, error } = usePoll('/nightmode', MS);
  if (error || !data || !data.estado) return null;
  const abierto = data.estado === 'abierto';
  return (
    <Tooltip label={textoEstado(data) + (data.modo === 'auto' ? ' · por horario' : ' · forzado a mano')}>
      <Badge size="sm" radius="sm" variant="light" color={abierto ? 'teal' : 'indigo'}
        leftSection={abierto ? <IconSun size={11} /> : <IconMoonStars size={11} />}>
        {abierto ? 'Abierto' : 'Modo noche'}
      </Badge>
    </Tooltip>
  );
}

/** Control completo. `compacto` achica el encabezado para meterlo arriba de una pantalla. */
export default function NightModeCard({ compacto = false }) {
  const { data, error, recargar } = usePoll('/nightmode', MS);
  const [modo, setModo] = useState(null);
  const [guardando, setGuardando] = useState(false);

  // El valor del control sigue a la API salvo mientras se está guardando el cambio propio.
  useEffect(() => { if (data && data.modo && !guardando) setModo(data.modo); }, [data, guardando]);

  async function cambiar(v) {
    const previo = modo;
    setModo(v); setGuardando(true);
    try {
      const r = await apiPut('/nightmode', { modo: v });
      /* Con `aviso`, la base quedó al día y la central NO: el modo noche decide a dónde entra
       * cada llamada de la calle, así que no se puede festejar un cambio que no se aplicó. */
      if (r && r.aviso) toast(r.aviso, 'bad', { description: 'Mientras tanto la central sigue como estaba.' });
      else toast(v === 'auto' ? 'Modo noche automático: manda el horario' :
        v === 'abierto' ? 'Forzado ABIERTO: entra por el destino normal' :
          'Forzado CERRADO: entra por el destino de fuera de hora', 'ok');
      recargar();
    } catch (e) { setModo(previo); toast(e.message, 'bad'); }
    setGuardando(false);
  }

  if (error) {
    return (
      <Alert color="orange" variant="light" icon={<IconInfoCircle size={18} />} title="Modo noche no disponible">
        <Text fz="sm">{error.message}</Text>
      </Alert>
    );
  }
  if (!data) return <Skeleton h={compacto ? 96 : 140} radius="lg" />;

  const abierto = data.estado === 'abierto';
  const forzado = data.modo && data.modo !== 'auto';

  return (
    <Card withBorder radius="lg" padding={compacto ? 'md' : 'lg'}
      style={{ background: abierto ? 'rgba(18,184,134,.06)' : 'rgba(76,110,245,.07)' }}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={44} radius="md" variant="light" color={abierto ? 'teal' : 'indigo'}>
            {abierto ? <IconSun size={24} /> : <IconMoonStars size={24} />}
          </ThemeIcon>
          <div>
            <Group gap={8}>
              <Text fw={800} fz="lg" lh={1.1}>{abierto ? 'La central está abierta' : 'La central está cerrada'}</Text>
              {forzado && <Badge size="sm" variant="light" color="orange" leftSection={<IconLock size={10} />}>forzado a mano</Badge>}
            </Group>
            <Group gap={6} mt={2}>
              <IconClockHour4 size={13} style={{ opacity: .6 }} />
              <Text fz="sm" c="dimmed">{textoEstado(data)}</Text>
            </Group>
          </div>
        </Group>
        <Stack gap={4} align="flex-end">
          <SegmentedControl size="sm" radius="md" value={modo || 'auto'} data={OPCIONES}
            onChange={cambiar} disabled={guardando} />
          <Text fz="10px" c="dimmed">Automático = manda el horario y los feriados</Text>
        </Stack>
      </Group>
      {!compacto && (
        <Text fz="xs" c="dimmed" mt="sm">
          Las rutas entrantes que tengan un horario asignado entran por el destino normal cuando
          está abierto y por el destino de fuera de hora cuando está cerrado. Los dos forzados
          quedan puestos hasta que alguien vuelva a Automático (no se sueltan solos a medianoche).
        </Text>
      )}
    </Card>
  );
}
