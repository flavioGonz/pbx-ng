'use client';
/* ============================================================================
 *  Mapa de ataques — globo 3D (cobe).
 *
 *  Reemplaza el mapa plano equirectangular por un globo WebGL que gira, con un
 *  punto encendido por cada país que está atacando (tamaño según cuántos golpes
 *  metió) y un punto propio, en verde, sobre el servidor. Mismos datos que el
 *  mapa viejo (`top_paises` de /api/security, ya geolocalizado) y los mismos
 *  overlays (título, "en vivo", KPIs) montados encima.
 *
 *  Se puede arrastrar con el mouse para girarlo; suelto, sigue rotando solo.
 *
 *  cobe (github.com/shuding/cobe) es ~5 kB y sin dependencias de red: el mapa del
 *  planeta lo trae el propio shader, así que —igual que el mapa plano— la pantalla
 *  no depende de internet ni le cuenta a un tercero que el cliente mira su SOC.
 *
 *  Si el navegador no tiene WebGL, cae al mapa plano de siempre (AttackMap): un
 *  SOC no se puede quedar sin su mapa por un tema de video.
 * ==========================================================================*/
import { useEffect, useRef, useState } from 'react';
import { Group, Text, Badge } from '@mantine/core';
import { IconWorldBolt, IconBan, IconFlame, IconWorld, IconShieldCheck, IconLockOff } from '@tabler/icons-react';
import AttackMap from './AttackMap';

/* Centroide aproximado (lat, lon) de los países que solemos ver atacando.
 * cobe usa marcadores [lat, lon], así que esta tabla entra tal cual. */
const LL = {
  US: [38, -97], CA: [56, -106], BR: [-10, -55], DE: [51, 10], NL: [52, 5], GB: [54, -2],
  FR: [46, 2], RU: [61, 100], CN: [35, 105], IN: [21, 78], UA: [49, 32], TR: [39, 35],
  VN: [16, 108], ID: [-2, 118], IR: [32, 53], PK: [30, 70], RO: [46, 25], PL: [52, 19],
  KR: [37, 128], JP: [36, 138], MX: [23, -102], AR: [-38, -63], CL: [-30, -71], CO: [4, -72],
  PE: [-10, -76], ES: [40, -4], IT: [42, 12], PT: [39, -8], SE: [62, 15], CH: [47, 8],
  SG: [1, 104], HK: [22, 114], TW: [24, 121], TH: [15, 101], MY: [4, 102], PH: [13, 122],
  ZA: [-29, 24], NG: [9, 8], EG: [26, 30], MA: [32, -6], SA: [24, 45], AE: [24, 54],
  IL: [31, 35], AU: [-25, 133], NZ: [-42, 174], BG: [43, 25], CZ: [50, 15], HU: [47, 19],
  GR: [39, 22], RS: [44, 21], MD: [47, 28], BY: [53, 28], KZ: [48, 67], LT: [55, 24],
  LV: [57, 25], UY: [-33, -56], PY: [-23, -58], BO: [-17, -64], EC: [-2, -78], VE: [8, -66],
  BE: [50, 4], SC: [-4, 55], LU: [49, 6], IE: [53, -8], FI: [64, 26], NO: [62, 10], DK: [56, 9],
  AT: [47, 14], HR: [45, 15], SK: [48, 19], EE: [58, 25], IS: [65, -18], BD: [23, 90],
  PA: [9, -80], CR: [10, -84], GT: [15, -90], DO: [19, -70], CU: [22, -79], KE: [1, 38],
  DZ: [28, 2], TN: [34, 9], IQ: [33, 44], SY: [35, 38], JO: [31, 36], LK: [7, 81], NP: [28, 84],
  MM: [20, 96], KH: [12, 105], LA: [18, 104], MN: [46, 105], UZ: [41, 64], GE: [42, 43], AM: [40, 45], AZ: [40, 47],
};
const flagUrl = (cc) => `https://flagcdn.com/${String(cc).toLowerCase()}.svg`;

/* Dónde estamos nosotros: el punto que recibe los golpes. Uruguay. */
const HOME = [-34.9, -56.2];

export default function AttackGlobe({ paises = [], kpis = {}, titulo = 'Mapa de ataques en vivo' }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const globeRef = useRef(null);
  const phiRef = useRef(0);
  const thetaRef = useRef(0.25);
  const dragRef = useRef(null);      // { x, phi } mientras se arrastra
  const [webglRoto, setWebglRoto] = useState(false);

  // Marcadores: los países atacantes (rojo, tamaño según golpes) + nosotros (verde).
  const pts = (paises || [])
    .map((p) => { const ll = LL[String(p.cc || '').toUpperCase()]; return ll ? { ...p, lat: ll[0], lon: ll[1] } : null; })
    .filter(Boolean);
  const maxN = Math.max(1, ...pts.map((p) => p.n || 1));

  // Firma de los datos: si no cambió, no recreamos el globo (evita el parpadeo del
  // socket, que refresca seguido). Ordenada para que el mismo conjunto de una firma igual.
  const firma = pts.map((p) => `${p.cc}:${p.n}`).sort().join('|');

  useEffect(() => {
    let vivo = true;
    let ancho = 0, alto = 0;
    let cleanup = null;

    (async () => {
      let createGlobe;
      try { createGlobe = (await import('cobe')).default; }
      catch (_) { if (vivo) setWebglRoto(true); return; }
      if (!vivo || !canvasRef.current) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const medir = () => {
        const r = wrapRef.current?.getBoundingClientRect();
        ancho = Math.max(1, Math.round(r?.width || 1));
        alto = Math.max(1, Math.round(r?.height || 1));
      };
      medir();

      const markers = [
        // nosotros, el blanco de todo esto
        { location: HOME, size: 0.06, color: [0.16, 0.86, 0.62] },
        // cada país atacante
        ...pts.map((p) => ({
          location: [p.lat, p.lon],
          size: 0.035 + ((p.n || 1) / maxN) * 0.075,
          color: [1, 0.3, 0.24],
        })),
      ];

      let globo;
      try {
        globo = createGlobe(canvasRef.current, {
          devicePixelRatio: dpr,
          width: ancho * dpr,
          height: alto * dpr,
          phi: phiRef.current,
          theta: thetaRef.current,
          dark: 1,
          diffuse: 1.2,
          mapSamples: 16000,
          mapBrightness: 5,
          baseColor: [0.24, 0.33, 0.46],       // continentes: azul acero, en tono con el panel
          markerColor: [1, 0.3, 0.24],         // rojo ataque por defecto
          glowColor: [0.13, 0.2, 0.32],        // halo tenue, oscuro
          markers,
          onRender: (state) => {
            // Gira solo; si el usuario arrastra, manda su gesto. Un pelín más lento
            // que el default para que no maree en una pantalla que se mira todo el día.
            if (!dragRef.current) phiRef.current += 0.0035;
            state.phi = phiRef.current;
            state.theta = thetaRef.current;
            state.width = ancho * dpr;
            state.height = alto * dpr;
          },
        });
      } catch (_) { if (vivo) setWebglRoto(true); return; }
      globeRef.current = globo;

      const ro = new ResizeObserver(() => { if (vivo) medir(); });
      if (wrapRef.current) ro.observe(wrapRef.current);

      // limpieza local del efecto
      cleanup = () => { ro.disconnect(); try { globo.destroy(); } catch (_) {} globeRef.current = null; };
    })();

    return () => { vivo = false; if (cleanup) cleanup(); else { try { globeRef.current?.destroy(); } catch (_) {} } };
    // Recrea el globo sólo cuando cambia el CONJUNTO de marcadores, no en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firma]);

  // Arrastrar para girar.
  const onDown = (e) => { dragRef.current = { x: e.clientX, phi: phiRef.current }; };
  const onMove = (e) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    phiRef.current = dragRef.current.phi + dx / 200;
  };
  const soltar = () => { dragRef.current = null; };

  // Si WebGL no está, no dejamos al SOC sin mapa: cae al plano de siempre.
  if (webglRoto) return <AttackMap paises={paises} kpis={kpis} titulo={titulo} />;

  const k = kpis || {};
  const KPIS = [
    { label: 'IPs bloqueadas', value: k.bloqueados || 0, color: '#f04438', Icon: IconBan },
    { label: 'Últimas 24 h',   value: k.ultimas_24h || 0, color: '#f79009', Icon: IconFlame },
    { label: 'Países origen',  value: k.paises || 0,       color: '#c084fc', Icon: IconWorld },
    { label: 'Fallos 24 h',    value: k.fallos_24h || 0,   color: '#12b886', Icon: IconShieldCheck },
    { label: 'Permanentes',    value: k.permanentes || 0,  color: '#94a3b8', Icon: IconLockOff },
  ];

  return (
    <div className="pbx-fade-in" style={{
      position: 'relative', width: '100%', height: '100%', minHeight: 380, borderRadius: 14, overflow: 'hidden',
      background: 'radial-gradient(120% 120% at 50% 15%, #0e2036 0%, #0a1524 55%, #060b14 100%)',
      boxShadow: 'inset 0 0 60px rgba(0,0,0,.45)',
    }}>
      <style jsx>{`
        @keyframes agLive { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
      `}</style>

      {/* el globo ocupa todo el bloque */}
      <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={soltar}
          onPointerLeave={soltar}
          style={{ width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }}
        />
      </div>

      {/* ── OVERLAY: título + estado en vivo ─────────────────────────────── */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '14px 16px', zIndex: 4,
                    background: 'linear-gradient(180deg, rgba(6,11,20,.82) 0%, rgba(6,11,20,0) 100%)', pointerEvents: 'none' }}>
        <Group gap={9} wrap="nowrap">
          <IconWorldBolt size={20} color="#ff6a5e" style={{ filter: 'drop-shadow(0 0 6px rgba(240,68,56,.6))' }} />
          <Text fw={700} c="#eaf1ff" style={{ textShadow: '0 1px 3px rgba(0,0,0,.6)' }}>{titulo}</Text>
          <Badge size="sm" variant="filled" color="red" ml="auto" style={{ pointerEvents: 'auto' }}
            leftSection={<span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#fff', animation: 'agLive 1.4s ease-in-out infinite' }} />}>
            {pts.length} orígenes
          </Badge>
        </Group>
      </div>

      {/* ── OVERLAY: KPIs en vertical ────────────────────────────────────── */}
      <div style={{ position: 'absolute', top: 50, right: 12, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 5, width: 138 }}>
        {KPIS.map((it) => {
          const Ic = it.Icon;
          return (
            <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px', borderRadius: 9,
              background: 'rgba(9,16,28,.62)', border: '1px solid rgba(255,255,255,.1)', backdropFilter: 'blur(3px)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 7,
                            background: `${it.color}22`, flex: '0 0 24px' }}>
                <Ic size={14} color={it.color} />
              </div>
              <div style={{ lineHeight: 1.1, minWidth: 0 }}>
                <Text fw={800} c="#eaf1ff" style={{ fontSize: 16 }}>{it.value}</Text>
                <Text c="#9fb2d4" style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }}>{it.label}</Text>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── OVERLAY: top de orígenes con bandera (abajo-izquierda) ─────────── */}
      {pts.length > 0 && (
        <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '55%' }}>
          {[...pts].sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 5).map((p) => (
            <div key={p.cc} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 8px', borderRadius: 8,
              background: 'rgba(9,16,28,.62)', border: '1px solid rgba(255,255,255,.08)', backdropFilter: 'blur(3px)' }}>
              <img src={flagUrl(p.cc)} alt="" width={17} height={12} style={{ borderRadius: 2, objectFit: 'cover', flex: '0 0 17px' }} />
              <Text c="#dbe6fb" style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.pais || p.cc}</Text>
              <Text c="#ff8a80" fw={700} style={{ fontSize: 11.5, marginLeft: 'auto' }}>{p.n || 1}</Text>
            </div>
          ))}
        </div>
      )}

      {pts.length === 0 && (
        <Group justify="center" style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}>
          <Text size="sm" c="#7f93b5">Sin ataques localizados todavía.</Text>
        </Group>
      )}
    </div>
  );
}
