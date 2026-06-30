/** @type {import('next').NextConfig} */
const API = process.env.API_URL || 'http://127.0.0.1:3000';
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), microphone=(self), camera=(self)' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [
      { source: '/backend/:path*', destination: `${API}/:path*` },
      { source: '/socket.io/:path*', destination: `${API}/socket.io/:path*` },
      { source: '/prov/:path*', destination: `${API}/prov/:path*` },
    ];
  },
};
module.exports = nextConfig;
