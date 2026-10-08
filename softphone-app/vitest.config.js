import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

/* Las pruebas del softphone. Va aparte de vite.config.js para no cargar el plugin de la
 * PWA (genera el service worker) en cada corrida. La cobertura mínima es la misma regla
 * que el resto del proyecto: 90 % de líneas, ramas y funciones, o el CI falla. */
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{js,jsx}'],
    setupFiles: ['test/setup.js'],
    restoreMocks: true,
    /* Mantine en jsdom, con cobertura y los archivos en paralelo, pasa los 5 s por defecto
     * en una máquina cargada (o en el runner del CI): que una prueba lenta no se vea rota. */
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.{js,jsx}', 'electron/**/*.cjs'],
      reporter: ['text-summary', 'text', 'lcov'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
