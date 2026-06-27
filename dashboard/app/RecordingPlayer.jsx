'use client';
import { useEffect, useRef, useState } from 'react';
import { Group, Text, ActionIcon, Slider, Box, Tooltip, useMantineColorScheme } from '@mantine/core';
import { IconPlayerPlay, IconPlayerPause, IconDownload, IconVolume, IconWaveSine } from '@tabler/icons-react';

let wsPromise = null;
function loadWS() {
  if (typeof window === 'undefined') return Promise.reject();
  if (window.WaveSurfer) return Promise.resolve(window.WaveSurfer);
  if (!wsPromise) wsPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.min.js';
    s.async = true; s.onload = () => res(window.WaveSurfer); s.onerror = rej;
    document.head.appendChild(s);
  });
  return wsPromise;
}
const fmt = (s) => { s = Math.floor(s || 0); const m = Math.floor(s / 60), ss = s % 60; return m + ':' + (ss < 10 ? '0' : '') + ss; };

export default function RecordingPlayer({ src, label, download = true }) {
  const ref = useRef(null); const ws = useRef(null);
  const { colorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  const [ready, setReady] = useState(false); const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0); const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1); const [vol, setVol] = useState(1); const [err, setErr] = useState(false);

  useEffect(() => {
    let dead = false;
    loadWS().then((WS) => {
      if (dead || !ref.current) return;
      const inst = WS.create({
        container: ref.current, height: 54, barWidth: 2.5, barGap: 2, barRadius: 3,
        waveColor: dark ? '#3d4d68' : '#b9c6da', progressColor: '#16a34a',
        cursorColor: dark ? '#e6edf6' : '#1e293b', cursorWidth: 1, normalize: true, url: src,
      });
      ws.current = inst;
      inst.on('ready', () => { setReady(true); setDur(inst.getDuration()); });
      inst.on('timeupdate', (t) => setCur(t));
      inst.on('play', () => setPlaying(true));
      inst.on('pause', () => setPlaying(false));
      inst.on('finish', () => setPlaying(false));
      inst.on('error', () => setErr(true));
    }).catch(() => setErr(true));
    return () => { dead = true; try { ws.current && ws.current.destroy(); } catch (_) {} };
  }, [src]);

  useEffect(() => { if (ws.current) { try { ws.current.setOptions({ waveColor: dark ? '#3d4d68' : '#b9c6da', cursorColor: dark ? '#e6edf6' : '#1e293b' }); } catch (_) {} } }, [dark]);

  const toggle = () => { try { ws.current && ws.current.playPause(); } catch (_) {} };
  const setSpeed = (r) => { setRate(r); try { ws.current && ws.current.setPlaybackRate(r, true); } catch (_) {} };
  const setV = (v) => { setVol(v); try { ws.current && ws.current.setVolume(v); } catch (_) {} };

  return (
    <Box p="sm" style={{ borderRadius: 14, background: 'var(--mantine-color-body)', border: '1px solid var(--mantine-color-default-border)', boxShadow: '0 1px 6px rgba(15,23,42,.06)' }}>
      {label && <Group gap={6} mb={6}><IconWaveSine size={13} style={{ opacity: .55 }} /><Text size="xs" c="dimmed" ff="monospace">{label}</Text></Group>}
      <Group gap="md" wrap="nowrap" align="center">
        <ActionIcon size={46} radius="xl" color="teal" variant="filled" onClick={toggle} loading={!ready && !err} disabled={err}>{playing ? <IconPlayerPause size={22} /> : <IconPlayerPlay size={22} />}</ActionIcon>
        <div style={{ flex: 1, minWidth: 0 }}>
          {err ? <Text size="sm" c="red">No se pudo cargar el audio.</Text> : <div ref={ref} style={{ width: '100%' }} />}
          <Group justify="space-between" mt={2}><Text size="xs" c="dimmed" ff="monospace">{fmt(cur)}</Text><Text size="xs" c="dimmed" ff="monospace">{fmt(dur)}</Text></Group>
        </div>
        <Group gap={3} wrap="nowrap">{[0.75, 1, 1.25, 1.5, 2].map((r) => (
          <Box key={r} onClick={() => setSpeed(r)} style={{ cursor: 'pointer', padding: '3px 8px', borderRadius: 8, fontSize: 12, fontWeight: 700, lineHeight: 1, background: rate === r ? 'var(--mantine-color-teal-filled)' : 'transparent', color: rate === r ? '#fff' : 'var(--mantine-color-dimmed)', transition: 'all .15s' }}>{r}x</Box>))}</Group>
        <Group gap={6} w={104} wrap="nowrap"><IconVolume size={16} style={{ opacity: .55, flex: 'none' }} /><Slider size="xs" color="teal" value={vol * 100} onChange={(v) => setV(v / 100)} style={{ flex: 1 }} label={null} /></Group>
        {download && <Tooltip label="Descargar"><ActionIcon variant="default" size="lg" component="a" href={src} download><IconDownload size={17} /></ActionIcon></Tooltip>}
      </Group>
    </Box>
  );
}
