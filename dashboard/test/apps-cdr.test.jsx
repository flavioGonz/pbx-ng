/* CDR: historial de llamadas, grabaciones y almacenamiento (la sección /cdr y /grabaciones).
 *
 * Es lo que el supervisor abre para responder «¿quién llamó, quién atendió, está grabada?».
 * Se fija: cómo se clasifica cada llamada (entrante/saliente/interna/IVR/IA y su medio), que
 * la grabación se asocie a la llamada correcta, que el CSV exporte lo filtrado, que un error
 * de la API se vea como error y NO como «no hay llamadas», y que lo que es de admin
 * (almacenamiento, borrar) no se le ofrezca al supervisor ni se pida a la API en su nombre. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderNG, fetchFalso, estado } from './helpers/apps-render.jsx';

const notify = vi.hoisted(() => ({ toast: vi.fn() }));
const sesion = vi.hoisted(() => ({ admin: true }));
const vivo = vi.hoisted(() => ({ snap: null }));
vi.mock('../app/notify', () => notify);
vi.mock('../app/auth', () => ({ useEsAdmin: () => sesion.admin }));
vi.mock('../app/useLive', () => ({ useLive: () => ({ snap: vivo.snap, connected: true }) }));
// El reproductor y la mini-onda tienen sus propias pruebas (y MiniWave es de otra área).
vi.mock('../app/RecordingPlayer', () => ({ default: (p) => <div data-testid="reproductor">{p.recId}|{p.src}|{p.label}</div> }));
vi.mock('../app/MiniWave', () => ({ default: () => <span>onda</span> }));

import Cdr from '../app/cdr/page';
import Historial from '../app/historial/page';
import Grabaciones from '../app/grabaciones/page';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

const AHORA = new Date();
const hace = (min) => new Date(AHORA.getTime() - min * 60000).toISOString();

const CDR = [
  { start: hace(5), src: '1001', dst: '1002', clid: '"Ana" <1001>', duration: 70, billsec: 65, disposition: 'ANSWERED' },          // interna, web
  { start: hace(10), src: '099123456', dst: '1001', clid: '099123456 <099123456>', duration: 30, billsec: 30, disposition: 'ANSWERED' }, // entrante
  { start: hace(20), src: '1002', dst: '099765432', duration: 12, billsec: 0, disposition: 'NO ANSWER' },                           // saliente
  { start: hace(30), src: '1001', dst: '7001', duration: 5, billsec: 5, disposition: 'BUSY' },                                     // ivr por número
  { start: hace(40), src: '1003', dst: 's', dcontext: 'pbxng-ivr', duration: 5, billsec: 5, disposition: 'FAILED' },               // ivr por contexto
  { start: hace(50), src: '1002', dst: '9000', lastapp: 'Stasis', duration: 5, billsec: 5, disposition: 'CONGESTION' },            // ia
  { start: hace(60), src: '1003', dst: '55', duration: 5, billsec: 5, disposition: 'RARO' },                                       // interna (sólo origen)
  { start: hace(70), src: '444', dst: '555', dcontext: 'from-trunk', duration: 5, billsec: 5 },                                    // entrante por contexto
  { start: hace(80), clid: '"Beto" <>' },                                                                       // sin números ni duración
  { src: 'x"1', dst: 'y', clid: '"Pepe" <x>', duration: 1, billsec: 1, disposition: 'ANSWERED' },                            // otra, sin fecha
];
const RECS = [
  { id: 31, ext: '1001', started_at: hace(5) },
  { id: 32, ext: '1002', started_at: new Date(AHORA.getTime() - 20 * 60000 + 3000).toISOString() },
  { id: 33 },                                     // sin interno ni fecha: no se indexa
];

let f;
beforeEach(() => {
  notify.toast.mockReset();
  sesion.admin = true;
  vivo.snap = { extensions: [{ id: 1001, webrtc: true }, { id: 1002 }, { id: 1003 }] };
  f = fetchFalso({ 'GET /cdr': CDR, 'GET /recordings': RECS });
  vi.stubGlobal('fetch', f);
  URL.createObjectURL = vi.fn(() => 'blob:csv');
  URL.revokeObjectURL = vi.fn();
});

const fila = (texto) => screen.getAllByText(texto)[0].closest('tr');
const leer = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsText(blob); });

describe('Historial', () => {
  it('clasifica cada llamada por tipo y medio, y resume los números de arriba', async () => {
    renderNG(<Historial />);
    expect(await screen.findByText('Ana')).toBeTruthy();
    expect(f.de('GET', '/cdr')[0].ruta).toBe('/cdr?limit=300');
    /* La fila de «src → dst»: se busca en las celdas SIN la fecha y cada número entero. Mirando
     * todo el texto, «1003 → 55» agarró la fila de la IVR de 1003 porque su hora era «05:55»
     * (falló en el CI según la hora a la que corrió). */
    const entero = (txt, n) => new RegExp('(^|[^0-9])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^0-9]|$)').test(txt);
    const tipo = (src, dst) => [...document.querySelectorAll('tbody tr')].find((tr) => {
      const txt = [...tr.querySelectorAll('td')].slice(1).map((td) => td.textContent).join(' | ');
      return entero(txt, src) && entero(txt, dst);
    });
    expect(tipo('1001', '1002').textContent).toMatch(/Interna.*WebRTC/);
    expect(tipo('099123456', '1001').textContent).toMatch(/Entrante.*Troncal/);
    expect(tipo('1002', '099765432').textContent).toMatch(/Saliente.*Troncal.*Sin respuesta/);
    expect(tipo('1001', '7001').textContent).toMatch(/IVR.*Ocupado/);
    expect(tipo('1003', 's').textContent).toMatch(/IVR.*SIP.*Fallida/);
    expect(tipo('1002', '9000').textContent).toMatch(/Agente IA.*IA.*Congestión/);
    expect(tipo('1003', '55').textContent).toMatch(/Interna.*SIP.*RARO/);
    expect(tipo('444', '555').textContent).toMatch(/Entrante/);
    expect(tipo('x"1', 'y').textContent).toMatch(/—Otra/);
    // el nombre del CLID sólo si no es un número
    expect(screen.queryByText('099123456', { selector: 'p.mantine-Text-root[style*="10px"]' })).toBeNull();
    expect(screen.getByText('Pepe')).toBeTruthy();
    // KPIs: llamadas, atendidas, sin respuesta, min hablados, hoy
    const kpi = (k) => screen.getAllByText(k).map((e) => e.previousSibling).find(Boolean).textContent;
    expect(kpi('Llamadas')).toBe('10');
    expect(kpi('Atendidas')).toBe('3');
    expect(kpi('Sin respuesta')).toBe('7');
    expect(screen.getByText('Beto').closest('tr').textContent).toMatch(/Otra.*—.*—/);
    expect(kpi('Min. hablados')).toBe('2');
    expect(Number(kpi('Hoy'))).toBeGreaterThanOrEqual(1);
    // duración hablada y total con timbrado
    expect(screen.getByText('1m 5s')).toBeTruthy();
    expect(screen.getByText('tot 1m 10s')).toBeTruthy();
    expect(screen.getByText('Historial de llamadas')).toBeTruthy();
  });

  it('asocia la grabación por interno y hora, y la abre/cierra en la misma fila', async () => {
    renderNG(<Historial />);
    await screen.findByText('Ana');
    const ver = screen.getAllByRole('button', { name: 'Ver' });
    expect(ver.length).toBe(2);   // la de Ana (31) y la saliente de 1002 (32)
    fireEvent.click(ver[0]);
    expect(screen.getByTestId('reproductor').textContent).toBe('31|/backend/api/recordings/31/audio|1001  →  1002');
    expect(screen.getByText('Grabación #31')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByTestId('reproductor')).toBeNull();
  });

  it('las solapas filtran y cuentan; la búsqueda mira origen, destino y nombre', async () => {
    renderNG(<Historial embedded />);
    await screen.findByText('Ana');
    expect(screen.queryByText('Historial de llamadas')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Perdidas/ }));
    expect(screen.queryByText('Ana')).toBeNull();
    expect(screen.getByRole('tab', { name: /Perdidas/ }).textContent).toContain('7');
    fireEvent.click(screen.getByRole('tab', { name: /Entrantes/ }));
    expect(document.querySelectorAll('tbody tr').length).toBe(2);
    fireEvent.click(screen.getByRole('tab', { name: /Agente IA/ }));
    expect(document.querySelectorAll('tbody tr').length).toBe(1);
    fireEvent.click(screen.getByRole('tab', { name: /Todas/ }));
    fireEvent.change(screen.getByPlaceholderText('Buscar origen / destino / nombre'), { target: { value: 'ana' } });
    expect(document.querySelectorAll('tbody tr').length).toBe(1);
    fireEvent.change(screen.getByPlaceholderText('Buscar origen / destino / nombre'), { target: { value: 'BETO' } });
    expect(document.querySelectorAll('tbody tr').length).toBe(1);
    fireEvent.change(screen.getByPlaceholderText('Buscar origen / destino / nombre'), { target: { value: '7001' } });
    expect(document.querySelectorAll('tbody tr').length).toBe(1);
    fireEvent.change(screen.getByPlaceholderText('Buscar origen / destino / nombre'), { target: { value: 'zzz' } });
    expect(screen.getByText('Sin resultados en esta vista.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'CSV' }).disabled).toBe(true);
  });

  it('exporta a CSV exactamente lo filtrado, con comillas escapadas y el id de grabación', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderNG(<Historial />);
    await screen.findByText('Ana');
    fireEvent.click(screen.getByRole('tab', { name: /Internas/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(click).toHaveBeenCalled();
    const csv = await leer(URL.createObjectURL.mock.calls[0][0]);
    const lineas = csv.split('\n');
    expect(lineas[0]).toBe('Fecha,Tipo,Medio,Origen,Nombre,Destino,Duracion_s,Hablado_s,Resultado,GrabacionID');
    expect(lineas.length).toBe(3);
    expect(lineas[1]).toMatch(/"Interna","WebRTC","1001","Ana","1002","70","65","Atendida","31"$/);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv');
    fireEvent.click(screen.getByRole('tab', { name: /Todas/ }));
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    const todo = await leer(URL.createObjectURL.mock.calls[1][0]);
    expect(todo).toContain('"","Otra","SIP","x""1","Pepe","y"');
    expect(todo).toContain('"Pepe","y","1","1","Atendida",""');
    // una fila sin resultado sale con «—», no vacía
    expect(todo).toContain('"444","","555","5","5","—",""');
  });

  it('con muchas llamadas pagina de a 100 con «Ver más»', async () => {
    const muchas = Array.from({ length: 185 }, (_, i) => ({ start: hace(i), src: '1001', dst: '1002', duration: 1, billsec: 1, disposition: 'ANSWERED' }));
    vi.stubGlobal('fetch', fetchFalso({ 'GET /cdr': muchas, 'GET /recordings': 'no es lista' }));
    vivo.snap = null;
    renderNG(<Historial />);
    expect(await screen.findByRole('button', { name: 'Ver más (105)' })).toBeTruthy();
    expect(document.querySelectorAll('tbody tr').length).toBe(80);
    fireEvent.click(screen.getByRole('button', { name: 'Ver más (105)' }));
    expect(screen.getByRole('button', { name: 'Ver más (5)' })).toBeTruthy();
    // cambiar de vista vuelve a la primera página
    fireEvent.click(screen.getByRole('tab', { name: /Perdidas/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Todas/ }));
    expect(document.querySelectorAll('tbody tr').length).toBe(80);
  });

  it('sin llamadas lo dice; si la API falla lo dice como error (no como «no hay llamadas»)', async () => {
    vi.stubGlobal('fetch', fetchFalso({ 'GET /cdr': { no: 'lista' }, 'GET /recordings': [] }));
    const a = renderNG(<Historial />);
    expect(await screen.findByText('Aún no hay llamadas registradas.')).toBeTruthy();
    a.unmount();
    vi.stubGlobal('fetch', fetchFalso({ 'GET /cdr': estado(403), 'GET /recordings': estado(403) }));
    renderNG(<Historial />);
    expect(await screen.findByText('No se pudo cargar el historial: No tenés permiso para esta acción')).toBeTruthy();
    expect(notify.toast).toHaveBeenCalledWith('No tenés permiso para esta acción', 'bad');
  });
});

describe('/cdr', () => {
  it('admin ve Llamadas, Grabaciones y Almacenamiento', async () => {
    f = fetchFalso({ 'GET /cdr': CDR, 'GET /recordings': RECS, 'GET /recordings/storage/usage': {}, 'GET /recordings/config': { backend: 'local' } });
    vi.stubGlobal('fetch', f);
    renderNG(<Cdr />);
    expect(await screen.findByText('Ana')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Grabaciones/ }));
    expect(await screen.findByText('3 grabaciones')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Almacenamiento/ }));
    expect(await screen.findByRole('button', { name: /Guardar configuración/ })).toBeTruthy();
  });

  it('el supervisor no ve Almacenamiento ni se le piden rutas de admin', async () => {
    sesion.admin = false;
    renderNG(<Cdr />);
    await screen.findByText('Ana');
    expect(screen.queryByRole('tab', { name: /Almacenamiento/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Grabaciones/ }));
    await screen.findByText('3 grabaciones');
    expect(f.llamadas.some((l) => l.ruta.startsWith('/recordings/storage') || l.ruta.startsWith('/recordings/config'))).toBe(false);
    expect(document.querySelector('.tabler-icon-trash')).toBeNull();
  });
});

const GRABS = [
  { id: 1, ext: '1001', started_at: hace(1), duration: 65, bytes: '2048', storage: 'local', filename: 'a.wav' },
  { id: 2, ext: 'ventas', origen: 'cola', duration: 10, bytes: 1024, storage: 's3', src: '099', dst: '8001' },
  { id: 3, origen: 'sala', storage: 'nas' },
  { id: 4, ext: '9000', origen: 'ia', storage: 'raro' },
  { id: 5, ext: '700', origen: 'ivr' },
  { id: 6, ext: '1002', origen: 'otro' },
];

describe('Grabaciones', () => {
  const rutas = (extra = {}) => ({
    'GET /recordings': GRABS,
    'GET /recordings/storage/usage': { local: { path: '/var/rec', total: 100, used: 95, avail: 5, pct: 95, files: 4 }, nas: { mounted: true, path: '/mnt/nas', total: 100, used: 80, avail: 20, pct: 80 }, s3: { bytes: 4096, files: 2 } },
    'GET /recordings/config': { backend: 'local', retain_local: true },
    'DELETE /recordings/1': null,
    'GET /recordings/1/audio': () => new Response(new Blob(['RIFF']), { status: 200, headers: { 'content-type': 'audio/wav' } }),
    'POST /recordings/config': {},
    'POST /recordings/storage/test': { msg: 'Escritura OK' },
    ...extra,
  });
  beforeEach(() => {
    f = fetchFalso(rutas());
    vi.stubGlobal('fetch', f);
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  it('lista con KPIs, origen, almacenamiento y filtros por origen y búsqueda', async () => {
    renderNG(<Grabaciones />);
    expect(await screen.findByText('6 grabaciones')).toBeTruthy();
    expect(screen.getByText('3.0 KB')).toBeTruthy();         // bytes como texto también suman
    expect(screen.getByText('01:15')).toBeTruthy();
    const kpiNube = screen.getByText('En NAS / S3').previousSibling.textContent;
    expect(kpiNube).toBe('5');
    expect(fila('#2').textContent).toMatch(/Cola.*ventas.*S3/);
    expect(fila('#3').textContent).toMatch(/Sala.*—.*NAS/);
    expect(fila('#4').textContent).toMatch(/IA.*Local/);       // almacenamiento desconocido → Local
    expect(fila('#6').textContent).toMatch(/Interno/);          // origen desconocido → Interno
    fireEvent.click(screen.getByText('Colas (1)'));
    expect(screen.getByText('1 grabaciones')).toBeTruthy();
    fireEvent.click(screen.getByText('Todas'));
    for (const [q, n] of [['1001', 1], ['a.wav', 1], ['099', 1], ['8001', 1], ['5', 1]]) {
      fireEvent.change(screen.getByPlaceholderText('Buscar ID / interno / archivo'), { target: { value: q } });
      expect(screen.getByText(n + ' grabaciones')).toBeTruthy();
    }
    fireEvent.change(screen.getByPlaceholderText('Buscar ID / interno / archivo'), { target: { value: 'nada' } });
    expect(screen.getByText('Sin resultados.')).toBeTruthy();
  });

  it('reproduce en la fila, descarga CON token y borra con confirmación', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderNG(<Grabaciones embedded />);
    await screen.findByText('6 grabaciones');
    fireEvent.click(screen.getAllByRole('button', { name: 'Reproducir' })[0]);
    expect(screen.getByTestId('reproductor').textContent).toBe('1|/backend/api/recordings/1/audio|Grabación #1 · Interno 1001');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByTestId('reproductor')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Reproducir' })[2]);
    expect(screen.getByTestId('reproductor').textContent).toContain('Interno ?');
    // descarga
    fireEvent.click(fila('#1').querySelector('.tabler-icon-download').closest('button'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(f.de('GET', '/recordings/1/audio').length).toBe(1);
    await act(async () => { await new Promise((r) => setTimeout(r, 1050)); });
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    fireEvent.click(fila('#2').querySelector('.tabler-icon-download').closest('button'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No se pudo descargar', 'bad', { description: 'No encontrado: GET /recordings/2/audio' }));
    // borrar
    confirm.mockReturnValueOnce(false);
    fireEvent.click(fila('#1').querySelector('.tabler-icon-trash').closest('button'));
    expect(f.de('DELETE', '/recordings').length).toBe(0);
    fireEvent.click(fila('#1').querySelector('.tabler-icon-trash').closest('button'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Grabación eliminada', 'info'));
    fireEvent.click(fila('#2').querySelector('.tabler-icon-trash').closest('button'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No encontrado: DELETE /recordings/2', 'bad'));
  }, 10000);

  it('la descarga usa el nombre de archivo, o uno armado con el id', async () => {
    const nombres = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { nombres.push(this.download); });
    f = fetchFalso(rutas({ 'GET /recordings/2/audio': () => new Response(new Blob(['x']), { status: 200 }) }));
    vi.stubGlobal('fetch', f);
    renderNG(<Grabaciones embedded />);
    await screen.findByText('6 grabaciones');
    fireEvent.click(fila('#1').querySelector('.tabler-icon-download').closest('button'));
    await waitFor(() => expect(nombres.length).toBe(1));
    fireEvent.click(fila('#2').querySelector('.tabler-icon-download').closest('button'));
    await waitFor(() => expect(nombres).toEqual(['a.wav', 'grabacion-2.wav']));
  });

  it('sin grabaciones lo dice; un error del listado se muestra como error', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /recordings': [] })));
    const a = renderNG(<Grabaciones embedded />);
    expect(await screen.findByText(/Aún no hay grabaciones/)).toBeTruthy();
    a.unmount();
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /recordings': estado(500, { error: 'Disco lleno' }) })));
    renderNG(<Grabaciones embedded />);
    expect(await screen.findByText('No se pudieron cargar las grabaciones: Disco lleno')).toBeTruthy();
    expect(notify.toast).toHaveBeenCalledWith('Disco lleno', 'bad');
  });

  it('Almacenamiento: ocupación de cada destino con su color, y guardar recarga config y uso', async () => {
    renderNG(<Grabaciones embedded section="cfg" />);
    expect(await screen.findByText('95%')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(document.querySelector('rect[fill="#dc2626"]')).toBeTruthy();
    expect(document.querySelector('rect[fill="#f59e0b"]')).toBeTruthy();
    expect(screen.getByText('/var/rec')).toBeTruthy();
    expect(screen.getByText('/mnt/nas')).toBeTruthy();
    expect(screen.getByText('4.0 KB')).toBeTruthy();          // S3 sin límite: lo consumido
    expect(screen.getByText('sin límite fijo')).toBeTruthy();
    expect(screen.getByText('activo')).toBeTruthy();
    // en local no hay «Probar destino»
    expect(screen.queryByRole('button', { name: /Probar destino/ })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Subir automáticamente' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Conservar copia local' }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar configuración/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Configuración guardada', 'ok'));
    expect(f.de('POST', '/recordings/config')[0].cuerpo).toEqual({ backend: 'local', retain_local: false, auto_upload: true });
    await waitFor(() => expect(f.de('GET', '/recordings/config').length).toBe(2));
    expect(f.de('GET', '/recordings/storage/usage').length).toBe(2);
  });

  it('Almacenamiento: colores de ocupación media/baja y destinos sin datos', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({
      'GET /recordings/storage/usage': { local: { total: 10, used: 6, avail: 4, pct: 60 }, nas: { mounted: false }, s3: { total: 10, used: 1, pct: 10 } },
      'GET /recordings/config': { backend: 's3', s3_bucket: 'grab', s3_endpoint: 'http://minio' },
    })));
    renderNG(<Grabaciones embedded section="cfg" />);
    expect(await screen.findByText('60%')).toBeTruthy();
    expect(document.querySelector('rect[fill="#eab308"]')).toBeTruthy();
    expect(document.querySelector('rect[fill="#12b76a"]')).toBeTruthy();
    expect(screen.getByText('no montado')).toBeTruthy();
    expect(screen.getByText('grab · MinIO')).toBeTruthy();
    expect(screen.getByText('/recordings')).toBeTruthy();
  });

  it('Almacenamiento sin datos de uso: cae en la ruta configurada o «sin configurar»', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /recordings/storage/usage': estado(500), 'GET /recordings/config': { backend: 'nas', nas_path: '/mnt/x', s3_bucket: 'b' } })));
    renderNG(<Grabaciones embedded section="cfg" />);
    expect(await screen.findByText('/mnt/x')).toBeTruthy();
    expect(screen.getByText('b · AWS')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBe(3);
  });

  it('Almacenamiento: mientras carga la configuración muestra el indicador', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderNG(<Grabaciones embedded section="cfg" />);
    expect(screen.queryByRole('button', { name: /Guardar configuración/ })).toBeNull();
    expect(document.querySelector('.mantine-Loader-root')).toBeTruthy();
  });

  it('NAS: según el tipo pide ruta, servidor/export o usuario/clave; el diagnóstico muestra cada paso', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
    let n = 0;
    f = fetchFalso(rutas({
      'GET /recordings/storage/usage': {},
      'GET /recordings/config': { backend: 'local', has_nas_pass: true },
      'POST /recordings/storage/nastest': () => (n++ ? estado(503, { error: 'Agente caído' }) : { ok: true, pasos: [{ paso: 'Alcance', ok: true, detalle: 'ping ok' }, { paso: 'Montaje', ok: false, detalle: 'permiso' }, { paso: 'Nota', info: true, detalle: 'usar vers=3' }], mount_cmd: 'mount -t cifs //nas/grab /mnt' }),
    }));
    vi.stubGlobal('fetch', f);
    renderNG(<Grabaciones embedded section="cfg" />);
    const destino = await screen.findByRole('textbox', { name: 'Destino' });
    fireEvent.click(destino);
    fireEvent.click(await screen.findByRole('option', { name: 'NAS (en red)' }));
    expect(screen.getByText('El NAS ya está montado en el server; sólo indicá la ruta.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Servidor NAS (IP o host)' })).toBeNull();
    fireEvent.click(screen.getByText('NFS'));
    expect(screen.getByText(/Recurso NFS/)).toBeTruthy();
    expect(screen.getByPlaceholderText('/volume1/grabaciones')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Export' })).toBeTruthy();
    fireEvent.click(screen.getByText('CIFS / SMB'));
    expect(screen.getByText(/Recurso Windows\/SMB/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Servidor NAS (IP o host)' }), { target: { value: 'nas.local' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Recurso compartido' }), { target: { value: 'grab' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Usuario' }), { target: { value: 'pbx' } });
    fireEvent.change(screen.getByPlaceholderText('•••••• (guardada)'), { target: { value: 'secreto' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Ruta local montada/ }), { target: { value: '/mnt/grab' } });
    fireEvent.click(screen.getByRole('button', { name: /Probar conexión/ }));
    expect(await screen.findByText('ping ok')).toBeTruthy();
    expect(screen.getByText('permiso')).toBeTruthy();
    expect(screen.getByText('usar vers=3')).toBeTruthy();
    // la clave no viaja al diagnóstico: sólo lo necesario para probar
    expect(f.de('POST', '/recordings/storage/nastest')[0].cuerpo).toEqual({ nas_type: 'cifs', nas_path: '/mnt/grab', nas_server: 'nas.local', nas_share: 'grab', nas_user: 'pbx' });
    expect(screen.getByText('mount -t cifs //nas/grab /mnt')).toBeTruthy();
    await act(async () => { fireEvent.click(document.querySelector('.tabler-icon-copy').closest('button')); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('mount -t cifs //nas/grab /mnt');
    fireEvent.click(screen.getByRole('button', { name: /Probar conexión/ }));
    expect(await screen.findByText('Agente caído')).toBeTruthy();
    // «Probar destino» aparece fuera de local
    fireEvent.click(screen.getByRole('button', { name: /Probar destino/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Escritura OK', 'ok'));
  });

  it('NAS: el diagnóstico sin tipo elegido prueba como ruta montada', async () => {
    f = fetchFalso(rutas({ 'GET /recordings/config': { backend: 'nas' }, 'POST /recordings/storage/nastest': { ok: true } }));
    vi.stubGlobal('fetch', f);
    renderNG(<Grabaciones embedded section="cfg" />);
    fireEvent.click(await screen.findByRole('button', { name: /Probar conexión/ }));
    await waitFor(() => expect(f.de('POST', '/recordings/storage/nastest').length).toBe(1));
    expect(f.de('POST', '/recordings/storage/nastest')[0].cuerpo.nas_type).toBe('mount');
  });

  it('S3: credenciales; probar y guardar muestran el error de la API', async () => {
    f = fetchFalso(rutas({
      'GET /recordings/config': { backend: 's3', has_secret: true },
      'POST /recordings/storage/test': estado(502, { error: 'Bucket inexistente' }),
      'POST /recordings/config': estado(400, { error: 'Falta la región' }),
    }));
    vi.stubGlobal('fetch', f);
    renderNG(<Grabaciones embedded section="cfg" />);
    const campos = { 'Endpoint (vacío = AWS)': 'http://minio:9000', 'Región': 'us-east-1', 'Bucket': 'grab', 'Prefijo': 'rec/', 'Access Key': 'AK' };
    for (const [label, v] of Object.entries(campos)) fireEvent.change(await screen.findByRole('textbox', { name: label }), { target: { value: v } });
    fireEvent.change(screen.getByPlaceholderText('•••••• (guardado)'), { target: { value: 'SK' } });
    fireEvent.click(screen.getByRole('button', { name: /Probar destino/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Error: Bucket inexistente', 'bad'));
    fireEvent.click(screen.getByRole('button', { name: /Guardar configuración/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Error al guardar', 'bad', { description: 'Falta la región' }));
    expect(f.de('POST', '/recordings/config')[0].cuerpo).toMatchObject({ s3_endpoint: 'http://minio:9000', s3_region: 'us-east-1', s3_bucket: 'grab', s3_prefix: 'rec/', s3_key: 'AK', s3_secret: 'SK' });
  });

  it('probar destino sin mensaje de la API dice OK', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /recordings/config': { backend: 'nas' }, 'POST /recordings/storage/test': null })));
    renderNG(<Grabaciones embedded section="cfg" />);
    fireEvent.click(await screen.findByRole('button', { name: /Probar destino/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('OK', 'ok'));
  });

  it('página completa: «Actualizar» recarga listado y uso, y la solapa Almacenamiento muestra la config', async () => {
    renderNG(<Grabaciones />);
    await screen.findByText('6 grabaciones');
    expect(screen.getByText('Grabaciones', { selector: 'h2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Actualizar/ }));
    await waitFor(() => expect(f.de('GET', '/recordings/storage/usage').length).toBe(2));
    expect(f.llamadas.filter((l) => l.ruta === '/recordings').length).toBe(2);
    fireEvent.click(screen.getByRole('tab', { name: /Almacenamiento/ }));
    expect(await screen.findByRole('button', { name: /Guardar configuración/ })).toBeTruthy();
  });

  it('mientras carga el listado muestra los KPIs vacíos', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderNG(<Grabaciones embedded />);
    expect(screen.getAllByText('—').length).toBe(4);
  });
});
