'use client';
import { Stack, Title, Text, Badge, Tabs, Alert, Code, Button, Group } from '@mantine/core';
import { IconArrowDownLeft, IconArrowUpRight, IconTag, IconPhoneIncoming, IconArrowsSplit, IconTarget, IconAsterisk, IconDeviceLandlinePhone, IconBackspace, IconPlus, IconId, IconRoute, IconRouteAltLeft, IconShieldLock } from '@tabler/icons-react';
import CrudPanel from '../CrudPanel';
import { toast } from '../notify';
import { useEffect, useState } from 'react';
import PageHeader from '../PageHeader';
import DidOverview from '../DidOverview';
import PatternHint from '../PatternHint';

const destLabel = { extensión: 'Extensión', ivr: 'IVR', cola: 'Cola', app: 'Aplicación' };

export default function Rutas({ embedded } = {}) {
  const [trunkOpts, setTrunkOpts] = useState([]);
  const [gen, setGen] = useState(false); const [rk, setRk] = useState(0);
  async function generar() {
    setGen(true);
    try {
      const [inb, outb] = await Promise.all([
        fetch('/backend/api/routes/inbound').then((r) => r.json()).catch(() => []),
        fetch('/backend/api/routes/outbound').then((r) => r.json()).catch(() => []),
      ]);
      let n = 0;
      if (!(Array.isArray(outb) && outb.some((o) => (o.pattern || '').replace(/^_/, '') === '0X.'))) {
        await fetch('/backend/api/routes/outbound', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Salida por 0 (SBC)', pattern: '0X.', strip: 1 }) }); n++;
      }
      if (!(Array.isArray(inb) && inb.length)) {
        await fetch('/backend/api/routes/inbound', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ did: '_X.', name: 'Entrada por defecto (ajustar extensión)', dest_type: 'extensión', dest_value: '1001' }) }); n++;
      }
      toast(n ? ('Generadas ' + n + ' ruta(s) sugerida(s) hacia el SBC \u2014 revis\u00e1 y ajust\u00e1 el destino') : 'Ya hab\u00eda rutas; no se gener\u00f3 nada nuevo', 'ok');
      setRk((k) => k + 1);
    } catch (e) { toast('No se pudo generar', 'bad'); }
    setGen(false);
  }
  useEffect(() => { fetch('/backend/api/trunks').then((r) => r.json()).then((d) => Array.isArray(d) && setTrunkOpts(d.map((t) => ({ value: t.name, label: t.name + (t.provider_host ? ' (' + t.provider_host + ')' : '') })))).catch(() => {}); }, []);
  return (
    <Stack gap="lg">
      {!embedded && <PageHeader icon={<IconRoute size={24} />} title="Rutas" subtitle="Enrutamiento de llamadas de las troncales · entrantes (DID) y salientes" color="indigo" />}
      <Alert color="grape" variant="light" radius="md" icon={<IconRouteAltLeft size={18} />} title="Todo entra y sale por el SBC-NG">
        <Text size="sm">Asterisk no se conecta directo a los operadores: <b>las llamadas entrantes y salientes pasan por el SBC-NG</b>. Las <b>entrantes</b> llegan desde el SBC (contexto <Code>from-trunk</Code>) y las <b>salientes</b> se envían al SBC, que aplica seguridad, normaliza y <b>elige el operador</b>. Acá definís el ruteo; el enlace con el carrier se configura en <b>SBC-NG → Operadores</b>.</Text>
        <Group mt="sm"><Button size="xs" variant="light" color="grape" leftSection={<IconRouteAltLeft size={14} />} loading={gen} onClick={generar}>Generar rutas sugeridas (por el SBC)</Button><Text size="xs" c="dimmed">Crea la salida estándar (marcá 0 + número) y una entrada por defecto. Podés editarlas o borrarlas.</Text></Group>
      </Alert>
      <Tabs defaultValue="entrantes" variant="pills" radius="md" keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="entrantes" leftSection={<IconArrowDownLeft size={16} />}>Entrantes</Tabs.Tab>
          <Tabs.Tab value="salientes" leftSection={<IconArrowUpRight size={16} />}>Salientes</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="entrantes">
          <DidOverview />
          <CrudPanel key={"in-" + rk} title="Rutas entrantes (DID)" subtitle="Número que recibís del operador → destino extensión" color="indigo" icon={<IconArrowDownLeft size={18} />}
            idKey="id" fetchUrl="/backend/api/routes/inbound" createUrl="/backend/api/routes/inbound" deleteUrl={(r) => '/backend/api/routes/inbound/' + r.id}
            columns={[
              { key: 'did', label: 'DID / Número', mono: true, icon: <IconPhoneIncoming size={13} /> },
              { key: 'name', label: 'Nombre', icon: <IconTag size={13} /> },
              { key: 'dest_type', label: 'Tipo', icon: <IconArrowsSplit size={13} />, render: (r) => <Badge variant="dot" color="grape">{destLabel[r.dest_type] || r.dest_type}</Badge> },
              { key: 'dest_value', label: 'Destino', mono: true, icon: <IconTarget size={13} /> },
            ]}
            fields={[
              { name: 'did', label: 'DID / Número entrante', required: true, icon: <IconPhoneIncoming size={15} />, placeholder: '59824000000', description: 'El número que te entrega el operador. Ej: 59824000000 (o el formato que envía tu proveedor).' },
              { name: 'name', label: 'Nombre', icon: <IconTag size={15} />, placeholder: 'Línea principal', description: 'Etiqueta para identificar la ruta. Ej: Línea principal, Ventas.' },
              { name: 'dest_type', label: 'Tipo de destino', type: 'select', icon: <IconArrowsSplit size={15} />, description: 'A dónde se manda la llamada entrante.', data: [{ value: 'extensión', label: 'Extensión' }, { value: 'ivr', label: 'IVR' }, { value: 'cola', label: 'Cola' }, { value: 'app', label: 'Aplicación (nº de acceso)' }] },
              { name: 'dest_value', label: 'Destino', required: true, icon: <IconTarget size={15} />, placeholder: '1001', description: 'Según el tipo: Extensión → 1001 · IVR → 9000 · Cola → soporte · Aplicación → su número de acceso.' },
            ]} emptyText="Sin rutas de entrada. Creá una para recibir llamadas de la troncal." />
        </Tabs.Panel>

        <Tabs.Panel value="salientes">
          <CrudPanel key={"out-" + rk} title="Rutas salientes" subtitle="Patrón de marcado → salida por el SBC. El operador y el formato del carrier se eligen en SBC → Operadores." color="teal" icon={<IconArrowUpRight size={18} />}
            idKey="id" fetchUrl="/backend/api/routes/outbound" createUrl="/backend/api/routes/outbound" deleteUrl={(r) => '/backend/api/routes/outbound/' + r.id}
            columns={[
              { key: 'name', label: 'Nombre', icon: <IconTag size={13} /> },
              { key: 'pattern', label: 'Patrón', icon: <IconAsterisk size={13} />, render: (r) => <PatternHint pattern={r.pattern} strip={r.strip} prepend={r.prepend} /> },
              { key: 'trunk', label: 'Salida', icon: <IconRouteAltLeft size={13} />, render: (r) => <Badge variant="light" color="grape" leftSection={<IconShieldLock size={10} />}>{(!r.trunk || r.trunk === 'to-sbc') ? 'SBC-NG' : r.trunk}</Badge> },
              { key: 'strip', label: 'Quita', icon: <IconBackspace size={13} /> },
              { key: 'prepend', label: 'Antepone', icon: <IconPlus size={13} /> },
              { key: 'callerid', label: 'CallerID', icon: <IconId size={13} /> },
            ]}
            fields={[
              { name: 'name', label: 'Nombre', icon: <IconTag size={15} />, placeholder: 'Salida nacional', description: 'Etiqueta de la regla. Ej: Salida nacional, Celulares.' },
              { name: 'pattern', label: 'Patrón (sin el _)', required: true, icon: <IconAsterisk size={15} />, placeholder: '0X.', description: 'Patrón de marcado de Asterisk. Ej: 0X. = un 0 seguido de uno o más dígitos. X = un dígito 0-9, . = uno o más.' },
              { name: 'strip', label: 'Quitar dígitos iniciales', icon: <IconBackspace size={15} />, placeholder: '1', description: 'Quita el prefijo de salida que marca el usuario (ej: 1 saca el 0). La normalización del formato del carrier va en SBC → Operadores.' },
              { name: 'prepend', label: 'Anteponer (opcional)', icon: <IconPlus size={15} />, placeholder: '+598', description: 'Opcional. Para el formato del operador usá SBC → Operadores y evitá transformar el número en dos lugares.' },
              { name: 'callerid', label: 'CallerID saliente (opcional)', icon: <IconId size={15} />, placeholder: '59824000000', description: 'Número que verá el destinatario. Ej: 59824000000.' },
            ]} emptyText="Sin rutas de salida. Creá una para llamar a números externos." />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
