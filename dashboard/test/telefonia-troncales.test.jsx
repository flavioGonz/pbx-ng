/* ============================================================================
 *  Troncales: la topología (/troncales) y el cajón que crea o edita una troncal
 *  (TrunkEditor).
 *
 *  Lo que se fija:
 *   - el diagrama y la lista cuentan las troncales propias y cuántas están arriba, con
 *     el SBC-NG sólo cuando el backend dice que hay uno; el detalle de una troncal sale
 *     al tocarla (en la lista o en el nodo) y desde ahí se edita o se borra;
 *   - crear una troncal SIP valida nombre y host (y lleva a la solapa donde falta), manda
 *     el puerto como número y avisa lo que contestó la API — incluido el error;
 *   - editar no reenvía la contraseña vacía (no la pisa) y precarga lo guardado;
 *   - la troncal WebRTC muestra UNA vez el enlace y las credenciales para el otro extremo;
 *   - el diagnóstico muestra paso por paso qué respondió y qué no;
 *   - el encabezado del cajón dice si la troncal está conectada y con qué latencia.
 *  Si esto miente, el operador guarda una troncal que no registra y se entera cuando los
 *  clientes no pueden llamar.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());

const vivo = vi.hoisted(() => ({ snap: null }));
vi.mock('../app/useLive.js', () => ({ useLive: () => ({ snap: vivo.snap, connected: true }), useEstados: () => ({}) }));

/* React Flow necesita medir el DOM (ResizeObserver, getBoundingClientRect) y en jsdom no
 * dibuja nada. El doble pinta cada nodo con el MISMO componente de la pantalla (nodeTypes)
 * y expone los callbacks para poder "tocar" un nodo o soltarlo después de arrastrar. */
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlow: ({ nodes, nodeTypes, onNodeClick, onNodeDragStop, children }) => (
      <div data-testid="flow">
        {nodes.map((n) => {
          const C = nodeTypes[n.type];
          return (
            <div key={n.id} data-testid={'nodo-' + n.id} onClick={(e) => onNodeClick(e, n)}>
              <C data={n.data} />
            </div>
          );
        })}
        <button type="button" onClick={() => onNodeDragStop()}>soltar</button>
        {children}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    useNodesState: (ini) => { const [n, setN] = React.useState(ini); return [n, setN, () => {}]; },
  };
});

import { apiMock, notifyMock, resetNucleo } from './helpers/nucleo-render.jsx';
import { renderTel, stubFetch, escribir, campo, elegir } from './helpers/telefonia-render.jsx';
import Troncales from '../app/troncales/page.jsx';
import TrunkEditor, { trunkBlank } from '../app/TrunkEditor.jsx';

beforeEach(() => {
  resetNucleo();
  vivo.snap = null;
  vi.stubGlobal('confirm', vi.fn(() => true));
  /* Storage en memoria: el de Node (experimental) puede no estar y el de jsdom queda tapado. */
  const mem = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => mem.clear(),
  });
});

/* ─────────────────────────── /troncales ─────────────────────────── */
const troncales = [
  { name: 'antel', kind: 'asterisk', provider_host: 'sip.antel', provider_port: 5060, status: 'online', rtt: 42.4, transport: 'udp', channels: 30, dids: ['2400', '2401'], username: 'u1', logo: 'data:image/png;base64,AA' },
  { name: 'claro', kind: 'asterisk', provider_host: 'sip.claro', provider_port: 5061, status: 'offline', mode: 'ip', transport: 'tls', detail: 'timeout' },
  { name: 'web1', kind: 'webrtc', provider_host: 'pbx.local', status: 'sbc' },
  { name: 'nuevo', kind: 'asterisk', provider_host: 'sip.nuevo', provider_port: 5060 },
  { name: 'webc', kind: 'webrtc-client', link: 'wss://peer/ws', status: 'online', adv: { logo: 'data:x' } },
  { name: 'kam', kind: 'kamailio', status: 'sbc' },
  { name: 'to-sbc', kind: 'sbc', status: 'sbc' },
];

describe('/troncales', () => {
  it('sin troncales y sin SBC invita a crear la primera; Asterisk caído se pinta como tal', async () => {
    apiMock.responder('GET /trunks', []);
    apiMock.responder('GET /topology', { nodes: {} });
    renderTel(<Troncales />);
    expect(await screen.findByText(/Todavía no hay troncales/)).toBeTruthy();
    expect(screen.getByText('Enlaces con operadores · directos a la central')).toBeTruthy();
    expect(screen.queryByTestId('nodo-kam')).toBeNull();
    expect(screen.getByTestId('nodo-ast').textContent).toContain('0 llamada(s)');
    expect(screen.getByTestId('nodo-int').textContent).toContain('0 extensiones');
  });

  it('cuenta propias y activas, dibuja el SBC-NG cuando hay uno y no lista las del borde', async () => {
    vivo.snap = { channels: [{}, {}], extensions: [{}, {}, {}], health: { ami: true } };
    apiMock.responder('GET /trunks', troncales);
    apiMock.responder('GET /topology', { sbc: { active: true, host: '10.0.0.5' }, bordes_externos: [{ host: '10.0.0.9', estado: 'ok' }], nodes: { asterisk: '172.0.0.2' } });
    renderTel(<Troncales />);
    expect(await screen.findByText('Enlaces con operadores · directos o vía SBC-NG')).toBeTruthy();
    expect(screen.getByText('propias').previousSibling.textContent).toBe('5');
    expect(screen.getByText('activas').previousSibling.textContent).toBe('2');
    const sbc = screen.getByTestId('nodo-kam').textContent;
    expect(sbc).toContain('10.0.0.9');
    expect(sbc).toContain('WebRTC WSS');
    expect(screen.getByTestId('nodo-ast').textContent).toContain('2 llamada(s)');
    expect(screen.getByTestId('nodo-int').textContent).toContain('3 extensiones');
    expect(screen.queryByTestId('nodo-tk-to-sbc')).toBeNull();
    expect(screen.getByTestId('nodo-tk-antel').textContent).toContain('Registro · UDP · 30 ch');
    expect(screen.getByTestId('nodo-tk-claro').textContent).toContain('IP · TLS');
    expect(screen.getByTestId('nodo-tk-web1').textContent).toContain('WebRTC');
    // La lista: tipos y estados como los entiende el operador.
    expect(screen.getByText('WebRTC servidor')).toBeTruthy();
    expect(screen.getByText('WebRTC cliente')).toBeTruthy();
    expect(screen.getByText('IP / Peer')).toBeTruthy();
    expect(screen.getByText('timeout')).toBeTruthy();
    expect(screen.getByText('2 DID')).toBeTruthy();
    expect(screen.getByText('wss://peer/ws')).toBeTruthy();
    expect(screen.getByText('wss://pbx.local/ws')).toBeTruthy();
    expect(screen.getByText('Vía SBC-NG')).toBeTruthy();
    expect(screen.getByText('Sin datos')).toBeTruthy();
  });

  it('un SBC activo sin borde medido usa el host de la topología; sin troncales propias lo explica', async () => {
    apiMock.responder('GET /trunks', [{ name: 'to-sbc', kind: 'sbc', status: 'sbc' }]);
    apiMock.responder('GET /topology', { sbc: { active: true, host: '10.1.1.1' }, bordes_externos: [{ host: '', estado: 'caido' }] });
    renderTel(<Troncales />);
    expect(await screen.findByText(/Sin troncales propias/)).toBeTruthy();
    expect(screen.getByTestId('nodo-kam').textContent).toContain('10.1.1.1');
    expect(screen.getByTestId('nodo-kam').textContent).not.toContain('WebRTC WSS');
  });

  it('tocar una troncal (en la lista o en el nodo) muestra su detalle; se cierra con la X', async () => {
    apiMock.responder('GET /trunks', troncales);
    apiMock.responder('GET /topology', {});
    renderTel(<Troncales />);
    await screen.findByText('sip.antel:5060');
    fireEvent.click(screen.getByTestId('nodo-tk-antel'));
    expect(screen.getByText('Números (DID)')).toBeTruthy();
    expect(screen.getByText('u1')).toBeTruthy();
    expect(screen.getByText('Proveedor')).toBeTruthy();
    // Nodos que no se tocan (Asterisk) no cambian la selección.
    fireEvent.click(screen.getByTestId('nodo-ast'));
    expect(screen.getByText('Números (DID)')).toBeTruthy();
    fireEvent.click(screen.getByText('wss://peer/ws'));
    expect(screen.getByText('Destino')).toBeTruthy();
    expect(screen.getAllByText('WebRTC cliente').length).toBe(2);
    fireEvent.click(screen.getByText('sip.claro:5061'));
    expect(screen.getAllByText('IP / Peer').length).toBe(2);
    fireEvent.click(screen.getByText('wss://pbx.local/ws'));
    expect(screen.getAllByText('WebRTC servidor').length).toBe(2);
    const cerrar = screen.getByText('Configurar').closest('.mantine-Paper-root').querySelector('button');
    fireEvent.click(cerrar);
    expect(screen.queryByText('Configurar')).toBeNull();
  });

  it('el detalle de una troncal del borde (kamailio/sbc) usa su ícono y su rótulo', async () => {
    apiMock.responder('GET /trunks', [{ name: 'kam', kind: 'kamailio', provider_host: 'k', provider_port: 1, status: 'sbc' }, { name: 'border', kind: 'sbc', provider_host: 'b', provider_port: 2 }]);
    apiMock.responder('GET /topology', { sbc: { active: true } });
    renderTel(<Troncales />);
    await screen.findByText(/Sin troncales propias/);
    expect(screen.getByTestId('nodo-kam').textContent).toContain('-');
  });

  it('ocultar la lista, refrescar y guardar la posición de los nodos al soltar', async () => {
    apiMock.responder('GET /trunks', troncales);
    apiMock.responder('GET /topology', {});
    localStorage.setItem('pbxng_trunks_nodepos', JSON.stringify({ ast: { x: 1, y: 2 } }));
    const { container } = renderTel(<Troncales />);
    await screen.findByText('sip.antel:5060');
    fireEvent.click(screen.getByText('soltar'));
    expect(JSON.parse(localStorage.getItem('pbxng_trunks_nodepos')).ast).toEqual({ x: 1, y: 2 });
    const antes = apiMock.llamadasA('GET /trunks').length;
    const [lista, refrescar] = container.querySelectorAll('.mantine-ActionIcon-root');
    fireEvent.click(refrescar);
    await waitFor(() => expect(apiMock.llamadasA('GET /trunks').length).toBe(antes + 1));
    fireEvent.click(lista);
    expect(screen.queryByText('De la central')).toBeNull();
    fireEvent.click(lista);
    expect(screen.getByText('De la central')).toBeTruthy();
  });

  it('una posición guardada rota no rompe el diagrama', async () => {
    apiMock.responder('GET /trunks', []);
    apiMock.responder('GET /topology', {});
    localStorage.setItem('pbxng_trunks_nodepos', '{roto');
    renderTel(<Troncales />);
    expect(await screen.findByTestId('nodo-ast')).toBeTruthy();
  });

  it('borrar pide confirmación, avisa y recarga; si falla muestra el error', async () => {
    apiMock.responder('GET /trunks', troncales.slice(0, 2));
    apiMock.responder('GET /topology', {});
    apiMock.responder('DELETE /trunks/antel', null);
    apiMock.fallar('DELETE /trunks/claro', 409, 'La usa una ruta');
    renderTel(<Troncales />);
    await screen.findByText('sip.antel:5060');
    const botonesDe = (txt) => screen.getByText(txt).closest('.mantine-Card-root').querySelectorAll('button');
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(botonesDe('sip.antel:5060')[1]);
    expect(apiMock.llamadasA('DELETE /trunks/antel')).toHaveLength(0);
    fireEvent.click(botonesDe('sip.antel:5060')[1]);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Troncal eliminada', 'info'));
    fireEvent.click(screen.getByText('sip.claro:5061'));
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: La usa una ruta', 'bad'));
  });

  it('«Nueva troncal» y el lápiz abren el editor (vacío o con esa troncal)', async () => {
    stubFetch({ 'GET /trunks/antel/detail': { adv: { provider_host: 'sip.antel' } }, 'GET /trunks': troncales });
    apiMock.responder('GET /trunks', troncales);
    apiMock.responder('GET /topology', {});
    renderTel(<Troncales />);
    await screen.findByText('sip.antel:5060');
    fireEvent.click(screen.getByRole('button', { name: 'Nueva troncal' }));
    expect(screen.getByText('Enlace con tu operador SIP o con otra central')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByText('sip.antel:5060').closest('.mantine-Card-root').querySelectorAll('button')[0]);
    expect(screen.getByText('Troncal antel')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText('Conectada')).toBeTruthy();   // el estado vivo de la lista llega al cajón
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByText('sip.antel:5060'));
    fireEvent.click(screen.getByRole('button', { name: 'Configurar' }));
    expect(screen.getByText('Troncal antel')).toBeTruthy();
  });
});

/* ─────────────────────────── TrunkEditor ─────────────────────────── */
function abrir(props = {}) {
  const onClose = vi.fn(); const onSaved = vi.fn();
  const r = renderTel(<TrunkEditor opened onClose={onClose} onSaved={onSaved} {...props} />);
  return { ...r, onClose, onSaved };
}
const solapa = (n) => fireEvent.click(screen.getByRole('tab', { name: n }));

describe('TrunkEditor — alta SIP', () => {
  it('exporta el modelo vacío que usa el alta', () => {
    expect(trunkBlank).toMatchObject({ kind: 'asterisk', mode: 'register', provider_port: '5060', codecs: ['ulaw', 'alaw'] });
  });

  it('cerrado no dibuja nada', () => {
    renderTel(<TrunkEditor opened={false} onClose={() => {}} />);
    expect(screen.queryByText('Nueva troncal')).toBeNull();
  });

  it('valida nombre y host, y lleva a la solapa donde falta', async () => {
    const f = stubFetch({});
    abrir();
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal' }));
    expect(notifyMock.toast).toHaveBeenCalledWith('El nombre de la troncal es obligatorio', 'bad');
    escribir(screen.getByLabelText(/^Nombre/), 'antel');
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal' }));
    expect(notifyMock.toast).toHaveBeenCalledWith('Falta el host del proveedor', 'bad');
    expect(screen.getByLabelText(/Host del proveedor/)).toBeTruthy();   // quedó en «Enlace»
    expect(f).not.toHaveBeenCalled();
  });

  it('crea con POST, el puerto como número y todo lo cargado en las solapas', async () => {
    const f = stubFetch({ 'POST /trunks': { created: 'antel-1' } });
    const { onClose, onSaved } = abrir({ defaultKind: 'asterisk' });
    escribir(screen.getByLabelText(/^Nombre/), 'antel');
    escribir(screen.getByLabelText(/Caller ID saliente/), '"Empresa" <24000000>');
    solapa('Enlace');
    expect(screen.getByText('La PBX se registra con usuario y contraseña (lo más común).')).toBeTruthy();
    escribir(screen.getByLabelText(/Host del proveedor/), 'sip.antel');
    escribir(screen.getByLabelText(/Puerto/), 'abc');
    elegir(campo('Transporte'), 'TLS (cifrado)');
    solapa('Credenciales');
    expect(screen.getByText('Usuario SIP del operador')).toBeTruthy();
    escribir(screen.getByLabelText('Usuario'), 'u');
    escribir(screen.getByLabelText('Contraseña'), 'p');
    escribir(screen.getByLabelText('From user'), 'fu');
    escribir(screen.getByLabelText('From domain'), 'fd');
    solapa('Medios');
    elegir(campo('DTMF'), 'SIP INFO');
    escribir(screen.getByLabelText('Qualify (s)'), '30');
    fireEvent.click(screen.getByLabelText('Detrás de NAT (symmetric RTP)'));
    fireEvent.click(screen.getByLabelText('Direct media (RTP directo)'));
    elegir(campo('Códecs permitidos (en orden de prioridad)'), 'opus');
    solapa('Números');
    const dids = campo('Números del proveedor (DID)');
    escribir(dids, '2400');
    fireEvent.keyDown(dids, { key: 'Enter' });
    escribir(screen.getByLabelText('Canales (capacidad)'), '10');
    escribir(screen.getByLabelText('Contexto entrante'), 'from-antel');
    escribir(screen.getByLabelText('Expiración registro (s)'), '600');
    escribir(screen.getByLabelText('Prefijo de salida'), '9');
    escribir(screen.getByLabelText('Quitar dígitos'), '1');
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal' }));
    await waitFor(() => expect(f.de('POST /trunks')).toHaveLength(1));
    const body = f.de('POST /trunks')[0].body;
    expect(body).toMatchObject({
      name: 'antel', callerid: '"Empresa" <24000000>', provider_host: 'sip.antel', provider_port: 5060, transport: 'tls',
      username: 'u', password: 'p', from_user: 'fu', from_domain: 'fd', dtmf_mode: 'info', qualify_frequency: 30,
      nat: false, direct_media: true, codecs: ['ulaw', 'alaw', 'opus'], dids: ['2400'], channels: 10, context: 'from-antel',
      expiration: 600, outbound_prefix: '9', outbound_strip: 1,
    });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Troncal antel-1 creada', 'ok'));
    expect(onClose).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('modo IP: sin expiración de registro; sin ruta de salida automática no pide prefijo; el error de la API se muestra', async () => {
    stubFetch({ 'POST /trunks': { error: 'Nombre repetido' } });
    const { onClose } = abrir();
    escribir(screen.getByLabelText(/^Nombre/), 'x');
    solapa('Enlace');
    fireEvent.click(screen.getByLabelText('IP / Peer (sin registro)'));
    expect(screen.getByText('El operador autentica por IP; la PBX no se registra.')).toBeTruthy();
    escribir(screen.getByLabelText(/Host del proveedor/), 'h');
    solapa('Credenciales');
    expect(screen.getByText('Opcional en modo IP')).toBeTruthy();
    solapa('Números');
    expect(screen.queryByLabelText('Expiración registro (s)')).toBeNull();
    fireEvent.click(screen.getByLabelText('Crear ruta de salida automática'));
    expect(screen.queryByLabelText('Prefijo de salida')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: Nombre repetido', 'bad'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sin red el alta avisa «Error: red» y sin onSaved no explota', async () => {
    stubFetch({ 'POST /trunks': () => { throw new TypeError('Failed to fetch'); } });
    abrir({ onSaved: undefined });
    escribir(screen.getByLabelText(/^Nombre/), 'x');
    solapa('Enlace');
    escribir(screen.getByLabelText(/Host del proveedor/), 'h');
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: red', 'bad'));
  });

  it('una respuesta sin `created` usa el nombre cargado', async () => {
    stubFetch({ 'POST /trunks': {} });
    renderTel(<TrunkEditor opened onClose={() => {}} />);
    escribir(screen.getByLabelText(/^Nombre/), 'movistar');
    solapa('Enlace');
    escribir(screen.getByLabelText(/Host del proveedor/), 'h');
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Troncal movistar creada', 'ok'));
  });
});

describe('TrunkEditor — diagnóstico', () => {
  it('sin host no se puede probar; con host muestra cada paso y el veredicto', async () => {
    const f = stubFetch({ 'POST /trunks/diagnose': { ok: true, pasos: [
      { paso: 'DNS', ok: true, ms: 12, detalle: 'resuelve a 1.2.3.4' },
      { paso: 'NAT', info: true, ms: 0, detalle: 'detrás de router' },
      { paso: 'SIP OPTIONS', ok: false, detalle: 'sin respuesta' },
    ] } });
    abrir();
    solapa('Enlace');
    const probar = screen.getByRole('button', { name: 'Probar troncal' });
    expect(probar.disabled).toBe(true);
    escribir(screen.getByLabelText(/Host del proveedor/), 'sip.antel');
    fireEvent.click(probar);
    expect(await screen.findByText('resuelve a 1.2.3.4')).toBeTruthy();
    expect(screen.getByText('12ms')).toBeTruthy();
    expect(screen.getByText('sin respuesta')).toBeTruthy();
    expect(screen.getByText('El enlace responde: podés guardar con confianza.')).toBeTruthy();
    expect(f.de('POST /trunks/diagnose')[0].body).toEqual({ kind: 'asterisk', mode: 'register', provider_host: 'sip.antel', provider_port: '5060', transport: 'udp' });
  });

  it('un diagnóstico con fallas lo dice; si no se pudo ejecutar, también', async () => {
    let n = 0;
    stubFetch({ 'POST /trunks/diagnose': () => { n++; if (n === 1) return { ok: false, pasos: [{ paso: 'DNS', ok: false, detalle: 'no resuelve' }] }; throw new Error('red'); } });
    abrir();
    solapa('Números');   // el diagnóstico también está al pie de «Números»
    expect(screen.getByRole('button', { name: 'Probar troncal' }).disabled).toBe(true);
    solapa('Enlace');
    escribir(screen.getByLabelText(/Host del proveedor/), 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Probar troncal' }));
    expect(await screen.findByText(/Revisá lo marcado/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Probar troncal' }));
    expect(await screen.findByText('no se pudo ejecutar el diagnóstico')).toBeTruthy();
  });
});

describe('TrunkEditor — logo', () => {
  it('sube el logo reducido a 128 px y se puede quitar; si la imagen no carga, avisa', async () => {
    stubFetch({});
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    let falla = false;
    vi.stubGlobal('Image', class { set src(_) { setTimeout(() => (falla ? this.onerror(new Error('x')) : this.onload()), 0); } get width() { return 256; } get height() { return 128; } });
    const ctx = { drawImage: vi.fn() };
    const gc = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,LOGO');
    const { container } = abrir();
    const input = container.ownerDocument.querySelector('input[type=file]');
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] } }); });
    await waitFor(() => expect(container.ownerDocument.querySelector('img[src="data:image/png;base64,LOGO"]')).toBeTruthy());
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 128, 64);
    fireEvent.click(screen.getByRole('button', { name: 'Quitar' }));
    expect(container.ownerDocument.querySelector('img[src="data:image/png;base64,LOGO"]')).toBeNull();
    falla = true;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['y'], 'otro.png', { type: 'image/png' })] } }); });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No se pudo procesar el logo', 'bad'));
    gc.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('TrunkEditor — edición', () => {
  it('precarga lo guardado, muestra el estado vivo y no reenvía la contraseña vacía', async () => {
    const f = stubFetch({
      'GET /trunks/antel/detail': { adv: { provider_host: 'sip.antel', provider_port: 5070, transport: 'tls', password: 'NO' } },
      'GET /trunks': [{ name: 'antel', kind: 'asterisk' }],
      'PUT /trunks/antel': {},
    });
    const { onClose, onSaved } = abrir({ initialName: 'antel', vivo: { status: 'online', rtt: 42, detail: 'Registrada' } });
    expect(await screen.findByText('sip.antel:5070 · TLS')).toBeTruthy();
    expect(screen.getByText('42 ms')).toBeTruthy();
    expect(screen.getByText('Conectada')).toBeTruthy();
    expect(screen.getByText(/el tipo no se cambia después de crearla/)).toBeTruthy();
    expect(screen.getByLabelText(/^Nombre/).disabled).toBe(true);
    solapa('Credenciales');
    expect(screen.getByText('Dejar vacío para no cambiarla')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(f.de('PUT /trunks/antel')).toHaveLength(1));
    expect('password' in f.de('PUT /trunks/antel')[0].body).toBe(false);
    expect(f.de('PUT /trunks/antel')[0].body.provider_port).toBe(5070);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Troncal actualizada', 'ok'));
    expect(onClose).toHaveBeenCalled(); expect(onSaved).toHaveBeenCalled();
  });

  it('si cambian la contraseña al editar, sí va; latencias alta y media, y troncal caída', async () => {
    const f = stubFetch({ 'GET /trunks/a/detail': { adv: { provider_host: 'h' } }, 'GET /trunks': { no: 'lista' }, 'PUT /trunks/a': {} });
    const { rerender } = abrir({ initialName: 'a', vivo: { status: 'offline', rtt: 250 } });
    expect(screen.getByText('sin host:5060 · UDP')).toBeTruthy();   // antes de que llegue el detalle
    expect(await screen.findByText('h:5060 · UDP')).toBeTruthy();
    expect(screen.getByText('250 ms')).toBeTruthy();
    expect(screen.getByText('Caída')).toBeTruthy();
    rerender(<TrunkEditor opened initialName="a" onClose={() => {}} vivo={{ status: 'online', rtt: 120 }} />);
    expect(screen.getByText('120 ms')).toBeTruthy();
    rerender(<TrunkEditor opened initialName="a" onClose={() => {}} vivo={{ status: 'offline' }} />);
    expect(screen.queryByText(/ ms$/)).toBeNull();
    solapa('Credenciales');
    escribir(screen.getByLabelText('Contraseña'), 'nueva');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(f.de('PUT /trunks/a')).toHaveLength(1));
    expect(f.de('PUT /trunks/a')[0].body.password).toBe('nueva');
  });

  it('si no se puede leer el detalle, abre igual con el nombre y los valores de fábrica', async () => {
    stubFetch({ 'GET /trunks/b/detail': () => { throw new Error('red'); }, 'GET /trunks': () => { throw new Error('red'); } });
    abrir({ initialName: 'b', defaultKind: 'asterisk', vivo: null });
    await waitFor(() => expect(screen.getByLabelText(/^Nombre/).value).toBe('b'));
    expect(screen.queryByText('Conectada')).toBeNull();
  });
});

describe('TrunkEditor — WebRTC', () => {
  it('alta servidor: pide nombre y contraseña, y muestra UNA vez el enlace y las credenciales', async () => {
    const f = stubFetch({ 'POST /trunks': { link: 'wss://pbx.ejemplo/ws', username: 'peer1' } });
    const { onSaved, onClose } = abrir();
    fireEvent.click(screen.getByText('WebRTC (WSS)'));
    expect(screen.getByRole('button', { name: 'Crear troncal WebRTC' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal WebRTC' }));
    expect(notifyMock.toast).toHaveBeenCalledWith('Nombre y contraseña son obligatorios', 'bad');
    escribir(screen.getByLabelText(/^Nombre/), 'peer1');
    escribir(screen.getByLabelText(/^Contraseña/), 'clave');
    escribir(screen.getByLabelText(/Nota \/ Caller ID/), 'IES');
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal WebRTC' }));
    expect(await screen.findByText('Troncal WebRTC lista')).toBeTruthy();
    expect(f.de('POST /trunks')[0].body).toEqual({ name: 'peer1', kind: 'webrtc', username: 'peer1', note: 'IES', password: 'clave' });
    expect(screen.getByDisplayValue('wss://pbx.ejemplo/ws')).toBeTruthy();
    expect(screen.getByDisplayValue('clave')).toBeTruthy();
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Listo' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cerrar' })).toBeTruthy();
  });

  it('alta servidor sin enlace en la respuesta arma el wss de esta central; el error de la API se muestra', async () => {
    let n = 0;
    stubFetch({ 'POST /trunks': () => (++n === 1 ? { error: 'ya existe' } : {}) });
    abrir({ onSaved: undefined });
    fireEvent.click(screen.getByText('WebRTC (WSS)'));
    escribir(screen.getByLabelText(/^Nombre/), 'p2');
    escribir(screen.getByLabelText(/^Contraseña/), 'c');
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal WebRTC' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: ya existe', 'bad'));
    fireEvent.click(screen.getByRole('button', { name: 'Crear troncal WebRTC' }));
    expect(await screen.findByDisplayValue('wss://' + window.location.host + '/ws')).toBeTruthy();
    expect(screen.getByDisplayValue('p2')).toBeTruthy();
  });

  it('editar una WebRTC servidor: PUT sin contraseña si no se cambió', async () => {
    const f = stubFetch({
      'GET /trunks/w1/detail': { username: 'w1u', adv: { note: 'nota' } },
      'GET /trunks': [{ name: 'w1', kind: 'webrtc' }],
      'PUT /trunks/w1': {},
    });
    const { onClose } = abrir({ initialName: 'w1' });
    expect(await screen.findByText('SIP sobre WSS + DTLS-SRTP')).toBeTruthy();
    expect(screen.getByLabelText(/^Usuario/).value).toBe('w1u');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(f.de('PUT /trunks/w1')).toHaveLength(1));
    expect(f.de('PUT /trunks/w1')[0].body).toEqual({ name: 'w1', kind: 'webrtc', username: 'w1u', note: 'nota' });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Troncal WebRTC actualizada', 'ok'));
    expect(onClose).toHaveBeenCalled();
  });

  it('una WebRTC servidor sin detalle usa el nombre como usuario; el error del PUT se muestra', async () => {
    const f = stubFetch({ 'GET /trunks/w2/detail': {}, 'GET /trunks': [{ name: 'w2', kind: 'webrtc' }], 'PUT /trunks/w2': { error: 'no' } });
    abrir({ initialName: 'w2', onSaved: undefined });
    await screen.findByText('SIP sobre WSS + DTLS-SRTP');
    escribir(screen.getByLabelText(/^Contraseña/), 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: no', 'bad'));
    expect(f.de('PUT /trunks/w2')[0].body).toMatchObject({ username: 'w2', password: 'x', note: '' });
  });

  it('una WebRTC cliente heredada: avisa que vive en SBC-NG, valida y guarda con PUT', async () => {
    const f = stubFetch({
      'GET /trunks/wc/detail': { username: 'remoto', remote_url: '', adv: {} },
      'GET /trunks': [{ name: 'wc', kind: 'webrtc-client' }],
      'PUT /trunks/wc': {},
      'POST /trunks/diagnose': { ok: true, pasos: [] },
    });
    const { onSaved } = abrir({ initialName: 'wc' });
    expect(await screen.findByText(/heredada/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Probar troncal' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(notifyMock.toast).toHaveBeenCalledWith('Nombre, URL WSS remota, usuario y contraseña son obligatorios', 'bad');
    escribir(screen.getByLabelText(/URL WSS remota/), 'wss://peer/ws');
    escribir(screen.getByLabelText(/Usuario \(remoto\)/), 'remoto2');
    escribir(screen.getByLabelText(/Contraseña \(remoto\)/), 'pw');
    fireEvent.click(screen.getByRole('button', { name: 'Probar troncal' }));
    await waitFor(() => expect(f.de('POST /trunks/diagnose')).toHaveLength(1));
    expect(f.de('POST /trunks/diagnose')[0].body).toEqual({ kind: 'webrtc-client', remote_url: 'wss://peer/ws' });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(f.de('PUT /trunks/wc')).toHaveLength(1));
    expect(f.de('PUT /trunks/wc')[0].body).toEqual({ name: 'wc', kind: 'webrtc-client', remote_url: 'wss://peer/ws', username: 'remoto2', note: '', password: 'pw' });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Troncal WebRTC (cliente) actualizada', 'ok'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('una WebRTC cliente sin contraseña nueva no la manda; el error de la API se muestra', async () => {
    const f = stubFetch({
      'GET /trunks/wc/detail': { username: 'r', remote_url: 'wss://p/ws', adv: { note: 'n' } },
      'GET /trunks': [{ name: 'wc', kind: 'webrtc-client' }],
      'PUT /trunks/wc': { error: 'bridge caído' },
    });
    abrir({ initialName: 'wc', onSaved: undefined });
    await screen.findByText(/heredada/);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: bridge caído', 'bad'));
    expect('password' in f.de('PUT /trunks/wc')[0].body).toBe(false);
  });
});
