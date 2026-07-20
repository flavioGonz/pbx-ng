'use client';
import dynamic from 'next/dynamic';
import PbxLogo from '../PbxLogo';
const SbcFlow = dynamic(() => import('../SbcFlow'), { ssr: false });

export default function TopologiaPage() {
  return (
    <div style={{ margin: 'calc(var(--mantine-spacing-lg) * -1)', position: 'relative' }}>
      {/* marca del producto, flotando en una esquina del lienzo */}
      <div style={{
        position: 'absolute', top: 16, left: 16, zIndex: 5,
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px 8px 10px', borderRadius: 14,
        background: 'rgba(16,18,27,.72)', backdropFilter: 'blur(10px)',
        border: '1px solid rgba(124,58,237,.28)', pointerEvents: 'none',
      }}>
        <PbxLogo size={30} />
        <div style={{ lineHeight: 1.1 }}>
          <div style={{ fontWeight: 800, fontSize: 13, color: '#fff' }}>PBX-NG</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,.55)' }}>Topología de la central</div>
        </div>
      </div>
      <SbcFlow fullBleed />
    </div>
  );
}
