'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TextInput, PasswordInput, Button, Text } from '@mantine/core';
export default function Login() {
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [err, setErr] = useState(''); const [loading, setLoading] = useState(false);
  const router = useRouter();
  const [brand, setBrand] = useState({ name: 'PBX-NG', subtitle: 'Comunicaciones', tagline: 'Comunicaciones unificadas', logo: '' });
  const [setup, setSetup] = useState(null);
  const [tok, setTok] = useState('');
  const [np, setNp] = useState(''); const [np2, setNp2] = useState('');
  useEffect(() => { fetch('/backend/api/branding').then((r) => r.json()).then(setBrand).catch(() => {}); }, []);
  useEffect(() => { fetch('/backend/api/auth/setup').then((r) => r.json()).then(setSetup).catch(() => {}); }, []);
  async function submit(e) {
    e.preventDefault(); setErr(''); setLoading(true);
    try {
      const r = await fetch('/backend/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Error'); setLoading(false); return; }
      if (d.must_change) { setTok(d.token); setLoading(false); return; }
      localStorage.setItem('pbxng_jwt', d.token);
      window.location.href = '/';
    } catch (e) { setErr('No se pudo conectar'); setLoading(false); }
  }
  async function changePass(e) {
    e.preventDefault(); setErr('');
    if (np.length < 4) { setErr('La contraseña debe tener al menos 4 caracteres'); return; }
    if (np !== np2) { setErr('Las contraseñas no coinciden'); return; }
    setLoading(true);
    try {
      const r = await fetch('/backend/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ password: np }) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Error'); setLoading(false); return; }
      localStorage.setItem('pbxng_jwt', tok);
      window.location.href = '/';
    } catch (e) { setErr('No se pudo conectar'); setLoading(false); }
  }
  return (
    <div style={wrap}>
      <div style={panel}>
        <div style={brandCol}>
          {brand.logo ? <img src={brand.logo} alt="" style={{ width: 64, height: 64, objectFit: 'contain' }} /> : <svg width="64" height="64" viewBox="0 0 48 48"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7aa2ff" /><stop offset="1" stopColor="#1e40af" /></linearGradient></defs><path d="M24 2 L42 9 V25 C42 36 34 43 24 46 C14 43 6 36 6 25 V9 Z" fill="url(#lg)" /><text x="24" y="30" textAnchor="middle" fontWeight="800" fontSize="15" fill="#fff" fontFamily="Inter,sans-serif">IES</text></svg>}
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em', marginTop: 18 }}>{brand.name}</div>
          <div style={{ color: '#aebfe0', marginTop: 4 }}>{brand.tagline || brand.subtitle}</div>
        </div>
        <div style={tagline}>
          <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.25 }}>Plataforma de telefonía<br />empresarial</div>
          <div style={{ color: '#9fb3d9', marginTop: 14, maxWidth: 360 }}>Internos WebRTC, troncales SIP, colas, IVR, conferencias y monitoreo en tiempo real.</div>
        </div>
      </div>
      <div style={formSide}>
        {!tok ? (
        <form onSubmit={submit} style={card}>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Iniciar sesión</div>
          <Text size="sm" c="dimmed" mb="lg">Ingresá con tu cuenta de administrador</Text>
          {setup && setup.defaultAdmin && (
            <div style={hint}>
              <b>Primer ingreso</b> · usuario <b>admin</b> · contraseña <b>admin</b><br />
              Se te pedirá cambiarla al entrar.
            </div>
          )}
          <TextInput label="Usuario" placeholder="admin" value={u} onChange={e => setU(e.target.value)} size="md" required mb="md" autoFocus />
          <PasswordInput label="Contraseña" value={p} onChange={e => setP(e.target.value)} size="md" required mb="sm" />
          {err && <Text c="red" size="sm" mb="sm">{err}</Text>}
          <Button type="submit" fullWidth size="md" mt="md" loading={loading}>Entrar</Button>
          <Text size="xs" c="dimmed" ta="center" mt="lg">IES · Ingeniería en Seguridad</Text>
        </form>
        ) : (
        <form onSubmit={changePass} style={card}>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Cambiá tu contraseña</div>
          <Text size="sm" c="dimmed" mb="lg">Estás usando la contraseña por defecto. Definí una nueva para continuar.</Text>
          <PasswordInput label="Nueva contraseña" value={np} onChange={e => setNp(e.target.value)} size="md" required mb="md" autoFocus />
          <PasswordInput label="Repetir contraseña" value={np2} onChange={e => setNp2(e.target.value)} size="md" required mb="sm" />
          {err && <Text c="red" size="sm" mb="sm">{err}</Text>}
          <Button type="submit" fullWidth size="md" mt="md" loading={loading}>Guardar y entrar</Button>
        </form>
        )}
      </div>
    </div>
  );
}
const wrap = { position: 'fixed', inset: 0, display: 'flex', fontFamily: 'Inter,system-ui,sans-serif' };
const panel = { flex: 1.1, background: 'radial-gradient(900px 600px at 30% 20%, #1e3a8a 0%, #0b1020 60%, #070a16 100%)', color: '#fff', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '56px 48px' };
const brandCol = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' };
const tagline = {};
const formSide = { flex: 1, background: '#f4f6fb', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 };
const card = { width: 'min(380px, 92vw)', background: '#fff', borderRadius: 18, padding: '34px 32px', boxShadow: '0 10px 40px rgba(16,24,40,.12)', border: '1px solid #e6eaf2' };
const hint = { background: '#eef4ff', border: '1px solid #cfe0ff', color: '#274690', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginBottom: 16, lineHeight: 1.5 };
