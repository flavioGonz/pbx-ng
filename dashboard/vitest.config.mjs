import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/* Las pruebas del panel. Next no usa Vite para compilar, pero Vitest sí: con el plugin de
 * React alcanza para el JSX de app/. La cobertura mínima es la regla del proyecto: 90 % de
 * líneas, ramas y funciones, o el CI falla. */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{js,jsx}'],
    setupFiles: ['test/setup.js'],
    restoreMocks: true,
    /* Mantine en jsdom, con cobertura y los archivos en paralelo, pasa los 5 s por defecto
     * en una máquina cargada (o en el runner del CI): que una prueba lenta no se vea rota. */
    testTimeout: 30000,
    css: false,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['app/**/*.{js,jsx}', 'server.js'],
      reporter: ['text-summary', 'text', 'lcov'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
