'use client';
/* ============================================================================
 *  Mapa de ataques — globo 3D (cobe).
 *
 *  MONTADO LIMPIO sobre la configuración que SÍ renderiza el planeta: cobe 0.6.3
 *  y el panel oscuro propio. Historia corta de por qué está así, para no repetirla:
 *
 *    - Subir a cobe 2.x (por los arcos) + `transpilePackages: ['cobe']` dejó de
 *      dibujar el mapa de puntos del planeta: sólo salían los marcadores. Los
 *      shaders GLSL viajan como strings y no les sienta bien que los transpilen.
 *    - Sacarle el fondo oscuro al panel también lo borra: cobe dibuja el océano
 *      TRANSPARENTE, así que sin un fondo oscuro detrás la esfera no existe.
 *
 *  O sea: el panel oscuro NO es decoración, es lo que le da cuerpo al planeta.
 *  Es además la convención de cualquier consola de seguridad, así que se ve bien
 *  tanto con el panel en claro como en oscuro.
 *
 *  Qué muestra:
 *    · un punto rojo por país que está atacando, del tamaño de los golpes que metió
 *    · un punto verde sobre el servidor: el blanco de todo esto
 *    · los países del filtro geográfico (ámbar si están vetados, cian si son los
 *      únicos permitidos): son un muro puesto a propósito, no un ataque
 *    · abajo, los últimos bloqueos con bandera + ícono del TIPO de intento
 *
 *  El planeta lo dibuja el shader: sin imagen externa, no depende de internet ni
 *  le cuenta a un tercero que el cliente está mirando su SOC. Si el navegador no
 *  tiene WebGL, cae al mapa plano de siempre (AttackMap).
 * ==========================================================================*/
import { useEffect, useRef, useState } from 'react';
import { Group, Text, Badge, ThemeIcon } from '@mantine/core';
import {
  IconWorldBolt, IconBan, IconFlame, IconWorld, IconShieldCheck, IconLockOff,
  IconWaveSine, IconRadar2, IconKey, IconUserOff, IconHandStop, IconLock, IconAlertTriangle,
} from '@tabler/icons-react';
import AttackMap from './AttackMap';

/* Centroide aproximado (lat, lon) por país. cobe usa [lat, lon] tal cual. */
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
const HOME = [-34.9, -56.2];   // Uruguay: el blanco de los ataques

/* Tipo de intento -> ícono + color. Mismos criterios que el resto del SOC: el
 * ícono le dice al operador QUÉ intentaron, de un vistazo. */
const TIPOS = [
  { re: /flood|avalancha|rate|too many|session ?limit|load|carga/i, key: 'flood', color: '#f04438', Icon: IconWaveSine, label: 'Flood / abuso' },
  { re: /scan|escáner|escaner|friendly|sipvicious|sipcli|vicious|sonda/i, key: 'escaner', color: '#c084fc', Icon: IconRadar2, label: 'Escáner' },
  { re: /clave|password|auth|cred|nonce|challenge|bruta/i, key: 'auth', color: '#f7b955', Icon: IconKey, label: 'Fuerza bruta' },
  { re: /cuenta|account|inexistente/i, key: 'cuenta', color: '#f79009', Icon: IconUserOff, label: 'Cuenta inexistente' },
  { re: /\bacl\b|no permitid|not allowed|transporte|transport/i, key: 'acl', color: '#5b8def', Icon: IconHandStop, label: 'Rechazado (ACL)' },
  { re: /geo|país|pais|country|vetado/i, key: 'geo', color: '#38bdf8', Icon: IconWorld, label: 'País vetado' },
  { re: /lista negra|manual/i, key: 'manual', color: '#94a3b8', Icon: IconLock, label: 'Bloqueo manual' },
];
const tipoDe = (reason) => TIPOS.find((t) => t.re.test(String(reason || ''))) || { key: 'otro', color: '#ff6a5e', Icon: IconAlertTriangle, label: 'Intento bloqueado' };

export default function AttackGlobe({ paises = [], bloqueos = [], geoblock = null, kpis = {}, titulo = 'Mapa de ataques en vivo' }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const globeRef = useRef(null);
  const phiRef = useRef(0);
  const dragRef = useRef(null);
  const [webglRoto, setWebglRoto] = useState(false);

  // Países que están atacando (de top_paises, ya geolocalizado por la API).
  const pts = (paises || [])
    .map((p) => { const ll = LL[String(p.cc || '').toUpperCase()]; return ll ? { ...p, lat: ll[0], lon: ll[1] } : null; })
    .filter(Boolean);
  const maxN = Math.max(1, ...pts.map((p) => p.n || 1));

  // Países del filtro geográfico: un muro, no ataques.
  const modoGeo = (geoblock && geoblock.modo) || 'bloquear';
  const geoPts = ((geoblock && geoblock.paises) || [])
    .map((g) => { const ll = LL[String(g.cc || '').toUpperCase()]; return ll ? { cc: g.cc, nombre: g.nombre, lat: ll[0], lon: ll[1] } : null; })
    .filter(Boolean);
  const geoColor = modoGeo === 'permitir' ? [0.3, 0.72, 1] : [1, 0.6, 0.15];
  const geoHex = modoGeo === 'permitir' ? '#4db8ff' : '#f79009';

  // Últimos bloqueos, con su tipo, para el feed de abajo.
  const feed = (bloqueos || [])
    .filter((b) => b && (b.cc || b.country))
    .slice(0, 6)
    .map((b) => ({ ip: b.ip, cc: b.cc, pais: b.country, tipo: tipoDe(b.reason) }));

  // Recreamos el globo sólo cuando cambia el conjunto de puntos (el socket refresca
  // seguido y no queremos reconstruir el planeta en cada tick).
  const firma = pts.map((p) => `${p.cc}:${p.n}`).sort().join('|')
    + '#' + modoGeo + '#' + geoPts.map((g) => g.cc).sort().join(',');

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

      const atacantes = new Set(pts.map((p) => String(p.cc).toUpperCase()));
      const markers = [
        { location: HOME, size: 0.06, color: [0.16, 0.86, 0.62] },
        ...pts.map((p) => ({ location: [p.lat, p.lon], size: 0.035 + ((p.n || 1) / maxN) * 0.075, color: [1, 0.3, 0.24] })),
        // el muro del filtro por país, salvo los que además están atacando: en ese
        // caso gana el rojo, porque lo que importa es que está golpeando ahora
        ...geoPts.filter((g) => !atacantes.has(String(g.cc).toUpperCase()))
          .map((g) => ({ location: [g.lat, g.lon], size: 0.028, color: geoColor })),
      ];

      let globo;
      try {
        // ⚠ Config verificada: así renderiza el planeta. No tocar a ciegas.
        globo = createGlobe(canvasRef.current, {
          devicePixelRatio: dpr,
          width: ancho * dpr,
          height: alto * dpr,
          phi: 0,
          theta: 0.25,
          dark: 1,
          diffuse: 1.2,
          mapSamples: 16000,
          mapBrightness: 5,
          baseColor: [0.24, 0.33, 0.46],
          markerColor: [1, 0.3, 0.24],
          glowColor: [0.13, 0.2, 0.32],
          markers,
          onRender: (state) => {
            if (!dragRef.current) phiRef.current += 0.0035;
            state.phi = phiRef.current;
            state.width = ancho * dpr;
            state.height = alto * dpr;
          },
        });
      } catch (_) { if (vivo) setWebglRoto(true); return; }
      globeRef.current = globo;

      const ro = new ResizeObserver(() => { if (vivo) medir(); });
      if (wrapRef.current) ro.observe(wrapRef.current);
      cleanup = () => { ro.disconnect(); try { globo.destroy(); } catch (_) {} globeRef.current = null; };
    })();

    return () => { vivo = false; if (cleanup) cleanup(); else { try { globeRef.current?.destroy(); } catch (_) {} } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firma]);

  const onDown = (e) => { dragRef.current = { x: e.clientX, phi: phiRef.current }; };
  const onMove = (e) => { if (!dragRef.current) return; phiRef.current = dragRef.current.phi + (e.clientX - dragRef.current.x) / 200; };
  const soltar = () => { dragRef.current = null; };

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
    /* El panel oscuro es lo que le da cuerpo a la esfera (el océano de cobe es
       transparente). Va siempre oscuro, como cualquier consola de seguridad, y por
       eso se ve igual de bien con el panel en claro o en oscuro. */
    <div className="pbx-fade-in" style={{
      position: 'relative', width: '100%', height: '100%', minHeight: 400, borderRadius: 14, overflow: 'hidden',
      background: 'radial-gradient(120% 120% at 50% 15%, #0e2036 0%, #0a1524 55%, #060b14 100%)',
      boxShadow: 'inset 0 0 60px rgba(0,0,0,.45)',
    }}>
      <style jsx>{`
        @keyframes agLive { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
        @keyframes agIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
      `}</style>

      <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={soltar} onPointerLeave={soltar}
          style={{ width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }}
        />
      </div>

      {/* título + estado en vivo */}
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

      {/* KPIs verticales */}
      <div style={{ position: 'absolute', top: 50, right: 12, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 5, width: 138 }}>
        {KPIS.map((it) => {
          const Ic = it.Icon;
          return (
            <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px', borderRadius: 9,
              background: 'rgba(9,16,28,.62)', border: '1px solid rgba(255,255,255,.1)', backdropFilter: 'blur(3px)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 7, background: `${it.color}22`, flex: '0 0 24px' }}>
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

      {/* feed: bandera + ícono del tipo de intento */}
      {feed.length > 0 && (
        <div style={{ position: 'absolute', bottom: 10, left: 12, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '58%' }}>
          {feed.map((a, i) => {
            const Ic = a.tipo.Icon;
            return (
              <div key={(a.ip || '') + i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 9px', borderRadius: 9,
                background: 'rgba(9,16,28,.6)', border: '1px solid rgba(255,255,255,.08)', backdropFilter: 'blur(3px)',
                animation: `agIn .45s ease ${i * 0.05}s both` }}>
                <img src={flagUrl(a.cc)} alt="" width={18} height={13} style={{ borderRadius: 2, objectFit: 'cover', flex: '0 0 18px' }} />
                <ThemeIcon size={18} radius="sm" variant="light" style={{ background: `${a.tipo.color}22`, flex: '0 0 18px' }}>
                  <Ic size={12} color={a.tipo.color} />
                </ThemeIcon>
                <div style={{ lineHeight: 1.15, minWidth: 0 }}>
                  <Text c="#dbe6fb" style={{ fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.pais || a.cc}<Text span c="#7f93b5" style={{ fontWeight: 400 }}> · {a.ip}</Text>
                  </Text>
                  <Text style={{ fontSize: 9.5, color: a.tipo.color, whiteSpace: 'nowrap' }}>{a.tipo.label}</Text>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* leyenda del filtro por país */}
      {geoPts.length > 0 && (
        <div style={{ position: 'absolute', bottom: 10, right: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 7,
          padding: '4px 10px', borderRadius: 9, background: 'rgba(9,16,28,.6)', border: '1px solid rgba(255,255,255,.08)', backdropFilter: 'blur(3px)' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: geoHex, boxShadow: `0 0 7px ${geoHex}`, flex: '0 0 9px' }} />
          <Text style={{ fontSize: 11, color: '#c8d6ee', whiteSpace: 'nowrap' }}>
            {geoPts.length} {modoGeo === 'permitir' ? 'permitidos' : 'vetados'}
          </Text>
        </div>
      )}

      {pts.length === 0 && feed.length === 0 && (
        <Group justify="center" style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}>
          <Text size="sm" c="#7f93b5">{geoPts.length > 0 ? 'Sin ataques en curso.' : 'Sin ataques localizados todavía.'}</Text>
        </Group>
      )}
    </div>
  );
}
