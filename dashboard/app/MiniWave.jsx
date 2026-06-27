'use client';
import { useEffect, useState } from 'react';

export default function MiniWave({ recId, w = 110, h = 26 }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let dead = false;
    fetch('/backend/api/recordings/' + recId + '/peaks').then((r) => r.json()).then((x) => { if (!dead) setD(x); }).catch(() => { if (!dead) setD({ peaks: [], silent: true }); });
    return () => { dead = true; };
  }, [recId]);
  if (!d) return <div style={{ width: w, height: h }} />;
  if (!d.peaks || d.peaks.length === 0 || d.silent) return <span style={{ fontSize: 10.5, color: 'var(--mantine-color-dimmed)' }}>sin audio</span>;
  const n = d.peaks.length; const bw = w / n;
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      {d.peaks.map((v, i) => { const bh = Math.max(2, (v / 100) * (h - 2)); return <rect key={i} x={i * bw} y={(h - bh) / 2} width={Math.max(1, bw - 1)} height={bh} rx={1} fill="var(--mantine-color-teal-6)" opacity={0.45 + (v / 100) * 0.5} />; })}
    </svg>
  );
}
