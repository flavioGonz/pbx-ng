'use client';
/* ============================================================================
 *  Desvíos, No molestar y sígueme de UN interno.
 *
 *  Se usa en dos lugares con la misma pinta: el editor de interno (/internos,
 *  donde el administrador toca el de cualquiera) y el panel del agente
 *  (/agente → «Mis desvíos», donde cada uno cambia el propio). Por eso vive en
 *  un componente y no dentro de una pantalla: el texto que explica qué hace
 *  cada desvío tiene que ser el MISMO en los dos lados, si no el usuario
 *  aprende una cosa en el panel y otra en el teléfono.
 *
 *  La API guarda en Postgres y además escribe la AstDB (DB(dnd/<ext>),
 *  DB(cfu/<ext>)…), que es lo que lee el dialplan en caliente: por eso el
 *  cambio se nota en la llamada siguiente sin recargar nada en Asterisk.
 * ==========================================================================*/
import { useEffect, useMemo, useState } from 'react';
import {
  Card, Stack, Group, Text, Switch, TextInput, NumberInput, Button, ThemeIcon,
  Badge, Alert, Skeleton, Code, Divider,
} from '@mantine/core';
import {
  IconBellOff, IconArrowForward, IconPhoneOff, IconPhonePause, IconDeviceMobile,
  IconInfoCircle, IconDeviceFloppy, IconRotate,
} from '@tabler/icons-react';
import { apiGet, apiPut } from './api';
import { toast } from './notify';

/* Códigos de fábrica. Son los mismos que instala la API en el contexto `internal`;
 * si el administrador los cambió en Funciones → Códigos, ahí manda el catálogo y
 * acá se muestra el de fábrica como referencia (se aclara abajo del panel). */
export const CODIGOS_DESVIO = {
  dnd_on: '*78', dnd_off: '*79',
  cfu_set: '*21', cfb_set: '*22', cfnr_set: '*23', fm_set: '*24',
};

/* El catálogo guarda los patrones como los escribe Asterisk (`_*21*.`); lo que se
 * le muestra al usuario es lo que marca antes del destino: *21. */
const prefijo = (code) => String(code || '').replace(/^_/, '').replace(/\*?\.$/, '').replace(/\*$/, '');

const VACIO = { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '', fm_seg: 15 };
const soloNumero = (v) => String(v ?? '').replace(/[^0-9*#+]/g, '');

/* Una fila = un desvío. El destino vacío significa apagado: así el usuario no
 * tiene que entender que hay un interruptor Y un campo (es el error clásico de
 * las centrales: el desvío queda «activo» pero sin destino y la llamada se cae). */
function FilaDesvio({ icon, color, titulo, ayuda, codigo, valor, onChange, placeholder }) {
  const activo = !!String(valor || '').trim();
  return (
    <Card withBorder radius="md" padding="sm">
      <Group align="flex-start" wrap="nowrap" gap="sm">
        <ThemeIcon size={34} radius="md" variant="light" color={activo ? color : 'gray'}>{icon}</ThemeIcon>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Group gap={8} mb={2} wrap="wrap">
            <Text fw={650} fz="sm">{titulo}</Text>
            {activo
              ? <Badge size="xs" variant="light" color={color}>activo</Badge>
              : <Badge size="xs" variant="light" color="gray">apagado</Badge>}
          </Group>
          <Text fz="xs" c="dimmed" mb={8}>{ayuda}</Text>
          <Group gap="sm" wrap="wrap" align="flex-end">
            <TextInput size="xs" w={190} placeholder={placeholder} value={valor || ''}
              onChange={(e) => onChange(soloNumero(e.currentTarget.value))}
              description="Vacío = desvío apagado" />
            <Text fz="xs" c="dimmed" mb={6}>
              también desde el teléfono con <Code>{codigo}*destino#</Code> · se apaga con <Code>{codigo}</Code>
            </Text>
          </Group>
        </div>
      </Group>
    </Card>
  );
}

/**
 * DesviosPanel — ABM de los desvíos de un interno.
 * @param {string} ext            interno a editar (si falta, no se pide nada)
 * @param {boolean} propio        true en el panel del agente (cambia los textos a 1ª persona)
 * @param {function} onGuardado   aviso opcional al terminar de guardar
 */
export default function DesviosPanel({ ext, propio = false, codigos, onGuardado }) {
  const [datos, setDatos] = useState(null);
  const [form, setForm] = useState(VACIO);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!ext) { setDatos(null); return; }
    let vivo = true;
    const ctrl = new AbortController();
    setDatos(null); setError(null);
    apiGet('/extensions/' + encodeURIComponent(ext) + '/features', { signal: ctrl.signal })
      .then((d) => {
        if (!vivo) return;
        const v = { ...VACIO, ...(d || {}) };
        v.fm_seg = Number(v.fm_seg) > 0 ? Number(v.fm_seg) : 15;
        setDatos(v); setForm(v);
      })
      .catch((e) => { if (vivo && e.name !== 'AbortError') setError(e); });
    return () => { vivo = false; ctrl.abort(); };
  }, [ext]);

  /* Si quien nos usa pudo leer el catálogo (`GET /api/featurecodes`, sólo admin) se
   * muestran los códigos DE VERDAD de esta central; si no, los de fábrica. */
  const cod = useMemo(() => {
    const m = { ...CODIGOS_DESVIO };
    Object.entries(codigos || {}).forEach(([k, v]) => { if (v) m[k] = prefijo(v); });
    return m;
  }, [codigos]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const cambiado = useMemo(() => !!datos && JSON.stringify(datos) !== JSON.stringify(form), [datos, form]);

  async function guardar() {
    setGuardando(true);
    try {
      const body = {
        dnd: !!form.dnd,
        cfu: (form.cfu || '').trim(),
        cfb: (form.cfb || '').trim(),
        cfnr: (form.cfnr || '').trim(),
        fm: (form.fm || '').trim(),
        fm_seg: Number(form.fm_seg) > 0 ? Number(form.fm_seg) : 15,
      };
      const r = await apiPut('/extensions/' + encodeURIComponent(ext) + '/features', body);
      const v = { ...VACIO, ...body, ...(r || {}) };
      v.fm_seg = Number(v.fm_seg) > 0 ? Number(v.fm_seg) : 15;
      setDatos(v); setForm(v);
      /* `aviso` llega cuando la API guardó en la base pero Asterisk no tomó el cambio (AMI
       * caído). Decirle «guardado» a secas era la mentira que más caro salía acá: la persona
       * apaga el no-molestar, se va tranquila y el teléfono sigue sin sonar. */
      if (r && r.aviso) toast(r.aviso, 'bad', { description: 'El panel ya lo tiene guardado; la central lo va a tomar cuando vuelva.' });
      else toast(propio ? 'Tus desvíos quedaron guardados' : 'Desvíos del interno ' + ext + ' guardados', 'ok');
      if (onGuardado) onGuardado(v);
    } catch (e) { toast(e.message, 'bad'); }
    setGuardando(false);
  }

  const apagarTodo = () => setForm((f) => ({ ...f, dnd: false, cfu: '', cfb: '', cfnr: '', fm: '' }));

  if (!ext) return <Text fz="sm" c="dimmed">Sin interno asignado: no hay desvíos que mostrar.</Text>;
  if (error) {
    return (
      <Alert color="red" variant="light" icon={<IconInfoCircle size={18} />} title="No se pudieron leer los desvíos">
        <Text fz="sm">{error.message}</Text>
      </Alert>
    );
  }
  if (!datos) return <Skeleton h={330} radius="lg" />;

  const yo = propio ? 'tu' : 'el';
  return (
    <Stack gap="sm">
      <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />}>
        Los desvíos se aplican en la llamada siguiente, sin reiniciar nada. El mismo cambio se
        puede hacer desde el teléfono marcando el código que figura en cada línea: lo que se
        marca ahí aparece acá y al revés.
      </Alert>

      <Card withBorder radius="md" padding="sm" style={{ background: form.dnd ? 'rgba(251,146,60,.07)' : undefined }}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap={10} wrap="nowrap">
            <ThemeIcon size={34} radius="md" variant="light" color={form.dnd ? 'orange' : 'gray'}><IconBellOff size={18} /></ThemeIcon>
            <div>
              <Text fw={650} fz="sm">No molestar (DND)</Text>
              <Text fz="xs" c="dimmed">
                {yo === 'tu' ? 'Tu teléfono no suena' : 'El teléfono no suena'}: quien llame va directo al buzón.
                Desde el teléfono: <Code>{cod.dnd_on}</Code> lo prende y <Code>{cod.dnd_off}</Code> lo apaga.
              </Text>
            </div>
          </Group>
          <Switch color="orange" checked={!!form.dnd} onChange={(e) => set('dnd', e.currentTarget.checked)} />
        </Group>
      </Card>

      <FilaDesvio icon={<IconArrowForward size={18} />} color="grape" titulo="Desvío incondicional"
        ayuda="Todas las llamadas van a otro lado sin timbrar acá. Es el que más se usa cuando alguien se va de licencia."
        codigo={cod.cfu_set} placeholder="1002 o un celular" valor={form.cfu} onChange={(v) => set('cfu', v)} />

      <FilaDesvio icon={<IconPhoneOff size={18} />} color="orange" titulo="Si está ocupado"
        ayuda="Sólo cuando el interno ya está en otra llamada. Si está vacío, va al buzón."
        codigo={cod.cfb_set} placeholder="1002" valor={form.cfb} onChange={(v) => set('cfb', v)} />

      <FilaDesvio icon={<IconPhonePause size={18} />} color="yellow" titulo="Si no contesta"
        ayuda="Cuando timbra y nadie atiende. Si está vacío se usa el sígueme y, si tampoco hay, el buzón."
        codigo={cod.cfnr_set} placeholder="1002" valor={form.cfnr} onChange={(v) => set('cfnr', v)} />

      <Card withBorder radius="md" padding="sm">
        <Group align="flex-start" wrap="nowrap" gap="sm">
          <ThemeIcon size={34} radius="md" variant="light" color={String(form.fm || '').trim() ? 'teal' : 'gray'}><IconDeviceMobile size={18} /></ThemeIcon>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Group gap={8} mb={2}>
              <Text fw={650} fz="sm">Sígueme</Text>
              {String(form.fm || '').trim()
                ? <Badge size="xs" variant="light" color="teal">activo</Badge>
                : <Badge size="xs" variant="light" color="gray">apagado</Badge>}
            </Group>
            <Text fz="xs" c="dimmed" mb={8}>
              Primero timbra el interno y, si nadie atiende, la llamada sale al celular por la ruta
              saliente que corresponda. Poné el número como lo marcarías desde el teléfono.
            </Text>
            <Group gap="sm" wrap="wrap" align="flex-end">
              <TextInput size="xs" w={190} placeholder="099123456" value={form.fm || ''}
                onChange={(e) => set('fm', soloNumero(e.currentTarget.value))}
                description="Vacío = sígueme apagado" />
              <NumberInput size="xs" w={150} min={5} max={120} value={form.fm_seg}
                onChange={(v) => set('fm_seg', Number(v) > 0 ? Number(v) : 15)}
                label={undefined} description="Segundos que timbra antes" />
              <Text fz="xs" c="dimmed" mb={6}>
                también con <Code>{cod.fm_set}*099123456#</Code>
              </Text>
            </Group>
          </div>
        </Group>
      </Card>

      <Divider my={2} />
      <Group justify="space-between">
        <Button variant="subtle" color="gray" size="compact-sm" leftSection={<IconRotate size={14} />} onClick={apagarTodo}>
          Apagar todos
        </Button>
        <Group gap="sm">
          {cambiado && <Text fz="xs" c="dimmed">Hay cambios sin guardar</Text>}
          <Button size="sm" loading={guardando} disabled={!cambiado}
            leftSection={<IconDeviceFloppy size={16} />} onClick={guardar}>Guardar desvíos</Button>
        </Group>
      </Group>
    </Stack>
  );
}
