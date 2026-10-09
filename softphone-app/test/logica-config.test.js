/* Configuración del softphone (src/config.js): dónde quedan la cuenta SIP, las cuentas
 * guardadas y los clientes/cámaras del aparato. Importa porque son credenciales: en
 * Electron tienen que ir al almacén cifrado (DPAPI) y NUNCA quedar en localStorage en
 * claro; y porque una instalación vieja (config plana, o sin clientes) tiene que migrar
 * sin que el operador pierda su interno. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import './helpers/logica-storage.js';

let cfg;
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  delete window.sphone;
  cfg = await import('../src/config.js');
});

describe('loadConfig / saveConfig', () => {
  it('sin nada guardado devuelve los valores por defecto, sin STUN público', () => {
    const c = cfg.loadConfig();
    expect(c.transport).toBe('webrtc');
    expect(c.stun).toBe('');
    expect(c.sipPort).toBe('5060');
  });

  it('en navegador guarda en localStorage y vuelve a leerlo', () => {
    cfg.saveConfig({ ext: '101', wss: 'wss://x/ws' });
    const raw = JSON.parse(localStorage.getItem('sp_config'));
    expect(raw.config.ext).toBe('101');
    expect(raw.accounts).toEqual([]);
    expect(cfg.loadConfig().ext).toBe('101');
  });

  it('migra la config plana vieja (pre-cuentas) al leer', () => {
    localStorage.setItem('sp_config', JSON.stringify({ ext: '200', domain: 'pbx' }));
    const c = cfg.loadConfig();
    expect(c.ext).toBe('200');
    expect(c.domain).toBe('pbx');
  });

  it('un JSON roto en localStorage no rompe: vuelven los defaults', () => {
    localStorage.setItem('sp_config', '{no');
    expect(cfg.loadConfig().ext).toBe('');
  });

  it('en Electron guarda cifrado y borra la copia en claro de localStorage', () => {
    localStorage.setItem('sp_config', 'viejo');
    const secureSave = vi.fn();
    window.sphone = { secureSave };
    cfg.saveConfig({ ext: '7', pass: 'secreta' });
    expect(secureSave).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secureSave.mock.calls[0][0]).config.pass).toBe('secreta');
    expect(localStorage.getItem('sp_config')).toBeNull();
  });

  it('si el almacén cifrado tira error, no se cae la app', () => {
    window.sphone = { secureSave: () => { throw new Error('dpapi'); } };
    expect(() => cfg.saveConfig({ ext: '1' })).not.toThrow();
  });
});

describe('cuentas', () => {
  it('lee las cuentas del formato nuevo y devuelve una copia', () => {
    localStorage.setItem('sp_config', JSON.stringify({ config: null, accounts: [{ ext: '1' }] }));
    const a = cfg.getAccounts();
    expect(a).toEqual([{ ext: '1' }]);
    a.push({ ext: '2' });
    expect(cfg.getAccounts()).toHaveLength(1);
  });

  it('setAccounts persiste y null queda como lista vacía', () => {
    cfg.setAccounts([{ ext: '9' }]);
    expect(cfg.getAccounts()).toEqual([{ ext: '9' }]);
    cfg.setAccounts(null);
    expect(cfg.getAccounts()).toEqual([]);
  });

  it('sin nada guardado no hay cuentas', () => {
    expect(cfg.getAccounts()).toEqual([]);
  });
});

describe('clientes locales del aparato', () => {
  it('esLocal reconoce solo ids con prefijo loc_', () => {
    expect(cfg.esLocal({ id: 'loc_abc' })).toBe(true);
    expect(cfg.esLocal({ id: '12' })).toBe(false);
    expect(cfg.esLocal({ id: 12 })).toBe(false);
    expect(cfg.esLocal(null)).toBe(false);
  });

  it('nuevoIdLocal genera ids distintos aun en el mismo milisegundo', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const a = cfg.nuevoIdLocal(), b = cfg.nuevoIdLocal();
    expect(a.startsWith('loc_')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('sin crypto cae a Math.random', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      expect(cfg.nuevoIdLocal()).toMatch(/^loc_[0-9a-z]+$/);
    } finally { vi.unstubAllGlobals(); }
  });

  it('guarda y lee clientes, y el formato viejo sin clientes devuelve lista vacía', () => {
    expect(cfg.getClientesLocales()).toEqual([]);
    cfg.setClientesLocales([{ id: 'loc_1', name: 'Edificio' }]);
    expect(cfg.getClientesLocales()[0].name).toBe('Edificio');
    cfg.setClientesLocales(undefined);
    expect(cfg.getClientesLocales()).toEqual([]);
  });

  it('lee clientes guardados por otra sesión desde localStorage', () => {
    localStorage.setItem('sp_config', JSON.stringify({ clientes: [{ id: 'loc_z' }] }));
    expect(cfg.getClientesLocales()).toEqual([{ id: 'loc_z' }]);
  });
});

describe('hydrateSecure (arranque en Electron)', () => {
  it('en navegador no hace nada', async () => {
    await cfg.hydrateSecure();
    expect(cfg.loadConfig().ext).toBe('');
  });

  it('carga el almacén cifrado con el formato nuevo', async () => {
    window.sphone = { secureLoad: async () => JSON.stringify({ config: { ext: '55' }, accounts: [{ ext: '55' }], clientes: [{ id: 'loc_1' }] }) };
    await cfg.hydrateSecure();
    expect(cfg.loadConfig().ext).toBe('55');
    expect(cfg.getAccounts()).toHaveLength(1);
    expect(cfg.getClientesLocales()).toHaveLength(1);
  });

  it('formato nuevo con campos faltantes quedan vacíos', async () => {
    window.sphone = { secureLoad: async () => JSON.stringify({ accounts: [{ ext: '1' }] }) };
    await cfg.hydrateSecure();
    expect(cfg.getAccounts()).toEqual([{ ext: '1' }]);
    expect(cfg.loadConfig().ext).toBe('');
  });

  it('migra la config plana cifrada', async () => {
    window.sphone = { secureLoad: async () => JSON.stringify({ ext: '33' }) };
    await cfg.hydrateSecure();
    expect(cfg.loadConfig().ext).toBe('33');
  });

  it('un cifrado ilegible deja la config vacía', async () => {
    window.sphone = { secureLoad: async () => 'basura' };
    await cfg.hydrateSecure();
    expect(cfg.loadConfig().ext).toBe('');
  });

  it('si el almacén está vacío migra lo de localStorage al cifrado y borra la copia en claro', async () => {
    localStorage.setItem('sp_config', JSON.stringify({ config: { ext: '44', pass: 'p' }, accounts: [{ ext: '44' }] }));
    const secureSave = vi.fn(async () => {});
    window.sphone = { secureLoad: async () => '', secureSave };
    await cfg.hydrateSecure();
    expect(secureSave).toHaveBeenCalled();
    expect(JSON.parse(secureSave.mock.calls[0][0]).config.pass).toBe('p');
    expect(localStorage.getItem('sp_config')).toBeNull();
    expect(cfg.loadConfig().ext).toBe('44');
  });

  it('migración: config plana en localStorage sin cuentas', async () => {
    localStorage.setItem('sp_config', JSON.stringify({ config: { ext: '1' } }));
    window.sphone = { secureLoad: async () => null, secureSave: async () => { throw new Error('x'); } };
    await cfg.hydrateSecure();
    expect(cfg.loadConfig().ext).toBe('1');
    // si el guardado cifrado falla, no se borra la copia: no perder la cuenta
    expect(localStorage.getItem('sp_config')).not.toBeNull();
  });

  it('almacén vacío y nada en localStorage: queda todo por defecto', async () => {
    window.sphone = { secureLoad: async () => null };
    await cfg.hydrateSecure();
    expect(cfg.getAccounts()).toEqual([]);
  });

  it('si secureLoad explota, no se propaga', async () => {
    window.sphone = { secureLoad: async () => { throw new Error('x'); } };
    await expect(cfg.hydrateSecure()).resolves.toBeUndefined();
  });
});

describe('isComplete', () => {
  it('pide wss, dominio, interno y clave en WebRTC', () => {
    expect(cfg.isComplete(null)).toBe(false);
    expect(cfg.isComplete({ wss: 'w', domain: 'd', ext: 'e', pass: 'p' })).toBe(true);
    expect(cfg.isComplete({ wss: '', domain: 'd', ext: 'e', pass: 'p' })).toBe(false);
  });
  it('en SIP nativo pide el servidor SIP en vez del wss', () => {
    expect(cfg.isComplete({ transport: 'sip', sipServer: 's', domain: 'd', ext: 'e', pass: 'p' })).toBe(true);
    expect(cfg.isComplete({ transport: 'sip', wss: 'w', domain: 'd', ext: 'e', pass: 'p' })).toBe(false);
  });
});
