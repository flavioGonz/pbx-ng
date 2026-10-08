/* ============================================================================
 *  Buzones de voz (BuzonesPanel) y la conexión con SBC-NG (/sbc).
 *
 *  Buzones — lo que se fija: el listado NO trae el PIN y marca los que todavía tienen el
 *  PIN igual al número (cualquiera los escucha con *98); el PIN se muestra UNA vez al
 *  crear o rotar (en un cartel que no se va solo), se puede pedir de a uno, y crear un
 *  buzón que ya existía no se anuncia como «creado».
 *
 *  SBC — lo que se fija: el módulo se prende y apaga, la conexión valida la dirección,
 *  guarda el puerto como número, avisa si creó la ruta «marca 0», desconectar dice cuántas
 *  rutas salientes se van con él, y una caída de la API se avisa UNA vez (no un toast cada
 *  vuelta del encuestado).
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());

import { apiMock, notifyMock, resetNucleo } from './helpers/nucleo-render.jsx';
import { renderTel, escribir, elegir, campo } from './helpers/telefonia-render.jsx';
import BuzonesPanel from '../app/BuzonesPanel.jsx';
import SbcLinkPage from '../app/sbc/page.jsx';

beforeEach(() => {
  resetNucleo();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

/* ─────────────────────────── Buzones ─────────────────────────── */
describe('BuzonesPanel', () => {
  it('mientras carga muestra el esqueleto; sin buzones explica que cada interno trae el suyo', async () => {
    apiMock.responder('GET /mailboxes', []);
    renderTel(<BuzonesPanel />);
    expect(screen.queryByText(/Sin buzones/)).toBeNull();
    expect(await screen.findByText(/Sin buzones/)).toBeTruthy();
  });

  it('si la lista falla, avisa', async () => {
    apiMock.fallar('GET /mailboxes', 403, 'No tenés permiso para esta acción');
    renderTel(<BuzonesPanel />);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No tenés permiso para esta acción', 'bad'));
  });

  it('marca los buzones con PIN débil (uno o varios) sin mostrar ningún PIN', async () => {
    apiMock.responder('GET /mailboxes', [
      { mailbox: '1001', fullname: 'Ana', email: 'ana@x.com', pin_debil: true },
      { mailbox: '1002', pin_debil: false },
    ]);
    const { unmount } = renderTel(<BuzonesPanel />);
    expect(await screen.findByText('Hay un buzón sin PIN de verdad')).toBeTruthy();
    expect(screen.getByText('Es el número')).toBeTruthy();
    expect(screen.getByText('Propio')).toBeTruthy();
    expect(screen.getAllByText('—')).toHaveLength(2);
    unmount();
    apiMock.responder('GET /mailboxes', [{ mailbox: '1', pin_debil: true }, { mailbox: '2', pin_debil: true }]);
    renderTel(<BuzonesPanel />);
    expect(await screen.findByText('Hay 2 buzones sin PIN de verdad')).toBeTruthy();
    expect(screen.getByText('1 · 2')).toBeTruthy();
  });

  it('crear: el PIN lo genera la API y se muestra una vez, avisando si nadie se lo manda al dueño', async () => {
    apiMock.responder('GET /mailboxes', []);
    apiMock.responder('POST /mailboxes', ({ body }) => ({ created: body.mailbox, pin: '482913' }));
    renderTel(<BuzonesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nuevo buzón' }));
    const crear = screen.getByRole('button', { name: 'Crear buzón' });
    expect(crear.disabled).toBe(true);
    escribir(screen.getByLabelText(/Buzón \(interno\)/), '1003');
    escribir(screen.getByLabelText('Nombre completo'), 'Luis');
    escribir(screen.getByLabelText('Email'), 'luis@x.com');
    fireEvent.click(crear);
    expect(await screen.findByText('Buzón creado')).toBeTruthy();
    expect(apiMock.llamadasA('POST /mailboxes')[0].body).toEqual({ mailbox: '1003', fullname: 'Luis', email: 'luis@x.com' });
    expect(screen.getByText('482913')).toBeTruthy();
    expect(screen.getByText(/pasáselo al dueño/)).toBeTruthy();
    expect(screen.queryByText(/ya existía/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Listo' }));
    await waitFor(() => expect(screen.queryByText('482913')).toBeNull());
  });

  it('crear uno que ya existía no dice «creado»: muestra el PIN que ya tenía', async () => {
    apiMock.responder('GET /mailboxes', []);
    apiMock.responder('POST /mailboxes', { created: '1001', pin: '1001', ya_existia: true });
    renderTel(<BuzonesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nuevo buzón' }));
    escribir(screen.getByLabelText(/Buzón \(interno\)/), '1001');
    fireEvent.click(screen.getByRole('button', { name: 'Crear buzón' }));
    expect(await screen.findByText(/ya existía/)).toBeTruthy();
    expect(screen.getByText('PIN nuevo', { selector: 'p' })).toBeTruthy();
  });

  it('si crear falla, se muestra el motivo y el formulario sigue abierto', async () => {
    apiMock.responder('GET /mailboxes', []);
    apiMock.fallar('POST /mailboxes', 400, 'Buzón inválido');
    renderTel(<BuzonesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nuevo buzón' }));
    escribir(screen.getByLabelText(/Buzón \(interno\)/), 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Crear buzón' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Buzón inválido', 'bad'));
    expect(screen.getByText('Nuevo buzón de voz')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Nuevo buzón de voz')).toBeNull());
  });

  it('rotar pide confirmación y muestra el PIN nuevo (y si se le avisó al dueño); si falla, avisa', async () => {
    apiMock.responder('GET /mailboxes', [{ mailbox: '1001', pin_debil: true }]);
    let falla = false;
    apiMock.responder('POST /mailboxes/1001/pin', () => { if (falla) throw new Error('sin AMI'); return { mailbox: '1001', pin: '777111', avisado: true }; });
    renderTel(<BuzonesPanel />);
    const acciones = () => screen.getByText('1001', { selector: '.mantine-Badge-label' }).closest('tr').querySelectorAll('button');
    await screen.findByText('Es el número');
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(acciones()[1]);
    expect(apiMock.llamadasA('POST /mailboxes/1001/pin')).toHaveLength(0);
    fireEvent.click(acciones()[1]);
    expect(await screen.findByText('777111')).toBeTruthy();
    expect(screen.getByText(/Se le mandó el PIN nuevo por correo/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('777111')).toBeNull());
    falla = true;
    fireEvent.click(acciones()[1]);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('sin AMI', 'bad'));
  });

  it('ver el PIN lo pide de a uno al detalle; avisa si es débil; si no se puede leer, lo dice', async () => {
    apiMock.responder('GET /mailboxes', [{ mailbox: '1001', pin_debil: true }, { mailbox: '1002' }, { mailbox: '1003' }]);
    apiMock.responder('GET /mailboxes/1001', { pin: '1001', pin_debil: true });
    apiMock.responder('GET /mailboxes/1002', { pin: '559900' });
    apiMock.fallar('GET /mailboxes/1003', 403, 'Sólo admin');
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
    renderTel(<BuzonesPanel />);
    await screen.findByText('Es el número');
    const ver = (m) => fireEvent.click(screen.getByText(m, { selector: '.mantine-Badge-label' }).closest('tr').querySelector('button'));
    ver('1001');
    expect(await within(screen.getByRole('dialog')).findByText('no es un PIN')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    await waitFor(() => expect(screen.queryByText('PIN del buzón 1001')).toBeNull());
    ver('1002');
    expect(await screen.findByText('559900')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByText(/escucha sus mensajes marcando/)).toBeTruthy();
    fireEvent.click(screen.getByText('559900'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('559900'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('559900')).toBeNull());
    ver('1003');
    expect(await screen.findByText('Sólo admin')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('borrar confirma y avisa; si falla muestra el motivo', async () => {
    apiMock.responder('GET /mailboxes', [{ mailbox: '1001' }]);
    let falla = false;
    apiMock.responder('DELETE /mailboxes/1001', () => { if (falla) throw new Error('en uso'); return null; });
    renderTel(<BuzonesPanel />);
    await screen.findByText('Propio');
    const borrar = () => fireEvent.click(screen.getByText('Propio').closest('tr').querySelectorAll('button')[2]);
    window.confirm.mockReturnValueOnce(false);
    borrar();
    expect(apiMock.llamadasA('DELETE /mailboxes/1001')).toHaveLength(0);
    borrar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Buzón borrado', 'info'));
    falla = true;
    borrar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('en uso', 'bad'));
  });
});

/* ─────────────────────────── /sbc ─────────────────────────── */
describe('/sbc', () => {
  it('módulo apagado: no muestra la conexión; prenderlo avisa y recarga', async () => {
    apiMock.responder('GET /sbc-link', { configured: false, panel_url: 'https://sbc.x' });
    apiMock.responder('GET /modules', { sbc: false });
    apiMock.responder('POST /modules', {});
    renderTel(<SbcLinkPage />);
    expect(await screen.findByText('Módulo inactivo')).toBeTruthy();
    expect(screen.queryByText('Dirección del SBC-NG')).toBeNull();
    const sw = screen.getByText('Módulo «Conexión a SBC-NG»').closest('.mantine-Card-root').querySelector('input');
    await waitFor(() => expect(sw.disabled).toBe(false));
    fireEvent.click(sw);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Módulo activado: la central usará el SBC-NG cuando esté configurado', 'ok'));
    expect(apiMock.llamadasA('POST /modules')[0].body).toEqual({ id: 'sbc', enabled: true });
    expect(apiMock.llamadasA('GET /modules').length).toBe(2);
  });

  it('sin configurar: valida la dirección y conecta con el puerto como número (y avisa si creó la ruta)', async () => {
    apiMock.responder('GET /sbc-link', { configured: false });
    apiMock.responder('GET /modules', { sbc: true });
    apiMock.responder('POST /sbc-link', { ruta_creada: true });
    renderTel(<SbcLinkPage />);
    expect(await screen.findByText(/Todavía no hay un SBC-NG conectado/)).toBeTruthy();
    expect(screen.getByText('Sin configurar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Conectar SBC-NG' }));
    expect(notifyMock.toast).toHaveBeenCalledWith('La dirección del SBC-NG es obligatoria', 'bad');
    escribir(screen.getByLabelText(/IP o host del SBC-NG/), '192.168.99.113');
    escribir(screen.getByLabelText('Puerto SIP'), 'x');
    elegir(campo('Transporte'), 'TLS');
    elegir(campo('Transporte'), 'TLS');   // deseleccionar vuelve a UDP
    escribir(screen.getByLabelText('Contexto de entrada'), 'from-sbc');
    escribir(screen.getByLabelText(/URL del panel/), 'https://sbc.x');
    fireEvent.click(screen.getByLabelText(/Crear la ruta saliente/));
    const codecs = campo('Códecs');
    fireEvent.keyDown(codecs, { key: 'Backspace' });
    fireEvent.keyDown(codecs, { key: 'Backspace' });
    fireEvent.keyDown(codecs, { key: 'Backspace' });   // sin ninguno queda ulaw
    fireEvent.click(screen.getByRole('button', { name: 'Conectar SBC-NG' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Conexión al SBC-NG guardada · ruta saliente «marca 0» creada', 'ok'));
    expect(apiMock.llamadasA('POST /sbc-link')[0].body).toEqual({ host: '192.168.99.113', port: 5060, transport: 'udp', context: 'from-sbc', codecs: ['ulaw'], panel_url: 'https://sbc.x', create_route: false });
  });

  it('configurado: muestra el estado medido y guarda; desconectar dice cuántas rutas se van', async () => {
    apiMock.responder('GET /sbc-link', { configured: true, name: 'to-sbc', host: '10.0.0.9', port: 5070, transport: 'tcp', context: 'from-trunk', codecs: ['alaw'], panel_url: 'https://sbc.x', rutas_salientes: 2, estado: { vivo: true, ms: 12, motivo: 'OPTIONS 200' } });
    apiMock.responder('GET /modules', { sbc: true });
    apiMock.responder('POST /sbc-link', null);
    apiMock.responder('DELETE /sbc-link', {});
    renderTel(<SbcLinkPage />);
    expect(await screen.findByText('Conectado · 12 ms')).toBeTruthy();
    expect(screen.getByText('OPTIONS 200')).toBeTruthy();
    expect(screen.getByText('10.0.0.9:5070 · TCP')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://sbc.x' })).toBeTruthy();
    expect(screen.getByDisplayValue('10.0.0.9')).toBeTruthy();
    expect(screen.queryByLabelText(/Crear la ruta saliente/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Conexión al SBC-NG guardada', 'ok'));
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    expect(window.confirm.mock.calls[0][0]).toMatch(/y 2 ruta\(s\) saliente\(s\)/);
    expect(apiMock.llamadasA('DELETE /sbc-link')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('SBC-NG desconectado. La central opera sin borde.', 'ok'));
    const antes = apiMock.llamadasA('GET /sbc-link').length;
    fireEvent.click(screen.getByRole('button', { name: 'Refrescar' }));
    await waitFor(() => expect(apiMock.llamadasA('GET /sbc-link').length).toBe(antes + 1));
  });

  it('configurado pero caído: «No responde»; los errores de guardar, desconectar y del módulo se muestran', async () => {
    apiMock.responder('GET /sbc-link', { configured: true, enabled: true, host: '10.0.0.9', estado: { vivo: false } });
    apiMock.responder('GET /modules', null);
    apiMock.fallar('POST /sbc-link', 502, 'SBC no responde');
    apiMock.fallar('DELETE /sbc-link', 500, 'no se pudo');
    renderTel(<SbcLinkPage />);
    expect((await screen.findAllByText('No responde')).length).toBe(2);   // en el encabezado y en el estado
    expect(screen.getByText('10.0.0.9: · UDP')).toBeTruthy();
    expect(screen.getByDisplayValue('5060')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: SBC no responde', 'bad'));
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    expect(window.confirm.mock.calls[0][0]).not.toMatch(/ruta\(s\)/);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: no se pudo', 'bad'));
  });

  it('apagar el módulo avisa; si la API lo rechaza, se muestra', async () => {
    apiMock.responder('GET /sbc-link', { configured: false });
    apiMock.responder('GET /modules', {});
    let falla = false;
    apiMock.responder('POST /modules', () => { if (falla) throw new Error('Sólo admin'); return {}; });
    renderTel(<SbcLinkPage />);
    expect(await screen.findByText('Módulo activo')).toBeTruthy();
    const sw = () => screen.getByText('Módulo «Conexión a SBC-NG»').closest('.mantine-Card-root').querySelector('input');
    fireEvent.click(sw());
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Módulo desactivado: la central opera sin SBC', 'ok'));
    falla = true;
    fireEvent.click(sw());
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Sólo admin', 'bad'));
  });

  it('una caída de la API se avisa una sola vez y se rearma cuando vuelve', async () => {
    let caida = true;
    apiMock.responder('GET /sbc-link', () => { if (caida) throw Object.assign(new Error('Sin conexión con el servidor'), { status: 0 }); return { configured: false }; });
    apiMock.responder('GET /modules', { sbc: false });
    apiMock.responder('POST /modules', {});
    renderTel(<SbcLinkPage />);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Sin conexión con el servidor', 'bad'));
    const malos = () => notifyMock.toast.mock.calls.filter((c) => c[1] === 'bad').length;
    const sw = () => screen.getByText('Módulo «Conexión a SBC-NG»').closest('.mantine-Card-root').querySelector('input');
    await waitFor(() => expect(sw().disabled).toBe(false));
    // Sigue caída y se recarga: no se repite el aviso.
    fireEvent.click(sw());
    await waitFor(() => expect(apiMock.llamadasA('GET /sbc-link')).toHaveLength(2));
    expect(malos()).toBe(1);
    // Vuelve: se rearma.
    caida = false;
    fireEvent.click(sw());
    await waitFor(() => expect(apiMock.llamadasA('GET /sbc-link')).toHaveLength(3));
    expect(malos()).toBe(1);
    // Se cae otra vez: ahora sí se avisa de nuevo.
    caida = true;
    fireEvent.click(sw());
    await waitFor(() => expect(malos()).toBe(2));
  });
});
