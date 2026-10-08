import { describe, it, expect } from 'vitest';

describe('arranque', () => {
  it('fmt carga', async () => {
    expect(await import('../app/fmt.js')).toBeTruthy();
  });
});
