import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

/* La version se lee del package.json y se inyecta en el bundle. Antes estaba escrita a
 * mano en App.jsx y se olvidaba: la aplicacion decia 0.5.0 en Ajustes y en el pie del
 * menu lateral mientras el instalador ya era otro, y encima el chequeo de actualizacion
 * comparaba contra una version que no era la que corria. */
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// base './' para que el build sirva tanto en un subpath web como empaquetado en Electron (file://)
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'PBX-NG Softphone',
        short_name: 'Softphone',
        description: 'Softphone WebRTC para cualquier central',
        theme_color: '#0b1220',
        background_color: '#0b1220',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ],
  server: { host: true, port: 5180 }
});
