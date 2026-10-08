import { describe, it, expect } from 'vitest';

describe('arranque', () => {
  it('el módulo de configuración carga', async () => {
    const m = await import('../src/config.js');
    expect(m).toBeTruthy();
  });
});
