'use client';
/* ============================================================================
 *  Catálogo de códigos de función.
 *
 *  Lo que el usuario marca desde el teléfono para cambiar algo sin entrar al
 *  panel: no molestar, desvíos, sígueme, modo noche, buzón, prueba de eco.
 *  El catálogo lo manda la API (`GET /api/featurecodes`); **el código de cada
 *  acción es editable**, porque cada central llega con costumbres distintas
 *  (hay clientes que ya tienen a la gente acostumbrada al *72 de otra marca).
 *
 *  Los textos de ayuda y el agrupado por tema viven acá y no en la API: son
 *  interfaz. Si la API agrega una acción que este archivo no conoce, igual se
 *  muestra (con su nombre y su descripción) al final, en «Otros».
 * ==========================================================================*/
import { useEffect, useMemo, useState } from 'react';
import {
  Card, Group, Text, Badge, Table, Stack, Button, TextInput, Switch, Alert, ThemeIcon,
  Skeleton, Code, Tooltip,
} from '@mantine/core';
import {
  IconAsterisk, IconInfoCircle, IconBellOff, IconArrowForward, IconMoonStars, IconMail,
  IconTool, IconDeviceFloppy,
} from '@tabler/icons-react';
import { apiGet, apiPost, apiPut } from './api';
import { toast, toastPromise } from './notify';

/* Temas, en el orden en que se muestran. */
const TEMAS = [
  { id: 'estado', titulo: 'No molestar', icon: <IconBellOff size={16} />, color: 'orange' },
  { id: 'desvios', titulo: 'Desvíos y sígueme', icon: <IconArrowForward size={16} />, color: 'grape' },
  { id: 'noche', titulo: 'Modo noche', icon: <IconMoonStars size={16} />, color: 'indigo' },
  { id: 'buzon', titulo: 'Buzón de voz', icon: <IconMail size={16} />, color: 'blue' },
  { id: 'pruebas', titulo: 'Pruebas y ayuda', icon: <IconTool size={16} />, color: 'teal' },
  { id: 'otros', titulo: 'Otros', icon: <IconAsterisk size={16} />, color: 'gray' },
];

/* Acción → tema + explicación. La clave es la `accion` del catálogo de la API
 * (`pbxng_featurecodes.accion`): si no coincide, la fila igual se muestra, pero
 * cae en «Otros» y sin el texto largo. */
const TEXTOS = {
  dnd_on: { tema: 'estado', nombre: 'No molestar: prender', desc: 'El teléfono deja de sonar y las llamadas van directo al buzón.' },
  dnd_off: { tema: 'estado', nombre: 'No molestar: apagar', desc: 'Vuelve a timbrar normalmente.' },
  cfu_set: { tema: 'desvios', nombre: 'Desvío incondicional', desc: 'Manda TODAS las llamadas a otro lado. Se marca el código, el destino y almohadilla.', patron: true },
  cfu_off: { tema: 'desvios', nombre: 'Apagar desvío incondicional', desc: 'Saca el desvío de todas las llamadas.' },
  cfb_set: { tema: 'desvios', nombre: 'Desvío si está ocupado', desc: 'Sólo cuando el interno ya está en otra llamada.', patron: true },
  cfb_off: { tema: 'desvios', nombre: 'Apagar desvío si ocupado', desc: 'Vuelve a caer en el buzón cuando está ocupado.' },
  cfnr_set: { tema: 'desvios', nombre: 'Desvío si no contesta', desc: 'Cuando timbra y nadie atiende.', patron: true },
  cfnr_off: { tema: 'desvios', nombre: 'Apagar desvío si no contesta', desc: 'Vuelve a caer en el buzón cuando nadie atiende.' },
  fm_set: { tema: 'desvios', nombre: 'Sígueme', desc: 'Timbra el interno y después el celular que se indique.', patron: true },
  fm_off: { tema: 'desvios', nombre: 'Apagar sígueme', desc: 'Deja de pasar la llamada al celular.' },
  night: { tema: 'noche', nombre: 'Alternar modo noche', desc: 'Cierra o abre la central a mano desde cualquier teléfono.' },
  vm_propio: { tema: 'buzon', nombre: 'Mi buzón de voz', desc: 'Entra al buzón del interno que llama.' },
  vm_otro: { tema: 'buzon', nombre: 'Buzón de otro', desc: 'Pide número de buzón y PIN.' },
  eco: { tema: 'pruebas', nombre: 'Prueba de eco', desc: 'Repite tu voz para verificar micrófono y audio.' },
  midigito: { tema: 'pruebas', nombre: 'Decir mi número', desc: 'Locuta el número del interno desde el que llamás.' },
};
/* Instalaciones viejas: la API 1.8.0 devolvía sólo `code`, sin `accion`. */
const POR_CODIGO = { '*43': 'eco', '*65': 'midigito', '*97': 'vm_propio', '*98': 'vm_otro' };

function normalizar(r) {
  const accion = r.accion || POR_CODIGO[r.code] || r.code || '';
  const t = TEXTOS[accion] || {};
  return {
    accion,
    code: r.code || '',
    nombre: r.nombre || r.name || t.nombre || accion,
    desc: r.desc || r.descripcion || t.desc || '',
    enabled: r.enabled !== undefined ? r.enabled !== false : r.installed !== false,
    tema: t.tema || 'otros',
    patron: !!t.patron,
  };
}

function Fila({ f, onGuardar }) {
  const [code, setCode] = useState(f.code);
  const [enabled, setEnabled] = useState(f.enabled);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCode(f.code); setEnabled(f.enabled); }, [f]);
  const cambiado = code !== f.code || enabled !== f.enabled;

  async function guardar(valores) {
    setBusy(true);
    try { await onGuardar({ accion: f.accion, ...valores }); }
    catch (_) { setCode(f.code); setEnabled(f.enabled); }
    setBusy(false);
  }

  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <TextInput size="xs" w={110} value={code} ff="monospace" aria-label={'Código de ' + f.nombre}
            onChange={(e) => setCode(e.currentTarget.value.replace(/[^0-9A-Za-z*#._!\[\]-]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter' && cambiado) guardar({ code, enabled }); }} />
          {f.patron && (
            <Tooltip label="Se marca el código, el destino y almohadilla. Ej: *21*1002#">
              <Badge size="xs" variant="light" color="gray" style={{ cursor: 'help' }}>+destino#</Badge>
            </Tooltip>
          )}
        </Group>
      </Table.Td>
      <Table.Td><Text fz="sm" fw={600}>{f.nombre}</Text></Table.Td>
      <Table.Td><Text fz="xs" c="dimmed">{f.desc}</Text></Table.Td>
      <Table.Td>
        <Switch size="sm" checked={enabled} disabled={busy}
          onChange={(e) => { const v = e.currentTarget.checked; setEnabled(v); guardar({ code, enabled: v }); }} />
      </Table.Td>
      <Table.Td ta="right">
        <Button size="compact-xs" variant={cambiado ? 'filled' : 'subtle'} disabled={!cambiado} loading={busy}
          leftSection={<IconDeviceFloppy size={13} />} onClick={() => guardar({ code, enabled })}>Guardar</Button>
      </Table.Td>
    </Table.Tr>
  );
}

export default function FeatureCodes() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  const cargar = () => apiGet('/featurecodes')
    .then((d) => { setRows(Array.isArray(d) ? d.map(normalizar) : []); setError(null); })
    .catch((e) => { setError(e); setRows([]); });
  useEffect(() => { cargar(); }, []);

  const porTema = useMemo(() => {
    const m = {};
    (rows || []).forEach((f) => { (m[f.tema] = m[f.tema] || []).push(f); });
    return m;
  }, [rows]);

  async function guardar({ accion, code, enabled }) {
    if (!String(code || '').trim()) { toast('El código no puede quedar vacío', 'bad'); throw new Error('vacío'); }
    try {
      await apiPut('/featurecodes', { accion, code: String(code).trim(), enabled: !!enabled });
      toast('Código guardado: ' + code, 'ok');
      await cargar();
    } catch (e) { toast(e.message, 'bad'); throw e; }
  }

  const instalar = () => toastPromise(apiPost('/featurecodes/install').then(cargar), {
    loading: 'Instalando en el plan de marcado…', success: 'Códigos instalados', error: (e) => e.message,
  });
  const desinstalar = () => {
    if (!confirm('¿Sacar los códigos del plan de marcado? Los internos dejan de poder marcarlos.')) return;
    toastPromise(apiPost('/featurecodes/uninstall').then(cargar), {
      loading: 'Quitando…', success: 'Códigos quitados', error: (e) => e.message,
    });
  };

  if (!rows) return <Skeleton h={320} radius="lg" />;

  return (
    <Stack gap="md">
      <Alert variant="light" color="teal" icon={<IconInfoCircle size={18} />}>
        Estos son los atajos que cualquier interno puede marcar desde su teléfono. El
        <b> código es editable</b>: cambialo si tu gente ya está acostumbrada a otro. Lo que se
        cambia desde el teléfono (por ejemplo <Code>*21*1002#</Code>) queda reflejado en el panel,
        en la pestaña <b>Desvíos</b> del interno.
      </Alert>

      {error && (
        <Alert color="orange" variant="light" icon={<IconInfoCircle size={18} />} title="No se pudo leer el catálogo">
          <Text fz="sm">{error.message}</Text>
        </Alert>
      )}

      <Group justify="flex-end" gap="sm">
        <Button size="compact-sm" variant="default" onClick={desinstalar}>Quitar del plan</Button>
        <Button size="compact-sm" variant="light" onClick={instalar}>Reinstalar todos</Button>
      </Group>

      {TEMAS.filter((t) => (porTema[t.id] || []).length).map((t) => (
        <Card key={t.id} withBorder radius="lg" padding={0}>
          <Group p="sm" px="md" gap={9} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
            <ThemeIcon size={28} radius="md" variant="light" color={t.color}>{t.icon}</ThemeIcon>
            <Text fw={700} fz="sm">{t.titulo}</Text>
            <Badge size="xs" variant="light" color="gray">{porTema[t.id].length}</Badge>
          </Group>
          <Table highlightOnHover verticalSpacing="xs" fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={190}>Código</Table.Th>
                <Table.Th w={230}>Función</Table.Th>
                <Table.Th>Qué hace</Table.Th>
                <Table.Th w={90}>Activo</Table.Th>
                <Table.Th w={110} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {porTema[t.id].map((f) => <Fila key={f.accion} f={f} onGuardar={guardar} />)}
            </Table.Tbody>
          </Table>
        </Card>
      ))}

      {rows.length === 0 && !error && (
        <Card withBorder radius="lg" padding="xl">
          <Text ta="center" c="dimmed" fz="sm">Sin códigos en el catálogo. Tocá «Reinstalar todos» para dejar los de fábrica.</Text>
        </Card>
      )}
    </Stack>
  );
}
