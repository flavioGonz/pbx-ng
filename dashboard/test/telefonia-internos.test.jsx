/* ============================================================================
 *  Internos (/internos) y sus desvíos (DesviosPanel).
 *
 *  Lo que se fija:
 *   - la tabla y los contadores salen del estado EN VIVO (snapshot + carril rápido): en
 *     llamada, timbrando, pausa, DND y desvío se cuentan igual en los KPI, en el filtro y
 *     en cada fila; la búsqueda encuentra por número, nombre o IP;
 *   - el alta sugiere el próximo número libre del plan y lo valida contra la API mientras
 *     se escribe (con freno): un número ocupado NO se guarda;
 *   - editar no cambia el número ni el tipo (WebRTC/SIP son dos endpoints distintos) y
 *     ofrece crear el otro tipo; el acceso por QR se genera y se manda por correo;
 *   - los desvíos guardan exactamente lo que se ve, avisan si Asterisk no tomó el cambio
 *     y muestran los códigos reales de esta central.
 *  Es la pantalla del día a día de la mesa de ayuda: si cuenta mal o guarda un número
 *  repetido, se pisa el interno de otra persona.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());
const vivo = vi.hoisted(() => ({ snap: null, estados: {} }));
vi.mock('../app/useLive.js', () => ({ useLive: () => ({ snap: vivo.snap, connected: true }), useEstados: () => vivo.estados }));
// El contador animado no aporta nada acá y depende de medir el DOM.
vi.mock('../app/Slot.jsx', () => ({ default: ({ value }) => <span>{value == null ? '' : String(value)}</span> }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }) => <svg data-testid="qr" data-value={value} /> }));

import { apiMock, notifyMock, resetNucleo } from './helpers/nucleo-render.jsx';
import { renderTel, escribir, elegir } from './helpers/telefonia-render.jsx';
import Extensiones from '../app/internos/page.jsx';
import DesviosPanel, { CODIGOS_DESVIO } from '../app/DesviosPanel.jsx';

beforeEach(() => {
  resetNucleo();
  vivo.snap = null; vivo.estados = {};
  vi.stubGlobal('confirm', vi.fn(() => true));
});

const internos = [
  { id: '1001', name: 'Recepción', status: 'online', via: 'direct', ip: '10.0.0.11', rtt: 35.2, webrtc: false, video: true },
  { id: '1002', name: 'Ventas', status: 'in_call', via: 'sbc', origin: '200.1.1.1:5060', rtt: 150, webrtc: true },
  { id: '1003', name: 'Soporte', status: 'online', via: 'webrtc', rtt: 300, webrtc: true },
  { id: '1004', name: '', status: 'online', via: 'raro' },
  { id: '1005', name: 'Depósito', status: 'offline' },
  { id: '1006', name: 'Gerencia', status: 'online' },
];
const estados = {
  1002: { act: 'en_llamada' },
  1003: { act: 'timbrando' },
  1004: { act: 'libre', dnd: true },
  1006: { act: 'libre', pausa: true, desvio: 'incondicional', desvio_a: '099' },
};

const PLAN = { next: '1007', principal: { desde: 1000, hasta: 1099 } };
function apiInternos(opts = {}) {
  const plan = 'plan' in opts ? opts.plan : PLAN;
  apiMock.responder('GET /enrollments', [
    { ext: '1001', estado: 'activado', activated_at: '2026-10-01T12:00:00Z', device: 'iPhone', platform: 'iOS', ip: '1.2.3.4', uses: 2 },
    { ext: '1002', estado: 'activado' },
    { ext: '1003', estado: 'vencido' },
    { ext: '1005', estado: 'enviado' },
  ]);
  apiMock.responder('GET /extensions/record-all', { enabled: false });
  apiMock.responder('GET /featurecodes', [{ accion: 'cfu_set', code: '_*72*.' }, { accion: null }, null]);
  apiMock.responder('GET /numbering/plan', plan);
}
const fila = (id) => screen.getByText(id, { selector: 'td' }).closest('tr');

describe('/internos — tabla en vivo', () => {
  it('sin snapshot muestra la espera; con snapshot vacío, «Sin extensiones.»', () => {
    apiInternos();
    const { rerender } = renderTel(<Extensiones />);
    expect(screen.queryByText('Sin extensiones.')).toBeNull();
    vivo.snap = { extensions: [] };
    rerender(<Extensiones />);
    expect(screen.getByText('Sin extensiones.')).toBeTruthy();
  });

  it('cuenta y pinta cada estado igual en los KPI, en el filtro y en la fila', async () => {
    vivo.snap = { extensions: internos }; vivo.estados = estados;
    apiInternos();
    renderTel(<Extensiones />);
    const kpi = (k) => screen.getByText(k, { selector: 'p' }).previousSibling.textContent;
    expect(kpi('Total')).toBe('6');
    expect(kpi('En línea')).toBe('5');
    expect(kpi('En llamada')).toBe('1');
    expect(kpi('Pausados')).toBe('1');
    expect(kpi('No molestar')).toBe('1');
    expect(kpi('WebRTC')).toBe('2');
    expect(screen.getByText('1 timbrando')).toBeTruthy();
    expect(screen.getByText('5 en línea')).toBeTruthy();
    // Filas: vía, IP/origen, RTT, tipo, video y acceso.
    expect(within(fila('1001')).getByText('Directo')).toBeTruthy();
    expect(within(fila('1001')).getByText('10.0.0.11')).toBeTruthy();
    expect(within(fila('1001')).getByText('35')).toBeTruthy();
    expect(within(fila('1001')).getByText('Sí')).toBeTruthy();
    expect(await within(fila('1001')).findByText('iPhone')).toBeTruthy();
    expect(within(fila('1002')).getByText('SBC')).toBeTruthy();
    expect(within(fila('1002')).getByText('200.1.1.1:5060')).toBeTruthy();
    expect(within(fila('1002')).getByText('Activado')).toBeTruthy();
    expect(within(fila('1003')).getByText('Enlace vencido')).toBeTruthy();
    expect(within(fila('1004')).getByText('No molestar')).toBeTruthy();
    expect(within(fila('1005')).getByText('Enviado, sin activar')).toBeTruthy();
    expect(within(fila('1005')).getByText('Desconectado')).toBeTruthy();
    expect(within(fila('1006')).getByText('Pausado')).toBeTruthy();
  });

  it('los filtros dejan sólo lo que dicen y la búsqueda encuentra por número, nombre o IP', async () => {
    vivo.snap = { extensions: internos }; vivo.estados = estados;
    apiInternos();
    renderTel(<Extensiones />);
    const ids = () => screen.queryAllByText(/^100\d$/, { selector: 'td' }).map((td) => td.textContent);
    fireEvent.click(screen.getByText('En llamada (2)'));
    expect(ids()).toEqual(['1002', '1003']);
    fireEvent.click(screen.getByText('Libres (1)'));
    expect(ids()).toEqual(['1001']);
    fireEvent.click(screen.getByText('Pausa (1)'));
    expect(ids()).toEqual(['1006']);
    fireEvent.click(screen.getByText('DND (1)'));
    expect(ids()).toEqual(['1004']);
    fireEvent.click(screen.getByText('Desvío (1)'));
    expect(ids()).toEqual(['1006']);
    fireEvent.click(screen.getByText('Sin registrar (1)'));
    expect(ids()).toEqual(['1005']);
    fireEvent.click(screen.getByText('Todos'));
    const buscar = screen.getByPlaceholderText('Buscar extensión, nombre o IP');
    escribir(buscar, 'ventas');
    expect(ids()).toEqual(['1002']);
    escribir(buscar, '10.0.0');
    expect(ids()).toEqual(['1001']);
    escribir(buscar, '1005');
    expect(ids()).toEqual(['1005']);
  });

  it('borrar pide confirmación y avisa; si la API falla, se muestra el error', async () => {
    vivo.snap = { extensions: internos.slice(0, 2) };
    apiInternos();
    apiMock.responder('DELETE /endpoints/1001', null);
    apiMock.fallar('DELETE /endpoints/1002', 409, 'Está en una cola');
    renderTel(<Extensiones />);
    const borrar = (id) => fireEvent.click(fila(id).querySelectorAll('td:last-child button')[1]);
    window.confirm.mockReturnValueOnce(false);
    borrar('1001');
    expect(apiMock.llamadasA('DELETE /endpoints/1001')).toHaveLength(0);
    borrar('1001');
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Extensión 1001 eliminado', 'info'));
    borrar('1002');
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: Está en una cola', 'bad'));
  });
});

describe('/internos — alta', () => {
  it('sugiere el próximo libre, valida el número con freno y crea con POST', async () => {
    vivo.snap = { extensions: internos };
    apiInternos();
    apiMock.responder(/^\/numbering\/check\?ext=1007$/, { ok: true });
    apiMock.responder('POST /endpoints', { created: '1007' });
    renderTel(<Extensiones />);
    fireEvent.click(screen.getByRole('button', { name: /Nuevo extensión/ }));
    expect(await screen.findByText('Estás usando el rango 1000–1099. El próximo libre es 1007.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Usar el siguiente libre: 1007' }));
    expect(screen.getByLabelText(/Número de interno/).value).toBe('1007');
    await waitFor(() => expect(apiMock.llamadasA(/numbering\/check/)).toHaveLength(1), { timeout: 1500 });
    fireEvent.click(screen.getByRole('button', { name: 'Crear interno' }));
    expect(notifyMock.toast).toHaveBeenCalledWith('Completá extensión y contraseña', 'bad');
    escribir(screen.getByPlaceholderText('Obligatoria'), 'clave1');
    escribir(screen.getByLabelText('Nombre'), 'Caja');
    fireEvent.click(screen.getByRole('tab', { name: 'Conexión' }));
    expect(screen.getByText('DTLS-SRTP, ICE, ulaw/g722. Se aprovisiona con el QR.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/SIP físico/));
    expect(screen.getByText('Yealink, Grandstream, Fanvil, porteros SIP.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Video (VP8/H264)'));
    escribir(screen.getByLabelText('Dispositivos'), '');
    elegir(screen.getByDisplayValue('RFC 4733 — por RTP (recomendado)'), 'Automático con INFO — ideal para porteros');
    expect(screen.getByText(/La opción más compatible con porteros/)).toBeTruthy();
    fireEvent.click(screen.getByText('Grabar las llamadas de este interno').closest('.mantine-Card-root').querySelector('input'));
    fireEvent.click(screen.getByRole('button', { name: 'Crear interno' }));
    await waitFor(() => expect(apiMock.llamadasA('POST /endpoints')).toHaveLength(1));
    expect(apiMock.llamadasA('POST /endpoints')[0].body).toEqual({
      id: '1007', name: 'Caja', password: 'clave1', video: true, record: true, webrtc: false, max_contacts: 1, dtmf_mode: 'auto_info',
    });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Extensión 1007 creada', 'ok'));
  });

  it('un número ocupado se marca y no se guarda; uno «raro» avisa pero deja; letras no entran', async () => {
    vivo.snap = { extensions: [] };
    apiInternos({ plan: null });
    apiMock.responder(/^\/numbering\/check\?ext=1001$/, { ok: false, mensaje: 'Lo usa Recepción' });
    apiMock.responder(/^\/numbering\/check\?ext=9999$/, { ok: true, aviso: true, mensaje: 'Fuera del rango habitual' });
    apiMock.fallar(/^\/numbering\/check\?ext=5$/, 500, 'x');
    renderTel(<Extensiones />);
    fireEvent.click(screen.getByRole('button', { name: /Nuevo extensión/ }));
    const num = screen.getByLabelText(/Número de interno/);
    expect(num.placeholder).toBe('1006');
    escribir(num, '10a01');
    expect(num.value).toBe('1001');
    expect(await screen.findByText('Lo usa Recepción', {}, { timeout: 1500 })).toBeTruthy();
    escribir(screen.getByPlaceholderText('Obligatoria'), 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Crear interno' }));
    expect(notifyMock.toast).toHaveBeenCalledWith('Ese número no se puede usar', 'bad', { description: 'Lo usa Recepción' });
    expect(apiMock.llamadasA('POST /endpoints')).toHaveLength(0);
    escribir(num, '9999');
    expect(await screen.findByText('Fuera del rango habitual', {}, { timeout: 1500 })).toBeTruthy();
    escribir(num, '5');
    await waitFor(() => expect(screen.queryByText('Fuera del rango habitual')).toBeNull(), { timeout: 1500 });
    escribir(num, '');
    expect(screen.queryByText('Lo usa Recepción')).toBeNull();
  });

  it('si el alta falla, el motivo llega al operador; la grabación global bloquea el interruptor', async () => {
    vivo.snap = { extensions: [] };
    apiInternos();
    apiMock.responder('GET /extensions/record-all', { enabled: true });
    apiMock.fallar('POST /endpoints', 409, 'Ya existe');
    renderTel(<Extensiones />);
    fireEvent.click(screen.getByRole('button', { name: /Nuevo extensión/ }));
    escribir(screen.getByLabelText(/Número de interno/), '2000');
    escribir(screen.getByPlaceholderText('Obligatoria'), 'x');
    fireEvent.click(screen.getByRole('tab', { name: 'Conexión' }));
    expect(await screen.findByText(/La grabación global está activa/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Crear interno' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: Ya existe', 'bad'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Nuevo interno')).toBeNull());
  });
});

describe('/internos — edición', () => {
  it('abre con el estado vivo, genera el QR y lo manda por correo; guarda con PUT', async () => {
    vivo.snap = { extensions: internos }; vivo.estados = estados;
    apiInternos();
    apiMock.responder('POST /enroll', ({ body }) => ({ token: 'tok-' + body.ext, password: 'pw9', ext: body.ext }));
    apiMock.responder('POST /enroll/email', {});
    apiMock.responder('PUT /endpoints/1002', {});
    apiMock.responder('GET /extensions/1002/features', { dnd: false });
    renderTel(<Extensiones />);
    fireEvent.click(fila('1002'));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByText('Interno 1002')).toBeTruthy();
    expect(within(dlg).getByText('Ventas')).toBeTruthy();
    expect(within(dlg).getByText('150 ms')).toBeTruthy();
    expect(within(dlg).getByText('Registrado')).toBeTruthy();
    expect(screen.getByLabelText(/Número de interno/).disabled).toBe(true);
    await waitFor(() => expect(apiMock.llamadasA('POST /enroll')).toHaveLength(1));
    fireEvent.click(screen.getByRole('tab', { name: 'Acceso QR' }));
    expect(await screen.findByText('pw9')).toBeTruthy();
    expect(screen.getByTestId('qr').getAttribute('data-value')).toBe(location.origin + '/enroll?token=tok-1002');
    const enviar = screen.getByRole('button', { name: 'Enviar' });
    expect(enviar.disabled).toBe(true);
    escribir(screen.getByPlaceholderText('usuario@empresa.com'), 'ana@x.com');
    fireEvent.click(enviar);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('QR enviado a ana@x.com', 'ok'));
    expect(apiMock.llamadasA('POST /enroll/email')[0].body).toEqual({ ext: '1002', to: 'ana@x.com', tenant_id: 1 });
    fireEvent.click(screen.getByRole('tab', { name: 'Desvíos' }));
    expect(await screen.findByText('Desvío incondicional')).toBeTruthy();
    expect(screen.getAllByText('*72*destino#').length).toBe(1);   // el código real de esta central
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(apiMock.llamadasA('PUT /endpoints/1002')).toHaveLength(1));
    expect(apiMock.llamadasA('PUT /endpoints/1002')[0].body).toMatchObject({ id: '1002', webrtc: true, password: undefined });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Extensión 1002 actualizada', 'ok'));
  });

  it('desde el lápiz: un interno sin registrar lo dice; si falla el QR o el correo, avisa', async () => {
    vivo.snap = { extensions: internos }; vivo.estados = estados;
    apiInternos();
    apiMock.fallar('POST /enroll', 500, 'sin token');
    apiMock.fallar('POST /enroll/email', 502, 'sin SMTP');
    renderTel(<Extensiones />);
    fireEvent.click(fila('1005').querySelector('td:last-child button'));
    expect(within(screen.getByRole('dialog')).getByText('Sin registrar')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText('Depósito')).toBeTruthy();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: sin token', 'bad'));
    fireEvent.click(screen.getByRole('tab', { name: 'Acceso QR' }));
    escribir(screen.getByPlaceholderText('usuario@empresa.com'), 'b@x.com');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: sin SMTP', 'bad'));
  });

  it('un interno SIP sin nombre ofrece crear uno WebRTC nuevo (otro endpoint), con el alta ya elegida', async () => {
    vivo.snap = { extensions: [{ id: '1010', status: 'offline', webrtc: false }] };
    apiInternos();
    renderTel(<Extensiones />);
    fireEvent.click(fila('1010'));
    expect(within(screen.getByRole('dialog')).getByText('Teléfono físico')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Conexión' }));
    fireEvent.click(screen.getByRole('button', { name: 'Crear uno nuevo WebRTC' }));
    expect(await screen.findByText('Nuevo interno', {}, { timeout: 1500 })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Conexión' }));
    expect(screen.getByText('DTLS-SRTP, ICE, ulaw/g722. Se aprovisiona con el QR.')).toBeTruthy();
  });

  it('un interno WebRTC ofrece crear uno SIP; si ya no está en la lista viva, el cajón no inventa estado', async () => {
    vivo.snap = { extensions: [{ id: '1011', status: 'online', webrtc: true, dtmf_mode: 'info', tenant_id: 3 }] };
    apiInternos();
    const { rerender } = renderTel(<Extensiones />);
    fireEvent.click(fila('1011'));
    expect(within(screen.getByRole('dialog')).getByText('Navegador / app')).toBeTruthy();
    vivo.snap = { extensions: [] };
    rerender(<Extensiones />);
    expect(within(screen.getByRole('dialog')).queryByText('Registrado')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Conexión' }));
    expect(screen.getByRole('button', { name: 'Crear uno nuevo SIP físico' })).toBeTruthy();
    expect(screen.getByText('Fuerza SIP INFO. Elegilo si el portero no abre la puerta con las otras opciones.')).toBeTruthy();
  });
});

describe('/internos — acceso rápido por QR', () => {
  it('sugiere el próximo del plan y genera el acceso; «Generar otro» vuelve al formulario', async () => {
    vivo.snap = { extensions: internos };
    apiInternos();
    apiMock.responder('POST /enroll', ({ body }) => ({ token: 't', password: 'p', ext: body.ext }));
    renderTel(<Extensiones />);
    await waitFor(() => expect(apiMock.llamadasA('GET /numbering/plan')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /Acceso QR/ }));
    const n = screen.getByLabelText('Número de interno');
    await waitFor(() => expect(n.value).toBe('1007'));
    escribir(n, '1050');
    fireEvent.click(screen.getByRole('button', { name: 'Generar acceso' }));
    expect(await screen.findByText('Interno 1050')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Generar otro' }));
    expect(screen.getByRole('button', { name: 'Generar acceso' })).toBeTruthy();
  });

  it('sin plan sugiere el más alto + 1 (o 1001 si no hay ninguno); sin número no pide nada', async () => {
    vivo.snap = { extensions: [{ id: '2001', status: 'offline' }, { id: 'abc', status: 'offline' }] };
    apiInternos({ plan: {} });
    const { unmount } = renderTel(<Extensiones />);
    await waitFor(() => expect(apiMock.llamadasA('GET /numbering/plan')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /Acceso QR/ }));
    expect(screen.getByLabelText('Número de interno').value).toBe('2002');
    escribir(screen.getByLabelText('Número de interno'), '');
    fireEvent.click(screen.getByRole('button', { name: 'Generar acceso' }));
    expect(apiMock.llamadasA('POST /enroll')).toHaveLength(0);
    unmount();
    vivo.snap = { extensions: [] };
    renderTel(<Extensiones />);
    await waitFor(() => expect(apiMock.llamadasA('GET /numbering/plan')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /Acceso QR/ }));
    expect(screen.getByLabelText('Número de interno').value).toBe('1001');
  });
});

/* ─────────────────────────── DesviosPanel ─────────────────────────── */
describe('DesviosPanel', () => {
  it('sin interno no pide nada', () => {
    renderTel(<DesviosPanel />);
    expect(screen.getByText(/Sin interno asignado/)).toBeTruthy();
    expect(apiMock.llamadas).toHaveLength(0);
  });

  it('si no se pueden leer los desvíos, lo dice con el motivo', async () => {
    apiMock.fallar('GET /extensions/1001/features', 403, 'No tenés permiso para esta acción');
    renderTel(<DesviosPanel ext="1001" />);
    expect(await screen.findByText('No se pudieron leer los desvíos')).toBeTruthy();
    expect(screen.getByText('No tenés permiso para esta acción')).toBeTruthy();
  });

  it('muestra los códigos de fábrica, guarda exactamente lo que se ve y avisa al dueño', async () => {
    apiMock.responder('GET /extensions/1001/features', { dnd: false, cfu: '', fm_seg: 0 });
    apiMock.responder('PUT /extensions/1001/features', ({ body }) => ({ ...body, fm_seg: 'x' }));
    const onGuardado = vi.fn();
    renderTel(<DesviosPanel ext="1001" propio onGuardado={onGuardado} />);
    expect(await screen.findByText(/Tu teléfono no suena/)).toBeTruthy();
    expect(screen.getByText(CODIGOS_DESVIO.dnd_on)).toBeTruthy();
    const guardar = screen.getByRole('button', { name: 'Guardar desvíos' });
    expect(guardar.disabled).toBe(true);
    fireEvent.click(screen.getByText('No molestar (DND)').closest('.mantine-Card-root').querySelector('input'));
    const [cfu, cfb, cfnr, fm] = screen.getAllByRole('textbox');
    escribir(cfu, '09-912 34 56a');
    expect(cfu.value).toBe('099123456');
    escribir(cfb, '1002');
    escribir(cfnr, '*1003#');
    escribir(fm, '+59899');
    expect(screen.getByText('Hay cambios sin guardar')).toBeTruthy();
    expect(screen.getAllByText('activo').length).toBe(4);
    fireEvent.click(guardar);
    await waitFor(() => expect(apiMock.llamadasA('PUT /extensions/1001/features')).toHaveLength(1));
    expect(apiMock.llamadasA('PUT /extensions/1001/features')[0].body).toEqual({ dnd: true, cfu: '099123456', cfb: '1002', cfnr: '*1003#', fm: '+59899', fm_seg: 15 });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Tus desvíos quedaron guardados', 'ok'));
    expect(onGuardado).toHaveBeenCalledWith(expect.objectContaining({ dnd: true, fm_seg: 15 }));
  });

  it('con `aviso` (Asterisk no lo tomó) no festeja; «Apagar todos» limpia; los segundos del sígueme tienen piso', async () => {
    apiMock.responder('GET /extensions/1002/features', { dnd: true, cfu: '1003', fm: '099', fm_seg: 20 });
    apiMock.responder('PUT /extensions/1002/features', { aviso: 'Asterisk no respondió' });
    renderTel(<DesviosPanel ext="1002" codigos={{ cfu_set: '_*72*.', dnd_on: '', fm_set: '*24*' }} />);
    expect(await screen.findByText(/El teléfono no suena/)).toBeTruthy();
    expect(screen.getByText('*72*destino#')).toBeTruthy();
    expect(screen.getByText('*24*099123456#')).toBeTruthy();
    escribir(screen.getByDisplayValue('20'), '0');
    fireEvent.click(screen.getByRole('button', { name: 'Apagar todos' }));
    expect(screen.getAllByText('apagado').length).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar desvíos' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Asterisk no respondió', 'bad', expect.objectContaining({ description: expect.any(String) })));
    expect(apiMock.llamadasA('PUT /extensions/1002/features')[0].body).toEqual({ dnd: false, cfu: '', cfb: '', cfnr: '', fm: '', fm_seg: 15 });
  });

  it('un error al guardar se muestra; respuestas vacías no rompen', async () => {
    apiMock.responder('GET /extensions/1003/features', null);
    apiMock.fallar('PUT /extensions/1003/features', 500, 'Base caída');
    renderTel(<DesviosPanel ext="1003" />);
    await screen.findByText('Desvío incondicional');
    escribir(screen.getAllByRole('textbox')[0], '1');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar desvíos' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Base caída', 'bad'));
  });

  it('una respuesta del PUT vacía igual deja el formulario como se guardó', async () => {
    apiMock.responder('GET /extensions/1004/features', { cfu: '1' });
    apiMock.responder('PUT /extensions/1004/features', null);
    renderTel(<DesviosPanel ext="1004" />);
    await screen.findByText('Desvío incondicional');
    escribir(screen.getAllByRole('textbox')[0], '2');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar desvíos' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Desvíos del interno 1004 guardados', 'ok'));
    expect(screen.queryByText('Hay cambios sin guardar')).toBeNull();
  });
});
