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
 *    - Ponerle fondo claro al panel DEJANDO el globo en modo oscuro también lo
 *      borra: cobe dibuja el océano transparente, así que la esfera se pierde.
 *      La solución no es forzar fondo oscuro, es usar el parámetro `dark` de cobe:
 *      con dark:0 rinde un globo pensado para fondos claros (halo blanco que le
 *      dibuja el borde). Por eso el panel SÍ acompaña al tema.
 *
 *  Qué muestra:
 *    · un punto rojo por país que está atacando, del tamaño de los golpes que metió
 *    · un punto verde sobre el servidor: el blanco de todo esto
 *    · los países del filtro geográfico (ámbar si están vetados, cian si son los
 *      únicos permitidos): son un muro puesto a propósito, no un ataque
 *  Encima del globo va lo mínimo: título, contador y KPIs chicos. El detalle de
 *  los intentos vive en las tarjetas de abajo, no tapando el planeta.
 *
 *  El planeta lo dibuja el shader: sin imagen externa, no depende de internet ni
 *  le cuenta a un tercero que el cliente está mirando su SOC. Si el navegador no
 *  tiene WebGL, cae al mapa plano de siempre (AttackMap).
 * ==========================================================================*/
import { useEffect, useRef, useState } from 'react';
import { Group, Text, Badge, useMantineColorScheme } from '@mantine/core';
import { IconWorldBolt, IconBan, IconFlame, IconWorld, IconShieldCheck, IconLockOff } from '@tabler/icons-react';
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
const HOME = [-34.9, -56.2];   // Uruguay: el blanco de los ataques

/* Encuadre del globo — valores tomados del playground de cobe, no inventados.
 * OJO: `scale` y `offset` NO son solo estetica; el shader los aplica a las
 * coordenadas de pantalla, asi que la proyeccion de las etiquetas tiene que usar
 * exactamente los mismos numeros o quedan corridas. Por eso viven aca y no sueltos. */
const VISTA = {
  theta: -0.16,
  phi0: 4.02,          // rotacion inicial
  mapSamples: 40000,   // mas puntos = continentes mas finos
  diffuse: 1.2,
  scale: 1.35,
  offset: [-30, -10],  // en pixeles de dispositivo, como los toma cobe
  markerSize: 0.03,
};

const flagUrl = (cc) => `https://flagcdn.com/${String(cc).toLowerCase()}.svg`;

export default function AttackGlobe({ paises = [], bloqueos = [], geoblock = null, ataque = null, kpis = {}, titulo = 'Mapa de ataques en vivo' }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const globeRef = useRef(null);
  const phiRef = useRef(VISTA.phi0);
  const dragRef = useRef(null);
  // Un nodo DOM por bandera. Se mueven en cada frame desde onRender (no por estado
  // de React: son 60 fps y volver a renderizar el arbol seria carisimo).
  const flagRefs = useRef(new Map());
  const lineRefs = useRef(new Map());   // la línea que une el punto con su etiqueta
  /* Segunda pasada sobre el MISMO arco: un tramo corto que lo recorre de punta a
   * punta. Es lo que hace que la línea "viaje" hacia Uruguay en vez de quedarse
   * quieta. Va en un path aparte para poder darle su propio color y grosor sin
   * cortar la línea de base en pedacitos. */
  const pulseRefs = useRef(new Map());
  const [webglRoto, setWebglRoto] = useState(false);

  /* Tema completo del mapa: panel, planeta, textos y chips.
   *
   * El planeta se adapta con el parámetro `dark` de cobe, que existe justo para
   * esto: en claro rinde un globo con halo blanco que se recorta contra el fondo
   * claro (es el modo del demo oficial de cobe, que va sobre blanco), y en oscuro
   * el globo de siempre. Así el panel puede ser CLARO en tema claro sin que la
   * esfera desaparezca — que era lo que me pasaba cuando le sacaba el fondo oscuro
   * dejando el globo en modo oscuro. */
  const { colorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  const TEMA = dark
    ? {
        fondo: 'radial-gradient(120% 120% at 50% 15%, #0e2036 0%, #0a1524 55%, #060b14 100%)',
        borde: '1px solid rgba(255,255,255,.06)',
        sombra: 'inset 0 0 60px rgba(0,0,0,.45)',
        velo: 'linear-gradient(180deg, rgba(6,11,20,.82) 0%, rgba(6,11,20,0) 100%)',
        txt: '#eaf1ff', txt2: '#9fb2d4', txtSombra: '0 1px 3px rgba(0,0,0,.6)',
        chip: 'rgba(9,16,28,.62)', chipBorde: '1px solid rgba(255,255,255,.1)',
        globoDark: 1, base: [0.24, 0.33, 0.46], glow: [0.13, 0.2, 0.32], brillo: 6, brilloBase: 0,
      }
    : {
        fondo: 'radial-gradient(120% 120% at 50% 12%, #ffffff 0%, #fbfcfe 60%, #f2f5fa 100%)',
        borde: '1px solid rgba(15,23,42,.08)',
        sombra: '0 8px 26px rgba(15,23,42,.07)',
        velo: 'linear-gradient(180deg, rgba(255,255,255,.9) 0%, rgba(255,255,255,0) 100%)',
        txt: '#101f33', txt2: '#5b6b85', txtSombra: 'none',
        chip: 'rgba(255,255,255,.86)', chipBorde: '1px solid rgba(15,23,42,.09)',
        /* Esfera BLANCA con los continentes en puntos oscuros. Es el modo dark:0 de
         * cobe: ahi el brillo del mapa OSCURECE la tierra en vez de aclararla, asi
         * que con baseColor blanco el oceano queda blanco y la tierra se dibuja en
         * puntitos. Halo blanco para que la esfera se recorte del fondo. */
        globoDark: 0, base: [1, 1, 1], glow: [1, 1, 1], brillo: 3, brilloBase: 0,
      };

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

  /* De quién es el ataque en curso: detectarAtaque() devuelve la IP más insistente
   * pero no su país, así que lo cruzamos con los bloqueos (que sí traen cc). */
  const atacando = ataque && ataque.activo ? ataque : null;
  const origen = atacando && atacando.top_ip
    ? (bloqueos || []).find((b) => b && b.ip === atacando.top_ip) || null
    : null;
  const bajoAtaque = !!atacando;
  const ccOrigen = String((origen && origen.cc) || '').toUpperCase();

  // Recreamos el globo sólo cuando cambia el conjunto de puntos (el socket refresca
  // seguido y no queremos reconstruir el planeta en cada tick).
  const firma = pts.map((p) => `${p.cc}:${p.n}`).sort().join('|')
    + '#' + modoGeo + '#' + geoPts.map((g) => g.cc).sort().join(',') + '#' + (dark ? 'd' : 'l');

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
        { location: HOME, size: VISTA.markerSize * 1.6, color: [0.16, 0.86, 0.62] },
        ...pts.map((p) => ({ location: [p.lat, p.lon], size: VISTA.markerSize + ((p.n || 1) / maxN) * 0.045, color: [1, 0.3, 0.24] })),
        // el muro del filtro por país, salvo los que además están atacando: en ese
        // caso gana el rojo, porque lo que importa es que está golpeando ahora
        ...geoPts.filter((g) => !atacantes.has(String(g.cc).toUpperCase()))
          .map((g) => ({ location: [g.lat, g.lon], size: VISTA.markerSize * 0.9, color: geoColor })),
      ];

      let globo;
      try {
        // ⚠ Config verificada: así renderiza el planeta. No tocar a ciegas.
        globo = createGlobe(canvasRef.current, {
          devicePixelRatio: dpr,
          width: ancho * dpr,
          height: alto * dpr,
          phi: VISTA.phi0,
          theta: VISTA.theta,
          scale: VISTA.scale,
          offset: VISTA.offset,
          mapBaseBrightness: TEMA.brilloBase,
          dark: TEMA.globoDark,
          diffuse: VISTA.diffuse,
          mapSamples: VISTA.mapSamples,
          mapBrightness: TEMA.brillo,
          baseColor: TEMA.base,
          markerColor: [1, 0.3, 0.24],
          glowColor: TEMA.glow,
          markers,
          onRender: (state) => {
            if (!dragRef.current) phiRef.current += 0.0035;
            state.phi = phiRef.current;
            state.width = ancho * dpr;
            state.height = alto * dpr;

            /* Banderas encima de su punto.
             *
             * cobe pinta en WebGL y no admite HTML sobre la esfera, así que proyectamos
             * nosotros. La fórmula NO es inventada: sale de leer el shader de cobe 0.6.3.
             *
             *   1. El marcador se convierte igual que su función interna:
             *        m = (cos(lat)·cos(lon), sin(lat), −cos(lat)·sin(lon))
             *   2. El shader NO rota el marcador: rota el RAYO de la cámara y lo compara
             *      en ese espacio (`ray · M`, vector-fila por matriz). Para ir al revés
             *      hay que aplicar la TRANSPUESTA: ray = m · Mᵀ.
             *   3. El radio sale de que la esfera vive en |b| ≤ 0.8 con b.y normalizado
             *      por la ALTURA: radio real = 0.4 · alto (no min(ancho,alto)/2).
             *
             * Antes tenía el marcador mal armado y el radio 25 % grande: la bandera
             * orbitaba a la velocidad correcta pero caía en el lugar equivocado. */
            const th = VISTA.theta;                // el MISMO theta con el que se creó
            const cT = Math.cos(th), sT = Math.sin(th);
            const cP = Math.cos(phiRef.current), sP = Math.sin(phiRef.current);
            /* scale y offset del shader:
             *   b = ((frag/t)*2 - 1)/scale - offset*(1,-1)/t   ...  b.x *= t.x/t.y
             * Despejando la posición de pantalla queda el radio multiplicado por
             * `scale`, y el offset entra a la mitad. El offset viene en píxeles de
             * dispositivo (como lo toma cobe), por eso se divide por dpr. */
            const S = VISTA.scale;
            const R = S * 0.4 * alto;
            const cx = ancho / 2 + (S * VISTA.offset[0]) / (2 * dpr);
            const cy = alto / 2 + (S * VISTA.offset[1]) / (2 * dpr);
            const rad = Math.PI / 180;

            /* Proyecta lat/lon a pantalla. Derivado del shader de cobe 0.6.3:
             *   m = (cos(lat)cos(lon), sin(lat), -cos(lat)sin(lon))
             *   ray = m · Mᵀ   (el shader rota el RAYO, no el marcador) */
            const proy = (la, lo) => {
              const ca = Math.cos(la * rad);
              const mx = ca * Math.cos(lo * rad);
              const my = Math.sin(la * rad);
              const mz = -ca * Math.sin(lo * rad);
              const rx = mx * cP + mz * sP;
              const ry = mx * (sP * sT) + my * cT + mz * (-cP * sT);
              const rz = mx * (-sP * cT) + my * sT + mz * (cP * cT);
              return { x: cx + R * rx, y: cy - R * ry, visible: rz > 0.05 };
            };

            // La central: es el destino de todas las líneas.
            const casa = proy(HOME[0], HOME[1]);

            flagRefs.current.forEach((el) => {
              if (!el) return;
              const [la, lo] = el.dataset.ll.split(',').map(Number);
              const q = proy(la, lo);

              // La bandera va JUSTO encima de su punto, apenas despegada.
              el.style.opacity = q.visible ? '1' : '0';
              el.style.transform = `translate(-50%,-100%) translate(${q.x}px, ${q.y - 9}px)`;

              /* La línea va del país atacante HACIA LA CENTRAL (Uruguay): es lo que
               * cuenta el ataque. Arco suave — la curvatura es una fracción chica de
               * la distancia, así rebota apenas en vez de dispararse hacia arriba. */
              const ln = lineRefs.current.get(el.dataset.cc);
              const pl = pulseRefs.current.get(el.dataset.cc);
              if (ln || pl) {
                const juntos = q.visible && casa.visible;
                if (ln) ln.style.opacity = juntos ? '1' : '0';
                if (pl) pl.style.opacity = juntos ? '1' : '0';
                if (juntos) {
                  const dx = casa.x - q.x, dy = casa.y - q.y;
                  const dist = Math.hypot(dx, dy) || 1;
                  // perpendicular, elegida hacia afuera del centro del globo
                  let nx = -dy / dist, ny = dx / dist;
                  const mx2 = (q.x + casa.x) / 2, my2 = (q.y + casa.y) / 2;
                  if (nx * (mx2 - cx) + ny * (my2 - cy) < 0) { nx = -nx; ny = -ny; }
                  const comba = dist * 0.16;          // rebote suave, no un arco alto
                  // Un solo trazado para los dos paths: la línea y el pulso que la recorre
                  // tienen que ser exactamente la misma curva o el pulso se despega.
                  const trazo = `M ${q.x} ${q.y} Q ${mx2 + nx * comba} ${my2 + ny * comba} ${casa.x} ${casa.y}`;
                  if (ln) ln.setAttribute('d', trazo);
                  if (pl) pl.setAttribute('d', trazo);
                }
              }
            });
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
    /* Panel, planeta y textos siguen el tema. El planeta cambia con el `dark` de
       cobe, no con el fondo: por eso en claro puede ir panel claro sin perder la
       esfera. */
    <div className="pbx-fade-in" style={{
      position: 'relative', width: '100%', height: '100%', minHeight: 400, borderRadius: 14, overflow: 'hidden',
      background: TEMA.fondo, border: TEMA.borde, boxShadow: TEMA.sombra,
    }}>
      {/* `global`, no scoped: estas animaciones se aplican desde `style` en línea, y
          styled-jsx le cambia el nombre a los @keyframes de un bloque scoped — la
          referencia inline queda apuntando a un nombre que ya no existe y la animación
          no corre nunca. Por eso el latido del badge "en vivo" no se movía. */}
      <style jsx global>{`
        @keyframes agLive { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
        @keyframes agIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
        @keyframes agGolpe { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.35); } }
        /* El tramo recorre el arco del país atacante hacia Uruguay. El patrón de guiones
           mide 100 (= pathLength), así que un ciclo entero de dashoffset 100→0 lleva el
           trazo del principio al final de la curva exactamente una vez. */
        @keyframes agViaje { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
        @keyframes agLatido { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
      `}</style>

      <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={soltar} onPointerLeave={soltar}
          style={{ width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }}
        />
      </div>

      {/* Etiquetas AFUERA del globo, unidas al punto por una línea fina (el estilo
          del globo de Vercel). Quedan más legibles que pegadas encima y no tapan el
          planeta. Las líneas van en un SVG y las etiquetas son divs: las dos cosas
          se mueven desde onRender, en cada frame, siguiendo la rotación. */}
      <svg style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', overflow: 'visible' }}>
        {/* Filtro de brillo: sólo se usa cuando hay ataque, para que la línea roja
            queme un poco y se despegue del planeta. En reposo no se aplica (cuesta
            GPU en cada frame y no aporta nada). */}
        <defs>
          <filter id="agBrasa" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {pts.map((p) => {
          /* Tres niveles de intensidad, no dos:
           *   reposo        gris fino, pulso apenas insinuado — el mapa respira.
           *   bajo ataque   TODAS las líneas en rojo, más gruesas, pulso rápido.
           *   el culpable   la línea del país de la IP más insistente: la más gruesa,
           *                 la más rápida y con brillo, para que el ojo caiga ahí. */
          const culpable = bajoAtaque && String(p.cc || '').toUpperCase() === ccOrigen;
          const color = culpable ? '#ff3b30' : bajoAtaque ? 'rgba(240,68,56,.75)'
            : (dark ? 'rgba(200,215,240,.55)' : 'rgba(15,23,42,.45)');
          const grosor = culpable ? 2.4 : bajoAtaque ? 1.5 : 1;
          const seg = culpable ? 1.6 : bajoAtaque ? 1.4 : 1;  // duración del viaje, en segundos
          return (
            <g key={'arc-' + p.cc}>
              <path
                ref={(el) => { if (el) lineRefs.current.set(p.cc, el); else lineRefs.current.delete(p.cc); }}
                fill="none" stroke={color} strokeWidth={grosor}
                filter={culpable ? 'url(#agBrasa)' : undefined}
                style={{
                  opacity: 0,
                  transition: 'opacity .25s, stroke .4s, stroke-width .4s',
                  animation: bajoAtaque ? `agLatido ${seg * 1.5}s ease-in-out infinite` : undefined,
                }}
              />
              {/* El proyectil: un tramo corto que recorre la curva de origen a Uruguay.
                  pathLength="100" normaliza el largo del arco, así el dash mide lo mismo
                  en una línea corta que en una que cruza medio planeta, y la velocidad
                  se ve pareja aunque la curva cambie de tamaño al girar el globo. */}
              <path
                ref={(el) => { if (el) pulseRefs.current.set(p.cc, el); else pulseRefs.current.delete(p.cc); }}
                fill="none" stroke={culpable ? '#fff' : color}
                strokeWidth={grosor + (bajoAtaque ? 1 : 0.4)} strokeLinecap="round"
                pathLength="100" strokeDasharray={bajoAtaque ? '14 86' : '8 92'}
                filter={culpable ? 'url(#agBrasa)' : undefined}
                style={{
                  opacity: 0, transition: 'opacity .25s',
                  animation: `agViaje ${seg}s linear infinite`,
                }}
              />
            </g>
          );
        })}
      </svg>

      {pts.map((p) => {
        const esOrigen = origen && String(origen.cc || '').toUpperCase() === String(p.cc).toUpperCase();
        return (
          <div
            key={'fl-' + p.cc}
            ref={(el) => { if (el) flagRefs.current.set(p.cc, el); else flagRefs.current.delete(p.cc); }}
            data-ll={`${p.lat},${p.lon}`}
            data-cc={p.cc}
            style={{
              position: 'absolute', left: 0, top: 0, zIndex: 3, pointerEvents: 'none',
              display: 'flex', alignItems: 'center', gap: 5, padding: '2px 6px', borderRadius: 5,
              background: esOrigen ? '#e5342a' : (dark ? 'rgba(12,20,34,.92)' : 'rgba(15,23,42,.92)'),
              boxShadow: esOrigen ? '0 0 10px rgba(229,52,42,.6)' : '0 1px 4px rgba(0,0,0,.25)',
              whiteSpace: 'nowrap', opacity: 0, transition: 'opacity .25s',
              animation: esOrigen ? 'agGolpe 1s ease-in-out infinite' : undefined,
            }}>
            <img src={flagUrl(p.cc)} alt="" width={14} height={10} style={{ borderRadius: 1, objectFit: 'cover', display: 'block' }} />
            <span style={{ fontSize: 9.5, fontWeight: 600, color: '#fff', letterSpacing: .2,
                           fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
              {String(p.cc).toUpperCase()} · {p.n || 1}
            </span>
          </div>
        );
      })}

      {/* título + estado en vivo */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '10px 12px', zIndex: 4,
                    background: TEMA.velo, pointerEvents: 'none' }}>
        <Group gap={9} wrap="nowrap">
          <IconWorldBolt size={17} color="#ff6a5e" style={{ filter: 'drop-shadow(0 0 6px rgba(240,68,56,.6))' }} />
          <Text fw={700} c={TEMA.txt} style={{ textShadow: TEMA.txtSombra, fontSize: 13.5 }}>{titulo}</Text>
          <Badge size="sm" variant="filled" color="red" ml="auto" style={{ pointerEvents: 'auto' }}
            leftSection={<span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#fff', animation: 'agLive 1.4s ease-in-out infinite' }} />}>
            {pts.length} orígenes
          </Badge>
        </Group>
      </div>

      {/* Ataque en curso: el aviso vive acá, en el mapa, y no como franja arriba de
          la página. La bandera del país que golpea ya pulsa sobre su punto. */}
      {atacando && (
        <div style={{ position: 'absolute', top: 34, left: 12, zIndex: 6, display: 'flex', alignItems: 'center', gap: 7,
          padding: '4px 9px', borderRadius: 9, background: 'rgba(240,68,56,.94)',
          border: '1px solid rgba(255,255,255,.35)', boxShadow: '0 0 16px rgba(240,68,56,.55)',
          animation: 'agGolpe 1.2s ease-in-out infinite' }}>
          {origen && origen.cc && <img src={flagUrl(origen.cc)} alt="" width={17} height={12} style={{ borderRadius: 2, objectFit: 'cover' }} />}
          <div style={{ lineHeight: 1.15 }}>
            <Text style={{ fontSize: 10, fontWeight: 800, color: '#fff', letterSpacing: .4 }}>BAJO ATAQUE</Text>
            <Text style={{ fontSize: 9, color: 'rgba(255,255,255,.9)', whiteSpace: 'nowrap' }}>
              {atacando.golpes_min}/min · {atacando.top_ip || (atacando.ips + ' IPs')}
            </Text>
          </div>
        </div>
      )}

      {/* KPIs verticales */}
      <div style={{ position: 'absolute', top: 44, right: 10, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 4, width: 108 }}>
        {KPIS.map((it) => {
          const Ic = it.Icon;
          return (
            <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 7px', borderRadius: 8,
              background: TEMA.chip, border: TEMA.chipBorde, backdropFilter: 'blur(3px)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 19, height: 19, borderRadius: 6, background: `${it.color}22`, flex: '0 0 19px' }}>
                <Ic size={11} color={it.color} />
              </div>
              <div style={{ lineHeight: 1.1, minWidth: 0 }}>
                <Text fw={800} c={TEMA.txt} style={{ fontSize: 12.5, lineHeight: 1.15 }}>{it.value}</Text>
                <Text c={TEMA.txt2} style={{ fontSize: 7.5, textTransform: 'uppercase', letterSpacing: .2, whiteSpace: 'nowrap' }}>{it.label}</Text>
              </div>
            </div>
          );
        })}
      </div>

      {/* Sin feed encima del globo: los intentos ya se listan completos abajo
          ("De dónde vienen los ataques" y "Los más insistentes"). Taparle el planeta
          para repetir esa info era ruido. */}

      {/* leyenda del filtro por país */}
      {geoPts.length > 0 && (
        <div style={{ position: 'absolute', bottom: 10, right: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 7,
          padding: '4px 10px', borderRadius: 9, background: TEMA.chip, border: TEMA.chipBorde, backdropFilter: 'blur(3px)' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: geoHex, boxShadow: `0 0 7px ${geoHex}`, flex: '0 0 9px' }} />
          <Text style={{ fontSize: 11, color: TEMA.txt, whiteSpace: 'nowrap' }}>
            {geoPts.length} {modoGeo === 'permitir' ? 'permitidos' : 'vetados'}
          </Text>
        </div>
      )}

      {pts.length === 0 && (
        <Group justify="center" style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}>
          <Text size="sm" c={TEMA.txt2}>{geoPts.length > 0 ? 'Sin ataques en curso.' : 'Sin ataques localizados todavía.'}</Text>
        </Group>
      )}
    </div>
  );
}
