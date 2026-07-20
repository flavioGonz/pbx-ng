'use client';
/* ============================================================================
 *  RJ45 · el conector, dibujado y vivo (portado de SBC-NG)
 *
 *  Verde y con los LEDs parpadeando = hay enlace y pasa tráfico.
 *  Rojo/gris y con el cable colgando = no hay carrier (cable desenchufado o el
 *  switch del otro lado muerto). Que se vea de un vistazo ahorra una visita al rack.
 * ==========================================================================*/

export default function Rj45({ estado = 'conectada', rx = 0, tx = 0, size = 56 }) {
  const conectada = estado === 'conectada';
  const sinCable = estado === 'sin_cable';

  const color = conectada ? '#12b76a' : sinCable ? '#f04438' : '#94a3b8';
  const hayTrafico = conectada && (rx > 0 || tx > 0);

  return (
    <span
      className="rj45"
      style={{ '--c': color, display: 'inline-flex', width: size, height: size }}
      title={conectada ? 'Enlace activo' : sinCable ? 'Sin cable / sin enlace' : 'Interfaz apagada'}
    >
      <svg viewBox="0 0 48 48" width={size} height={size} role="img" aria-label={estado}>
        <rect x="10" y="12" width="28" height="24" rx="3" fill="none" stroke={color} strokeWidth="2.2" />
        <path className={sinCable ? 'rj45-lengueta-suelta' : undefined}
              d="M19 12 v-5 h10 v5" fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <line key={i} x1={14 + i * 2.8} y1="16" x2={14 + i * 2.8} y2="24" stroke={color} strokeWidth="1.4" opacity=".55" />
        ))}
        <circle cx="15.5" cy="32" r="2.4" fill={conectada ? '#12b76a' : '#475569'} className={conectada ? 'rj45-led-link' : undefined} />
        <circle cx="32.5" cy="32" r="2.4" fill={hayTrafico ? '#f59e0b' : '#475569'} className={hayTrafico ? 'rj45-led-act' : undefined} />
        <path className={sinCable ? 'rj45-cable-suelto' : 'rj45-cable'}
              d={sinCable ? 'M24 36 q2 6 -6 9' : 'M24 36 v8'} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <style jsx>{`
        .rj45 { position: relative; }
        :global(.rj45-led-link) { animation: rj45-latido 2.4s ease-in-out infinite; }
        @keyframes rj45-latido { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
        :global(.rj45-led-act) { animation: rj45-parpadeo .35s steps(2, end) infinite; }
        @keyframes rj45-parpadeo { 0% { opacity: 1; } 100% { opacity: .2; } }
        :global(.rj45-lengueta-suelta) { transform-origin: 24px 12px; animation: rj45-caer .6s ease-out forwards; }
        @keyframes rj45-caer { to { transform: rotate(-18deg) translateY(2px); } }
        :global(.rj45-cable-suelto) { animation: rj45-colgar 2.6s ease-in-out infinite; transform-origin: 24px 36px; }
        @keyframes rj45-colgar { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(4deg); } }
        @media (prefers-reduced-motion: reduce) {
          :global(.rj45-led-link), :global(.rj45-led-act),
          :global(.rj45-lengueta-suelta), :global(.rj45-cable-suelto) { animation: none; }
        }
      `}</style>
    </span>
  );
}
