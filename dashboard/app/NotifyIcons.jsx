'use client';
/* Iconografia de las notificaciones: SVG con trazo animado (se dibujan al aparecer).
   Un icono por tipo generico y uno por evento de telefonia, para reconocer el aviso
   de un vistazo sin leerlo. */
const S = { fill: 'none', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' };

function Wrap({ color, children, spin }) {
  return (
    <span className="pbx-nico" style={{ '--nc': color }}>
      <svg width="20" height="20" viewBox="0 0 24 24" className={spin ? 'pbx-nico-spin' : undefined}>
        <circle cx="12" cy="12" r="10.5" fill="none" stroke={color} strokeWidth="1.6" opacity=".22" />
        {children}
      </svg>
    </span>
  );
}

export const COLORS = {
  success: '#12b76a', error: '#f04438', warning: '#f79009', info: '#2f80ff',
  action: '#7c3aed', ring: '#2f80ff', talking: '#12b76a', hangup: '#64748b',
  waiting: '#f79009', agent: '#0ea5e9', security: '#f04438',
};

export function NotifyIcon({ kind = 'info' }) {
  const c = COLORS[kind] || COLORS.info;
  switch (kind) {
    case 'success':
      return <Wrap color={c}><path className="pbx-draw" d="M7 12.6l3.2 3.2L17.2 8.4" stroke={c} {...S} /></Wrap>;
    case 'error':
      return <Wrap color={c}><g className="pbx-draw"><path d="M8.6 8.6l6.8 6.8" stroke={c} {...S} /><path d="M15.4 8.6l-6.8 6.8" stroke={c} {...S} /></g></Wrap>;
    case 'warning':
      return <Wrap color={c}><g className="pbx-draw"><path d="M12 7.2v6" stroke={c} {...S} /><circle cx="12" cy="16.6" r="1.1" fill={c} /></g></Wrap>;
    case 'loading':
      return <Wrap color={c} spin><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" stroke={c} {...S} /></Wrap>;
    case 'action':
      return <Wrap color={c}><path className="pbx-draw" d="M9.5 7l5.5 5-5.5 5" stroke={c} {...S} /></Wrap>;
    // --- eventos de telefonia ---
    case 'ring':   // telefono sonando: el auricular vibra
      return <Wrap color={c}><g className="pbx-shake"><path d="M8.4 6.2h2.4l1.2 3-1.5.9a7.2 7.2 0 0 0 3.3 3.3l.9-1.5 3 1.2v2.4a1.2 1.2 0 0 1-1.3 1.2A10 10 0 0 1 7.2 7.5a1.2 1.2 0 0 1 1.2-1.3z" stroke={c} {...S} /></g></Wrap>;
    case 'talking': // en conversacion: onda de audio
      return <Wrap color={c}><g className="pbx-wave"><path d="M7 12v0M10 9.2v5.6M13 7.4v9.2M16 10.4v3.2" stroke={c} {...S} /></g></Wrap>;
    case 'waiting': // en espera: reloj
      return <Wrap color={c}><g className="pbx-draw"><circle cx="12" cy="12" r="5.6" stroke={c} {...S} /><path d="M12 9v3.2l2.1 1.3" stroke={c} {...S} /></g></Wrap>;
    case 'hangup': // colgado
      return <Wrap color={c}><g className="pbx-draw"><path d="M5.5 13.6a9 9 0 0 1 13 0" stroke={c} {...S} /><path d="M8.2 15.4l-1.6 1.6M15.8 15.4l1.6 1.6" stroke={c} {...S} /></g></Wrap>;
    case 'agent':
      return <Wrap color={c}><g className="pbx-draw"><circle cx="12" cy="9.6" r="2.8" stroke={c} {...S} /><path d="M6.6 17.4a5.6 5.6 0 0 1 10.8 0" stroke={c} {...S} /></g></Wrap>;
    case 'security':
      return <Wrap color={c}><g className="pbx-draw"><path d="M12 4.6l6 2.4v4.4c0 3.6-2.5 6.6-6 7.6-3.5-1-6-4-6-7.6V7z" stroke={c} {...S} /><path d="M9.8 12l1.6 1.6 3-3.2" stroke={c} {...S} /></g></Wrap>;
    default:
      return <Wrap color={c}><g className="pbx-draw"><path d="M12 11.2v5" stroke={c} {...S} /><circle cx="12" cy="7.6" r="1.1" fill={c} /></g></Wrap>;
  }
}
export default NotifyIcon;
