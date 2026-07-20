'use client';
import { useEffect, useRef, useState } from 'react';
import { Group, Text, ActionIcon, Slider, Box, Tooltip, Button, Badge, Loader, Divider, useMantineColorScheme } from '@mantine/core';
import { IconPlayerPlay, IconPlayerPause, IconDownload, IconVolume, IconWaveSine, IconFileText, IconMoodSad, IconMoodSmile, IconMoodNeutral, IconAlertTriangle } from '@tabler/icons-react';

const SENT = {
  negativo: { c: 'red', t: 'Negativo', i: IconMoodSad },
  tension: { c: 'orange', t: 'Tension', i: IconAlertTriangle },
  positivo: { c: 'teal', t: 'Positivo', i: IconMoodSmile },
  neutral: { c: 'gray', t: 'Neutral', i: IconMoodNeutral },
};

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

/* Las grabaciones dejaron de ser publicas (antes se bajaban enumerando ids: /1, /2, /3…).
 * wavesurfer y el boton de descarga usan una URL directa, que no manda cabeceras, asi
 * que primero traemos el audio por fetch —al que el parche global le pone el token— y
 * trabajamos sobre un blob local. Meter el token en la URL lo dejaria escrito en los
 * logs del proxy. */
function useAudioBlob(src) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!src) { setUrl(null); return; }
    let vivo = true, creada = null;
    fetch(src)
      .then((r) => { if (!r.ok) throw new Error('sin acceso'); return r.blob(); })
      .then((b) => { if (!vivo) return; creada = URL.createObjectURL(b); setUrl(creada); })
      .catch(() => { if (vivo) setUrl(null); });
    return () => { vivo = false; if (creada) URL.revokeObjectURL(creada); };
  }, [src]);
  return url;
}

export default function RecordingPlayer({ src, label, download = true, recId }) {
  const blobUrl = useAudioBlob(src);
  const ref = useRef(null); const ws = useRef(null);
  const { colorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  const [ready, setReady] = useState(false); const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0); const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1); const [vol, setVol] = useState(1); const [err, setErr] = useState(false);
  const [tr, setTr] = useState(null); const [an, setAn] = useState(null); const [tl, setTl] = useState(false); const [topen, setTopen] = useState(false);

  useEffect(() => {
    if (!recId) return; let dead = false;
    fetch('/backend/api/recordings/' + recId + '/transcript').then((r) => r.json()).then((d) => { if (dead) return; if (d.transcript) { setTr(d.transcript); setAn(d.analysis); setTopen(true); } }).catch(() => {});
    return () => { dead = true; };
  }, [recId]);

  const transcribe = async () => {
    setTl(true); setTopen(true);
    try {
      const d = await fetch('/backend/api/recordings/' + recId + '/transcribe', { method: 'POST' }).then((r) => r.json());
      if (d.error) { setTr('No se pudo transcribir: ' + d.error); setAn(null); }
      else { setTr(d.transcript || '(sin habla detectada)'); setAn(d.analysis || null); }
    } catch (_) { setTr('Error de transcripcion'); }
    setTl(false);
  };

  useEffect(() => {
    let dead = false;
    loadWS().then((WS) => {
      if (dead || !ref.current) return;
      const inst = WS.create({
        container: ref.current, height: 54, barWidth: 2.5, barGap: 2, barRadius: 3,
        waveColor: dark ? '#3d4d68' : '#b9c6da', progressColor: '#16a34a',
        cursorColor: dark ? '#e6edf6' : '#1e293b', cursorWidth: 1, normalize: true, url: blobUrl,
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
  }, [blobUrl]);

  useEffect(() => { if (ws.current) { try { ws.current.setOptions({ waveColor: dark ? '#3d4d68' : '#b9c6da', cursorColor: dark ? '#e6edf6' : '#1e293b' }); } catch (_) {} } }, [dark]);

  const toggle = () => { try { ws.current && ws.current.playPause(); } catch (_) {} };
  const setSpeed = (rr) => { setRate(rr); try { ws.current && ws.current.setPlaybackRate(rr, true); } catch (_) {} };
  const setV = (v) => { setVol(v); try { ws.current && ws.current.setVolume(v); } catch (_) {} };

  const S = an ? (SENT[an.sentiment] || SENT.neutral) : null;
  const SIcon = S ? S.i : null;

  return (
    <Box p="sm" style={{ borderRadius: 14, background: 'var(--mantine-color-body)', border: '1px solid var(--mantine-color-default-border)', boxShadow: '0 1px 6px rgba(15,23,42,.06)' }}>
      {label && <Group gap={6} mb={6}><IconWaveSine size={13} style={{ opacity: .55 }} /><Text size="xs" c="dimmed" ff="monospace">{label}</Text></Group>}
      <Group gap="md" wrap="nowrap" align="center">
        <ActionIcon size={46} radius="xl" color="teal" variant="filled" onClick={toggle} loading={!ready && !err} disabled={err}>{playing ? <IconPlayerPause size={22} /> : <IconPlayerPlay size={22} />}</ActionIcon>
        <div style={{ flex: 1, minWidth: 0 }}>
          {err ? <Text size="sm" c="red">No se pudo cargar el audio.</Text> : <div ref={ref} style={{ width: '100%' }} />}
          <Group justify="space-between" mt={2}><Text size="xs" c="dimmed" ff="monospace">{fmt(cur)}</Text><Text size="xs" c="dimmed" ff="monospace">{fmt(dur)}</Text></Group>
        </div>
        <Group gap={3} wrap="nowrap">{[0.75, 1, 1.25, 1.5, 2].map((rr) => (
          <Box key={rr} onClick={() => setSpeed(rr)} style={{ cursor: 'pointer', padding: '3px 8px', borderRadius: 8, fontSize: 12, fontWeight: 700, lineHeight: 1, background: rate === rr ? 'var(--mantine-color-teal-filled)' : 'transparent', color: rate === rr ? '#fff' : 'var(--mantine-color-dimmed)', transition: 'all .15s' }}>{rr}x</Box>
        ))}</Group>
        <Group gap={6} w={104} wrap="nowrap"><IconVolume size={16} style={{ opacity: .55, flex: 'none' }} /><Slider size="xs" color="teal" value={vol * 100} onChange={(v) => setV(v / 100)} style={{ flex: 1 }} label={null} /></Group>
        {download && <Tooltip label="Descargar"><ActionIcon variant="default" size="lg" component="a" href={blobUrl || undefined} download={(label || 'grabacion') + '.wav'}><IconDownload size={17} /></ActionIcon></Tooltip>}
      </Group>

      {recId && (
        <Box mt="sm">
          <Divider mb="sm" />
          {!topen && !tr ? (
            <Button size="xs" variant="light" color="grape" leftSection={<IconFileText size={14} />} onClick={transcribe} loading={tl}>Transcribir y analizar</Button>
          ) : (
            <Box>
              <Group justify="space-between" mb={6}>
                <Group gap={6}><IconFileText size={15} style={{ opacity: .6 }} /><Text size="sm" fw={700}>Transcripcion</Text></Group>
                <Group gap={6}>
                  {an && S && <Badge color={S.c} variant="light" leftSection={<SIcon size={12} />}>{S.t}</Badge>}
                  {an && an.conflict && <Badge color="red" variant="filled" leftSection={<IconAlertTriangle size={12} />}>Posible discusion</Badge>}
                  <Button size="compact-xs" variant="subtle" onClick={transcribe} loading={tl}>Reanalizar</Button>
                </Group>
              </Group>
              {tl ? (
                <Group gap="xs" py="sm"><Loader size="xs" color="grape" /><Text size="sm" c="dimmed">Transcribiendo con Whisper...</Text></Group>
              ) : (
                <Box>
                  <Text size="sm" p="xs" bg="var(--mantine-color-default-hover)" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5, maxHeight: 200, overflow: 'auto', borderRadius: 8 }}>{tr}</Text>
                  {an && <Group gap={6} mt={8} wrap="wrap">
                    {(an.keywords || []).map((k) => <Badge key={k} size="sm" variant="dot" color="blue">{k}</Badge>)}
                    {an.words ? <Text size="xs" c="dimmed" ml="auto">{an.words} palabras - {an.wpm} ppm</Text> : null}
                  </Group>}
                  {an && an.flags && an.flags.length > 0 && <Group gap={6} mt={6}><Text size="xs" c="red" fw={600}>Senales:</Text>{an.flags.map((f) => <Badge key={f} size="xs" color="red" variant="light">{f}</Badge>)}</Group>}
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
