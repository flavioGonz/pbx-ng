'use client';
/* ─────────────────────────────────────────────────────────────────────────────
 *  Qué softphone reparte ESTA central.
 *
 *  El problema que resuelve es de visibilidad: el botón del login y el actualizador del
 *  softphone leen el directorio de instaladores de la central, y hasta ahora la única forma
 *  de saber qué versión había ahí era entrar por SSH. El 30/09 CI publicó 0.17.0 y la
 *  central siguió repartiendo lo que tenía horneado en la imagen; el actualizador informaba
 *  —con razón— que estaba al día. Nadie se enteró.
 *
 *  Acá se ve la versión que reparte, desde cuándo, y si la central sale sola a buscar la
 *  nueva. «Buscar ahora» espera el resultado de verdad: bajar 85 MB tarda, y el que aprieta
 *  el botón quiere saber si quedó, no un «listo» que no significa nada.
 * ───────────────────────────────────────────────────────────────────────────── */
import { useEffect, useState } from 'react';
import { Card, Group, Text, Badge, Button, Switch, NumberInput, TextInput, Stack, Code, FileButton } from '@mantine/core';
import { IconDownload, IconRefresh, IconDeviceMobile, IconUpload } from '@tabler/icons-react';
import { apiGet, apiPost } from '../api';
import { toast } from '../notify';

const mb = (n) => (typeof n === 'number' ? Math.round(n / 1048576) + ' MB' : '—');
const cuando = (s) => {
  if (!s) return 'nunca';
  try { return new Date(s).toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(s); }
};
/* El resultado del último ciclo en palabras, no en el código interno. «Sin salida a
 * internet» es el caso normal de una central en la red de un cliente, no una falla. */
const RESULTADO = {
  al_dia: ['teal', 'Al día'],
  actualizado: ['teal', 'Actualizado'],
  sin_release: ['gray', 'No se llegó a GitHub'],
  sin_repo: ['orange', 'Sin repositorio configurado'],
  feed_invalido: ['orange', 'El release no trae feed válido'],
  sin_disco: ['red', 'Poco disco'],
  error: ['orange', 'No se pudo revisar'],
};

export default function DistribucionSoftphone() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [form, setForm] = useState(null);

  const cargar = () => apiGet('/softphone/ota').then((d) => { setSt(d); setForm({ auto: !!d.auto, repo: d.repo || '', cada_h: d.cada_h || 6 }); }).catch(() => setSt(false));
  useEffect(() => { cargar(); }, []);

  async function guardar(parche) {
    const f = { ...form, ...parche };
    setForm(f);
    try { const d = await apiPost('/softphone/ota/config', parche); setSt(d); }
    catch (e) { toast('No se pudo guardar: ' + e.message, 'bad'); cargar(); }
  }
  async function buscar(forzar) {
    setBusy(true);
    try {
      const r = await apiPost('/softphone/ota/revisar', { forzar: !!forzar });
      if (r.actualizado) toast('Ahora esta central reparte la ' + r.version, 'ok');
      else if (r.al_dia) toast('Ya estaba al día (' + r.version + ')', 'ok');
      else toast('No se pudo: ' + (r.motivo || 'error'), 'bad');
      await cargar();
    } catch (e) { toast('No se pudo: ' + e.message, 'bad'); }
    finally { setBusy(false); }
  }

  /* Sin rol de administrador el endpoint vuelve 403: no se muestra una tarjeta muerta. */
  if (st === false || !st || !form) return null;

  const sirv = st.sirviendo;
  const [color, texto] = RESULTADO[st.resultado] || ['gray', 'Todavía no se revisó'];

  /* Subir el instalador a mano. Para la central que de verdad no tiene salida a internet:
   * ahi no sirve el pull ni serviria un push de CI, y la respuesta honesta es que alguien
   * traiga el archivo. Van los tres juntos en una sola subida porque el `latest.yml` tiene
   * que escribirse al final: suelto, manda a los softphones a buscar un .exe que no esta. */
  async function subir(files) {
    const lista = Array.from(files || []);
    if (!lista.length) return;
    const nombres = lista.map((f) => f.name);
    if (!nombres.some((n) => /\.yml$/i.test(n)) && !nombres.some((n) => /\.apk$/i.test(n))) {
      toast('Falta el latest.yml: sin él el actualizador no se entera de la versión nueva', 'bad');
      return;
    }
    setSubiendo(true);
    try {
      const archivos = await Promise.all(lista.map((f) => new Promise((ok, mal) => {
        const fr = new FileReader();
        fr.onload = () => ok({ name: f.name, data: String(fr.result).split(',')[1] });
        fr.onerror = () => mal(new Error('no se pudo leer ' + f.name));
        fr.readAsDataURL(f);
      })));
      const d = await apiPost('/softphone/ota/subir', { archivos });
      setSt((x) => ({ ...x, sirviendo: d.sirviendo || x.sirviendo, android: d.android && d.android.available ? d.android : x.android }));
      toast('Instalador subido' + (d.version ? ': ' + d.version : ''), 'ok');
      await cargar();
    } catch (e) { toast('No se pudo subir: ' + e.message, 'bad'); }
    finally { setSubiendo(false); }
  }

  return (
    <Card withBorder radius="lg" padding="lg" shadow="sm">
      <Group justify="space-between" mb="md">
        <Group gap="xs"><IconDownload size={18} /><Text fw={600}>Instalador que reparte esta central</Text></Group>
        <Badge color={color} variant="light">{texto}</Badge>
      </Group>

      <Group align="flex-start" gap="xl" wrap="wrap">
        <div>
          <Text size="xs" c="dimmed">Windows</Text>
          {sirv
            ? <><Text fw={700} size="xl">{sirv.version}</Text><Text size="xs" c="dimmed">{mb(sirv.size)} · publicada {cuando(sirv.date)}</Text></>
            : <Text c="dimmed" size="sm">Ninguno. El botón de descarga no aparece en el login.</Text>}
        </div>
        <div>
          <Text size="xs" c="dimmed">Android</Text>
          {st.android
            ? <><Group gap={6}><IconDeviceMobile size={16} /><Text fw={700} size="xl">{st.android.version || '—'}</Text></Group><Text size="xs" c="dimmed">{mb(st.android.size)}</Text></>
            : <Text c="dimmed" size="sm">Sin APK. Se sube a mano: no lo compila CI.</Text>}
        </div>
      </Group>

      <Stack gap="xs" mt="lg">
        <Switch checked={form.auto} onChange={(e) => guardar({ auto: e.currentTarget.checked })}
          label="Traer sola la versión nueva"
          description="La central consulta el release y baja el instalador si hay uno más nuevo. Necesita salida HTTPS a github.com; si no la tiene, sigue repartiendo el que ya tiene." />
        {form.auto && (
          <Group align="flex-end" gap="sm" pl={46}>
            <TextInput label="Repositorio" value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })}
              onBlur={() => guardar({ repo: form.repo })} style={{ flex: 1, maxWidth: 280 }} />
            <NumberInput label="Revisar cada" suffix=" h" min={1} max={168} value={form.cada_h}
              onChange={(v) => setForm({ ...form, cada_h: v })} onBlur={() => guardar({ cada_h: form.cada_h })} style={{ width: 130 }} />
          </Group>
        )}
        <Text size="xs" c="dimmed">
          Última revisión: {cuando(st.ultimo_intento)}
          {st.detalle ? <> · <Code>{st.detalle}</Code></> : null}
          {st.bajando ? <> · bajando {st.bajando}…</> : null}
        </Text>
      </Stack>

      <Group mt="md">
        <Button variant="light" leftSection={<IconRefresh size={16} />} loading={busy} onClick={() => buscar(false)}>Buscar ahora</Button>
        <Button variant="subtle" color="gray" loading={busy} onClick={() => buscar(true)}>Volver a bajar la actual</Button>
        <FileButton multiple accept=".exe,.msi,.blockmap,.yml,.apk" onChange={subir}>
          {(props) => <Button {...props} variant="subtle" color="gray" loading={subiendo} leftSection={<IconUpload size={16} />}>Subir a mano</Button>}
        </FileButton>
      </Group>
      <Text size="xs" c="dimmed" mt={6}>
        Para una central sin salida a internet: elegí juntos el <Code>.exe</Code>, su <Code>.blockmap</Code> y el <Code>latest.yml</Code> del Release.
        Van en una sola subida porque el <Code>latest.yml</Code> se escribe al final — suelto, manda a los softphones a buscar un instalador que todavía no está.
      </Text>
    </Card>
  );
}
