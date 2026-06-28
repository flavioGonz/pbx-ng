/* BrandingPanel.jsx - identidad de marca (logo, nombre, subtitulo) */
'use client';
import { useEffect, useState } from 'react';
import { Stack, Card, Group, Text, TextInput, Button, FileButton, ThemeIcon } from '@mantine/core';
import { IconPhoto, IconDeviceFloppy, IconBuildingStore } from '@tabler/icons-react';
import { toast } from './notify';
export default function BrandingPanel() {
  const [b, setB] = useState({ name: '', subtitle: '', tagline: '', logo: '' }); const [saving, setSaving] = useState(false);
  useEffect(() => { fetch('/backend/api/branding').then((r) => r.json()).then((d) => setB({ name: d.name || '', subtitle: d.subtitle || '', tagline: d.tagline || '', logo: d.logo || '' })).catch(() => {}); }, []);
  async function onLogo(file) { if (!file) return; try { const img = new Image(); const url = URL.createObjectURL(file); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); const max = 256, sc = Math.min(1, max / Math.max(img.width, img.height)); const cv = document.createElement('canvas'); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); setB((s) => ({ ...s, logo: cv.toDataURL('image/png') })); URL.revokeObjectURL(url); } catch (_) { toast('No se pudo procesar el logo', 'bad'); } }
  async function save() { setSaving(true); const r = await fetch('/backend/api/branding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((x) => x.json()).catch(() => ({ error: 1 })); setSaving(false); toast(r.error ? 'Error al guardar' : 'Branding guardado · recargá para verlo aplicado', r.error ? 'bad' : 'ok'); }
  return (
    <Stack gap="md" maw={640}>
      <Card withBorder radius="md" padding="md">
        <Group gap="sm" mb="md"><ThemeIcon size={40} radius="md" variant="light" color="grape"><IconBuildingStore size={20} /></ThemeIcon><div><Text fw={700}>Identidad de marca</Text><Text size="xs" c="dimmed">Se aplica al panel, a la pantalla de login y a la PWA.</Text></div></Group>
        <Stack gap="sm">
          <Group gap="md" align="center" wrap="nowrap">
            <div style={{ width: 64, height: 64, borderRadius: 14, border: '1px dashed var(--mantine-color-default-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: 'var(--mantine-color-default-hover)', flex: 'none' }}>{b.logo ? <img src={b.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 6 }} /> : <IconPhoto size={24} style={{ opacity: .4 }} />}</div>
            <div style={{ flex: 1 }}><Text size="sm" fw={500}>Logo (PNG, fondo transparente)</Text><Text size="xs" c="dimmed">Se muestra en el sidebar y el login.</Text><Group gap="xs" mt={6}><FileButton onChange={onLogo} accept="image/png,image/jpeg,image/svg+xml">{(props) => <Button {...props} size="xs" variant="light" leftSection={<IconPhoto size={14} />}>Subir logo</Button>}</FileButton>{b.logo && <Button size="xs" variant="subtle" color="red" onClick={() => setB((s) => ({ ...s, logo: '' }))}>Quitar</Button>}</Group></div>
          </Group>
          <TextInput label="Nombre" placeholder="PBX-NG" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} description="Junto al logo en el sidebar y el login" />
          <TextInput label="Subtítulo" placeholder="Comunicaciones" value={b.subtitle} onChange={(e) => setB({ ...b, subtitle: e.target.value })} description="Texto chico bajo el nombre en el sidebar" />
          <TextInput label="Tagline (login)" placeholder="Comunicaciones unificadas" value={b.tagline} onChange={(e) => setB({ ...b, tagline: e.target.value })} description="Frase bajo el nombre en la pantalla de login" />
          <Button onClick={save} loading={saving} leftSection={<IconDeviceFloppy size={16} />} color="grape">Guardar branding</Button>
        </Stack>
      </Card>
    </Stack>
  );
}
