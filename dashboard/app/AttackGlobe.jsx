'use client';
/* ============================================================================
 *  Mapa de ataques — globo 3D (cobe) con arcos e "feed" en vivo.
 *
 *  El globo WebGL gira, con un punto encendido por país atacante (tamaño según
 *  golpes) y un punto propio en verde sobre el servidor. De cada país sale un ARCO
 *  animado hacia nosotros: se lee de una que todo el fuego converge acá.
 *
 *  Al costado, un feed de los últimos bloqueos: bandera del país + ícono del TIPO
 *  de intento (fuerza bruta, escáner, flood, país vetado…), que van entrando con
 *  una animación. Los tipos y sus íconos son los mismos que usa el resto del SOC.
 *
 *  Sin recuadro ni tarjeta: el globo ocupa todo el bloque y se funde con el fondo
 *  oscuro del panel. Los datos van montados encima como overlay.
 *
 *  Sin dependencias de red: el planeta lo dibuja el shader de cobe, así que la
 *  pantalla no depende de internet ni le cuenta a un tercero que el cliente mira su
 *  SOC. Si el navegador no tiene WebGL, cae al mapa plano de siempre (AttackMap).
 * ==========================================================================*/
import { useEffect, useRef, useState } from 'react';
import { Group, Text, Badge, ThemeIcon, useMantineColorScheme } from '@mantine/core';
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

/* Tipo de intento -> ícono + color. Mismos criterios que el SOC (MOTIVOS de la
 * pantalla de seguridad): el ícono le dice al operador QUÉ intentaron, de un vistazo. */
const TIPOS = [
  { re: /flood|avalancha|rate|too many|session ?limit|load|carga/i, key: 'flood',  color: '#f04438', Icon: IconWaveSine, label: 'Flood / abuso' },
  { re: /scan|escáner|escaner|friendly|sipvicious|sipcli|vicious|sonda/i, key: 'escaner', color: '#c084fc', Icon: IconRadar2, label: 'Escáner' },
  { re: /clave|password|auth|cred|nonce|challenge|bruta/i, key: 'auth', color: '#f7b955', Icon: IconKey, label: 'Fuerza bruta' },
  { re: /cuenta|account|inexistente/i, key: 'cuenta', color: '#f79009', Icon: IconUserOff, label: 'Cuenta inexistente' },
  { re: /\bacl\b|no permitid|not allowed|transporte|transport/i, key: 'acl', color: '#5b8def', Icon: IconHandStop, label: 'Rechazado (ACL)' },
  { re: /geo|país|pais|country|vetado/i, key: 'geo', color: '#38bdf8', Icon: IconWorld, label: 'País vetado' },
  { re: /lista negra|manual/i, key: 'manual', color: '#94a3b8', Icon: IconLock, label: 'Bloqueo manual' },
];
const tipoDe = (reason) => TIPOS.find((t) => t.re.test(String(reason || ''))) || { key: 'otro', color: '#ff6a5e', Icon: IconAlertTriangle, label: 'Intento bloqueado' };
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

export default function AttackGlobe({ paises = [], bloqueos = [], geoblock = null, kpis = {}, titulo = 'Mapa de ataques en vivo' }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const globeRef = useRef(null);
  const phiRef = useRef(0);
  const thetaRef = useRef(0.25);
  const dragRef = useRef(null);
  const [webglRoto, setWebglRoto] = useState(false);
  const { colorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';

  const pts = (paises || [])
    .map((p) => { const ll = LL[String(p.cc || '').toUpperCase()]; return ll ? { ...p, lat: ll[0], lon: ll[1] } : null; })
    .filter(Boolean);
  const maxN = Math.max(1, ...pts.map((p) => p.n || 1));

  // Feed: los últimos bloqueos con país y tipo. Se ordenan por fecha (lo más nuevo arriba).
  const feed = (bloqueos || [])
    .filter((b) => b && (b.cc || b.country))
    .slice(0, 8)
    .map((b) => ({ ip: b.ip, cc: b.cc, pais: b.country, tipo: tipoDe(b.reason), reason: b.reason, at: b.blocked_at }));

  // Países vetados por el filtro geográfico. Son un MURO, no ataques: se pintan
  // distinto (ámbar si es lista negra, cian si es lista blanca) y sin arco.
  const modoGeo = (geoblock && geoblock.modo) || 'bloquear';
  const geoPts = ((geoblock && geoblock.paises) || [])
    .map((g) => { const ll = LL[String(g.cc || '').toUpperCase()]; return ll ? { cc: g.cc, nombre: g.nombre, lat: ll[0], lon: ll[1] } : null; })
    .filter(Boolean);
  const geoColor = modoGeo === 'permitir' ? [0.3, 0.7, 1] : [1, 0.58, 0.13];
  const geoHex = modoGeo === 'permitir' ? '#4db8ff' : '#f79009';

  // Firma: recreamos el globo cuando cambia el conjunto de ataques O el de vetados.
  const firma = pts.map((p) => `${p.cc}:${p.n}`).sort().join('|') + '#' + modoGeo + '#' + geoPts.map((g) => g.cc).sort().join(',') + '#' + (dark ? 'd' : 'l');

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
        { location: HOME, size: 0.07, color: [0.16, 0.86, 0.62] },
        ...pts.map((p) => ({ location: [p.lat, p.lon], size: 0.035 + ((p.n || 1) / maxN) * 0.075, color: [1, 0.3, 0.24] })),
        // países vetados que NO están atacando ahora: sólo el muro, sin arco
        ...geoPts.filter((g) => !atacantes.has(String(g.cc).toUpperCase()))
          .map((g) => ({ location: [g.lat, g.lon], size: 0.03, color: geoColor })),
      ];
      // Un arco por país atacante hacia nosotros, con el color del tipo dominante.
      const arcs = pts.map((p) => {
        const b = (bloqueos || []).find((x) => (x.cc || '').toUpperCase() === String(p.cc).toUpperCase());
        return { from: [p.lat, p.lon], to: HOME, color: b ? rgb(tipoDe(b.reason).color) : [1, 0.3, 0.24] };
      });

      let globo;
      try {
        globo = createGlobe(canvasRef.current, {
          devicePixelRatio: dpr,
          width: ancho * dpr,
          height: alto * dpr,
          phi: phiRef.current,
          theta: thetaRef.current,
          // El planeta tiene que verse sobre CUALQUIER fondo (tema claro u oscuro).
          // La clave es el contraste: puntos de continente claros + un halo (glowColor)
          // que le da borde a la esfera. Sin halo y con colores oscuros, el globo se
          // fundía con el fondo y sólo quedaban los marcadores flotando.
          dark: dark ? 1 : 0,
          diffuse: 1.1,
          mapSamples: 16000,
          mapBrightness: dark ? 6 : 8,
          baseColor: dark ? [0.42, 0.5, 0.62] : [0.62, 0.68, 0.78],
          markerColor: [1, 0.3, 0.24],
          glowColor: dark ? [0.35, 0.45, 0.62] : [0.85, 0.9, 1],
          markers,
          arcs,                 // cobe 2.x: los arcos se animan solos (se dibujan y desvanecen)
          arcColor: [1, 0.42, 0.32],
          arcWidth: 0.35,
          arcHeight: 0.42,
          onRender: (state) => {
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
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 440 }}>
      <style jsx>{`
        @keyframes agLive { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
        @keyframes agIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
      `}</style>

      {/* Halo suave detrás del globo — sólo realza, no lo tapa. El cuerpo de la esfera
          lo pone ahora cobe (con más brillo y halo propio); antes un disco oscuro y
          grande se lo tragaba. En claro, un velo tenue; en oscuro, un resplandor azul. */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
        background: dark
          ? 'radial-gradient(circle at 50% 47%, rgba(30,52,86,.45) 0%, rgba(20,36,60,.18) 42%, rgba(10,20,34,0) 66%)'
          : 'radial-gradient(circle at 50% 47%, rgba(120,140,180,.18) 0%, rgba(150,165,195,.08) 44%, rgba(200,210,230,0) 66%)' }} />

      {/* el globo, sin recuadro: se funde con el fondo del panel */}
      <div ref={wrapRef} style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={soltar} onPointerLeave={soltar}
          style={{ width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }}
        />
      </div>

      {/* título + estado en vivo */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '6px 4px 14px', zIndex: 4, pointerEvents: 'none' }}>
        <Group gap={9} wrap="nowrap">
          <IconWorldBolt size={20} color="#ff6a5e" style={{ filter: 'drop-shadow(0 0 6px rgba(240,68,56,.6))' }} />
          <Text fw={700} c="#eaf1ff" style={{ textShadow: '0 1px 3px rgba(0,0,0,.6)' }}>{titulo}</Text>
          <Badge size="sm" variant="filled" color="red" ml="auto" style={{ pointerEvents: 'auto' }}
            leftSection={<span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#fff', animation: 'agLive 1.4s ease-in-out infinite' }} />}>
            {pts.length} orígenes
          </Badge>
        </Group>
      </div>

      {/* KPIs verticales (arriba-derecha) */}
      <div style={{ position: 'absolute', top: 44, right: 2, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 5, width: 138 }}>
        {KPIS.map((it) => {
          const Ic = it.Icon;
          return (
            <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px', borderRadius: 9,
              background: 'rgba(9,16,28,.55)', border: '1px solid rgba(255,255,255,.08)', backdropFilter: 'blur(3px)' }}>
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

      {/* feed de intentos: bandera + ícono de tipo, entrando animado (abajo-izquierda) */}
      {feed.length > 0 && (
        <div style={{ position: 'absolute', bottom: 8, left: 2, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '62%' }}>
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

      {/* leyenda del filtro por país (sólo si hay países configurados) */}
      {geoPts.length > 0 && (
        <div style={{ position: 'absolute', bottom: 8, right: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 7,
          padding: '4px 10px', borderRadius: 9, background: 'rgba(9,16,28,.6)', border: '1px solid rgba(255,255,255,.08)', backdropFilter: 'blur(3px)' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: geoHex, boxShadow: `0 0 7px ${geoHex}`, flex: '0 0 9px' }} />
          <Text style={{ fontSize: 11, color: '#c8d6ee', whiteSpace: 'nowrap' }}>
            {geoPts.length} {modoGeo === 'permitir' ? `país${geoPts.length === 1 ? '' : 'es'} permitido${geoPts.length === 1 ? '' : 's'}` : `país${geoPts.length === 1 ? '' : 'es'} vetado${geoPts.length === 1 ? '' : 's'}`}
          </Text>
        </div>
      )}

      {pts.length === 0 && feed.length === 0 && (
        <Group justify="center" style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}>
          <Text size="sm" c="#7f93b5">{geoPts.length > 0 ? 'Sin ataques en curso. Los puntos marcan el filtro por país.' : 'Sin ataques localizados todavía.'}</Text>
        </Group>
      )}
    </div>
  );
}
