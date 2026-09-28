import React, { useEffect, useState } from 'react';

/* ── Los medios de una llamada: el otro lado y las cámaras del cliente ───────
 *
 * QUÉ PROBLEMA RESUELVE. Quien atiende un portero no quiere «una videollamada»: quiere VER
 * la entrada. El portero muchas veces no manda video —es un interno de audio— y las cámaras
 * del frente están cargadas en la ficha del cliente, a dos pantallas de distancia. Hasta
 * ahora había que cortar, ir a Intercom, buscar el cliente y abrir la cámara: para cuando
 * uno llegaba, la persona ya se había ido.
 *
 * CÓMO FUNCIONA. Todas las fuentes de video de esta llamada —la imagen del otro lado, si la
 * hay, y cada cámara del cliente— se dibujan acá. Una ocupa la pantalla y el resto queda de
 * miniatura a la derecha, debajo de la cámara propia; un clic las intercambia.
 *
 * POR QUÉ TODAS EN EL MISMO CONTENEDOR, sin moverlas de padre: cada cámara es un WebSocket
 * con go2rtc y un MediaSource propio. Si al agrandar una la sacáramos de un contenedor para
 * meterla en otro, React la desmontaría y la volvería a montar — o sea, se cortaría el
 * video y habría que esperar de nuevo a que cargue, justo en el momento en que uno la
 * quiere mirar. Acá lo único que cambia es la clase CSS: el video no se entera. */
export default function EscenaMedios({ fuentes, principal, onPrincipal }) {
  const minis = fuentes.filter((f) => f.id !== principal);
  /* Las miniaturas arrancan debajo de la tarjeta de la cámara propia cuando está en su
   * esquina de siempre; si el usuario la movió, arrancan arriba y no se pisan con nada. */
  const arriba = (() => {
    try { return (localStorage.getItem('sp_video_esquina') || 'sup-der') === 'sup-der' ? 186 : 58; }
    catch (_) { return 186; }
  })();
  return (
    <div className="cs-medios">
      {fuentes.map((f) => {
        const grande = f.id === principal;
        const i = minis.indexOf(f);
        return (
          <div key={f.id}
            className={grande ? 'cs-fuente cs-fuente-main' : 'cs-fuente cs-fuente-mini'}
            style={grande ? undefined : { top: arriba + i * 108 }}
            onClick={grande ? undefined : () => onPrincipal(f.id)}
            title={grande ? undefined : 'Ver «' + f.label + '» en grande'}>
            {f.nodo}
            {grande ? null : <span className="cs-fuente-lab">{f.label}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ¿Está LLEGANDO imagen del otro lado? Se pregunta cada 700 ms porque una pista de video
 * puede existir y estar muda —el otro todavía no encendió la cámara— y eso no dispara
 * ningún evento. De esto depende que la cámara del cliente ocupe la pantalla o no. */
export function useVideoRemoto(activa, getRemoteStream) {
  const [vivo, setVivo] = useState(false);
  useEffect(() => {
    if (!activa || !getRemoteStream) { setVivo(false); return undefined; }
    const mirar = () => {
      const st = getRemoteStream();
      const t = st && st.getVideoTracks && st.getVideoTracks()[0];
      setVivo(!!(t && t.readyState === 'live' && !t.muted));
    };
    mirar();
    const id = setInterval(mirar, 700);
    return () => clearInterval(id);
  }, [activa, getRemoteStream]);
  return vivo;
}

