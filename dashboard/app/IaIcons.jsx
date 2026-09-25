'use client';
/* ============================================================================
 *  Iconografía animada de IA & Voz (SVG inline, sin dependencias).
 *
 *  POR QUÉ SVG PROPIO Y NO UN ICONO MÁS DE LA LIBRERÍA: en esta pantalla la pregunta
 *  que se hace quien entra no es «qué es esto» sino «¿está vivo?». Un contenedor que no
 *  responde, un modelo que no abre sesión y un agente apagado se ven igual en una captura
 *  estática. Estos iconos se mueven SÓLO cuando la cosa está andando, así que el
 *  movimiento es información, no decoración: si algo está quieto, está caído.
 *
 *  Por eso cada uno toma `activo` y, quieto, sigue siendo legible (no depende del color).
 *
 *  Accesibilidad: todo el movimiento se apaga con `prefers-reduced-motion`. El estado
 *  nunca se comunica sólo con la animación — siempre hay además una insignia con texto.
 * ==========================================================================*/
import { useEffect } from 'react';

const CSS = `
@keyframes pbxng-onda { 0%,100% { transform: scaleY(.35) } 50% { transform: scaleY(1) } }
@keyframes pbxng-pulso { 0%,100% { opacity:.25; transform: scale(.92) } 50% { opacity:1; transform: scale(1) } }
@keyframes pbxng-subir { 0% { transform: translateY(3px); opacity:0 } 35% { opacity:1 } 100% { transform: translateY(-7px); opacity:0 } }
@keyframes pbxng-latido { 0%,100% { transform: scale(1) } 18% { transform: scale(1.14) } 36% { transform: scale(1) } }
@keyframes pbxng-girar { to { transform: rotate(360deg) } }
.pbxng-ico { display:block }
.pbxng-ico [data-anim] { animation-play-state: paused }
.pbxng-ico[data-activo="1"] [data-anim] { animation-play-state: running }
@media (prefers-reduced-motion: reduce) {
  .pbxng-ico [data-anim] { animation: none !important; transform: none !important; opacity: 1 !important }
}
`;

/* Una sola inyección para toda la pantalla: son cuatro iconos que se repiten en tarjetas,
 * tabs y filas de tabla, y un <style> por instancia serían decenas de nodos iguales. */
let puesto = false;
function useCss() {
  useEffect(() => {
    if (puesto || typeof document === 'undefined') return;
    const el = document.createElement('style');
    el.id = 'pbxng-ia-iconos';
    el.textContent = CSS;
    document.head.appendChild(el);
    puesto = true;
  }, []);
}

const base = (size, activo) => ({
  className: 'pbxng-ico', 'data-activo': activo ? '1' : '0',
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
  'aria-hidden': true,
});

/* Onda de voz: las barras laten cuando hay audio de verdad. Es el icono del motor local
 * y el de la fila de una voz que se está reproduciendo. */
export function IcoOnda({ size = 22, activo = false }) {
  useCss();
  const barras = [[4, 7], [8, 4], [12, 2], [16, 4], [20, 7]];
  return (
    <svg {...base(size, activo)}>
      {barras.map(([x, off], i) => (
        <line key={x} x1={x} y1={off} x2={x} y2={24 - off} data-anim
          style={{ transformOrigin: `${x}px 12px`, animation: `pbxng-onda ${0.9 + i * 0.12}s ease-in-out infinite`, animationDelay: `${i * 0.09}s` }} />
      ))}
    </svg>
  );
}

/* Cerebro con pulso: el modelo. Late cuando el agente tiene un proveedor con IA de
 * verdad detrás; queda quieto en modo demo, que es exactamente la diferencia. */
export function IcoCerebro({ size = 22, activo = false }) {
  useCss();
  return (
    <svg {...base(size, activo)}>
      <path d="M12 4.5a3 3 0 0 0-5.7-1.3A2.8 2.8 0 0 0 4 8.4a3 3 0 0 0 .5 5 2.8 2.8 0 0 0 4 3.3A3 3 0 0 0 12 19.5z" />
      <path d="M12 4.5a3 3 0 0 1 5.7-1.3A2.8 2.8 0 0 1 20 8.4a3 3 0 0 1-.5 5 2.8 2.8 0 0 1-4 3.3A3 3 0 0 1 12 19.5z" />
      <circle cx="12" cy="11.5" r="2.4" fill="currentColor" stroke="none" opacity=".25" data-anim
        style={{ transformOrigin: '12px 11.5px', animation: 'pbxng-pulso 1.6s ease-in-out infinite' }} />
    </svg>
  );
}

/* Nube con paquetes que suben: lo que SALE a internet y se factura. El movimiento hacia
 * arriba es el punto — recuerda que el audio se va del edificio. */
export function IcoNube({ size = 22, activo = false }) {
  useCss();
  return (
    <svg {...base(size, activo)}>
      <path d="M6.5 18.5A3.5 3.5 0 0 1 6 11.6a5 5 0 0 1 9.6-1.4A3.9 3.9 0 0 1 18 18.5z" />
      {[9.5, 12, 14.5].map((x, i) => (
        <circle key={x} cx={x} cy="21" r="1" fill="currentColor" stroke="none" data-anim
          style={{ animation: `pbxng-subir 1.5s ease-out infinite`, animationDelay: `${i * 0.28}s` }} />
      ))}
    </svg>
  );
}

/* Servidor con latido: el contenedor propio. Late si responde. */
export function IcoServidor({ size = 22, activo = false }) {
  useCss();
  return (
    <svg {...base(size, activo)}>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <line x1="7" y1="7.5" x2="7.01" y2="7.5" />
      <line x1="7" y1="16.5" x2="7.01" y2="16.5" />
      <circle cx="17" cy="7.5" r="1.3" fill="currentColor" stroke="none" data-anim
        style={{ transformOrigin: '17px 7.5px', animation: 'pbxng-latido 1.4s ease-in-out infinite' }} />
      <circle cx="17" cy="16.5" r="1.3" fill="currentColor" stroke="none" data-anim
        style={{ transformOrigin: '17px 16.5px', animation: 'pbxng-latido 1.4s ease-in-out infinite', animationDelay: '.35s' }} />
    </svg>
  );
}

/* Auricular con anillo: un agente atendiendo. */
export function IcoAgente({ size = 22, activo = false }) {
  useCss();
  return (
    <svg {...base(size, activo)}>
      <path d="M4 13v-1a8 8 0 0 1 16 0v1" />
      <rect x="2.5" y="13" width="4" height="6" rx="1.6" />
      <rect x="17.5" y="13" width="4" height="6" rx="1.6" />
      <path d="M20 19v.5a2.5 2.5 0 0 1-2.5 2.5H14" />
      <circle cx="12" cy="12" r="9.2" opacity=".28" data-anim
        style={{ transformOrigin: '12px 12px', animation: 'pbxng-pulso 2s ease-in-out infinite' }} />
    </svg>
  );
}
