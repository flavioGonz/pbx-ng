/* ONVIF (electron/onvif.cjs): encontrar cámaras en la LAN (WS-Discovery multicast) y
 * sacarles la URL RTSP de cada perfil con la clave ya puesta. Lo que se fija es lo que el
 * técnico sufre si sale mal: la URL desescapada (&amp; literal = cámara que no anda), la
 * clave rechazada dicha como tal (aunque venga como HTTP 500), y los dos "no hay perfiles"
 * distinguidos porque mandan a mirar lugares distintos. La cámara es un servidor HTTP
 * real en 127.0.0.1; el multicast se reemplaza por un socket falso. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const onvif = require('../electron/onvif.cjs');
const dgram = require('dgram');

let srv, base, pedidos, responder;
beforeEach(async () => {
  pedidos = [];
  srv = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', (d) => { b += d; }); rq.on('end', () => {
      pedidos.push({ url: rq.url, body: b, headers: rq.headers });
      const [status, cuerpo] = responder(rq.url, b);
      if (status === 'colgar') return;   // no contesta nunca
      rs.writeHead(status, { 'Content-Type': 'application/soap+xml' }); rs.end(cuerpo);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
afterEach(() => { srv.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

const CAPS = (x) => `<env:Envelope><env:Body><tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>${x}</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse></env:Body></env:Envelope>`;
const PERFILES = `<trt:GetProfilesResponse>
  <trt:Profiles token="Prof_1" fixed="true"><tt:Name>Principal</tt:Name>
    <tt:VideoEncoderConfiguration token="v1"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution><tt:RateControl><tt:FrameRateLimit>25</tt:FrameRateLimit></tt:RateControl></tt:VideoEncoderConfiguration>
  </trt:Profiles>
  <trt:Profiles token="Prof_2"><tt:VideoEncoderConfiguration><tt:Encoding>H265</tt:Encoding></tt:VideoEncoderConfiguration></trt:Profiles>
  <trt:Profiles><tt:Name>sin token</tt:Name></trt:Profiles>
</trt:GetProfilesResponse>`;
const URI = (u) => `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>${u}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`;

describe('perfiles', () => {
  it('pide capacidades, perfiles y la URI de cada uno; desescapa y le pone la clave', async () => {
    responder = (url, b) => {
      if (/GetCapabilities/.test(b)) return [200, CAPS(base + '/onvif/media_service')];
      if (/GetProfiles/.test(b)) return [200, PERFILES];
      if (/Prof_1/.test(b)) return [200, URI('rtsp://192.168.1.50:554/Streaming/Channels/101?transportmode=unicast&amp;profile=Prof_1')];
      return [200, `<Envelope><Uri>rtsp://192.168.1.50/sub</Uri></Envelope>`];
    };
    const p = await onvif.perfiles({ xaddr: base + '/onvif/device_service', user: 'admin', pass: 'cl@ve:1' });
    expect(p).toEqual([
      { nombre: 'Principal', codec: 'H264', resolucion: '1920×1080', fps: 25, rtsp: 'rtsp://admin:cl%40ve%3A1@192.168.1.50:554/Streaming/Channels/101?transportmode=unicast&profile=Prof_1' },
      { nombre: 'Prof_2', codec: 'H265', resolucion: '', fps: null, rtsp: 'rtsp://admin:cl%40ve%3A1@192.168.1.50/sub' },
    ]);
    expect(pedidos[0].url).toBe('/onvif/device_service');
    expect(pedidos[1].url).toBe('/onvif/media_service');
    expect(pedidos[0].headers['content-type']).toMatch(/application\/soap\+xml/);
    // la clave no viaja en claro: va el digest WS-Security
    expect(pedidos[0].body).toContain('<Username>admin</Username>');
    expect(pedidos[0].body).not.toContain('cl@ve:1');
    const m = pedidos[0].body.match(/<Nonce[^>]*>([^<]+)<\/Nonce>.*<Created[^>]*>([^<]+)<\/Created>/);
    const dig = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(m[1], 'base64'), Buffer.from(m[2]), Buffer.from('cl@ve:1')])).digest('base64');
    expect(pedidos[0].body).toContain('#PasswordDigest">' + dig + '<');
  });

  it('sin usuario no manda cabecera de seguridad ni pone clave; sin capacidades cae a /onvif/Media', async () => {
    responder = (url, b) => {
      if (/GetCapabilities/.test(b)) return [500, '<Fault>no implementado</Fault>'];
      if (/GetProfiles/.test(b)) return [200, '<Profiles token="a&amp;b"><Name>&lt;Uno&gt; &quot;x&quot; &apos;y&apos; &#65;</Name></Profiles>'];
      return [200, URI('rtsp://cam/1')];
    };
    const p = await onvif.perfiles({ xaddr: base + '/onvif/device_service' });
    expect(pedidos[1].url).toBe('/onvif/Media');
    expect(pedidos[0].body).not.toContain('Security');
    expect(pedidos[2].body).toContain('<ProfileToken>a&amp;amp;b</ProfileToken>');
    expect(p).toEqual([{ nombre: '<Uno> "x" \'y\' A', codec: '', resolucion: '', fps: null, rtsp: 'rtsp://cam/1' }]);
  });

  it('capacidades sin XAddr de Media también cae al path estándar', async () => {
    responder = (url, b) => {
      if (/GetCapabilities/.test(b)) return [200, '<Capabilities/>'];
      if (/GetProfiles/.test(b)) return [200, '<Profiles token="t"></Profiles>'];
      return [200, URI('rtsp://cam/2')];
    };
    const p = await onvif.perfiles({ xaddr: base + '/x', user: 'u' });
    expect(pedidos[1].url).toBe('/onvif/Media');
    expect(p[0].rtsp).toBe('rtsp://u@cam/2');   // clave vacía: sólo el usuario
  });

  it('clave rechazada (aunque venga como 500) se dice con esas palabras', async () => {
    responder = () => [500, '<Fault><Subcode>ter:NotAuthorized</Subcode></Fault>'];
    await expect(onvif.perfiles({ xaddr: base + '/d', user: 'u', pass: 'mal' })).rejects.toThrow('usuario o contraseña rechazados por la cámara');
  });

  it('perfiles sin URI vs respuesta irreconocible: mensajes distintos', async () => {
    responder = (url, b) => {
      if (/GetProfiles/.test(b)) return [200, '<Profiles token="p1"></Profiles><Profiles token="p2"></Profiles>'];
      if (/GetStreamUri/.test(b)) return [500, 'error'];
      return [200, CAPS(base + '/m')];
    };
    await expect(onvif.perfiles({ xaddr: base + '/d' })).rejects.toThrow('la cámara devolvió 2 perfil(es) pero ninguno con URL RTSP (¿RTSP deshabilitado en la cámara?)');
    responder = (url, b) => (/GetProfiles/.test(b) ? [200, '<Profiles><Name>x</Name></Profiles>'] : [200, CAPS(base + '/m')]);
    await expect(onvif.perfiles({ xaddr: base + '/d' })).rejects.toThrow('la respuesta de la cámara no trae perfiles reconocibles');
    responder = (url, b) => (/GetProfiles/.test(b) ? [200, '<nada/>'] : [200, CAPS(base + '/m')]);
    await expect(onvif.perfiles({ xaddr: base + '/d' })).rejects.toThrow('la cámara no devolvió perfiles');
    responder = () => [404, 'no'];
    await expect(onvif.perfiles({ xaddr: base + '/d' })).rejects.toThrow('la cámara contestó HTTP 404');
  });

  it('una URI rara no rompe al ponerle la clave', async () => {
    responder = (url, b) => (/GetProfiles/.test(b) ? [200, '<Profiles token="p"></Profiles>'] : /GetStreamUri/.test(b) ? [200, URI('no es url')] : [200, '']);
    expect((await onvif.perfiles({ xaddr: base + '/d', user: 'u' }))[0].rtsp).toBe('no es url');
  });

  it('valida la dirección: falta, inválida o https', async () => {
    await expect(onvif.perfiles()).rejects.toThrow('falta la dirección de la cámara');
    await expect(onvif.perfiles({ xaddr: 'basura' })).rejects.toThrow('URL de servicio inválida');
    await expect(onvif.perfiles({ xaddr: 'https://cam/onvif' })).rejects.toThrow('ONVIF sólo por http en esta versión');
  });

  it('cámara que no contesta: timeout con mensaje claro', async () => {
    responder = () => ['colgar'];
    const http2 = require('http');
    const orig = http2.request;
    vi.spyOn(http2, 'request').mockImplementation((o, cb) => orig.call(http2, { ...o, timeout: 50 }, cb));
    await expect(onvif.perfiles({ xaddr: base + '/d' })).rejects.toThrow('la cámara no contestó a tiempo');
  });

  it('error de conexión se propaga', async () => {
    srv.close();
    await expect(onvif.perfiles({ xaddr: 'http://127.0.0.1:1/onvif' })).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('descubrir (WS-Discovery)', () => {
  function sockFalso() {
    const s = new EventEmitter();
    s.enviados = [];
    s.bind = (cb) => setTimeout(cb, 0);
    s.setBroadcast = vi.fn(); s.setMulticastTTL = vi.fn();
    s.send = vi.fn((b, o, l, port, host) => s.enviados.push({ xml: b.toString(), port, host }));
    s.close = vi.fn();
    return s;
  }
  const respuesta = (xaddrs, scopes = '') => Buffer.from(`<d:ProbeMatches><d:ProbeMatch><d:Scopes>${scopes}</d:Scopes><d:XAddrs>${xaddrs}</d:XAddrs></d:ProbeMatch></d:ProbeMatches>`);

  it('manda el Probe 3 veces al multicast y junta las cámaras sin repetir', async () => {
    const s = sockFalso();
    vi.spyOn(dgram, 'createSocket').mockReturnValue(s);
    const p = onvif.descubrir(1600);
    await new Promise((r) => setTimeout(r, 5));
    s.emit('message', respuesta('http://[fe80::1]/onvif http://192.168.1.50/onvif/device_service', 'onvif://www.onvif.org/name/Portero_Calle onvif://www.onvif.org/hardware/DS-KV6113'));
    s.emit('message', respuesta('http://192.168.1.50/onvif/device_service'));
    s.emit('message', respuesta('http://192.168.1.51/onvif'));
    s.emit('message', respuesta('https://solo.https/onvif'));
    s.emit('message', Buffer.from('<otra>cosa</otra>'));
    const r = await p;
    expect(s.enviados).toHaveLength(3);
    expect(s.enviados[0]).toMatchObject({ port: 3702, host: '239.255.255.250' });
    expect(s.enviados[0].xml).toContain('dn:NetworkVideoTransmitter');
    // de cada equipo se toma la PRIMERA http:// (acá la IPv6), y uno repetido no se duplica
    expect(r.map((x) => x.xaddr)).toEqual(['http://[fe80::1]/onvif', 'http://192.168.1.50/onvif/device_service', 'http://192.168.1.51/onvif']);
    expect(r[0]).toEqual({ xaddr: 'http://[fe80::1]/onvif', host: '[fe80::1]', nombre: 'Portero Calle', modelo: 'DS-KV6113' });
    expect(r[1]).toEqual({ xaddr: 'http://192.168.1.50/onvif/device_service', host: '192.168.1.50', nombre: '192.168.1.50', modelo: '' });
    expect(s.close).toHaveBeenCalled();
  });

  it('toma nombre y modelo de los Scopes', async () => {
    const s = sockFalso();
    vi.spyOn(dgram, 'createSocket').mockReturnValue(s);
    const p = onvif.descubrir(30);
    await new Promise((r) => setTimeout(r, 5));
    s.emit('message', respuesta('http://10.0.0.9/onvif', 'onvif://www.onvif.org/name/Portero_Calle onvif://www.onvif.org/hardware/DS%2DKV6113'));
    expect(await p).toEqual([{ xaddr: 'http://10.0.0.9/onvif', host: '10.0.0.9', nombre: 'Portero Calle', modelo: 'DS-KV6113' }]);
  });

  it('error de socket o sin poder crearlo: lista vacía, sin colgarse', async () => {
    const s = sockFalso();
    s.setBroadcast = () => { throw new Error('x'); };
    s.send = () => { throw new Error('x'); };
    s.close = () => { throw new Error('x'); };
    vi.spyOn(dgram, 'createSocket').mockReturnValue(s);
    const p = onvif.descubrir(5000);
    await new Promise((r) => setTimeout(r, 5));
    s.emit('error', new Error('EADDRINUSE'));
    expect(await p).toEqual([]);
    dgram.createSocket.mockImplementation(() => { throw new Error('x'); });
    expect(await onvif.descubrir()).toEqual([]);
  });
});

describe('onvif: bordes', () => {
  it('servicio sin puerto explícito va al 80; un XAddr con host inválido se anota sin host', async () => {
    const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
    const spy = vi.spyOn(http, 'request').mockImplementation(() => { setTimeout(() => req.emit('error', new Error('nada')), 0); return req; });
    await expect(onvif.perfiles({ xaddr: 'http://camara.local/onvif' })).rejects.toThrow('nada');
    expect(spy.mock.calls[0][0]).toMatchObject({ hostname: 'camara.local', port: 80 });
    const s = new EventEmitter();
    s.bind = (cb) => cb(); s.setBroadcast = vi.fn(); s.setMulticastTTL = vi.fn(); s.send = vi.fn(); s.close = vi.fn();
    vi.spyOn(dgram, 'createSocket').mockReturnValue(s);
    vi.useFakeTimers();
    const p = onvif.descubrir();
    s.emit('message', Buffer.from('<XAddrs>http://[malo/onvif</XAddrs>'));
    vi.advanceTimersByTime(4000);
    expect(await p).toEqual([{ xaddr: 'http://[malo/onvif', host: '', nombre: '', modelo: '' }]);
  });
});
