/** @type {import('next').NextConfig} */
/* Sin `rewrites` hacia la API: los hace server.js (proxy propio) porque el de Next no
 * agrega X-Forwarded-For y el rate limit del login de la API depende de esa cabecera.
 * API_URL se lee al arrancar server.js, no en el build. */
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), microphone=(self), camera=(self)' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['cobe'],
  output: 'standalone',               // imagen Docker chica: solo server.js + .next/static + public (antes ~1.4 GB)
  skipTrailingSlashRedirect: true,   // por si un /socket.io/ llega a Next (no debería: lo toma server.js antes)
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};
module.exports = nextConfig;
