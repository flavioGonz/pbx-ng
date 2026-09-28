'use client';
/* ============================================================================
 *  Iconografía propia para los paneles de configuración (drawers).
 *
 *  Están acá y no salen de una librería porque varios se ANIMAN POR DENTRO: la antena
 *  emite ondas sólo cuando el interno está registrado, el punto de grabación late sólo si
 *  la grabación está encendida. Un icono de librería obliga a animar el contenedor, y eso
 *  se ve distinto: se mueve la caja, no el dibujo.
 *
 *  LA REGLA: el movimiento dice algo o no está. Un icono que se mueve siempre es ruido —
 *  cuando todo late, nada llama la atención—. Por eso cada uno recibe `vivo` y, apagado,
 *  es un dibujo quieto. Y todo se detiene con `prefers-reduced-motion`.
 * ==========================================================================*/

const base = (s) => ({ width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' });

/* Antena: el aparato registrado emite; el que no, es una antena apagada. */
export const IcoRegistro = ({ s = 20, vivo = false }) => (
  <svg {...base(s)} className={vivo ? 'ng-vivo' : ''}>
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6" className={vivo ? 'ng-onda ng-onda-1' : ''} />
    <path d="M15.8 8.2a5.4 5.4 0 0 1 0 7.6" className={vivo ? 'ng-onda ng-onda-1' : ''} />
    <path d="M5.5 5.5a9.2 9.2 0 0 0 0 13" className={vivo ? 'ng-onda ng-onda-2' : ''} />
    <path d="M18.5 5.5a9.2 9.2 0 0 1 0 13" className={vivo ? 'ng-onda ng-onda-2' : ''} />
  </svg>
);

/* Latencia: tres barras. No se animan — el número ya cambia, y dos cosas moviéndose por
 * el mismo dato se leen como dos datos. */
export const IcoLatencia = ({ s = 20, nivel = 3 }) => (
  <svg {...base(s)}>
    <line x1="6" y1="18" x2="6" y2="14" opacity={nivel >= 1 ? 1 : 0.25} />
    <line x1="12" y1="18" x2="12" y2="10" opacity={nivel >= 2 ? 1 : 0.25} />
    <line x1="18" y1="18" x2="18" y2="6" opacity={nivel >= 3 ? 1 : 0.25} />
  </svg>
);

/* Identidad. */
export const IcoPersona = ({ s = 20 }) => (
  <svg {...base(s)}><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></svg>
);

/* Conexión: el globo con el meridiano, que es lo que distingue WebRTC de un aparato. */
export const IcoConexion = ({ s = 20 }) => (
  <svg {...base(s)}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.4 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.4-3.6-8.5S9.6 5.9 12 3.5z" /></svg>
);

/* Grabación: el punto late sólo si está grabando de verdad. */
export const IcoGrabar = ({ s = 20, vivo = false }) => (
  <svg {...base(s)}>
    <circle cx="12" cy="12" r="8.5" opacity=".55" />
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" className={vivo ? 'ng-late' : ''} />
  </svg>
);

/* QR: los tres ojos y unos módulos. El barrido cruza sólo mientras se está generando. */
export const IcoQr = ({ s = 20, vivo = false }) => (
  <svg {...base(s)} strokeWidth="1.6">
    <rect x="3.5" y="3.5" width="6" height="6" rx="1.2" />
    <rect x="14.5" y="3.5" width="6" height="6" rx="1.2" />
    <rect x="3.5" y="14.5" width="6" height="6" rx="1.2" />
    <path d="M14.5 14.5h2.5v2.5M20.5 17v3.5h-3.5" />
    {vivo && <line x1="2" y1="12" x2="22" y2="12" className="ng-barrido" strokeWidth="1.2" />}
  </svg>
);

/* Desvío: la flecha que se va por la rama. */
export const IcoDesvio = ({ s = 20 }) => (
  <svg {...base(s)}><path d="M3 17h5.5a5 5 0 0 0 5-5V9" /><path d="M11 6.5 13.5 9 11 11.5" /><path d="M3 7h4" /></svg>
);

/* Troncal: dos nodos y el enlace entre ellos. */
export const IcoTroncal = ({ s = 20, vivo = false }) => (
  <svg {...base(s)}>
    <circle cx="5.5" cy="12" r="2.6" /><circle cx="18.5" cy="12" r="2.6" />
    <path d="M8.1 12h7.8" className={vivo ? 'ng-flujo' : ''} strokeDasharray={vivo ? '2 3' : undefined} />
  </svg>
);

/* Llave: la contraseña. El diente gira un cuarto de vuelta al enfocar el campo. */
export const IcoLlave = ({ s = 20 }) => (
  <svg {...base(s)}><circle cx="8" cy="12" r="3.4" /><path d="M11.4 12H20M17 12v3M14.4 12v2.2" /></svg>
);
