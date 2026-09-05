'use client';
/* ============================================================================
 *  Mapa de ataques — de qué países viene el fuego, en vivo.
 *
 *  Full-bleed, SIN bordes ni tarjeta: el mapa ocupa todo el bloque y los datos
 *  (título, orígenes en vivo y KPIs) van montados ENCIMA como overlay, sobre un
 *  degradado que los hace legibles. Proyección equirectangular (lon -180..180 → x,
 *  lat 90..-90 → y), un punto pulsante por país atacante con tamaño según cuántos
 *  golpes metió. Se alimenta de `top_paises` de /api/security (ya geolocalizado y
 *  cacheado en la API) — el refresco lo dispara el socket.
 *
 *  Portado del SBC-NG. Diferencia: el fondo NO es una imagen externa (el SBC tiraba
 *  de wikimedia); acá los continentes son polígonos SVG inline, toscos a propósito
 *  (van con opacidad baja y sólo ubican). Así la pantalla no depende de internet ni
 *  filtra a un tercero que el cliente está mirando su SOC.
 * ==========================================================================*/
import { Group, Text, Badge, Tooltip } from '@mantine/core';
import { IconWorldBolt, IconBan, IconFlame, IconWorld, IconShieldCheck, IconLockOff } from '@tabler/icons-react';

// Centroide aproximado (lat, lon) de los países que solemos ver atacando.
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

/* Continentes en (lon, lat), toscos: se dibujan al 20 % de opacidad y sólo sirven para
 * que el ojo ubique dónde cae cada punto. No es cartografía. */
const CONTINENTES = [
  // América del Norte y Central
  [[-168, 66], [-160, 70], [-140, 70], [-125, 72], [-110, 73], [-95, 72], [-80, 70], [-65, 62], [-55, 52], [-60, 45], [-70, 42], [-75, 36], [-80, 30], [-82, 25], [-85, 30], [-90, 29], [-97, 26], [-98, 21], [-92, 17], [-87, 15], [-83, 9], [-79, 8], [-84, 13], [-92, 15], [-105, 20], [-110, 24], [-115, 30], [-120, 34], [-124, 40], [-124, 48], [-130, 55], [-140, 60], [-152, 60], [-165, 55]],
  // Groenlandia
  [[-55, 60], [-45, 60], [-20, 70], [-20, 80], [-40, 83], [-70, 78], [-70, 72]],
  // América del Sur
  [[-79, 8], [-75, 11], [-70, 12], [-62, 10], [-52, 4], [-50, 0], [-45, -2], [-35, -5], [-35, -10], [-39, -15], [-42, -23], [-48, -28], [-52, -33], [-58, -38], [-62, -40], [-65, -45], [-68, -52], [-70, -55], [-75, -50], [-74, -45], [-72, -35], [-71, -25], [-70, -18], [-77, -12], [-81, -5], [-80, 0], [-77, 4]],
  // Eurasia
  [[-10, 36], [-9, 43], [-2, 48], [2, 51], [8, 54], [10, 57], [18, 56], [22, 60], [27, 60], [20, 65], [25, 71], [40, 68], [45, 68], [60, 70], [70, 73], [90, 75], [110, 77], [130, 72], [150, 70], [170, 68], [180, 66], [180, 62], [170, 60], [160, 60], [155, 52], [140, 52], [135, 42], [130, 42], [126, 35], [121, 30], [120, 23], [110, 20], [108, 12], [104, 2], [100, 8], [98, 15], [95, 22], [90, 22], [85, 20], [80, 10], [77, 8], [73, 20], [68, 24], [62, 25], [57, 25], [52, 24], [56, 20], [57, 16], [48, 13], [43, 13], [40, 20], [35, 30], [35, 36], [27, 37], [26, 40], [24, 37], [20, 40], [18, 42], [12, 44], [10, 42], [3, 43], [0, 40], [-2, 37], [-6, 36]],
  // Reino Unido / Irlanda
  [[-5, 50], [1, 51], [0, 53], [-2, 57], [-5, 58], [-8, 55], [-10, 52], [-6, 51]],
  // África
  [[-17, 15], [-17, 21], [-10, 30], [-5, 36], [10, 37], [12, 33], [20, 32], [30, 31], [33, 28], [38, 20], [43, 12], [50, 10], [51, 5], [42, -2], [40, -10], [36, -18], [35, -25], [32, -29], [27, -34], [19, -35], [15, -27], [12, -18], [13, -8], [9, -2], [9, 4], [3, 6], [-8, 4], [-14, 8]],
  // Madagascar
  [[44, -25], [50, -15], [49, -12], [44, -18]],
  // Japón
  [[130, 32], [132, 34], [137, 35], [141, 38], [142, 42], [144, 44], [140, 40], [135, 34]],
  // Indonesia / Nueva Guinea
  [[95, 5], [105, -6], [115, -8], [125, -8], [131, -1], [140, -2], [150, -6], [141, -9], [132, -4], [120, -5], [110, -3], [100, 0]],
  // Australia
  [[114, -22], [114, -32], [118, -35], [125, -33], [131, -31], [137, -36], [141, -38], [147, -39], [150, -37], [153, -30], [153, -25], [147, -19], [142, -11], [136, -12], [130, -12], [126, -14], [122, -18]],
  // Nueva Zelanda
  [[167, -46], [172, -43], [174, -37], [178, -38], [175, -41], [170, -46]],
];
const pol = (pts) => pts.map(([lon, lat]) => `${(lon + 180).toFixed(1)},${(90 - lat).toFixed(1)}`).join(' ');

export default function AttackMap({ paises = [], kpis = {}, titulo = 'Mapa de ataques en vivo' }) {
  const pts = (paises || [])
    .map((p) => { const ll = LL[String(p.cc || '').toUpperCase()]; return ll ? { ...p, lat: ll[0], lon: ll[1] } : null; })
    .filter(Boolean);
  const maxN = Math.max(1, ...pts.map((p) => p.n || 1));

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
        @keyframes amPing { 0% { transform: scale(.6); opacity: .9; } 100% { transform: scale(2.6); opacity: 0; } }
        @keyframes amDot { 0%,100% { transform: scale(1); } 50% { transform: scale(1.25); } }
        @keyframes amLive { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
      `}</style>

      {/* mapa mundi tenue (equirectangular, inline) + graticule sutil */}
      <svg viewBox="0 0 360 180" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <g fill="#5b7fb0" fillOpacity=".22" stroke="#7f9fcf" strokeOpacity=".35" strokeWidth=".4" strokeLinejoin="round">
          {CONTINENTES.map((c, i) => <polygon key={i} points={pol(c)} />)}
        </g>
        <g stroke="#5b7fb0" strokeWidth=".4" opacity=".16">
          {[30, 60, 90, 120, 150].map((y) => <line key={'h' + y} x1="0" x2="360" y1={y} y2={y} />)}
          {[60, 120, 180, 240, 300].map((x) => <line key={'v' + x} x1={x} x2={x} y1="0" y2="180" />)}
        </g>
      </svg>

      {/* puntos de ataque */}
      {pts.map((p) => {
        const x = ((p.lon + 180) / 360) * 100;
        const y = ((90 - p.lat) / 180) * 100;
        const sz = 7 + Math.round(((p.n || 1) / maxN) * 12);
        const n = p.n || 1;
        return (
          <Tooltip key={p.cc} withArrow position="top" color="dark"
            label={
              <Group gap={6} wrap="nowrap">
                <img src={flagUrl(p.cc)} alt="" width={18} height={13} style={{ borderRadius: 2, objectFit: 'cover' }} />
                <span>{p.pais || p.cc} · {n} golpe{n === 1 ? '' : 's'}</span>
              </Group>
            }>
            <div style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, transform: 'translate(-50%,-50%)',
                          width: sz + 14, height: sz + 14, cursor: 'help', zIndex: 3 }}>
              <span style={{ position: 'absolute', left: '50%', top: '50%', width: sz, height: sz, marginLeft: -sz / 2, marginTop: -sz / 2,
                             borderRadius: '50%', border: '2px solid rgba(240,68,56,.7)', animation: 'amPing 1.8s ease-out infinite', pointerEvents: 'none' }} />
              <span style={{ position: 'absolute', left: '50%', top: '50%', width: sz, height: sz, marginLeft: -sz / 2, marginTop: -sz / 2,
                             borderRadius: '50%', background: 'radial-gradient(circle, #ff6a5e, #f04438)', boxShadow: '0 0 10px 2px rgba(240,68,56,.6)',
                             animation: 'amDot 2s ease-in-out infinite', pointerEvents: 'none' }} />
            </div>
          </Tooltip>
        );
      })}

      {/* ── OVERLAY: título + estado en vivo (arriba, sobre el mapa) ─────── */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '14px 16px', zIndex: 4,
                    background: 'linear-gradient(180deg, rgba(6,11,20,.82) 0%, rgba(6,11,20,0) 100%)', pointerEvents: 'none' }}>
        <Group gap={9} wrap="nowrap">
          <IconWorldBolt size={20} color="#ff6a5e" style={{ filter: 'drop-shadow(0 0 6px rgba(240,68,56,.6))' }} />
          <Text fw={700} c="#eaf1ff" style={{ textShadow: '0 1px 3px rgba(0,0,0,.6)' }}>{titulo}</Text>
          <Badge size="sm" variant="filled" color="red" ml="auto" style={{ pointerEvents: 'auto' }}
            leftSection={<span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#fff', animation: 'amLive 1.4s ease-in-out infinite' }} />}>
            {pts.length} orígenes
          </Badge>
        </Group>
      </div>

      {/* ── OVERLAY: KPIs en vertical (arriba-derecha, compactos) ─────────── */}
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

      {/* Los puntos ya indican el país (con tooltip al hover); sin chips al pie. */}
      {pts.length === 0 && (
        <Group justify="center" style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
          <Text size="sm" c="#7f93b5">Sin ataques localizados todavía.</Text>
        </Group>
      )}
    </div>
  );
}
