'use client';
import { useEffect, useRef, useState } from 'react';
import { Paper, Group, Text, Badge, ThemeIcon, SegmentedControl, ActionIcon, Tooltip, Divider } from '@mantine/core';
import { IconMapPin, IconRefresh, IconArrowDownLeft, IconArrowUpRight } from '@tabler/icons-react';

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

export default function Mapa() {
  const mapEl = useRef(null); const map = useRef(null); const layer = useRef(null); const L = useRef(null);
  const [hours, setHours] = useState('168'); const [pts, setPts] = useState([]); const [ready, setReady] = useState(false);

  async function load() {
    try { const d = await fetch('/backend/api/geo?hours=' + hours + '&limit=500').then(r => r.json()); setPts(Array.isArray(d) ? d : []); } catch (_) {}
  }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [hours]);

  useEffect(() => {
    let alive = true;
    loadLeaflet().then((lf) => {
      if (!alive || !mapEl.current || map.current) return;
      L.current = lf;
      map.current = lf.map(mapEl.current, { zoomControl: true, attributionControl: true }).setView([-34.9011, -56.1645], 11);
      lf.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
      layer.current = lf.layerGroup().addTo(map.current);
      setReady(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!ready || !L.current || !layer.current) return;
    const lf = L.current; layer.current.clearLayers();
    const bounds = [];
    pts.forEach((p) => {
      if (p.lat == null || p.lng == null) return;
      const inbound = p.dir === 'in'; const color = inbound ? '#2f74e6' : '#7c3aed';
      if (p.accuracy) lf.circle([p.lat, p.lng], { radius: Math.min(p.accuracy, 2000), color, weight: 1, opacity: 0.35, fillOpacity: 0.08 }).addTo(layer.current);
      const m = lf.circleMarker([p.lat, p.lng], { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.95 }).addTo(layer.current);
      const when = new Date(p.ts * 1000).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      m.bindPopup('<div style="font-family:sans-serif;font-size:13px;min-width:160px"><b>Interno ' + (p.ext || '?') + '</b> ' + (inbound ? '◀ entrante' : '▶ saliente') + '<br/>' + (p.number ? 'Con: <b>' + p.number + '</b><br/>' : '') + when + (p.accuracy ? '<br/><span style="color:#888">precisión ±' + Math.round(p.accuracy) + ' m</span>' : '') + '</div>');
      bounds.push([p.lat, p.lng]);
    });
    if (bounds.length) { try { map.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 }); } catch (_) {} }
  }, [pts, ready]);

  const glass = { background: 'rgba(255,255,255,.9)', backdropFilter: 'blur(10px)', border: '1px solid rgba(15,23,42,.08)', boxShadow: '0 10px 30px rgba(15,42,74,.12)' };
  const inN = pts.filter(p => p.dir === 'in').length, outN = pts.length - pts.filter(p => p.dir === 'in').length;

  return (
    <div style={{ position: 'relative', height: 'calc(100vh - 40px)', borderRadius: 18, overflow: 'hidden', border: '1px solid rgba(15,23,42,.10)' }}>
      <div ref={mapEl} style={{ position: 'absolute', inset: 0, background: '#e8eef5' }} />

      <Paper style={{ position: 'absolute', top: 14, left: 14, padding: '10px 14px', borderRadius: 14, zIndex: 1000, ...glass }}>
        <Group gap={10} wrap="nowrap">
          <ThemeIcon size={34} radius="md" variant="light" color="teal"><IconMapPin size={19} /></ThemeIcon>
          <div><Text fw={800} fz="sm" lh={1.1}>Mapa de llamadas</Text><Text fz={11} c="dimmed">Ubicación GPS de las llamadas WebRTC</Text></div>
          <Divider orientation="vertical" />
          <Group gap={12}>
            <div style={{ textAlign: 'center' }}><Text fw={800} fz="lg" lh={1}>{pts.length}</Text><Text fz={10} c="dimmed">puntos</Text></div>
            <Badge variant="light" color="blue" leftSection={<IconArrowDownLeft size={11} />}>{inN}</Badge>
            <Badge variant="light" color="grape" leftSection={<IconArrowUpRight size={11} />}>{outN}</Badge>
          </Group>
        </Group>
      </Paper>

      <Group style={{ position: 'absolute', top: 14, right: 14, zIndex: 1000 }} gap={8}>
        <Paper style={{ borderRadius: 12, ...glass }} p={3}>
          <SegmentedControl size="xs" value={hours} onChange={setHours} data={[{ value: '24', label: '24 h' }, { value: '168', label: '7 d' }, { value: '720', label: '30 d' }]} />
        </Paper>
        <Tooltip label="Actualizar"><ActionIcon size={36} radius="md" variant="default" onClick={load} style={glass}><IconRefresh size={18} /></ActionIcon></Tooltip>
      </Group>

      {ready && pts.length === 0 &&
        <Paper style={{ position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', padding: '10px 16px', borderRadius: 12, zIndex: 1000, ...glass }}>
          <Text fz="sm" c="dimmed">Sin ubicaciones aún. Activá «Compartir ubicación» en la app del teléfono y hacé una llamada.</Text>
        </Paper>}
    </div>
  );
}
