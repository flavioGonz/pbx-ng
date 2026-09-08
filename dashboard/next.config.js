/** @type {import('next').NextConfig} */
/* Sin `rewrites` hacia la API: los hace server.js (proxy propio) porque el de Next no
 * agrega X-Forwarded-For y el rate limit del login de la API depende de esa cabecera.
 * API_URL se lee al arrancar server.js, no en el build. */
/* Content-Security-Policy del panel.
 *
 * Por qué `script-src 'unsafe-inline'` y no un nonce: Next 14 sólo propaga un nonce a
 * los scripts que inyecta (el bootstrap del App Router y los `self.__next_f.push` con
 * el payload de RSC) si la CSP la pone un `middleware.js`, porque el nonce se lee de la
 * cabecera del *request*. Acá la CSP sale de `headers()` (respuesta), que además queda
 * cacheada por página estática: el mismo nonce para todos los clientes no sería un
 * nonce. Sumar un middleware sólo para esto obligaría a que TODA página pase por el
 * runtime (adiós al render estático) y encima `ColorSchemeScript` de Mantine mete su
 * propio inline en el `<head>`. Con 'unsafe-inline' el panel queda igual de expuesto a
 * XSS reflejado que sin CSP en ese vector, pero el resto de la política (object-src,
 * base-uri, frame-ancestors, connect-src) sigue valiendo. Si algún día se agrega
 * middleware, se pasa a nonce y se saca 'unsafe-inline' (los navegadores IGNORAN
 * 'unsafe-inline' si hay nonce, así que no se puede dejar como respaldo).
 *
 * Las excepciones a 'self' son todas cosas que ya existen en el panel:
 *  - unpkg.com en script/style: leaflet (`/mapa`, `/clientes/[id]`) y wavesurfer
 *    (`RecordingPlayer`) se cargan por CDN a demanda. Deuda: bajarlos a `public/vendor`
 *    y sacar el CDN de la política (ver informe).
 *  - fonts.googleapis.com (hoja) + fonts.gstatic.com (woff2): Inter y JetBrains Mono
 *    del `layout.jsx`, y el `@import` de la pantalla de login.
 *  - img-src https:: banderas de flagcdn, favicons de ISP de `/seguridad`, tiles de
 *    carto/OSM y el fondo del login. `data:`/`blob:` para los QR y las previews.
 *  - media-src blob:: los audios (grabaciones, buzón, prompts de IVR) se bajan por
 *    fetch con token y se reproducen desde un ObjectURL, nunca por URL directa.
 *  - worker-src blob:: `/sw.js` es 'self', pero el blob: cubre a cualquier lib que se
 *    arme un worker en memoria (cobe no lo hace: dibuja WebGL en el canvas principal,
 *    y WebGL no lo mira la CSP).
 * connect-src queda en 'self' porque todo va por el mismo origen: la API por /backend,
 * el socket por /socket.io y el SIP del softphone por wss://<host>/ws (CSP3 hace que
 * 'self' matchee ws/wss del mismo host y puerto). */
const dev = process.env.NODE_ENV === 'development';
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  // 'unsafe-eval' sólo en `next dev`: el HMR de webpack evalúa los módulos.
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''} https://unpkg.com`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), microphone=(self), camera=(self)' },
  { key: 'Content-Security-Policy', value: CSP },
];
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',               // imagen Docker chica: solo server.js + .next/static + public (antes ~1.4 GB)
  skipTrailingSlashRedirect: true,   // por si un /socket.io/ llega a Next (no debería: lo toma server.js antes)
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      /* El panel es una app con login: su HTML NO debe quedar en cachés compartidas.
       * Next marca las páginas prerenderizadas con s-maxage de un año, así que un
       * proxy delante se queda con el HTML viejo y sigue sirviendo los chunks de
       * la build anterior — cada deploy "no aparece" hasta que caduque. Se excluyen
       * los assets de /_next/static, que SÍ conviene cachear: llevan hash en el
       * nombre, así que un deploy nuevo genera nombres nuevos. */
      {
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },
};
module.exports = nextConfig;
