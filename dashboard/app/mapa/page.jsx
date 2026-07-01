'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Paper, Group, Text, Badge, ThemeIcon, SegmentedControl, ActionIcon, Tooltip, Divider, ScrollArea, Stack, CloseButton, useComputedColorScheme } from '@mantine/core';
import { IconMapPin, IconRefresh, IconArrowDownLeft, IconArrowUpRight, IconPhone, IconUser, IconClockHour4 } from '@tabler/icons-react';

let leafletP;
function loadLeaflet() {
  if (leafletP) return leafletP;
  leafletP = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject();
    if (window.L) return resolve(window.L);
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve(window.L); js.onerror = reject; document.body.appendChild(js);
  });
  return leafletP;
}
const TILES = {
  light: { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attr: '© OpenStreetMap, © CARTO' },
  dark: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', attr: '© OpenStreetMap, © CARTO' },
};
const fmtDur = (s) => { s = s || 0; const m = Math.floor(s / 60); return m ? m + 'm ' + (s % 60) + 's' : (s + 's'); };
const dispEs = (d) => ({ ANSWERED: 'Atendida', 'NO ANSWER': 'Sin respuesta', BUSY: 'Ocupado', FAILED: 'Fallida' }[d] || d || '—');

export default function Mapa() {
  const scheme = useComputedColorScheme('dark');
  const mapEl = useRef(null); const map = useRef(null); const layer = useRef(null); const L = useRef(null); const tileRef = useRef(null);
  const [hours, setHours] = useState('168'); const [pts, setPts] = useState([]); const [cdr, setCdr] = useState([]); const [ready, setReady] = useState(false);
  const [sel, setSel] = useState(null);

  async function load() {
    try { const d = await fetch('/backend/api/geo?hours=' + hours + '&limit=500').then(r => r.json()); setPts(Array.isArray(d) ? d : []); } catch (_) {}
    try { const c = await fetch('/backend/api/cdr?limit=500').then(r => r.json()); setCdr(Array.isArray(c) ? c : []); } catch (_) {}
  }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [hours]);

  // último punto por interno
  const byExt = useMemo(() => {
    const m = {};
    for (const p of pts) { if (!p.ext || p.lat == null) continue; if (!m[p.ext] || p.ts > m[p.ext].ts) m[p.ext] = p; }
    return Object.values(m);
  }, [pts]);

  useEffect(() => {
    let alive = true;
    loadLeaflet().then((lf) => {
      if (!alive || !mapEl.current || map.current) return;
      L.current = lf;
      map.current = lf.map(mapEl.current, { zoomControl: false, scrollWheelZoom: true }).setView([-34.9011, -56.1645], 11);
      const tl = TILES[scheme] || TILES.light;
      tileRef.current = lf.tileLayer(tl.url, { maxZoom: 19, attribution: tl.attr }).addTo(map.current);
      layer.current = lf.layerGroup().addTo(map.current);
      setReady(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // cambiar tiles al cambiar el theme
  useEffect(() => {
    if (!ready || !L.current || !map.current) return;
    if (tileRef.current) map.current.removeLayer(tileRef.current);
    const tl = TILES[scheme] || TILES.light;
    tileRef.current = L.current.tileLayer(tl.url, { maxZoom: 19, attribution: tl.attr }).addTo(map.current);
  }, [scheme, ready]);

  // marcadores: solo el interno
  useEffect(() => {
    if (!ready || !L.current || !layer.current) return;
    const lf = L.current; layer.current.clearLayers();
    const bounds = [];
    byExt.forEach((p) => {
      const icon = lf.divIcon({ className: '', html: '<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%)"><div style="background:#2f74e6;color:#fff;font:700 13px sans-serif;padding:4px 10px;border-radius:14px;box-shadow:0 3px 10px rgba(0,0,0,.35);white-space:nowrap;border:2px solid #fff">' + p.ext + '</div><div style="width:0;height:0;border:6px solid transparent;border-top-color:#fff;margin-top:-1px"></div></div>', iconSize: [0, 0] });
      const m = lf.marker([p.lat, p.lng], { icon }).addTo(layer.current);
      m.on('click', () => setSel(p.ext));
      bounds.push([p.lat, p.lng]);
    });
    if (bounds.length) { try { map.current.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 }); } catch (_) {} }
  }, [byExt, ready]);

  // historial de llamadas del interno seleccionado
  const hist = useMemo(() => {
    if (!sel) return [];
    return cdr.filter(r => String(r.src) === String(sel) || String(r.dst) === String(sel)).slice(0, 40).map(r => {
      const out = String(r.src) === String(sel); return { out, other: out ? r.dst : r.src, start: r.start, billsec: r.billsec, disposition: r.disposition };
    });
  }, [sel, cdr]);
  const selPt = useMemo(() => byExt.find(p => p.ext === sel), [byExt, sel]);

  const ov = { opacity: 0.97 };
  const inN = byExt.length;

  return (
    <div style={{ position: 'relative', height: 'calc(100vh - 40px)', borderRadius: 18, overflow: 'hidden', border: '1px solid var(--mantine-color-default-border)' }}>
      <div ref={mapEl} style={{ position: 'absolute', inset: 0, background: 'var(--mantine-color-default-hover)' }} />

      <Paper withBorder shadow="md" style={{ position: 'absolute', top: 14, left: 14, padding: '10px 14px', borderRadius: 14, zIndex: 1000, ...ov }}>
        <Group gap={10} wrap="nowrap">
          <ThemeIcon size={34} radius="md" variant="light" color="teal"><IconMapPin size={19} /></ThemeIcon>
          <div><Text fw={800} fz="sm" lh={1.1}>Mapa de llamadas</Text><Text fz={11} c="dimmed">Ubicación GPS de internos WebRTC</Text></div>
          <Divider orientation="vertical" />
          <div style={{ textAlign: 'center' }}><Text fw={800} fz="lg" lh={1}>{inN}</Text><Text fz={10} c="dimmed">internos</Text></div>
        </Group>
      </Paper>

      <Group style={{ position: 'absolute', top: 14, right: 14, zIndex: 1000 }} gap={8}>
        <Paper withBorder shadow="md" style={{ borderRadius: 12, ...ov }} p={3}>
          <SegmentedControl size="xs" value={hours} onChange={setHours} data={[{ value: '24', label: '24 h' }, { value: '168', label: '7 d' }, { value: '720', label: '30 d' }]} />
        </Paper>
        <Tooltip label="Actualizar"><ActionIcon size={36} radius="md" variant="default" onClick={load} style={ov}><IconRefresh size={18} /></ActionIcon></Tooltip>
      </Group>

      {sel &&
        <Paper withBorder shadow="xl" style={{ position: 'absolute', top: 70, right: 14, width: 320, maxHeight: 'calc(100% - 90px)', borderRadius: 16, overflow: 'hidden', zIndex: 1000, display: 'flex', flexDirection: 'column', ...ov }}>
          <Group justify="space-between" px="md" py="sm" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
            <Group gap={10}><ThemeIcon size={36} radius="xl" variant="light" color="blue"><IconUser size={18} /></ThemeIcon>
              <div><Text fw={800} lh={1.1}>Interno {sel}</Text><Text fz={11} c="dimmed">{selPt ? 'Últ. ubicación ' + new Date(selPt.ts * 1000).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</Text></div></Group>
            <CloseButton onClick={() => setSel(null)} />
          </Group>
          <Text fz="xs" fw={700} tt="uppercase" c="dimmed" px="md" pt="sm">Historial de llamadas</Text>
          <ScrollArea.Autosize mah={'calc(100vh - 260px)'}>
            <Stack gap={4} p={8}>
              {hist.length === 0 ? <Text c="dimmed" fz="sm" ta="center" py="lg">Sin llamadas registradas.</Text> :
                hist.map((h, i) => (
                  <Group key={i} gap={10} wrap="nowrap" style={{ padding: '8px 8px', borderRadius: 10, background: 'var(--mantine-color-default-hover)' }}>
                    <ThemeIcon size={30} radius="md" variant="light" color={h.out ? 'grape' : 'blue'}>{h.out ? <IconArrowUpRight size={15} /> : <IconArrowDownLeft size={15} />}</ThemeIcon>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text fw={600} fz="sm" ff="monospace" truncate>{h.other || '—'}</Text>
                      <Text fz={11} c="dimmed">{new Date(h.start).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {dispEs(h.disposition)}</Text>
                    </div>
                    <Badge size="sm" variant="light" color="gray">{fmtDur(h.billsec)}</Badge>
                  </Group>
                ))}
            </Stack>
          </ScrollArea.Autosize>
        </Paper>}

      {ready && byExt.length === 0 &&
        <Paper withBorder shadow="md" style={{ position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', padding: '10px 16px', borderRadius: 12, zIndex: 1000, ...ov }}>
          <Text fz="sm" c="dimmed">Sin ubicaciones aún. La app del teléfono comparte la ubicación al llamar (activada por defecto).</Text>
        </Paper>}
    </div>
  );
}
