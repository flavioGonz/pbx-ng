import React, { useEffect, useState } from 'react';
import CallScreen from './CallScreen';

/* ============================================================================
 *  Vista de prueba de la pantalla de llamada (`?demo=call`).
 *
 *  Existe para poder MIRAR los cinco estados y sus transiciones sin levantar una llamada
 *  real: probar un cambio de animación marcando a alguien es carísimo en tiempo y encima
 *  depende de que del otro lado alguien atienda. No se incluye en el menú ni en ninguna
 *  ruta: se llega sólo con el parámetro, y no molesta a nadie.
 * ==========================================================================*/
const PASOS = [
  { estado: 'entrante', desc: 'Entra una llamada' },
  { estado: 'marcando', desc: 'Estamos llamando' },
  { estado: 'hablando', desc: 'Conversación' },
  { estado: 'espera', desc: 'En espera' },
  { estado: 'terminada', desc: 'Terminó' },
];

export default function DemoLlamada() {
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  const [pad, setPad] = useState(false);
  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(() => setI(x => (x + 1) % PASOS.length), 2600);
    return () => clearInterval(t);
  }, [auto]);
  const paso = PASOS[i];
  const desde = paso.estado === 'hablando' || paso.estado === 'espera' ? Date.now() - 134000 : 0;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <CallScreen
        estado={paso.estado}
        titulo={paso.estado === 'entrante' ? 'Carlos' : 'Carlos'}
        subtitulo="1008"
        iniciales="CA"
        desde={desde}
        calidad={3}
        viaTurn={false}
        flags={{ muted: false, held: paso.estado === 'espera', videoOn: false, pad }}
        acciones={{
          colgar: () => {}, rechazar: () => {}, atender: () => {}, atenderVideo: () => {},
          mute: () => {}, hold: () => {}, video: () => {},
          teclado: () => setPad(v => !v), mas: () => {}, tecla: () => {},
        }}
      />
      <div style={{ position: 'absolute', top: 44, left: 12, zIndex: 20, display: 'flex', gap: 6, alignItems: 'center', background: 'rgba(0,0,0,.4)', padding: 6, borderRadius: 10 }}>
        {PASOS.map((x, n) => (
          <button key={x.estado} onClick={() => { setAuto(false); setI(n); }}
            style={{ fontSize: 11, padding: '4px 8px', borderRadius: 7, cursor: 'pointer', border: '1px solid rgba(255,255,255,.18)', background: n === i ? '#3b82f6' : 'rgba(255,255,255,.08)', color: '#fff' }}>
            {x.desc}
          </button>
        ))}
        <button onClick={() => setPad(v => !v)} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 7, cursor: 'pointer', border: '1px solid rgba(255,255,255,.18)', background: pad ? '#3b82f6' : 'rgba(255,255,255,.08)', color: '#fff' }}>Teclado</button>
      </div>
    </div>
  );
}
