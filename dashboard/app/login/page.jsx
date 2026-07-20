'use client';
import { useState, useEffect, useRef } from 'react';
import PbxLogo from '../PbxLogo';

const ROLES = {
  admin: { label: 'Administrador', icon: 'admin_panel_settings', heading: 'Panel de administración' },
  agente: { label: 'Agente', icon: 'headset_mic', heading: 'Panel de agente' },
  supervisor: { label: 'Supervisor', icon: 'supervisor_account', heading: 'Panel de supervisor' },
};

const FEATURES = [
  { icon: 'monitor_heart', title: 'Dashboard live', desc: 'Estado de internos, colas y troncales en tiempo real.' },
  { icon: 'swap_horiz', title: 'Hotdesking dinámico', desc: 'Los agentes inician sesión en cualquier puesto disponible.' },
  { icon: 'assessment', title: 'Reportes detallados', desc: 'CDR, métricas de colas y exportación a PDF / Excel.' },
  { icon: 'sensors', title: 'Monitoreo real-time', desc: 'Escucha, susurro e irrupción sobre llamadas activas.' },
];

// Imagen del hero: sala de monitoreo/seguridad (Unsplash, pública).
// No se depende de la IP interna 10.1.1.192; hay un gradiente verde/negro de fallback.
const HERO_IMAGE =
  "linear-gradient(135deg, rgba(26,26,26,0.35), rgba(17,179,40,0.10)), url('https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1400&q=80')";

export default function Login() {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [role, setRole] = useState('admin');
  const videoRef = useRef(null); const [muted, setMuted] = useState(true);
  const toggleMute = () => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; if (!v.muted) { try { v.play(); } catch (_) {} } setMuted(v.muted); };

  const [brand, setBrand] = useState({ name: 'PBX-NG', subtitle: 'Comunicaciones', tagline: 'Central telefónica unificada', logo: '' });
  const [setup, setSetup] = useState(null);

  const [tok, setTok] = useState('');
  const [np, setNp] = useState('');
  const [np2, setNp2] = useState('');
  const [showNp, setShowNp] = useState(false);
  const [showNp2, setShowNp2] = useState(false);

  useEffect(() => { fetch('/backend/api/branding').then((r) => r.json()).then(setBrand).catch(() => {}); }, []);
  useEffect(() => { fetch('/backend/api/auth/setup').then((r) => r.json()).then(setSetup).catch(() => {}); }, []);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const r = await fetch('/backend/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // role se envía para el futuro; el backend aún lo ignora.
        body: JSON.stringify({ username: u, password: p, role }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Error'); setLoading(false); return; }
      if (d.must_change) { setTok(d.token); setLoading(false); return; }
      localStorage.setItem('pbxng_jwt', d.token);
      window.location.href = dest(d.user && d.user.role);
    } catch (e) {
      setErr('No se pudo conectar');
      setLoading(false);
    }
  }

  async function changePass(e) {
    e.preventDefault();
    setErr('');
    if (np.length < 4) { setErr('La contraseña debe tener al menos 4 caracteres'); return; }
    if (np !== np2) { setErr('Las contraseñas no coinciden'); return; }
    setLoading(true);
    try {
      const r = await fetch('/backend/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ password: np }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Error'); setLoading(false); return; }
      localStorage.setItem('pbxng_jwt', tok);
      window.location.href = '/';
    } catch (e) {
      setErr('No se pudo conectar');
      setLoading(false);
    }
  }

  useEffect(() => { if (!brand.callcenter && role !== 'admin') setRole('admin'); }, [brand.callcenter, role]);
  const dest = (rl) => (rl === 'agente' ? '/agente' : rl === 'supervisor' ? '/supervisor' : '/');
  const brandName = brand.name || 'PBX-NG';
  const brandSub = brand.subtitle || 'Comunicaciones';

  return (
    <div className="hzn-login-root">
      {/* FORM (izquierda) */}
      <div className="hzn-login-form-wrap">
        <div className="hzn-login-form-inner">
          <div className="hzn-login-mobile-logo">
            {brand.logo
              ? <img src={brand.logo} alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />
              : <PbxLogo size={38} />}
            <span className="hzn-logo-text-mobile">{brandName}</span>
          </div>

          {!tok ? (
            <>
              <div className="hzn-login-heading">
                <h2>Iniciar sesión</h2>
                <p>{ROLES[role].heading} · ingresá con tu cuenta.</p>
              </div>

              {/* Role tabs (3): Administrador · Agente · Supervisor */}
              <div className="hzn-role-tabs">
                {Object.keys(ROLES).filter((k) => k === 'admin' || brand.callcenter).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={role === k ? 'active' : ''}
                    onClick={() => setRole(k)}
                  >
                    <span className="material-icons-round">{ROLES[k].icon}</span>
                    {ROLES[k].label}
                  </button>
                ))}
              </div>

              {setup && setup.defaultAdmin && (
                <div className="hzn-hint">
                  <span className="material-icons-round">info</span>
                  <span>
                    <b>Primer ingreso:</b> usuario <b>admin</b> · contraseña <b>admin</b>.
                    Se te pedirá cambiarla al entrar.
                  </span>
                </div>
              )}

              <form className="hzn-form" onSubmit={submit}>
                <div className="hzn-field">
                  <label className="hzn-label">Usuario</label>
                  <div className="hzn-input-wrap">
                    <input
                      className="hzn-input"
                      placeholder="admin"
                      value={u}
                      onChange={(e) => setU(e.target.value)}
                      required
                      autoFocus
                      autoComplete="username"
                    />
                    <span className="material-icons-round hzn-input-icon">person</span>
                  </div>
                </div>

                <div className="hzn-field">
                  <label className="hzn-label">Contraseña</label>
                  <div className="hzn-input-wrap">
                    <input
                      className="hzn-input pr-12"
                      type={showPass ? 'text' : 'password'}
                      value={p}
                      onChange={(e) => setP(e.target.value)}
                      required
                      autoComplete="current-password"
                    />
                    <span className="material-icons-round hzn-input-icon">lock</span>
                    <button type="button" className="hzn-input-toggle" onClick={() => setShowPass((s) => !s)} tabIndex={-1} aria-label="Mostrar contraseña">
                      <span className="material-icons-round">{showPass ? 'visibility_off' : 'visibility'}</span>
                    </button>
                  </div>
                </div>

                {err && (
                  <div className="hzn-alert">
                    <span className="material-icons-round">error_outline</span>
                    {err}
                  </div>
                )}

                <button type="submit" className="hzn-btn-primary" disabled={loading}>
                  <span className="material-icons-round">login</span>
                  {loading ? 'Ingresando…' : 'Iniciar sesión'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="hzn-login-heading">
                <h2>Cambiá tu contraseña</h2>
                <p>Estás usando la contraseña por defecto. Definí una nueva para continuar.</p>
              </div>

              <form className="hzn-form" onSubmit={changePass}>
                <div className="hzn-field">
                  <label className="hzn-label">Nueva contraseña</label>
                  <div className="hzn-input-wrap">
                    <input
                      className="hzn-input pr-12"
                      type={showNp ? 'text' : 'password'}
                      value={np}
                      onChange={(e) => setNp(e.target.value)}
                      required
                      autoFocus
                      autoComplete="new-password"
                    />
                    <span className="material-icons-round hzn-input-icon">lock</span>
                    <button type="button" className="hzn-input-toggle" onClick={() => setShowNp((s) => !s)} tabIndex={-1} aria-label="Mostrar contraseña">
                      <span className="material-icons-round">{showNp ? 'visibility_off' : 'visibility'}</span>
                    </button>
                  </div>
                </div>

                <div className="hzn-field">
                  <label className="hzn-label">Repetir contraseña</label>
                  <div className="hzn-input-wrap">
                    <input
                      className="hzn-input pr-12"
                      type={showNp2 ? 'text' : 'password'}
                      value={np2}
                      onChange={(e) => setNp2(e.target.value)}
                      required
                      autoComplete="new-password"
                    />
                    <span className="material-icons-round hzn-input-icon">lock</span>
                    <button type="button" className="hzn-input-toggle" onClick={() => setShowNp2((s) => !s)} tabIndex={-1} aria-label="Mostrar contraseña">
                      <span className="material-icons-round">{showNp2 ? 'visibility_off' : 'visibility'}</span>
                    </button>
                  </div>
                </div>

                {err && (
                  <div className="hzn-alert">
                    <span className="material-icons-round">error_outline</span>
                    {err}
                  </div>
                )}

                <button type="submit" className="hzn-btn-primary" disabled={loading}>
                  <span className="material-icons-round">check</span>
                  {loading ? 'Guardando…' : 'Guardar y entrar'}
                </button>
              </form>
            </>
          )}

          <div className="hzn-login-footer">
            <span>PBX-NG</span>
            <span className="hzn-dot">·</span>
            <span>© Infratec 2026</span>
          </div>
        </div>
      </div>

      {/* HERO (derecha) */}
      <div className="hzn-login-hero">
        <video ref={videoRef} className="hzn-login-hero-video" autoPlay loop muted playsInline preload="auto"><source src="/background-login.mp4" type="video/mp4" /></video>
        <div className="hzn-login-hero-overlay" />
        <button type="button" className="hzn-hero-mute" onClick={toggleMute} aria-label={muted ? 'Activar sonido' : 'Silenciar'}><span className="material-icons-round">{muted ? 'volume_off' : 'volume_up'}</span></button>
        <div className="hzn-login-hero-content">
          {/* El logo, grande y flotando: es lo primero que se ve del producto. */}
          <div className="pbx-login-float" aria-hidden>
            <PbxLogo size={150} />
          </div>
          <div className="hzn-logo">
            <div style={{ textAlign: 'right' }}>
              <div className="hzn-logo-text">{brandName}</div>
              <div className="hzn-logo-sub">{brandSub}</div>
            </div>
            <div className="hzn-logo-mark">
              {brand.logo
                ? <img src={brand.logo} alt="" style={{ width: 30, height: 30, objectFit: 'contain' }} />
                : <PbxLogo size={30} />}
            </div>
          </div>

          <div className="hzn-login-tagline">
            <span className="hzn-role-pill">
              <span className="material-icons-round">verified_user</span>
              PBX-NG
            </span>
            <h1>{brand.tagline || 'Central telefónica unificada'}</h1>
            <p>
              Internos WebRTC, troncales SIP, colas, IVR, conferencias y monitoreo en tiempo real,
              en una sola consola centralizada.
            </p>

            <ul className="hzn-feature-list">
              {FEATURES.map((f) => (
                <li key={f.title}>
                  <div>
                    <strong>{f.title}</strong>
                    <span>{f.desc}</span>
                  </div>
                  <span className="material-icons-round">{f.icon}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
        @import url('https://fonts.googleapis.com/icon?family=Material+Icons+Round');

        :root {
          --horizon-green: #11b328;
          --horizon-green-glow: rgba(17, 179, 40, 0.45);
          --horizon-black: #1a1a1a;
          --horizon-bg-light: #e6e7e8;
        }

        .material-icons-round {
          font-family: 'Material Icons Round';
          font-weight: normal;
          font-style: normal;
          line-height: 1;
          letter-spacing: normal;
          text-transform: none;
          display: inline-block;
          white-space: nowrap;
          word-wrap: normal;
          direction: ltr;
          -webkit-font-feature-settings: 'liga';
          -webkit-font-smoothing: antialiased;
        }

        .hzn-login-root {
          position: fixed;
          inset: 0;
          display: grid;
          grid-template-columns: 2fr 4fr; /* form 2/6 (izquierda) - imagen 4/6 (derecha) */
          background: #fff;
          color: var(--horizon-black);
          font-family: 'Inter', system-ui, sans-serif;
          overflow: hidden;
        }
        .hzn-login-form-wrap { grid-column: 1; }
        .hzn-login-hero { grid-column: 2; }

        @media (max-width: 900px) {
          .hzn-login-root { grid-template-columns: 1fr; }
          .hzn-login-hero { display: none; }
          .hzn-login-form-wrap { grid-column: 1; }
        }

        /* HERO (derecha) */
        .hzn-login-hero { position: relative; overflow: hidden; background: #000; }
        .hzn-login-hero-image {
          position: absolute; inset: 0;
          background-size: cover;
          background-position: center;
          background-repeat: no-repeat;
          filter: saturate(1.05);
        }
        .hzn-login-hero-video {
          position: absolute; inset: 0; width: 100%; height: 100%;
          object-fit: cover; z-index: 0; filter: saturate(1.06) contrast(1.03);
          animation: heroZoom 34s ease-in-out infinite alternate;
        }
        @keyframes heroZoom { from { transform: scale(1); } to { transform: scale(1.09); } }
        .hzn-hero-mute {
          position: absolute; bottom: 22px; left: 22px; z-index: 3;
          width: 44px; height: 44px; border-radius: 50%;
          border: 1px solid rgba(255,255,255,.25); background: rgba(18,18,18,.5);
          backdrop-filter: blur(6px); color: #fff; display: flex; align-items: center; justify-content: center;
          cursor: pointer; transition: background .2s, transform .2s; box-shadow: 0 6px 18px rgba(0,0,0,.35);
        }
        .hzn-hero-mute:hover { background: rgba(17,179,40,.6); transform: scale(1.06); }
        .hzn-login-hero-overlay {
          position: absolute; inset: 0;
          background:
            radial-gradient(ellipse at 30% 50%, rgba(17, 179, 40, 0.18), transparent 60%),
            linear-gradient(135deg, rgba(26,26,26,0.65) 0%, rgba(26,26,26,0.45) 50%, rgba(26,26,26,0.75) 100%);
        }
        .hzn-login-hero-content {
          position: relative; z-index: 1;
          height: 100%;
          display: flex; flex-direction: column; justify-content: space-between;
          padding: 50px 60px;
          color: #fff; text-align: right;
        }
        .hzn-logo { display: flex; align-items: center; gap: 14px; justify-content: flex-end; }
        .hzn-logo-mark {
          display: flex; align-items: center; justify-content: center;
          width: 52px; height: 52px;
          background: rgba(255,255,255,0.96);
          border-radius: 50%;
          box-shadow: 0 6px 16px rgba(0,0,0,0.25), 0 0 0 4px rgba(17,179,40,0.18);
        }
        .hzn-logo-text { font-size: 26px; font-weight: 900; letter-spacing: 0.08em; color: #fff; line-height: 1; }
        .hzn-logo-sub {
          font-size: 11px; font-weight: 700; letter-spacing: 0.32em;
          color: var(--horizon-green); margin-top: 4px; text-transform: uppercase;
        }
        .hzn-login-tagline { max-width: 560px; margin-left: auto; }
        .hzn-login-tagline h1 {
          font-size: 38px; font-weight: 800; letter-spacing: -0.02em;
          line-height: 1.15; margin: 14px 0 14px; color: #fff;
        }
        .hzn-login-tagline p {
          font-size: 14.5px; font-weight: 500; line-height: 1.6;
          color: rgba(255,255,255,0.85); margin: 0 0 20px;
        }
        .hzn-role-pill {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 12px;
          background: rgba(17,179,40,0.18);
          border: 1px solid rgba(17,179,40,0.4);
          border-radius: 100px;
          font-size: 11px; font-weight: 700;
          color: var(--horizon-green);
          letter-spacing: 0.04em; text-transform: uppercase;
        }
        .hzn-role-pill .material-icons-round { font-size: 13px; }
        .hzn-feature-list {
          list-style: none; padding: 0; margin: 8px 0 0;
          display: flex; flex-direction: column; gap: 12px;
        }
        .hzn-feature-list li { display: flex; align-items: flex-start; gap: 12px; justify-content: flex-end; }
        .hzn-feature-list li > .material-icons-round {
          order: 2; width: 36px; height: 36px; border-radius: 9px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.1);
          display: flex; align-items: center; justify-content: center;
          font-size: 18px; color: var(--horizon-green); flex-shrink: 0;
        }
        .hzn-feature-list li > div { order: 1; text-align: right; display: flex; flex-direction: column; min-width: 0; }
        .hzn-feature-list li strong { font-size: 13px; font-weight: 700; color: #fff; line-height: 1.2; }
        .hzn-feature-list li span:not(.material-icons-round) {
          font-size: 11.5px; font-weight: 500; color: rgba(255,255,255,0.6);
          margin-top: 3px; line-height: 1.4;
        }

        /* FORM (izquierda) */
        .hzn-login-form-wrap {
          background: #fff;
          display: flex; align-items: center; justify-content: center;
          padding: 40px 24px; overflow-y: auto;
        }
        @media (max-width: 900px) {
          .hzn-login-form-wrap {
            background-image:
              linear-gradient(135deg, rgba(255,255,255,0.96), rgba(255,255,255,0.92)),
              url('https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1400&q=80');
            background-size: cover; background-position: center;
          }
        }
        .hzn-login-form-inner { width: 100%; max-width: 420px; }
        .hzn-login-mobile-logo { display: none; align-items: center; justify-content: center; gap: 12px; margin-bottom: 24px; }
        @media (max-width: 900px) { .hzn-login-mobile-logo { display: flex; } }
        .hzn-logo-text-mobile { font-size: 22px; font-weight: 900; letter-spacing: 0.08em; color: var(--horizon-black); }

        .hzn-login-heading { margin-bottom: 28px; }
        .hzn-login-heading h2 {
          font-size: 28px; font-weight: 800; letter-spacing: -0.02em;
          color: var(--horizon-black); margin: 0; line-height: 1.1;
        }
        .hzn-login-heading p { font-size: 13px; color: #6b7280; margin: 8px 0 0; line-height: 1.5; }

        /* Hint (primer ingreso) */
        .hzn-hint {
          display: flex; align-items: flex-start; gap: 10px;
          padding: 10px 14px; margin-bottom: 22px;
          background: rgba(17,179,40,0.08);
          border: 1px solid rgba(17,179,40,0.3);
          border-radius: 8px;
          font-size: 12.5px; color: #166534; line-height: 1.5;
        }
        .hzn-hint .material-icons-round { font-size: 18px; color: var(--horizon-green); flex-shrink: 0; margin-top: 1px; }

        /* Role tabs */
        .hzn-role-tabs {
          display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px;
          padding: 4px; background: var(--horizon-bg-light);
          border-radius: 10px; margin-bottom: 22px;
        }
        .hzn-role-tabs button {
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          padding: 10px 12px; border: none; background: transparent;
          border-radius: 7px; font-size: 12px; font-weight: 700;
          color: #6b7280; cursor: pointer; transition: all 0.18s ease;
          font-family: inherit;
        }
        .hzn-role-tabs button .material-icons-round { font-size: 16px; }
        .hzn-role-tabs button:hover { color: var(--horizon-black); }
        .hzn-role-tabs button.active {
          background: #fff; color: var(--horizon-black);
          box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04);
        }

        /* Form fields */
        .hzn-form { display: flex; flex-direction: column; gap: 16px; }
        .hzn-field { display: block; }
        .hzn-label {
          display: block; font-size: 12px; font-weight: 700;
          color: var(--horizon-black); margin-bottom: 6px; letter-spacing: 0.01em;
        }
        .hzn-input-wrap { position: relative; }
        .hzn-input {
          width: 100%; height: 44px; padding: 0 14px 0 42px;
          background: #fff; border: 1.5px solid #d4d4d8; border-radius: 8px;
          font-size: 14px; color: var(--horizon-black);
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
          font-family: inherit;
        }
        .hzn-input:focus {
          outline: none; border-color: var(--horizon-green);
          box-shadow: 0 0 0 3px rgba(17,179,40,0.18);
        }
        .hzn-input::placeholder { color: #9ca3af; }
        .hzn-input.pr-12 { padding-right: 44px; }
        .hzn-input-icon {
          position: absolute; left: 13px; top: 50%; transform: translateY(-50%);
          font-size: 18px; color: #9ca3af; pointer-events: none;
          transition: color 0.15s ease;
        }
        .hzn-input-wrap:focus-within .hzn-input-icon { color: var(--horizon-green); }
        .hzn-input-toggle {
          position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
          background: transparent; border: none; padding: 6px; border-radius: 6px;
          cursor: pointer; color: #9ca3af; display: inline-flex;
          transition: color 0.15s ease, background 0.15s ease;
        }
        .hzn-input-toggle:hover { color: var(--horizon-black); background: var(--horizon-bg-light); }
        .hzn-input-toggle .material-icons-round { font-size: 18px; }

        /* Alert */
        .hzn-alert {
          display: flex; align-items: center; gap: 10px;
          padding: 10px 14px;
          background: rgba(239,68,68,0.08);
          border: 1px solid rgba(239,68,68,0.32);
          border-radius: 8px;
          font-size: 12.5px; font-weight: 600; color: #b91c1c;
        }
        .hzn-alert .material-icons-round { font-size: 18px; color: #dc2626; }

        /* Primary button */
        .hzn-btn-primary {
          width: 100%; height: 46px;
          display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          background: var(--horizon-green); color: #fff; border: none; border-radius: 8px;
          font-size: 14px; font-weight: 700; letter-spacing: 0.02em; cursor: pointer;
          box-shadow: 0 4px 12px var(--horizon-green-glow), inset 0 -2px 0 rgba(0,0,0,0.08);
          transition: all 0.18s ease; margin-top: 4px; font-family: inherit;
        }
        .hzn-btn-primary:hover:not(:disabled) {
          background: #0ea021;
          box-shadow: 0 6px 18px var(--horizon-green-glow), inset 0 -2px 0 rgba(0,0,0,0.1);
          transform: translateY(-1px);
        }
        .hzn-btn-primary:active:not(:disabled) { transform: translateY(0); }
        .hzn-btn-primary:disabled { opacity: 0.65; cursor: not-allowed; }
        .hzn-btn-primary .material-icons-round { font-size: 18px; }

        /* Footer */
        .hzn-login-footer {
          margin-top: 28px;
          display: flex; align-items: center; justify-content: center; gap: 6px;
          font-size: 11px; color: #9ca3af;
        }
        .hzn-dot { opacity: 0.4; }
      `}</style>
    </div>
  );
}
