'use client';
/* ============================================================================
 *  Logo de PBX-NG — el escudo violeta con los dos diálogos encadenados.
 *
 *  Misma familia que SBC-NG (son productos hermanos), pero en violeta: el escudo
 *  protege la central, y las dos burbujas encadenadas son las dos conversaciones
 *  que la PBX une — la de adentro (los internos) y la de afuera (el mundo). Se
 *  tocan pero no se mezclan.
 *
 *  Animado igual que el hermano: el escudo se dibuja de un trazo, las burbujas
 *  entran una detrás de la otra, y después el conjunto respira. Con
 *  prefers-reduced-motion queda quieto.
 * ==========================================================================*/

export default function PbxLogo({ size = 40, animado = true, color = '#7c3aed', texto = false }) {
  const cls = animado ? 'pbxlogo-vivo' : '';
  return (
    <span className={`pbx-logo ${cls}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" role="img" aria-label="PBX-NG">
        <defs>
          <linearGradient id="pbxEsc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="1" stopColor={color} />
          </linearGradient>
        </defs>

        {/* escudo */}
        <path
          className="pbx-escudo"
          d="M32 4.5 L56 13.5 V31 c0 14.4 -9.9 25.5 -24 28.5 C17.9 56.5 8 45.4 8 31 V13.5 Z"
          fill="none" stroke="url(#pbxEsc)" strokeWidth="3.4" strokeLinejoin="round"
        />

        {/* burbuja de arriba (blanca): la conversación con el interno */}
        <path
          className="pbx-burbuja pbx-burbuja-a"
          d="M20 20 h13 a3.5 3.5 0 0 1 3.5 3.5 v9 a3.5 3.5 0 0 1 -3.5 3.5 h-6 l-5 5 v-5 h-2 a3.5 3.5 0 0 1 -3.5 -3.5 v-9 A3.5 3.5 0 0 1 20 20 Z"
          fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round"
        />

        {/* burbuja de abajo (violeta): la conversación con el mundo */}
        <path
          className="pbx-burbuja pbx-burbuja-b"
          d="M31 27.5 h13 a3.5 3.5 0 0 1 3.5 3.5 v9 A3.5 3.5 0 0 1 44 43.5 h-2 v5 l-5 -5 h-6 a3.5 3.5 0 0 1 -3.5 -3.5 v-9 a3.5 3.5 0 0 1 3.5 -3.5 Z"
          fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round"
        />
      </svg>

      {texto && (
        <span className="pbx-logo-txt" style={{ fontWeight: 800, letterSpacing: '-.01em', fontSize: size * 0.44 }}>
          PBX-NG
        </span>
      )}

      <style jsx>{`
        .pbx-logo { color: #ffffff; }

        :global(.pbxlogo-vivo .pbx-escudo) {
          stroke-dasharray: 210;
          stroke-dashoffset: 210;
          animation: pbxTrazo 1.1s cubic-bezier(.4, 0, .2, 1) forwards,
                     pbxRespira 4.5s 1.3s ease-in-out infinite;
        }
        @keyframes pbxTrazo { to { stroke-dashoffset: 0; } }
        @keyframes pbxRespira { 0%, 100% { opacity: 1; } 50% { opacity: .72; } }

        :global(.pbxlogo-vivo .pbx-burbuja) {
          stroke-dasharray: 120;
          stroke-dashoffset: 120;
          transform-origin: 32px 32px;
        }
        :global(.pbxlogo-vivo .pbx-burbuja-a) { animation: pbxTrazoB .7s .55s ease forwards, pbxLatido 4.5s 1.5s ease-in-out infinite; }
        :global(.pbxlogo-vivo .pbx-burbuja-b) { animation: pbxTrazoB .7s .85s ease forwards, pbxLatido 4.5s 1.9s ease-in-out infinite; }
        @keyframes pbxTrazoB { to { stroke-dashoffset: 0; } }
        @keyframes pbxLatido { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.045); } }

        @media (prefers-reduced-motion: reduce) {
          :global(.pbxlogo-vivo .pbx-escudo),
          :global(.pbxlogo-vivo .pbx-burbuja) { animation: none; stroke-dashoffset: 0; }
        }
      `}</style>
    </span>
  );
}
