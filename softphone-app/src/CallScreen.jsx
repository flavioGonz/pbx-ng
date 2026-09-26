import React, { useEffect, useRef, useState } from 'react';

/* ============================================================================
 *  Softphone-NG · La pantalla de llamada.
 *
 *  UNA PANTALLA, SEIS ESTADOS, Y TRANSICIONES ENTRE ELLOS: entrante, marcando,
 *  hablando, en espera, transfiriendo y terminada. Antes cada estado era un bloque
 *  distinto que aparecía y desaparecía de golpe; acá el avatar, el nombre y la barra de
 *  abajo son los MISMOS elementos y lo que cambia es su contenido. Eso es lo que hace que
 *  se sienta una app y no una sucesión de pantallas.
 *
 *  POR QUÉ IMPORTA MÁS DE LO QUE PARECE: quien atiende un portero mira esta pantalla
 *  cincuenta veces por día. Un cambio de estado que salta —o peor, que no se nota— es la
 *  diferencia entre saber si el otro ya atendió o seguís escuchando el tono.
 *
 *  REGLAS DE LAS ANIMACIONES, que valen para todo el archivo:
 *   · el movimiento SIEMPRE dice algo: los anillos laten mientras timbra, las barras se
 *     mueven con el audio real del otro lado, el reloj sólo corre cuando hay llamada;
 *   · nada tarda más de 400 ms: esto es una herramienta de trabajo, no una intro;
 *   · todo se apaga con `prefers-reduced-motion`, y ningún estado se comunica SÓLO con
 *     movimiento — siempre hay además una palabra.
 *
 *  Es una pantalla oscura a propósito, aunque el resto de la app sea clara: en una llamada
 *  la atención tiene que estar en una cosa sola.
 * ==========================================================================*/

/* ── Paleta ───────────────────────────────────────────────────────────────── */
export const T = {
  /* Los valores salieron de medir las capturas del teléfono que ya usa el cliente: el
   * fondo, la barra y el rojo de cortar son los mismos, para que las dos aplicaciones se
   * sientan la misma familia y nadie tenga que reaprender dónde está cada cosa. */
  fondo: '#1f2229',
  barra: '#31333a',
  linea: '#4d4e54',
  texto: '#e9ebee',
  suave: '#c6cad0',
  tenue: '#8d929a',
  avatarTxt: '#33404f',
  rojo: '#eb4c46',        // el botón «Terminar» de la barra
  rojoTimbre: '#ff3f00',  // el redondo de cortar mientras timbra: más naranja, más grande
  verde: '#2bd95a',
  azul: '#4c9aff',
  ambar: '#f0b429',
};

/* El color del avatar sale del nombre, como en la agenda del teléfono: así el mismo
 * contacto es siempre del mismo color y se reconoce antes de leer. */
const PASTELES = ['#d9d7ef', '#c6ddf2', '#d5ecd7', '#f2dcc6', '#efd7e4', '#d7e9ef', '#e4e2c6'];
export function colorAvatar(txt) {
  const s = String(txt || '');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PASTELES[h % PASTELES.length];
}

/* ── Iconos, en SVG propio ─────────────────────────────────────────────────
 * Van acá y no de una librería porque varios se ANIMAN por dentro (el auricular que
 * tiembla, las barras que laten, el micrófono tachado). Un icono de librería obliga a
 * animar el contenedor, y eso se nota: se mueve la caja, no el dibujo. */
const svg = (s, extra) => ({ width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', ...extra });

export const IcTel = ({ s = 22 }) => (
  <svg {...svg(s)}><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.2.2 2.4.57 3.5a1 1 0 0 1-.25 1z" /></svg>
);
export const IcTelCortar = ({ s = 22 }) => (
  /* El mismo auricular, rotado: colgar es la misma acción al revés. */
  <svg {...svg(s)} style={{ transform: 'rotate(134deg)' }}><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.2.2 2.4.57 3.5a1 1 0 0 1-.25 1z" /></svg>
);
export const IcMic = ({ s = 22, off }) => (
  <svg {...svg(s)}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><line x1="12" y1="17.5" x2="12" y2="21" />
    {off && <line x1="4" y1="3.4" x2="20" y2="20.6" style={{ stroke: T.rojo, strokeWidth: 2.1 }} />}
  </svg>
);
export const IcCam = ({ s = 22, off }) => (
  <svg {...svg(s)}>
    <rect x="2.5" y="6.5" width="13" height="11" rx="2.5" /><path d="M15.5 10.5 21.5 7.5v9l-6-3z" />
    {off && <line x1="3.4" y1="4.4" x2="20.6" y2="19.6" style={{ stroke: T.rojo, strokeWidth: 2.1 }} />}
  </svg>
);
export const IcPausa = ({ s = 22 }) => (<svg {...svg(s)}><rect x="7" y="4.5" width="3.4" height="15" rx="1.2" fill="currentColor" stroke="none" /><rect x="13.6" y="4.5" width="3.4" height="15" rx="1.2" fill="currentColor" stroke="none" /></svg>);
export const IcPlay = ({ s = 22 }) => (<svg {...svg(s)}><path d="M7 4.6 19 12 7 19.4z" fill="currentColor" stroke="none" /></svg>);
export const IcTeclado = ({ s = 22 }) => (
  <svg {...svg(s)}>{[0, 1, 2].map(f => [0, 1, 2].map(c => <circle key={f + '-' + c} cx={6 + c * 6} cy={6 + f * 6} r="1.55" fill="currentColor" stroke="none" />))}</svg>
);
export const IcMas = ({ s = 22 }) => (<svg {...svg(s)}>{[6, 12, 18].map(x => <circle key={x} cx={x} cy="12" r="1.7" fill="currentColor" stroke="none" />)}</svg>);
export const IcSwap = ({ s = 22 }) => (<svg {...svg(s)}><path d="M4 8h13l-3.2-3.2M20 16H7l3.2 3.2" /></svg>);
export const IcRec = ({ s = 22 }) => (<svg {...svg(s)}><circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none" /></svg>);
export const IcAlta = ({ s = 22 }) => (<svg {...svg(s)}><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M16 9.2a4 4 0 0 1 0 5.6" /><path d="M18.6 6.6a7.6 7.6 0 0 1 0 10.8" /></svg>);
export const IcMasPersona = ({ s = 22 }) => (<svg {...svg(s)}><circle cx="10" cy="8.5" r="3.6" /><path d="M3.5 20a6.6 6.6 0 0 1 13 0" /><line x1="19" y1="7" x2="19" y2="13" /><line x1="16" y1="10" x2="22" y2="10" /></svg>);
const IcChevron = ({ s = 12 }) => (<svg {...svg(s, { strokeWidth: 2.4 })}><path d="M6 15l6-6 6 6" /></svg>);

/* ── Señal de calidad: cuatro barras que suben ─────────────────────────────── */
function Senal({ score = 0 }) {
  const color = score >= 3 ? T.verde : score === 2 ? T.ambar : score >= 1 ? T.rojo : T.tenue;
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden>
      {[0, 1, 2, 3].map(i => (
        <rect key={i} x={i * 4} y={11 - i * 3} width="2.6" height={3 + i * 3} rx="1"
          fill={i < score ? color : 'rgba(255,255,255,.16)'} />
      ))}
    </svg>
  );
}

/* ── Reloj de la llamada ───────────────────────────────────────────────────── */
export function Reloj({ desde, className }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!desde) return undefined;
    const tic = () => setT(Math.max(0, Math.floor((Date.now() - desde) / 1000)));
    tic(); const id = setInterval(tic, 1000); return () => clearInterval(id);
  }, [desde]);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const dd = (n) => String(n).padStart(2, '0');
  return <span className={className} style={{ fontVariantNumeric: 'tabular-nums' }}>{dd(hh)}:{dd(mm)}:{dd(ss)}</span>;
}

/* ── Avatar ───────────────────────────────────────────────────────────────
 * Un círculo liso con las iniciales: nada de sombras ni degradés. Es a propósito —el
 * teléfono que usa el cliente lo dibuja así, y en una pantalla que se mira cincuenta
 * veces por día lo plano cansa menos que lo brillante. */
function Avatar({ txt, size = 120, entra }) {
  return (
    <div className={'cs-avatar' + (entra ? ' cs-avatar-in' : '')}
      style={{
        width: size, height: size, borderRadius: '50%', background: colorAvatar(txt),
        color: T.avatarTxt, display: 'grid', placeItems: 'center', userSelect: 'none',
        fontSize: Math.round(size * 0.285), fontWeight: 400, letterSpacing: 0.5,
      }}>
      {txt}
    </div>
  );
}

/* ── Onda del audio REAL del otro lado ─────────────────────────────────────
 * Es la diferencia entre una animación decorativa y una que informa: si las barras no se
 * mueven mientras el otro habla, hay un problema de audio y se ve sin abrir nada. */
function Onda({ getStream, activa, ancho = 600, alto = 72, barras = 48 }) {
  const ref = useRef(null);
  const datos = useRef(new Array(barras).fill(0.06));
  useEffect(() => {
    if (!activa || !getStream) return undefined;
    let ctx = null, anal = null, raf = 0, parado = false;
    try {
      const st = getStream(); if (!st) return undefined;
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(st);
      anal = ctx.createAnalyser(); anal.fftSize = 256; anal.smoothingTimeConstant = 0.75;
      src.connect(anal);
      const buf = new Uint8Array(anal.frequencyBinCount);
      const paso = Math.max(1, Math.floor(buf.length / barras));
      const pintar = () => {
        if (parado) return;
        anal.getByteFrequencyData(buf);
        const el = ref.current;
        if (el) {
          for (let i = 0; i < barras; i++) {
            let suma = 0; for (let k = 0; k < paso; k++) suma += buf[i * paso + k] || 0;
            const v = Math.min(1, (suma / paso) / 190);
            /* Suavizado: sin esto las barras tiemblan como estática y cansa mirarlas. */
            datos.current[i] = datos.current[i] * 0.62 + Math.max(0.06, v) * 0.38;
          }
          const mitad = alto / 2;
          const d = datos.current.map((v, i) => {
            const x = (i / (barras - 1)) * ancho;
            /* Las puntas se aplanan: la onda nace y muere en la línea, como en un editor. */
            const borde = Math.sin((i / (barras - 1)) * Math.PI);
            return `${i ? 'L' : 'M'}${x.toFixed(1)},${(mitad - v * borde * mitad * 0.92).toFixed(1)}`;
          }).join(' ');
          const d2 = datos.current.map((v, i) => {
            const x = (ancho) - (i / (barras - 1)) * ancho;
            const j = barras - 1 - i;
            const borde = Math.sin((j / (barras - 1)) * Math.PI);
            return `L${x.toFixed(1)},${(mitad + datos.current[j] * borde * mitad * 0.92).toFixed(1)}`;
          }).join(' ');
          el.setAttribute('d', d + ' ' + d2 + ' Z');
        }
        raf = requestAnimationFrame(pintar);
      };
      pintar();
    } catch (_) { /* sin audio: queda la línea quieta, que ya dice algo */ }
    return () => { parado = true; cancelAnimationFrame(raf); try { ctx && ctx.close(); } catch (_) {} };
  }, [activa, getStream, ancho, alto, barras]);

  return (
    <svg width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} aria-hidden style={{ maxWidth: '100%' }}>
      <defs>
        <linearGradient id="cs-onda" x1="0" x2="1">
          <stop offset="0" stopColor="rgba(255,255,255,.10)" />
          <stop offset=".5" stopColor="rgba(190,215,255,.85)" />
          <stop offset="1" stopColor="rgba(255,255,255,.10)" />
        </linearGradient>
      </defs>
      <path ref={ref} d={`M0,${alto / 2} L${ancho},${alto / 2} Z`} fill="url(#cs-onda)" stroke="none" />
    </svg>
  );
}

/* Mientras timbra no hay audio que mostrar: una onda en reposo, respirando. */
function OndaReposo({ ancho = 600, alto = 72 }) {
  const mitad = alto / 2;
  const curva = (amp, fase) => {
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const x = (i / 60) * ancho;
      const borde = Math.sin((i / 60) * Math.PI);
      pts.push(`${i ? 'L' : 'M'}${x.toFixed(1)},${(mitad + Math.sin((i / 60) * Math.PI * 4 + fase) * amp * borde).toFixed(1)}`);
    }
    return pts.join(' ');
  };
  return (
    <svg width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} aria-hidden style={{ maxWidth: '100%' }}>
      {[0, 1, 2, 3].map(i => (
        <path key={i} className="cs-reposo" style={{ animationDelay: (i * 0.35) + 's' }}
          d={curva(8 + i * 3.5, i * 0.8)} fill="none" stroke="rgba(198,210,225,.34)" strokeWidth={1} />
      ))}
    </svg>
  );
}

/* ── Un botón de la barra de abajo ─────────────────────────────────────────── */
function Ctl({ icon, label, on, apagado, onClick, caret, onCaret, deshabilitado }) {
  return (
    <div className="cs-ctl-caja" style={{ opacity: deshabilitado ? 0.4 : 1 }}>
      <div className="cs-ctl-fila">
        <button className="cs-ctl" onClick={deshabilitado ? undefined : onClick} disabled={deshabilitado} title={label}
          style={{ color: on ? T.azul : T.texto }}>
          {icon}
        </button>
        {caret && (
          <button className="cs-caret" onClick={onCaret} title={'Elegir ' + label.toLowerCase()} style={{ color: T.suave }}>
            <IcChevron />
          </button>
        )}
      </div>
      {/* La etiqueta NO cambia de color al apagar: lo que cambia es el icono (la raya
          roja). Si cambiaran los dos, el ojo no sabe cuál de los dos mirar. */}
      <span className="cs-ctl-lab" style={{ color: on ? T.azul : T.suave }}>{label}</span>
    </div>
  );
}

/* ── Teclado, que entra y sale desde abajo ─────────────────────────────────── */
function Teclado({ abierto, onTecla }) {
  const [montado, setMontado] = useState(abierto);
  useEffect(() => {
    if (abierto) { setMontado(true); return undefined; }
    /* Se desmonta DESPUÉS de la animación de salida: si se desmontara al instante, el
     * teclado desaparecería de golpe y la salida no existiría. */
    const t = setTimeout(() => setMontado(false), 220);
    return () => clearTimeout(t);
  }, [abierto]);
  if (!montado) return null;
  return (
    <div className={abierto ? 'cs-pad cs-pad-in' : 'cs-pad cs-pad-out'}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k, i) => (
        <button key={k} className="cs-tecla" style={{ animationDelay: (i * 18) + 'ms' }} onClick={() => onTecla(k)}>
          <span>{k}</span>
          <em>{({ 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ', 0: '+' })[k] || ' '}</em>
        </button>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 *  La pantalla
 * ══════════════════════════════════════════════════════════════════════════ */
export default function CallScreen(p) {
  const {
    estado,              // 'entrante' | 'marcando' | 'hablando' | 'espera' | 'terminada'
    titulo, subtitulo, iniciales, nota,
    desde,               // marca de tiempo del inicio, para el reloj
    calidad,             // 0..4
    viaTurn,             // true | false | null
    video,               // hay video activo
    getRemoteStream,
    acciones = {},       // { colgar, atender, atenderVideo, rechazar, mute, hold, video, teclado, transferir, grabar, altavoz, invitar, elegirMic, elegirCam }
    flags = {},          // { muted, held, videoOn, grabando, altavoz, pad, transfiriendo }
    extra = null,        // barras de estado (consulta en curso, conferencia, CRM…)
    ventana = null,      // controles de ventana del sistema
  } = p;

  const timbrando = estado === 'entrante' || estado === 'marcando';
  const hablando = estado === 'hablando';

  /* La transición entre estados: se anima el bloque del medio cada vez que cambia. No es
   * un fade genérico — cada estado entra con su gesto (el entrante «rebota», hablando
   * «asienta», terminada «se apaga»), y eso hace que el cambio se note sin mirarlo. */
  const [gesto, setGesto] = useState('cs-entra');
  const antes = useRef(estado);
  useEffect(() => {
    if (antes.current === estado) return;
    antes.current = estado;
    setGesto('');
    const id = requestAnimationFrame(() => setGesto(
      estado === 'terminada' ? 'cs-apaga' : estado === 'hablando' ? 'cs-asienta' : 'cs-entra'));
    return () => cancelAnimationFrame(id);
  }, [estado]);

  /* «Carlos (1008)» en un solo renglón, como en el teléfono del cliente. En la pantalla
   * de llamada terminada el subtítulo ya no es el interno sino la duración, y esa va
   * debajo: meterla entre paréntesis al lado del nombre se leía como otro número. */
  const nombre = subtitulo && estado !== 'terminada' ? titulo + ' (' + subtitulo + ')' : titulo;
  const leyenda = estado === 'entrante' ? (video ? 'Videollamada entrante' : 'Llamada entrante')
    : estado === 'marcando' ? (nota || 'Timbrando')
      : estado === 'espera' ? 'En espera'
        : estado === 'terminada' ? 'Llamada finalizada'
          : '';
  /* Mientras timbra no hay barra de abajo: sólo el redondo de cortar, como en el teléfono
   * del cliente. Poner ahí los cinco controles seria ofrecer cosas que todavía no existen
   * —no se puede poner en espera una llamada que nadie atendió. */
  const conBarra = estado === 'hablando' || estado === 'espera';

  return (
    <div className={'cs-raiz' + (flags.pad ? ' cs-con-pad' : '') + (conBarra ? '' : ' cs-sin-barra')}
      style={{ background: T.fondo, color: T.texto }}>
      {/* Barra de arrastre de la ventana: en Electron, sin esto la ventana no se mueve. */}
      <div className="cs-drag" />
      {ventana ? <div style={{ position: 'absolute', top: 6, right: 8, zIndex: 8 }}>{ventana}</div> : null}

      {video ? p.videoNodes : null}

      <div className={'cs-centro ' + gesto} key={estado === 'hablando' ? 'hablando' : estado}>
        {!video && <Avatar txt={iniciales} entra={timbrando} />}

        <div className="cs-nombre">{nombre}</div>
        {leyenda ? (
          <div className="cs-estado">
            {leyenda}
            {estado === 'marcando' ? <span className="cs-puntos"><i /><i /><i /></span> : null}
          </div>
        ) : null}

        {/* La onda vive mientras timbra: es lo único que se mueve en esa pantalla y dice
            «esto sigue vivo». Con la llamada en curso quien informa es el reloj. */}
        {!video && timbrando && (
          <div className="cs-onda"><OndaReposo /></div>
        )}
        {!video && hablando && getRemoteStream && (
          <div className="cs-onda cs-onda-viva"><Onda getStream={getRemoteStream} activa /></div>
        )}

        {/* Los redondos de timbrado, debajo de la onda y centrados. */}
        {estado === 'marcando' && (
          <div className="cs-redondos">
            <button className="cs-red cs-red-cortar" onClick={acciones.colgar} title="Cortar"><IcTelCortar s={24} /></button>
          </div>
        )}
        {estado === 'entrante' && (
          <div className="cs-redondos">
            <button className="cs-red cs-red-cortar" onClick={acciones.rechazar} title="Rechazar"><IcTelCortar s={24} /></button>
            {acciones.atenderVideo ? (
              <button className="cs-red cs-red-video" onClick={acciones.atenderVideo} title="Atender con video"><IcCam s={24} /></button>
            ) : null}
            <button className="cs-red cs-red-atender" onClick={acciones.atender} title="Atender"><IcTel s={24} /></button>
          </div>
        )}

        {estado === 'terminada' && subtitulo ? <div className="cs-dur">{subtitulo}</div> : null}

        {extra}
      </div>

      <Teclado abierto={!!flags.pad} onTecla={acciones.tecla || (() => {})} />

      {/* ── Barra inferior ───────────────────────────────────────────────── */}
      {conBarra && (
        <div className="cs-barra" style={{ background: T.barra }}>
          <div className="cs-barra-izq">
            <span title={calidad >= 3 ? 'Audio estable' : calidad >= 1 ? 'Audio con pérdidas' : 'Sin datos de calidad'}>
              <Senal score={calidad || 0} />
            </span>
            {desde ? <Reloj desde={desde} /> : <span style={{ color: T.tenue }}>00:00:00</span>}
            {viaTurn != null && desde ? (
              <span className="cs-via" title={viaTurn ? 'El audio pasa por el servidor TURN' : 'El audio va directo entre los dos extremos'}>
                {viaTurn ? 'TURN' : 'directo'}
              </span>
            ) : null}
          </div>

          <div className="cs-barra-centro">
            <Ctl icon={<IcMic s={22} off={flags.muted} />} label="Micrófono" apagado={flags.muted} onClick={acciones.mute}
              caret={!!acciones.elegirMic} onCaret={acciones.elegirMic} />
            {acciones.video ? (
              <Ctl icon={<IcCam s={22} off={!flags.videoOn} />} label="Cámara web" apagado={!flags.videoOn} onClick={acciones.video}
                caret={!!acciones.elegirCam} onCaret={acciones.elegirCam} />
            ) : null}
            {/* La misma raya que separa «lo mío» (micrófono, cámara) de «la llamada». */}
            <span className="cs-sep" />
            {acciones.hold ? (
              <Ctl icon={flags.held ? <IcPlay s={22} /> : <IcPausa s={22} />} label={flags.held ? 'Reanudar' : 'En espera'}
                on={flags.held} onClick={acciones.hold} />
            ) : null}
            <Ctl icon={<IcTeclado s={22} />} label="Teclado" on={flags.pad} onClick={acciones.teclado} />
            <Ctl icon={<IcMas s={22} />} label="Más" on={flags.masAbierto} onClick={acciones.mas} />
          </div>

          <div className="cs-barra-der">
            <button className="cs-terminar" onClick={acciones.colgar} title="Terminar la llamada">
              <span className="cs-terminar-caja"><IcTelCortar s={20} /></span>
              <span>Terminar</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
