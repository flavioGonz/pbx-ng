'use client';
/* ============================================================================
 *  Manuales de PBX-NG · con editor de capturas en vivo.
 *
 *  Los manuales traen recuadros con el nombre exacto del archivo que va en cada
 *  lugar. Acá se listan todos, y cada uno acepta la captura pegada del portapapeles
 *  (Ctrl+V), arrastrada o elegida del disco: se guarda con ese nombre en el volumen
 *  persistente y el manual la toma sola, sin recompilar ni tocar el repositorio.
 * ==========================================================================*/
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Stack, Card, Group, Text, Button, SimpleGrid, ThemeIcon, Badge, Alert,
  Tooltip, ActionIcon, Loader, Divider, Progress,
} from '@mantine/core';
import {
  IconBook, IconExternalLink, IconFileTypePdf, IconMarkdown, IconPhotoPlus,
  IconClipboardCheck, IconTrash, IconCheck, IconUpload,
} from '@tabler/icons-react';
import PageHeader from '../PageHeader';
import { toast } from '../notify';

async function api(path, opts = {}) {
  const r = await fetch('/backend/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || (j && j.error)) {
    // Ojo: un 413 del proxy (nginx) o de express responde HTML, no JSON. Sin este
    // fallback el mensaje quedaba vacio y el panel mostraba un toast rojo mudo.
    const porCodigo = {
      413: 'La imagen es demasiado grande para subirla.',
      401: 'Se venció la sesión. Volvé a entrar al panel.',
      403: 'No tenés permiso para editar los manuales.',
      502: 'El backend no respondió. Revisá que el servicio esté arriba.',
    };
    throw new Error((j && j.error) || porCodigo[r.status] || ('El servidor respondió ' + r.status + '.'));
  }
  return j || {};
}

function fileADataURL(file) {
  return new Promise((ok, err) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    // FileReader entrega un ProgressEvent, no un Error: sin esto el .catch de arriba
    // recibia un objeto sin .message y el toast salia sin texto.
    r.onerror = () => err(new Error('No se pudo leer el archivo.'));
    r.readAsDataURL(file);
  });
}

/* Una captura de pantalla pegada viene en PNG sin comprimir y puede pasar los 10 MB.
 * La reducimos a un ancho razonable para el manual antes de mandarla: se sube en
 * segundos, ocupa poco en el volumen y en pantalla se ve igual. Si algo falla en el
 * camino, devolvemos el original y que decida el servidor. */
const ANCHO_MAX = 1800;
async function achicar(dataURL) {
  try {
    const img = await new Promise((ok, err) => {
      const i = new Image(); i.onload = () => ok(i); i.onerror = () => err(new Error('imagen ilegible')); i.src = dataURL;
    });
    if (img.width <= ANCHO_MAX) return dataURL;
    const c = document.createElement('canvas');
    c.width = ANCHO_MAX; c.height = Math.round((img.height * ANCHO_MAX) / img.width);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch (_) { return dataURL; }
}

/* Una zona de carga por cada recuadro del manual: pegar, arrastrar o elegir archivo. */
function Zona({ ph, cargada, accent, onHecho }) {
  const [subiendo, setSubiendo] = useState(false);
  const [bust, setBust] = useState(0);
  const inputRef = useRef(null);

  const subir = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) { toast('Eso no es una imagen', 'bad'); return; }
    setSubiendo(true);
    try {
      const data = await achicar(await fileADataURL(file));
      await api('/manuales/img/' + ph.file, { method: 'POST', body: { data } });
      setBust(Date.now()); onHecho(ph.file, true);
      toast(`Cargada: ${ph.file}`, 'ok');
    } catch (e) { toast(e.message || 'No se pudo subir', 'bad'); }
    finally { setSubiendo(false); }
  }, [ph.file, onHecho]);

  const onPaste = (e) => {
    const it = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith('image/'));
    if (it) { e.preventDefault(); subir(it.getAsFile()); }
  };
  const onDrop = (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) subir(f); };
  const quitar = async () => {
    try { await api('/manuales/img/' + ph.file, { method: 'DELETE' }); onHecho(ph.file, false); setBust(Date.now()); }
    catch (e) { toast(e.message, 'bad'); }
  };

  const src = `/backend/api/manuales/img/${ph.file}?v=${bust}`;

  return (
    <Card withBorder radius="md" p="xs" style={{ borderColor: cargada ? accent + '88' : undefined }}>
      <Group justify="space-between" gap={6} mb={6} wrap="nowrap">
        <Text size="10px" fw={800} c="dimmed" style={{ fontFamily: 'monospace' }} truncate>{ph.file}</Text>
        {cargada
          ? <Badge size="xs" color="teal" variant="light" leftSection={<IconCheck size={10} />}>cargada</Badge>
          : <Badge size="xs" color="gray" variant="light">pendiente</Badge>}
      </Group>

      <div
        tabIndex={0}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => !cargada && inputRef.current?.click()}
        style={{
          height: 92, borderRadius: 8, cursor: 'pointer', overflow: 'hidden',
          border: `1.5px dashed ${cargada ? accent + '66' : 'var(--mantine-color-default-border)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
          background: cargada ? 'transparent' : 'var(--mantine-color-default-hover)',
        }}
        title={ph.alt}
      >
        {subiendo ? <Loader size="sm" />
          : cargada ? <img src={src} alt={ph.alt} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <Text size="10px" c="dimmed" px={6} lineClamp={4}>{ph.alt || 'Clic y Ctrl+V para pegar'}</Text>}
      </div>

      <Group gap={6} mt={6} grow>
        <Button size="compact-xs" variant="light" leftSection={<IconUpload size={12} />}
          onClick={() => inputRef.current?.click()}>Archivo</Button>
        {cargada && (
          <Tooltip label="Quitar para recapturar">
            <ActionIcon variant="light" color="red" size="md" onClick={quitar}><IconTrash size={14} /></ActionIcon>
          </Tooltip>
        )}
      </Group>
      <input ref={inputRef} type="file" accept="image/*" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) subir(f); e.target.value = ''; }} />
    </Card>
  );
}

export default function Manuales() {
  const [meta, setMeta] = useState(null);
  const [phs, setPhs] = useState(null);          // [{manual, title, accent, file, alt}]
  const [cargadas, setCargadas] = useState(new Set());

  useEffect(() => {
    (async () => {
      const m = await fetch('/manuales/index.json').then((r) => r.json()).catch(() => ({ manuals: [] }));
      setMeta(m);
      // Los recuadros salen del propio Markdown servido: si el manual cambia, la lista
      // se actualiza sola. No hay una lista de imágenes escrita a mano en ningún lado.
      const todos = [];
      for (const man of (m.manuals || [])) {
        const md = await fetch(`/manuales/${man.id}.md`).then((r) => r.text()).catch(() => '');
        const re = /!\[([^\]]*)\]\(img\/([^)]+)\)/g; let x;
        while ((x = re.exec(md))) todos.push({ manual: man.id, title: man.title, accent: man.accent, alt: x[1], file: x[2] });
      }
      setPhs(todos);
    })();
    api('/manuales/img-list').then((d) => setCargadas(new Set(d.cargadas || []))).catch(() => {});
  }, []);

  const marcar = useCallback((file, ok) => {
    setCargadas((s) => { const n = new Set(s); ok ? n.add(file) : n.delete(file); return n; });
  }, []);

  const list = (meta && meta.manuals) || [];
  const total = phs ? phs.length : 0;
  const hechas = phs ? phs.filter((p) => cargadas.has(p.file)).length : 0;
  const porManual = (id) => (phs || []).filter((p) => p.manual === id);

  return (
    <Stack>
      <PageHeader icon={<IconBook size={24} />} color="grape" title="Manuales"
        subtitle="Documentación de la plataforma · abrir, exportar a PDF y cargar las capturas de pantalla" />

      <SimpleGrid cols={{ base: 1, md: 3 }}>
        {list.map((m) => (
          <Card key={m.id} withBorder radius="lg" padding="lg" shadow="sm">
            <Group gap="sm" mb="xs">
              <ThemeIcon size={46} radius="md" variant="light" style={{ color: m.accent, background: m.accent + '18' }}>
                <span style={{ fontSize: 22 }}>{m.icon}</span>
              </ThemeIcon>
              <div style={{ minWidth: 0 }}>
                <Text fw={700} lh={1.2}>{m.title}</Text>
                <Text size="xs" c="dimmed">{m.subtitle}</Text>
              </div>
            </Group>
            <Badge size="xs" variant="light" color="gray" mb="md">Dirigido a: {m.audience}</Badge>
            <Stack gap={8}>
              <Button component="a" href={`/manuales/${m.id}.html`} target="_blank" leftSection={<IconExternalLink size={16} />} variant="filled" style={{ background: m.accent }}>
                Abrir manual
              </Button>
              <Group grow gap={8}>
                <Button component="a" href={`/manuales/${m.id}.html?print=1`} target="_blank"
                  size="xs" variant="light" leftSection={<IconFileTypePdf size={14} />}>PDF</Button>
                <Button component="a" href={`/manuales/${m.id}.md`} download size="xs" variant="light" leftSection={<IconMarkdown size={14} />}>Markdown</Button>
              </Group>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      <Divider my="xs" />

      <Group justify="space-between" align="flex-end">
        <div>
          <Group gap={8}><IconPhotoPlus size={20} /><Text fw={700}>Cargar capturas</Text></Group>
          <Text size="sm" c="dimmed" maw={640}>
            Cada recuadro es un lugar del manual. Pegá la captura (clic en el recuadro y <b>Ctrl+V</b>),
            arrastrala o elegí el archivo: se guarda sola en su sitio, sin tocar el diseño ni recompilar.
          </Text>
        </div>
        {phs && <Badge size="lg" variant="light" color={hechas === total && total ? 'teal' : 'grape'}>{hechas} / {total}</Badge>}
      </Group>

      {phs && total > 0 && <Progress value={(hechas / total) * 100} color="teal" radius="xl" size="sm" />}

      {!phs && <Group justify="center" p="xl"><Loader /></Group>}

      {phs && list.map((m) => (
        <div key={m.id}>
          <Group gap={8} mt="sm" mb={6}>
            <span style={{ fontSize: 16 }}>{m.icon}</span>
            <Text fw={700} size="sm">{m.title}</Text>
            <Badge size="xs" variant="light" style={{ color: m.accent, background: m.accent + '18' }}>
              {porManual(m.id).filter((p) => cargadas.has(p.file)).length} / {porManual(m.id).length}
            </Badge>
          </Group>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="xs">
            {porManual(m.id).map((ph) => (
              <Zona key={ph.file} ph={ph} accent={m.accent} cargada={cargadas.has(ph.file)} onHecho={marcar} />
            ))}
          </SimpleGrid>
        </div>
      ))}

      <Alert icon={<IconClipboardCheck size={18} />} color="grape" variant="light" radius="md" mt="sm">
        <Text size="sm">
          Las imágenes quedan guardadas en la central (volumen persistente) y se ven al instante al abrir el
          manual — también en el PDF. Para reemplazar una, tocá <b>Quitar</b> y volvé a pegar.
        </Text>
      </Alert>
    </Stack>
  );
}
