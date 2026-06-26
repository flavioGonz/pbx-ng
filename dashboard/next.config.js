/** @type {import('next').NextConfig} */
const API = process.env.API_URL || 'http://127.0.0.1:3000';
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/backend/:path*', destination: `${API}/:path*` },
      { source: '/socket.io/:path*', destination: `${API}/socket.io/:path*` },
      { source: '/prov/:path*', destination: `${API}/prov/:path*` },
    ];
  },
};
module.exports = nextConfig;
