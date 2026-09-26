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
  { estado: 'entrante', corto: 'Entra', desc: 'Entra una llamada' },
  { estado: 'marcando', corto: 'Marca', desc: 'Estamos llamando' },
  { estado: 'hablando', corto: 'Habla', desc: 'Conversación' },
  { estado: 'espera', corto: 'Espera', desc: 'En espera' },
  { estado: 'terminada', corto: 'Fin', desc: 'Terminó' },
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
