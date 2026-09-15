'use client';
/* ============================================================================
 *  TurnOrigen — de dónde sale el TURN de esta central, y si de verdad sirve.
 *
 *  Por qué existe esta pantalla: `GET|PUT /api/turn/origen` está desde 1.11.0 y no lo
 *  llamaba NINGUNA pantalla, así que el «ya no hace falta entrar por SSH» del CHANGELOG
 *  era mentira: el origen del TURN y el host del coturn propio sólo se podían cambiar
 *  editando el `.env` del appliance. Acá se eligen los tres orígenes que soporta la API
 *  (propio / SBC-NG / externo) y se cargan host, puerto y credenciales del que
 *  corresponda.
 *
 *  Y el botón «Probar» corre la sonda de verdad (`POST /api/turn/probe`: STUN Binding →
 *  Allocate sin credenciales → Allocate firmado, por UDP y por TCP). Se muestran los
 *  pasos tal como los devuelve la API, con el relay y el veredicto: un TURN que contesta
 *  el puerto pero reparte una dirección privada sale en ROJO y con el motivo escrito,
 *  porque ese —un coturn escuchando sólo en el bridge de Docker— es el caso real que
 *  dejó una central entera sin audio con el panel en verde.
 * ==========================================================================*/
import { useEffect, useRef, useState } from 'react';
import { Stack, Card, Group, Text, Badge, Button, TextInput, NumberInput, PasswordInput, ThemeIcon, SimpleGrid, Alert, Radio, Divider, List, Loader, Code, Tooltip } from '@mantine/core';
import { IconArrowsLeftRight, IconDeviceFloppy, IconTestPipe, IconRefresh, IconShieldCheck, IconShieldX, IconInfoCircle, IconWorld, IconKey, IconHash, IconServer2, IconCloud } from '@tabler/icons-react';
import { toast } from './notify';
import { apiPut, apiPost, usePoll } from './api';
import { estadoInfra } from './fmt';

/* El texto de cada origen se escribe una vez acá: es lo que el administrador lee para
 * decidir, y repetirlo en el radio y en la ayuda es cómo se desincronizan. */
const ORIGENES = [
  { id: 'propio', label: 'Propio (coturn del appliance)', ayuda: 'El relay lo corre esta misma central. Necesita una dirección pública alcanzable y los puertos del rango relay abiertos.' },
  { id: 'sbc', label: 'Del SBC-NG', ayuda: 'El relay lo pone el borde. El host NO se copia: sale del enlace a SBC-NG (Configuración → SBC-NG), que es el único lugar donde vive esa dirección. Apaga el coturn local.' },
  { id: 'externo', label: 'Externo (otro proveedor)', ayuda: 'Una o varias URL turn:/turns: de un tercero, con sus credenciales. También apaga el coturn local.' },
];

const VACIO = { propio_host: '', propio_puerto: 3478, sbc_usuario: '', sbc_clave: '', sbc_puerto: 3478, externo_urls: '', externo_usuario: '', externo_clave: '', stun_url: '' };

/* Un intercambio de la sonda (UDP o TCP) con sus pasos tal como los devolvió la API.
 * No se reinterpretan: `ok` por paso y el veredicto vienen escritos del backend, que es
 * el que de verdad midió. */
function Intercambio({ p }) {
  if (!p) return null;
  const col = p.ok ? 'teal' : 'red';
  return (
    <Card withBorder radius="md" padding="sm">
      <Group justify="space-between" mb={6} wrap="nowrap">
        <Group gap={8}>
          <ThemeIcon size={28} radius="md" variant="light" color={col}>{p.ok ? <IconShieldCheck size={16} /> : <IconShieldX size={16} />}</ThemeIcon>
          <Text fw={700} size="sm">{p.proto} · {p.host}:{p.puerto}</Text>
        </Group>
        <Badge variant={p.ok ? 'filled' : 'light'} color={col}>{p.ok ? 'OK' : 'FALLA'}</Badge>
      </Group>
      <List spacing={2} size="xs" withPadding>
        {(p.pasos || []).map((x, i) => (
          <List.Item key={i} icon={<ThemeIcon size={14} radius="xl" color={x.ok ? 'teal' : 'red'} variant="light">{x.ok ? <IconShieldCheck size={9} /> : <IconShieldX size={9} />}</ThemeIcon>}>
            <Text span fw={600}>{x.paso}</Text> <Text span c="dimmed">· {x.detalle}</Text>
          </List.Item>
        ))}
      </List>
      <SimpleGrid cols={{ base: 1, sm: 3 }} mt="xs" spacing="xs">
        <div><Text size="xs" c="dimmed">Candidato relay</Text><Text size="xs" ff="monospace" fw={700} c={p.relay ? undefined : 'dimmed'}>{p.relay || '—'}</Text></div>
        <div><Text size="xs" c="dimmed">Nos ve como (STUN)</Text><Text size="xs" ff="monospace">{p.mapped || '—'}</Text></div>
        <div><Text size="xs" c="dimmed">Host resuelto</Text><Text size="xs" ff="monospace">{p.host_ip || '—'}</Text></div>
      </SimpleGrid>
      {p.veredicto && <Text size="xs" mt={6} c={p.ok ? 'teal' : 'red'} fw={600}>{p.veredicto}</Text>}
    </Card>
  );
}

export default function TurnOrigen() {
  const [f, setF] = useState(VACIO);
  const [origen, setOrigen] = useState('propio');
  const [guardando, setGuardando] = useState(false);
  const [probando, setProbando] = useState(false);
  const [probe, setProbe] = useState(null);
  /* El 409 del PUT: el TURN nuevo no entregó candidato relay, así que la API NO cambió
   * nada. Se guarda para dibujar el motivo medido y ofrecer «cambiar igual», que es la
   * única forma de pasar a un relay que sólo responde desde afuera del NAT. */
  const [rechazo, setRechazo] = useState(null);
  /* Mientras alguien está tipeando, el poll de 30 s no le puede pisar el formulario.
   * Un ref y no un estado: sólo decide si copiar del servidor, no se dibuja. */
  const tocado = useRef(false);

  /* Configuración: la cambia una persona desde este mismo panel, así que 60 s alcanza
   * (CONTRATOS §2, política de encuestado). El estado medido va aparte, a 30 s. */
  const { data: cfg, error: cfgError, recargar: recargarCfg } = usePoll('/turn/origen', 60000);
  const { data: est, recargar: recargarEstado } = usePoll('/turn/estado', 30000);

  useEffect(() => {
    if (!cfg || tocado.current) return;
    setOrigen(cfg.origen || 'propio');
    setF({
      propio_host: cfg.propio?.host || '',
      propio_puerto: cfg.propio?.puerto || 3478,
      sbc_usuario: cfg.sbc?.usuario || '',
      sbc_clave: '',
      sbc_puerto: cfg.sbc?.puerto || 3478,
      externo_urls: cfg.externo?.urls || '',
      externo_usuario: cfg.externo?.usuario || '',
      externo_clave: '',
      stun_url: cfg.stun_url || '',
    });
  }, [cfg]);

  const set = (k, v) => { tocado.current = true; setF((x) => ({ ...x, [k]: v })); };
  const elegir = (v) => { tocado.current = true; setOrigen(v); };

  async function guardar(forzar = false) {
    setGuardando(true);
    setRechazo(null);
    /* Se manda SÓLO lo del origen elegido: mandar los tres bloques haría que cambiar de
     * origen reescribiera credenciales de los otros dos sin que nadie las haya tocado.
     * La clave vacía significa «no cambiar» (así lo define el PUT). */
    const body = { origen, stun_url: f.stun_url };
    /* `forzar` sólo cuando la persona ya vio el motivo medido y pidió cambiar igual:
     * nunca por defecto. Sin él, cambiar a un TURN que no contesta no apaga el coturn
     * que hoy está sirviendo. */
    if (forzar) body.forzar = true;
    if (origen === 'propio') { body.propio_host = f.propio_host; body.propio_puerto = f.propio_puerto; }
    if (origen === 'sbc') { body.sbc_usuario = f.sbc_usuario; body.sbc_puerto = f.sbc_puerto; if (f.sbc_clave) body.sbc_clave = f.sbc_clave; }
    if (origen === 'externo') { body.externo_urls = f.externo_urls; body.externo_usuario = f.externo_usuario; if (f.externo_clave) body.externo_clave = f.externo_clave; }
    try {
      const r = await apiPut('/turn/origen', body);
      const ef = (r && r.efectivo) || {};
      const ver = r && r.verificacion;
      /* Guardar no es «anda»: si el origen quedó inutilizable el backend lo dice en
       * `motivo` y hay que repetirlo tal cual, no tragárselo con un «Guardado». Y si
       * hubo verificación, el verde dice qué se midió —o qué quedó afuera, que es el
       * caso del aviso: relay por UDP sí, por TCP no—. */
      if (ef.usable === false) toast('Guardado, pero el origen no está utilizable: ' + (ef.motivo || 'sin motivo'), 'bad');
      else if (r && r.forzado) toast('Origen del TURN guardado SIN verificar (lo forzaste): probá el relay antes de dar por buena la central', 'bad');
      else if (ver && ver.aviso) toast('Origen del TURN guardado y verificado · ' + ver.aviso, 'bad');
      else toast(ver && ver.ok ? 'Origen del TURN guardado y verificado: entrega candidato relay' : 'Origen del TURN guardado', 'ok');
      tocado.current = false;
      setProbe(null);
      recargarCfg(); recargarEstado();
    } catch (e) {
      /* 409 = no se cambió NADA porque el relay nuevo no contesta. No es un error a
       * tragarse en un toast que se va solo: se muestra el motivo medido y se ofrece
       * cambiar igual, con todas las letras de lo que eso implica. */
      if (e.status === 409 && e.data && e.data.verificacion) {
        const v = e.data.verificacion;
        setRechazo({ mensaje: e.message });
        /* La medición que RECHAZÓ el cambio se dibuja entera en la tarjeta de abajo, con
         * los mismos pasos que el botón «Probar»: el administrador tiene que poder ver
         * en qué paso se cortó, no sólo que «no anduvo». */
        setProbe({ ok: v.ok, udp: v.udp, tcp: v.tcp, veredicto: v.veredicto, aviso: v.aviso });
      } else toast(e.message, 'bad');
    }
    finally { setGuardando(false); }
  }

  async function probar() {
    setProbando(true); setProbe(null);
    /* Sin cuerpo: la sonda corre contra el origen EFECTIVO, que es exactamente lo que
     * `/api/ice` le reparte a los softphones. Probar lo tipeado y todavía no guardado
     * daría un verde que no corresponde a lo que la central entrega. */
    try { setProbe(await apiPost('/turn/probe')); }
    catch (e) { toast(e.message, 'bad'); }
    finally { setProbando(false); recargarEstado(); }
  }

  if (cfgError) return <Alert color="red" title="No se pudo leer el origen del TURN">{cfgError.message}</Alert>;
  if (!cfg) return <Group gap="xs"><Loader size="sm" /><Text c="dimmed" size="sm">Leyendo la configuración de TURN…</Text></Group>;

  const inf = estadoInfra(est);
  const ef = cfg.efectivo || {};
  const sbcListo = !!cfg.sbc?.disponible;

  return (
    <Stack gap="lg">
      {/* Estado MEDIDO arriba de todo: es la respuesta a «¿el TURN de esta central sirve?» */}
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={42} radius="md" variant="light" color={inf.color}><IconArrowsLeftRight size={22} /></ThemeIcon>
            <div>
              <Text fw={800} lh={1.1}>Estado real del TURN</Text>
              <Text size="xs" c="dimmed">{est ? (est.host ? est.host + ':' + est.puerto : 'sin host configurado') : 'midiendo…'}</Text>
            </div>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Badge size="lg" variant={inf.color === 'teal' ? 'filled' : 'light'} color={inf.color}>{inf.texto}</Badge>
            <Tooltip label="Volver a medir"><Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={recargarEstado}>Refrescar</Button></Tooltip>
          </Group>
        </Group>
        {inf.detalle && <Text size="xs" c={inf.color === 'teal' ? 'dimmed' : 'red'} mt={8}>{inf.detalle}</Text>}
        <SimpleGrid cols={{ base: 2, sm: 4 }} mt="md" spacing="xs">
          <div><Text size="xs" c="dimmed">Origen</Text><Text fw={700} size="sm">{ORIGENES.find((o) => o.id === (est?.origen || cfg.origen))?.label || '—'}</Text></div>
          <div><Text size="xs" c="dimmed">Interruptor (deseado)</Text><Text fw={700} size="sm">{est ? (est.deseado ? 'encendido' : 'apagado') : '—'}</Text></div>
          <div><Text size="xs" c="dimmed">Contestó el servidor</Text><Text fw={700} size="sm" c={est ? (est.corriendo ? 'teal' : 'red') : undefined}>{est ? (est.corriendo ? 'sí' : 'no') : '—'}</Text></div>
          <div><Text size="xs" c="dimmed">Candidato relay</Text><Text fw={700} size="xs" ff="monospace">{est?.relay || '—'}</Text></div>
        </SimpleGrid>
      </Card>

      <Card withBorder radius="md" padding="md">
        <Text fw={800} mb={4}>Origen del TURN</Text>
        <Text size="xs" c="dimmed" mb="sm">Uno solo a la vez. Si elegís el SBC-NG o uno externo, el coturn de este appliance se apaga: dos relays escuchando y uno solo anunciado es el estado donde nadie sabe cuál está sirviendo.</Text>
        <Radio.Group value={origen} onChange={elegir}>
          <Stack gap="xs">
            {ORIGENES.map((o) => (
              <Radio key={o.id} value={o.id} disabled={o.id === 'sbc' && !sbcListo}
                label={<Group gap={6}><Text fw={600} size="sm">{o.label}</Text>{o.id === 'sbc' && <Badge size="xs" variant="light" color={sbcListo ? 'teal' : 'gray'}>{sbcListo ? 'enlace activo' : 'sin enlace activo'}</Badge>}</Group>}
                description={o.ayuda} />
            ))}
          </Stack>
        </Radio.Group>

        <Divider my="md" />

        {origen === 'propio' && (
          <Stack gap="sm">
            <Group grow>
              <TextInput label="Host público del coturn" leftSection={<IconWorld size={15} />} value={f.propio_host} onChange={(e) => set('propio_host', e.target.value)}
                placeholder={cfg.propio?.host_efectivo || 'IP o nombre público'}
                description={'Vacío = se usa PUBLIC_IP / DOMAIN del appliance' + (cfg.propio?.host_efectivo ? ' (hoy: ' + cfg.propio.host_efectivo + ')' : '')} />
              <NumberInput label="Puerto" leftSection={<IconHash size={15} />} value={f.propio_puerto} onChange={(v) => set('propio_puerto', v)} description="STUN/TURN (típico 3478)" min={1} max={65535} />
            </Group>
            <Group gap="xs">
              <Badge variant="light" color="gray" leftSection={<IconKey size={12} />}>usuario: {cfg.propio?.usuario || '—'}</Badge>
              <Badge variant="light" color={cfg.propio?.tiene_clave ? 'teal' : 'red'}>{cfg.propio?.tiene_clave ? 'clave cargada' : 'sin clave (TURN_PASS)'}</Badge>
            </Group>
            {/* Las credenciales del coturn propio salen del .env que escribe install.sh; se
              * cambian en la solapa «Servidor coturn», que reescribe turnserver.conf. */}
            <Text size="xs" c="dimmed">Usuario y clave del coturn propio vienen de <Code>TURN_USER</Code> / <Code>TURN_PASS</Code> del appliance y se cambian en la solapa «Servidor coturn».</Text>
          </Stack>
        )}

        {origen === 'sbc' && (
          <Stack gap="sm">
            {!sbcListo && <Alert color="yellow" icon={<IconInfoCircle size={16} />} variant="light">No hay un enlace a SBC-NG activo: conectalo primero en Configuración → SBC-NG. Sin enlace no hay de dónde sacar el host del TURN.</Alert>}
            <Group grow>
              <TextInput label="Host del TURN del SBC-NG" leftSection={<IconServer2 size={15} />} value={cfg.sbc?.host || ''} readOnly
                description="Sale del enlace a SBC-NG y no se edita acá: tener esa IP en dos lugares es cómo se llegó a un TURN apuntando a un borde desconectado." />
              <NumberInput label="Puerto" leftSection={<IconHash size={15} />} value={f.sbc_puerto} onChange={(v) => set('sbc_puerto', v)} min={1} max={65535} description="STUN/TURN del borde" />
            </Group>
            <Group grow>
              <TextInput label="Usuario TURN del SBC-NG" leftSection={<IconKey size={15} />} value={f.sbc_usuario} onChange={(e) => set('sbc_usuario', e.target.value)} description="Credencial que configuró el borde" />
              <PasswordInput label="Clave TURN del SBC-NG" leftSection={<IconKey size={15} />} value={f.sbc_clave} onChange={(e) => set('sbc_clave', e.target.value)}
                placeholder={cfg.sbc?.tiene_clave ? '(sin cambios)' : ''} description={cfg.sbc?.tiene_clave ? 'Hay una clave guardada; vacío = no cambiarla' : 'Todavía no hay clave guardada'} />
            </Group>
          </Stack>
        )}

        {origen === 'externo' && (
          <Stack gap="sm">
            <TextInput label="URL(s) del TURN externo" leftSection={<IconCloud size={15} />} value={f.externo_urls} onChange={(e) => set('externo_urls', e.target.value)}
              placeholder="turn:turn.proveedor.com:3478,turns:turn.proveedor.com:5349"
              description="Separadas por coma. Cada una tiene que empezar con turn: o turns:" />
            <Group grow>
              <TextInput label="Usuario" leftSection={<IconKey size={15} />} value={f.externo_usuario} onChange={(e) => set('externo_usuario', e.target.value)} />
              <PasswordInput label="Clave" leftSection={<IconKey size={15} />} value={f.externo_clave} onChange={(e) => set('externo_clave', e.target.value)}
                placeholder={cfg.externo?.tiene_clave ? '(sin cambios)' : ''} description={cfg.externo?.tiene_clave ? 'Hay una clave guardada; vacío = no cambiarla' : 'Todavía no hay clave guardada'} />
            </Group>
          </Stack>
        )}

        <Divider my="md" />
        <TextInput label="STUN (opcional)" leftSection={<IconWorld size={15} />} value={f.stun_url} onChange={(e) => set('stun_url', e.target.value)}
          placeholder={(ef.stun && ef.stun[0]) || 'stun:host:3478'}
          description="Vacío = el STUN es el propio host del origen. Nada de servicios públicos: una central sin salida a internet arrancaría el WebRTC pidiéndole permiso a un tercero." />

        <Group mt="md">
          <Button leftSection={<IconDeviceFloppy size={16} />} color="teal" loading={guardando} onClick={() => guardar(false)}>Guardar origen</Button>
          <Button variant="light" leftSection={<IconTestPipe size={16} />} loading={probando} onClick={probar}>Probar</Button>
        </Group>
        {rechazo && (
          <Alert mt="md" color="red" variant="light" icon={<IconShieldX size={16} />} title="No se cambió nada: el TURN nuevo no entrega candidato relay">
            <Text size="sm">{rechazo.mensaje}</Text>
            <Text size="xs" c="dimmed" mt={6}>El coturn de este appliance sigue como estaba: no se apaga lo que anda hasta comprobar que lo nuevo sirve.</Text>
            <Group mt="sm" gap="xs">
              <Button size="xs" color="red" variant="light" loading={guardando} onClick={() => guardar(true)}>Cambiar igual</Button>
              <Button size="xs" variant="default" onClick={() => setRechazo(null)}>Corregir los datos</Button>
            </Group>
          </Alert>
        )}
        {ef.usable === false && <Alert mt="md" color="red" variant="light" icon={<IconInfoCircle size={16} />} title="El origen configurado no está utilizable">{ef.motivo || 'sin motivo'} · Mientras tanto <Code>/api/ice</Code> no reparte ningún TURN: no cae en silencio a otro.</Alert>}
      </Card>

      {probe && (
        <Card withBorder radius="md" padding="md">
          <Group justify="space-between" mb="xs" wrap="nowrap">
            <div>
              <Text fw={800} lh={1.1}>Resultado de la prueba</Text>
              <Text size="xs" c="dimmed">STUN Binding → Allocate sin credenciales (tiene que dar 401) → Allocate firmado. Es la misma sonda que corre el instalador.</Text>
            </div>
            <Badge size="lg" variant={probe.ok ? 'filled' : 'light'} color={probe.ok ? 'teal' : 'red'}>{probe.ok ? 'TURN utilizable' : 'TURN NO utilizable'}</Badge>
          </Group>
          {/* El veredicto va SIEMPRE, también cuando algún intercambio dio OK: que el
            * puerto conteste no alcanza, y el motivo de la falla es el dato que sirve. */}
          {probe.veredicto && <Alert mb="sm" variant="light" color={probe.ok ? 'teal' : 'red'} icon={probe.ok ? <IconShieldCheck size={16} /> : <IconShieldX size={16} />}>{probe.veredicto}</Alert>}
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
            <Intercambio p={probe.udp} />
            <Intercambio p={probe.tcp} />
          </SimpleGrid>
          <Text size="xs" c="dimmed" mt="sm">Un relay en <Code>127.0.0.1</Code>, <Code>0.0.0.0</Code> o en una dirección privada mientras el TURN está publicado en una pública sale como <b>FALLA</b> aunque el servidor autentique perfecto: ese candidato no lo alcanza ningún cliente de afuera, que es para lo único que existe el TURN.</Text>
        </Card>
      )}
    </Stack>
  );
}
