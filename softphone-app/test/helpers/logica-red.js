/* Utilidades de red para las pruebas del SIP nativo: puertos UDP libres en 127.0.0.1 y
 * esperar a que llegue algo sin dormir a ciegas. */
import dgram from 'node:dgram';

/* Un puerto par libre con su impar también libre (RTP + RTCP). */
export async function parLibre() {
  for (let i = 0; i < 50; i++) {
    const p = 20000 + 2 * Math.floor(Math.random() * 10000);
    const ok = await Promise.all([p, p + 1].map((port) => new Promise((res) => {
      const s = dgram.createSocket('udp4');
      s.once('error', () => { try { s.close(); } catch {} res(false); });
      s.bind(port, '127.0.0.1', () => s.close(() => res(true)));
    })));
    if (ok.every(Boolean)) return p;
  }
  throw new Error('sin puertos libres');
}

/* Espera hasta que `cond()` devuelva algo truthy (o vence). */
export async function hasta(cond, ms = 3000, paso = 5) {
  const t0 = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('vencido esperando condición');
    await new Promise((r) => setTimeout(r, paso));
  }
}

export function socketUdp(port = 0) {
  return new Promise((res) => {
    const s = dgram.createSocket('udp4');
    s.bind(port, '127.0.0.1', () => res(s));
  });
}
