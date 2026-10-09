/* El servidor del panel (`server.js`): Next + el proxy propio hacia la API.
 *
 * Qué se fija y por qué importa: la API confía en UN salto, así que el X-Forwarded-For
 * que arma este proxy es lo que decide la IP de cada cliente (cupo de login, baneos del
 * SOC). Si se puede falsear, cualquiera en la LAN se hace pasar por otro; si se recorta
 * de más, toda la oficina comparte un cupo. También: que /backend se reescriba a la API,
 * que la API caída se vea como un 502 JSON (y no como una página de Next rota), que el
 * video de los porteros exija la entrada de un solo uso, y que los WebSocket pasen.
 *
 * Se levanta una API falsa en 127.0.0.1 con puerto 0 y se reemplaza `next` por un doble:
 * no hay red real ni build de Next. */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

/* ---- API falsa ---- */
const socketsApi = new Set();
let api, apiPort, pedidos = [], modoVerify = 200, modoGo2rtc = 200;
function arrancarApi() {
  return new Promise((ok) => {
    api = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        pedidos.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url.startsWith('/api/intercom/ticket/verify')) {
          const q = new URL(req.url, 'http://x').searchParams;
          if (modoVerify === 'colgar') return;
          res.writeHead(q.get('t') === 'bueno' ? modoVerify : 403); return res.end();
        }
        if (req.url === '/api' && req.method === 'GET' && !req.headers['x-forwarded-for']) { if (modoGo2rtc === 'colgar') return; res.writeHead(modoGo2rtc); return res.end(); }
        res.writeHead(201, { 'content-type': 'application/json', 'x-api': '1' });
        res.end(JSON.stringify({ url: req.url, body }));
      });
    });
    api.on('upgrade', (req, socket) => {
      pedidos.push({ method: 'UPGRADE', url: req.url, headers: req.headers });
      if (req.url.includes('rechazar')) {
        socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 2\r\n\r\nno');
        return;
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nHOLA');
      if (req.url.includes('cortar')) { setTimeout(() => socket.destroy(), 20); return; }
      socket.on('data', (d) => socket.write('eco:' + d));
    });
    // Los sockets que pasaron a WebSocket el server ya no los sigue: se cierran a mano.
    api.on('connection', (c) => { socketsApi.add(c); c.on('close', () => socketsApi.delete(c)); });
    api.listen(0, '127.0.0.1', () => { apiPort = api.address().port; ok(); });
  });
}

/* ---- carga de server.js con next falso ---- */
const cargados = [];
async function cargar(env = {}, { prepare = () => Promise.resolve(), upgrade = true, host = '127.0.0.1' } = {}) {
  const viejo = { ...process.env };
  Object.assign(process.env, {
    API_URL: 'http://127.0.0.1:' + apiPort, GO2RTC_URL_INTERNA: 'http://127.0.0.1:' + apiPort,
    HOSTNAME: '127.0.0.1', NODE_ENV: 'production', TRUST_PROXY: '', COMPOSE_PROFILES: '',
  }, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  const handle = vi.fn((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('next:' + req.url); });
  const handleUpgrade = vi.fn((req, socket) => { socket.end('HTTP/1.1 426 Next\r\n\r\n'); });
  const envEnNext = {};
  const nextFn = vi.fn(() => (envEnNext.standalone = process.env.__NEXT_PRIVATE_STANDALONE_CONFIG, {
    getRequestHandler: () => handle,
    ...(upgrade ? { getUpgradeHandler: () => handleUpgrade } : {}),
    prepare,
  }));
  const idNext = require.resolve('next');
  require.cache[idNext] = { id: idNext, filename: idNext, loaded: true, exports: nextFn };
  let server;
  const origCreate = http.createServer;
  const spy = vi.spyOn(http, 'createServer').mockImplementation((...a) => {
    server = origCreate(...a);
    const listen = server.listen.bind(server);
    server.listen = (_p, _h, cb) => listen(0, host, cb);
    return server;
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  /* Por el cargador de Vitest (y no con `require` nativo) para que la cobertura de v8
   * salga con el mapa de fuentes bien; Vitest le da `require`/`__dirname` igual que CJS. */
  vi.resetModules();
  try { await import('../server.js'); } finally { Object.keys(process.env).forEach((k) => { if (!(k in viejo)) delete process.env[k]; }); Object.assign(process.env, viejo); }
  for (let i = 0; i < 50 && !(server && server.listening); i++) await new Promise((r) => setTimeout(r, 10));
  spy.mockRestore();
  const s = { envEnNext, server, handle, handleUpgrade, nextFn, log, port: server && server.listening ? server.address().port : null };
  cargados.push(s);
  return s;
}

function pedir(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((ok, ko) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', ko);
    if (body) r.write(body);
    r.end();
  });
}
function crudo(port, texto, { esperar = 'HOLA', escribirDespues } = {}) {
  return new Promise((ok) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(texto));
    let b = '';
    s.on('data', (d) => {
      b += d;
      if (escribirDespues && b.includes(esperar)) { s.write(escribirDespues); escribirDespues = null; }
      else if (b.includes('eco:') || (!escribirDespues && esperar && b.includes(esperar) && esperar !== 'HOLA')) s.destroy();
    });
    s.on('close', () => ok(b));
    s.on('error', () => ok(b));
    setTimeout(() => s.destroy(), 1500);
  });
}

beforeAll(arrancarApi);
afterEach(() => { pedidos = []; modoVerify = 200; modoGo2rtc = 200; vi.restoreAllMocks(); while (cargados.length) { const s = cargados.pop(); if (s.server) { s.server.closeAllConnections(); s.server.close(); } } });
afterAll(() => new Promise((r) => { socketsApi.forEach((c) => c.destroy()); api.close(r); }));

describe('arranque', () => {
  it('levanta Next en prod y anuncia a dónde proxya', async () => {
    const { nextFn, log, port } = await cargar();
    expect(port).toBeGreaterThan(0);
    expect(nextFn).toHaveBeenCalledWith(expect.objectContaining({ dev: false, hostname: '127.0.0.1', port: 3001 }));
    expect(log.mock.calls.some((c) => /\[panel\] Next prod .* → API http:\/\/127\.0\.0\.1:\d+ \(TRUST_PROXY=0\)/.test(c[0]))).toBe(true);
  });

  it('modo dev, puerto propio y config del standalone embebida', async () => {
    const rsf = vi.spyOn(fs, 'readFileSync');
    const { nextFn } = await cargar({ NODE_ENV: 'development', PORT: '4555' });
    expect(nextFn).toHaveBeenCalledWith(expect.objectContaining({ dev: true, port: 4555 }));
    expect(rsf.mock.calls.some((c) => String(c[0]).includes('required-server-files'))).toBe(false);
    rsf.mockRestore();
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...a) => (String(p).endsWith('required-server-files.json') ? JSON.stringify({ config: { output: 'standalone' } }) : real(p, ...a)));
    const { envEnNext } = await cargar({ __NEXT_PRIVATE_STANDALONE_CONFIG: undefined });
    expect(JSON.parse(envEnNext.standalone)).toEqual({ output: 'standalone' });
    // Si el entorno ya trae la config, no se relee el archivo.
    const { envEnNext: e2 } = await cargar({ __NEXT_PRIVATE_STANDALONE_CONFIG: '{"ya":1}' });
    expect(e2.standalone).toBe('{"ya":1}');
  });

  it('el standalone sin `config` no toca el entorno, y si Next no arranca el proceso sale con 1', async () => {
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...a) => (String(p).endsWith('required-server-files.json') ? '{}' : real(p, ...a)));
    const ex = await cargar({ __NEXT_PRIVATE_STANDALONE_CONFIG: undefined });
    expect(ex.envEnNext.standalone).toBeUndefined();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cargar({ __NEXT_PRIVATE_STANDALONE_CONFIG: undefined }, { prepare: () => Promise.reject(new Error('sin build')) });
    await new Promise((r) => setTimeout(r, 20));
    expect(err).toHaveBeenCalledWith('[panel] no arranca:', expect.any(Error));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('TRUST_PROXY: explícito, inválido (0) o inferido del perfil `proxy` de compose', async () => {
    const a = await cargar({ TRUST_PROXY: '2' });
    expect(a.log.mock.calls.some((c) => /TRUST_PROXY=2/.test(c[0]))).toBe(true);
    const b = await cargar({ TRUST_PROXY: 'nada' });
    expect(b.log.mock.calls.some((c) => /TRUST_PROXY=0/.test(c[0]))).toBe(true);
    const c = await cargar({ COMPOSE_PROFILES: 'base, proxy' });
    expect(c.log.mock.calls.some((x) => /TRUST_PROXY=1/.test(x[0]))).toBe(true);
  });
});

describe('valores por defecto', () => {
  it('sin variables: API en 127.0.0.1:3000 y go2rtc por sus dos nombres de compose', async () => {
    const { log } = await cargar({ HOSTNAME: undefined, API_URL: undefined, GO2RTC_URL_INTERNA: undefined });
    expect(log.mock.calls.some((c) => / → API http:\/\/127\.0\.0\.1:3000 /.test(c[0]))).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  it('una API sin puerto en la URL va al 80 (nombre que no resuelve: 502 con el código)', async () => {
    const { port } = await cargar({ API_URL: 'http://pbx-api.invalid', GO2RTC_URL_INTERNA: 'http://go2rtc.invalid' });
    const r = await pedir(port, { path: '/backend/api/x' });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error).toMatch(/^la API no responde \((ENOTFOUND|EAI_AGAIN)\)$/);
    expect((await pedir(port, { path: '/camaras/api/frame.jpeg?t=bueno&src=a' })).status).toBe(403);
    expect(await crudo(port, 'GET /socket.io/ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')).toBe('');
  });
});

describe('ruteo HTTP', () => {
  it('lo que no es de la API va a Next', async () => {
    const { port, handle } = await cargar();
    const r = await pedir(port, { path: '/troncales' });
    expect(r.body).toBe('next:/troncales');
    expect(handle).toHaveBeenCalled();
  });

  it('/backend se reescribe sin el prefijo y viaja con método, cuerpo y status tal cual', async () => {
    const { port } = await cargar();
    const r = await pedir(port, { method: 'POST', path: '/backend/api/users?x=1', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(201);
    expect(r.headers['x-api']).toBe('1');
    expect(JSON.parse(r.body)).toEqual({ url: '/api/users?x=1', body: '{"a":1}' });
    expect((await pedir(port, { path: '/backend' })).body).toContain('"url":"/"');
  });

  it('/socket.io, /prov y /descargas/softphone van a la API con su ruta', async () => {
    const { port } = await cargar();
    expect(JSON.parse((await pedir(port, { path: '/socket.io/?EIO=4' })).body).url).toBe('/socket.io/?EIO=4');
    expect(JSON.parse((await pedir(port, { path: '/prov/aa.cfg' })).body).url).toBe('/prov/aa.cfg');
    expect(JSON.parse((await pedir(port, { path: '/descargas/softphone/x.exe' })).body).url).toBe('/softphone/x.exe');
    expect((await pedir(port, { path: '/backendx' })).body).toBe('next:/backendx');
  });

  it('API caída: 502 JSON con el código del error', async () => {
    const { port } = await cargar({ API_URL: 'http://127.0.0.1:1' });
    const r = await pedir(port, { path: '/backend/api/x' });
    expect(r.status).toBe(502);
    expect(r.headers['content-type']).toContain('application/json');
    expect(JSON.parse(r.body).error).toMatch(/^la API no responde \(ECONNREFUSED\)$/);
  });
});

describe('X-Forwarded-For y compañía', () => {
  const ultimo = () => pedidos.filter((p) => p.url.startsWith('/api/eco')).at(-1).headers;

  it('sin proxy adelante: la IP del socket va última y un XFF inventado no gana', async () => {
    const { port } = await cargar();
    await pedir(port, { path: '/backend/api/eco', headers: { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'falso', connection: 'keep-alive', 'proxy-authorization': 'x' } });
    const h = ultimo();
    expect(h['x-forwarded-for']).toBe('1.2.3.4, 127.0.0.1');
    expect(h['x-real-ip']).toBe('127.0.0.1');
    expect(h['x-forwarded-proto']).toBe('http');
    expect(h['x-forwarded-host']).toBe('127.0.0.1:' + port);
    expect(h['x-forwarded-port']).toBe(String(port));
    expect(h['proxy-authorization']).toBeUndefined();
  });

  it('con un proxy confiable: se recorta su salto y se respetan proto/host/port', async () => {
    const { port } = await cargar({ TRUST_PROXY: '1' });
    await pedir(port, { path: '/backend/api/eco', headers: { 'x-forwarded-for': 'spoof, 198.51.100.7', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'pbx.cliente', 'x-forwarded-port': '443' } });
    const h = ultimo();
    expect(h['x-forwarded-for']).toBe('spoof, 198.51.100.7');
    expect(h['x-real-ip']).toBe('198.51.100.7');
    expect([h['x-forwarded-proto'], h['x-forwarded-host'], h['x-forwarded-port']]).toEqual(['https', 'pbx.cliente', '443']);
  });

  it('socket dual-stack: la IPv4 mapeada (::ffff:) llega limpia; sin Host, host vacío', async () => {
    const { port } = await cargar({}, { host: '::' });
    await pedir(port, { path: '/backend/api/eco' });
    expect(ultimo()['x-forwarded-for']).toBe('127.0.0.1');
    await crudo(port, 'GET /backend/api/eco HTTP/1.0\r\n\r\n', { esperar: '}' });
    expect(ultimo()['x-forwarded-host']).toBe('');
  });

  it('TRUST_PROXY mal puesto (de más) nunca recorta la IP del socket', async () => {
    const { port } = await cargar({ TRUST_PROXY: '5' });
    await pedir(port, { path: '/backend/api/eco' });
    expect(ultimo()['x-forwarded-for']).toBe('127.0.0.1');
  });
});

describe('video de porteros (go2rtc)', () => {
  it('sin entrada válida: 403 y no se pide nada a go2rtc', async () => {
    const { port } = await cargar();
    for (const q of ['', '?t=malo&src=puerta', '?t=bueno']) {
      const r = await pedir(port, { path: '/camaras/api/frame.jpeg' + q });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error).toBe('entrada de video inválida o vencida');
    }
    expect(pedidos.some((p) => p.url.startsWith('/api/frame.jpeg'))).toBe(false);
  });

  it('con entrada válida pasa a go2rtc sin el prefijo /camaras', async () => {
    const { port } = await cargar();
    const r = await pedir(port, { path: '/camaras/api/stream.mjpeg?t=bueno&src=puerta%201' });
    expect(r.status).toBe(201);
    expect(JSON.parse(r.body).url).toBe('/api/stream.mjpeg?t=bueno&src=puerta%201');
    const v = pedidos.find((p) => p.url.startsWith('/api/intercom/ticket/verify'));
    expect(v.url).toBe('/api/intercom/ticket/verify?t=bueno&src=puerta%201');
  });

  it('la administración de go2rtc NO se publica: va a Next', async () => {
    const { port } = await cargar();
    expect((await pedir(port, { path: '/camaras/api/streams' })).body).toBe('next:/camaras/api/streams');
  });

  it('go2rtc ausente: 502 «el servicio de video no está corriendo»', async () => {
    const { port, log } = await cargar({ GO2RTC_URL_INTERNA: 'http://127.0.0.1:1, ' });
    await new Promise((r) => setTimeout(r, 50));
    expect(log.mock.calls.some((c) => /go2rtc no encontrado \(http:\/\/127\.0\.0\.1:1\)/.test(c[0]))).toBe(true);
    const r = await pedir(port, { path: '/camaras/api/frame.jpeg?t=bueno&src=a' });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error).toBe('el servicio de video no está corriendo');
  });

  it('go2rtc que contesta 5xx no cuenta como vivo; la API de verificación caída es entrada inválida', async () => {
    modoGo2rtc = 503;
    const { port } = await cargar();
    await new Promise((r) => setTimeout(r, 50));
    expect((await pedir(port, { path: '/camaras/api/frame.jpeg?t=bueno&src=a' })).status).toBe(502);
    const b = await cargar({ API_URL: 'http://127.0.0.1:1' });
    expect((await pedir(b.port, { path: '/camaras/api/frame.jpeg?t=bueno&src=a' })).status).toBe(403);
  });
});

describe('sondas que no contestan', () => {
  it('go2rtc colgado no cuenta como vivo y una verificación colgada es entrada inválida (por timeout)', async () => {
    modoGo2rtc = 'colgar'; modoVerify = 'colgar';
    const { port } = await cargar();
    const r = await pedir(port, { path: '/camaras/api/frame.jpeg?t=bueno&src=a' });
    expect(r.status).toBe(403);
    modoVerify = 200;
    const r2 = await pedir(port, { path: '/camaras/api/frame.jpeg?t=bueno&src=a' });
    expect(r2.status).toBe(502);
  }, 15000);
});

describe('WebSocket (upgrade)', () => {
  const up = (p, extra = '') => `GET ${p} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${extra}\r\n`;

  it('socket.io pasa a la API, con head y datos en los dos sentidos', async () => {
    const { port } = await cargar();
    const b = await crudo(port, up('/socket.io/?EIO=4&transport=websocket') + 'PRIMERO', { escribirDespues: 'ping' });
    expect(b).toMatch(/^HTTP\/1\.1 101 Switching Protocols/);
    expect(b).toContain('HOLA');
    expect(b).toContain('eco:');
    const p = pedidos.find((x) => x.method === 'UPGRADE');
    expect(p.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(p.headers.upgrade).toBe('websocket');
  });

  it('si la API contesta sin upgrade (401 del handshake) se devuelve tal cual', async () => {
    const { port } = await cargar();
    const b = await crudo(port, up('/socket.io/?rechazar=1'), { esperar: 'no' });
    expect(b).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
  });

  it('si la API corta el WebSocket, el del navegador también se cierra', async () => {
    const { port } = await cargar();
    const b = await crudo(port, up('/socket.io/?cortar=1'));
    expect(b).toMatch(/^HTTP\/1\.1 101/);
    expect(b).toContain('HOLA');
  });

  it('si el navegador se va a mitad del handshake no queda nada colgado', async () => {
    const { port } = await cargar();
    await new Promise((ok) => {
      const s = net.connect(port, '127.0.0.1', () => { s.write(up('/socket.io/?cortar=1')); setTimeout(() => { s.resetAndDestroy(); ok(); }, 5); });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(pedidos.some((p) => p.method === 'UPGRADE')).toBe(true);
  });

  it('API caída: el socket se cierra', async () => {
    const { port } = await cargar({ API_URL: 'http://127.0.0.1:1' });
    expect(await crudo(port, up('/socket.io/'))).toBe('');
  });

  it('rutas que no son de la API van al upgrade de Next (HMR), o se cierran si no hay', async () => {
    const a = await cargar();
    expect(await crudo(a.port, up('/_next/webpack-hmr'), { esperar: 'Next' })).toContain('426 Next');
    expect(a.handleUpgrade).toHaveBeenCalled();
    const b = await cargar({}, { upgrade: false });
    expect(await crudo(b.port, up('/_next/webpack-hmr'))).toBe('');
  });

  it('video por WebSocket: sin entrada 403, sin go2rtc 502, y con todo bien pasa', async () => {
    const a = await cargar();
    expect(await crudo(a.port, up('/camaras/api/ws?src=a'), { esperar: 'close' })).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    const ok = await crudo(a.port, up('/camaras/api/ws?t=bueno&src=a'), { escribirDespues: 'x' });
    expect(ok).toMatch(/^HTTP\/1\.1 101/);
    const b = await cargar({ GO2RTC_URL_INTERNA: 'http://127.0.0.1:1' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await crudo(b.port, up('/camaras/api/ws?t=bueno&src=a'), { esperar: 'close' })).toMatch(/^HTTP\/1\.1 502 Bad Gateway/);
  });
});
