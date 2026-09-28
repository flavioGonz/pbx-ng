import React, { useEffect, useRef, useState } from 'react';
import CallScreen from './CallScreen';

/* Un video de mentira para poder mirar la videollamada sin levantar una: un lienzo que se
 * mueve, convertido en pista de video. Es lo único honesto que se puede hacer sin cámara y
 * sin alguien del otro lado. */
function streamFalso(texto, tono) {
  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360;
  const ctx = cv.getContext('2d');
  let t = 0;
  setInterval(() => {
    t += 0.03;
    const g = ctx.createLinearGradient(0, 0, 640, 360);
    g.addColorStop(0, 'hsl(' + ((tono + Math.sin(t) * 20 + 360) % 360) + ',45%,32%)');
    g.addColorStop(1, 'hsl(' + ((tono + 60 + Math.cos(t * 0.7) * 20 + 360) % 360) + ',45%,18%)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = '600 34px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(texto, 320, 190);
    ctx.beginPath(); ctx.arc(320 + Math.sin(t) * 120, 280, 16, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fill();
  }, 40);
  return cv.captureStream(25);
}

/* Una voz de mentira para poder VER si el orbe reacciona: un tono cuya intensidad sube y
 * baja como una frase hablada. Sin esto, la reacción al audio sólo se puede juzgar
 * llamando a alguien y pidiéndole que hable, que es exactamente lo que esta vista evita. */
function vozFalsa() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dst = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 160;
    const g = ctx.createGain(); g.gain.value = 0;
    osc.connect(g); g.connect(dst); osc.start();
    /* Sílabas: golpes de 90 ms con silencios irregulares, no una onda constante. */
    let t = 0;
    setInterval(() => {
      t += 1;
      const habla = (t % 11) < 7;
      const v = habla ? 0.25 + Math.abs(Math.sin(t * 1.7)) * 0.7 : 0;
      try { g.gain.setTargetAtTime(v, ctx.currentTime, 0.04); } catch (_) {}
    }, 90);
    return dst.stream;
  } catch (_) { return null; }
}

/* ============================================================================
 *  Vista de prueba de la pantalla de llamada (`?demo=call`).
 *
 *  Existe para poder MIRAR los cinco estados y sus transiciones sin levantar una llamada
 *  real: probar un cambio de animación marcando a alguien es carísimo en tiempo y encima
 *  depende de que del otro lado alguien atienda. No se incluye en el menú ni en ninguna
 *  ruta: se llega sólo con el parámetro, y no molesta a nadie.
 * ==========================================================================*/
const PASOS = [
  { estado: 'entrante', corto: 'Entra', desc: 'Entra una llamada' },
  { estado: 'marcando', corto: 'Marca', desc: 'Estamos llamando' },
  { estado: 'hablando', corto: 'Habla', desc: 'Conversación' },
  { estado: 'espera', corto: 'Espera', desc: 'En espera' },
  { estado: 'terminada', corto: 'Fin', desc: 'Terminó' },
  { estado: 'hablando', corto: 'Video', desc: 'Videollamada', video: true },
];

export default function DemoLlamada() {
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  const [pad, setPad] = useState(false);
  const [mas, setMas] = useState(false);
  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(() => setI(x => (x + 1) % PASOS.length), 2600);
    return () => clearInterval(t);
  }, [auto]);
  const paso = PASOS[i];
  /* Las dos pistas falsas se arman una sola vez: si se rehicieran en cada render, el video
   * parpadearía y no se podría juzgar nada. */
  const falsos = useRef(null);
  if (!falsos.current && typeof document !== 'undefined') {
    falsos.current = { remoto: streamFalso('EL OTRO LADO', 210), yo: streamFalso('VOS', 140), voz: vozFalsa() };
  }
  const nodos = paso.video ? {
    remoto: <video autoPlay playsInline muted className="cs-video-remoto" ref={el => { if (el && falsos.current && el.srcObject !== falsos.current.remoto) { el.srcObject = falsos.current.remoto; el.play().catch(() => {}); } }} />,
    yo: <video autoPlay playsInline muted className="cs-video-yo" ref={el => { if (el && falsos.current && el.srcObject !== falsos.current.yo) { el.srcObject = falsos.current.yo; el.play().catch(() => {}); } }} />,
  } : null;
  const desde = paso.estado === 'hablando' || paso.estado === 'espera' ? Date.now() - 134000 : 0;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <CallScreen
        estado={paso.estado}
        titulo={paso.estado === 'entrante' ? 'Carlos' : 'Carlos'}
        subtitulo="1008"
        iniciales="CA"
        desde={paso.video ? Date.now() - 74000 : desde}
        calidad={3}
        video={!!paso.video}
        videoNodes={nodos}
        getRemoteStream={paso.video ? (() => falsos.current && falsos.current.remoto) : null}
        getAudioStream={() => (falsos.current && falsos.current.voz) || null}
        menuMas={<>
          {['Grabar la llamada', 'Invitar a la llamada'].map((l) => (
            <button key={l} onClick={() => setMas(false)} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, background: 'none', border: 'none', color: '#e8ebf0', padding: '9px 10px', borderRadius: 10, cursor: 'pointer', font: '500 13.5px system-ui', textAlign: 'left' }}>{l}</button>
          ))}
        </>}
        viaTurn={false}
        flags={{ muted: false, held: paso.estado === 'espera', videoOn: !!paso.video, pad, masAbierto: mas }}
        acciones={{
          colgar: () => {}, rechazar: () => {}, atender: () => {}, atenderVideo: () => {},
          mute: () => {}, hold: () => {}, video: () => {}, elegirMic: () => {}, elegirCam: () => {},
          altavoz: () => {}, transferir: () => {},
          teclado: () => setPad(v => !v), mas: () => setMas(v => !v), tecla: () => {},
        }}
      />
      {/* Mando de la vista de prueba. Queda ESCONDIDO: se muestra al acercar el mouse al
          borde de arriba. Estos no son pestañas de la aplicación —son los estados de una
          misma llamada— y dejarlo fijo hacía creer que el teléfono tiene solapas. */}
      <div className="dm-zona">
      <div className="dm-mando">
        <span className="dm-tag">vista de prueba</span>
        <div className="dm-seg">
          {PASOS.map((x, n) => (
            <button key={x.estado} className={'dm-chip' + (n === i ? ' dm-on' : '')}
              title={x.desc} onClick={() => { setAuto(false); setI(n); }}>{x.corto}</button>
          ))}
        </div>
        <button className={'dm-chip dm-suelto' + (pad ? ' dm-on' : '')} title="Abrir o cerrar el teclado"
          onClick={() => setPad(v => !v)}>Teclado</button>
        <button className={'dm-chip dm-suelto' + (auto ? ' dm-on' : '')} title="Recorrer los estados solo"
          onClick={() => setAuto(v => !v)}>{auto ? '❚❚' : '▶'}</button>
      </div>
      </div>
    </div>
  );
}
