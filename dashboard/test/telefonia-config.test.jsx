/* ============================================================================
 *  Configuración de telefonía: ajustes SIP de la central (SipPanel), aprovisionamiento
 *  de teléfonos físicos (/telefonos) y la lectura del plan de marcado (/dialplan).
 *
 *  Lo que se fija:
 *   - SIP: se guarda TODO lo que se ve en las solapas, y cuando el cambio pide reiniciar
 *     Asterisk se avisa y se ofrece reiniciar ahora o cuando no haya llamadas (siempre
 *     con confirmación, porque reiniciar corta llamadas); la grabación global no festeja
 *     si Asterisk no la tomó;
 *   - teléfonos: los aprovisionados, los detectados que faltan dar de alta (precargando
 *     lo que el teléfono contó), el archivo que va a pedir cada marca, y los ajustes del
 *     servidor SIP y de la libreta; con la pestaña oculta no se encuesta;
 *   - dialplan: el texto de `dialplan show` se convierte en una tabla legible (extensión,
 *     paso, aplicación y argumentos), con búsqueda y modo crudo.
 *  Son pantallas donde un dato que no se guarda o un error tragado deja teléfonos sin
 *  registrar o una central que no aplica lo que el operador cree que aplicó.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());

import { apiMock, notifyMock, resetNucleo } from './helpers/nucleo-render.jsx';
import { renderTel, stubFetch, escribir, campo, elegir } from './helpers/telefonia-render.jsx';
import SipPanel from '../app/SipPanel.jsx';
import Telefonos from '../app/telefonos/page.jsx';
import Dialplan from '../app/dialplan/page.jsx';

beforeEach(() => {
  resetNucleo();
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => { vi.unstubAllGlobals(); });

/* ─────────────────────────── SipPanel ─────────────────────────── */
const sipconf = () => ({
  general: { user_agent: 'PBX-NG', keep_alive_interval: 90, max_forwards: 70, default_realm: '', timer_t1: 500, timer_b: 32000, contact_expiration_check_interval: 30 },
  nat: { external_signaling_address: '', external_media_address: '', local_net: ['192.168.0.0/16'], tos_sip: 'cs3', tos_audio: 'ef' },
  rtp: { rtpstart: 10000, rtpend: 20000, strictrtp: 'yes', icesupport: 'yes', stunaddr: '', dtmftimeout: 3000, rtpchecksums: 'no' },
  timers: { timers: 'yes', timers_min_se: 90, timers_sess_expires: 1800 },
  tls: { method: 'tlsv1_2', cipher: '' },
  codecs: { audio: ['ulaw', 'alaw'], video: [] },
  options: { audio: ['ulaw', 'alaw', 'g722', 'opus'], video: ['vp8', 'h264'] },
  transports: [{ id: 'transport-udp', protocol: 'udp', bind: '0.0.0.0:5060' }],
  record_all: false,
});

/* Toca cada control visible de la solapa como lo haría alguien que recorre el formulario:
 * texto y números se reescriben, los Select se eligen y se vuelven a tocar (Mantine deja
 * deseleccionar, y ahí la pantalla tiene que caer a su valor por defecto). */
function recorrerSolapa(panel) {
  panel.querySelectorAll('input').forEach((el) => {
    if (el.type === 'checkbox' || el.type === 'hidden') return;
    if (el.readOnly) {
      // Las opciones de ESTE Select (puede haber otra lista abierta de un Select anterior).
      const opciones = () => {
        fireEvent.click(el);
        const lista = document.getElementById(el.getAttribute('aria-controls'));
        return lista ? within(lista).getAllByRole('option', { hidden: true }) : [];
      };
      const op = opciones()[1];
      if (op) fireEvent.click(op);
      const marcada = opciones().find((o) => o.getAttribute('aria-selected') === 'true');
      if (marcada) fireEvent.click(marcada);
      return;
    }
    fireEvent.change(el, { target: { value: '77' } });
  });
}

describe('SipPanel', () => {
  it('mientras no llega la configuración no dibuja el formulario; si la API falla, lo dice', async () => {
    apiMock.fallar('GET /sipconf', 403, 'No tenés permiso para esta acción');
    renderTel(<SipPanel />);
    expect(screen.queryByText('Guardar y aplicar')).toBeNull();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No tenés permiso para esta acción', 'bad'));
  });

  it('guarda todas las solapas juntas; si hace falta reiniciar, avisa y ofrece hacerlo', async () => {
    apiMock.responder('GET /sipconf', sipconf());
    apiMock.responder('POST /sipconf', { restart_required: true });
    renderTel(<SipPanel />);
    escribir(await screen.findByDisplayValue('PBX-NG'), 'Central-X');
    recorrerSolapa(screen.getByRole('tabpanel'));
    fireEvent.click(screen.getByRole('tab', { name: 'NAT' }));
    escribir(screen.getAllByPlaceholderText('200.1.2.3')[0], '200.9.9.9');
    const redes = screen.getByPlaceholderText('192.168.0.0/16');
    escribir(redes, '10.0.0.0/8');
    fireEvent.keyDown(redes, { key: 'Enter' });
    recorrerSolapa(screen.getByRole('tabpanel'));
    fireEvent.click(screen.getByRole('tab', { name: 'RTP / ToS' }));
    recorrerSolapa(screen.getByRole('tabpanel'));
    fireEvent.click(screen.getByRole('tabpanel').querySelector('input[type=checkbox]'));   // aplicar ToS a todos
    fireEvent.click(screen.getByRole('tab', { name: 'Session Timer' }));
    recorrerSolapa(screen.getByRole('tabpanel'));
    fireEvent.click(screen.getByRole('tabpanel').querySelector('input[type=checkbox]'));   // aplicar temporizadores
    fireEvent.click(screen.getByRole('tab', { name: 'TCP / TLS' }));
    expect(screen.getByText('transport-udp')).toBeTruthy();
    expect(screen.getByText('UDP')).toBeTruthy();
    recorrerSolapa(screen.getByRole('tabpanel'));
    fireEvent.click(screen.getByRole('tab', { name: 'Códecs' }));
    elegir(screen.getAllByRole('textbox').find((x) => x.closest('[role=tabpanel]') && !x.readOnly), 'opus');
    elegir(screen.getAllByRole('textbox').filter((x) => x.closest('[role=tabpanel]'))[1], 'vp8');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar y aplicar' }));
    await waitFor(() => expect(apiMock.llamadasA('POST /sipconf')).toHaveLength(1));
    const body = apiMock.llamadasA('POST /sipconf')[0].body;
    expect(body.general.user_agent).toBe('77');
    expect(body.nat.external_signaling_address).toBe('77');
    expect(body.nat.local_net).toContain('10.0.0.0/8');
    expect(body.codecs.audio).toContain('opus');
    expect(body.codecs.video).toEqual(['vp8']);
    expect(body.apply_timers).toBe(true);
    expect(body.apply_tos).toBe(true);
    // Lo que se deselecciona vuelve a su valor por defecto (nunca viaja vacío).
    expect(body.nat.tos_sip).toBeTruthy();
    expect(body.rtp.strictrtp).toBeTruthy();
    expect(body.timers.timers).toBeTruthy();
    expect(body.tls.method).toBeTruthy();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith(expect.stringMatching(/hace falta reiniciar Asterisk/), 'warn', { duration: 6000 }));
    expect(screen.getByText('Reinicio de Asterisk pendiente')).toBeTruthy();
  });

  it('reiniciar pide confirmación; «cuando esté libre» y «ahora» mandan `now` distinto', async () => {
    apiMock.responder('GET /sipconf', sipconf());
    apiMock.responder('POST /sipconf', { restart_required: true });
    let falla = true;
    apiMock.responder('POST /sipconf/restart', () => { if (falla) throw new Error('AMI caído'); return {}; });
    renderTel(<SipPanel />);
    await screen.findByDisplayValue('PBX-NG');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar y aplicar' }));
    await screen.findByText('Reinicio de Asterisk pendiente');
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar ahora' }));
    expect(apiMock.llamadasA('POST /sipconf/restart')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar ahora' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No se pudo reiniciar', 'bad', { description: 'AMI caído' }));
    expect(screen.getByText('Reinicio de Asterisk pendiente')).toBeTruthy();
    falla = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar cuando esté libre' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Asterisk reiniciará apenas no haya llamadas', 'info'));
    expect(apiMock.llamadasA('POST /sipconf/restart').map((c) => c.body.now)).toEqual([true, false]);
    expect(screen.queryByText('Reinicio de Asterisk pendiente')).toBeNull();
  });

  it('reiniciar ahora también avisa; sin transportes ni opciones de códec no rompe', async () => {
    apiMock.responder('GET /sipconf', { ...sipconf(), transports: [], options: null });
    apiMock.responder('POST /sipconf', { restart_required: true });
    apiMock.responder('POST /sipconf/restart', {});
    renderTel(<SipPanel />);
    await screen.findByDisplayValue('PBX-NG');
    fireEvent.click(screen.getByRole('tab', { name: 'TCP / TLS' }));
    expect(screen.getByText(/No se pudo consultar a Asterisk/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Códecs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar y aplicar' }));
    await screen.findByText('Reinicio de Asterisk pendiente');
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar ahora' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Asterisk reiniciando', 'info'));
  });

  it('sin reinicio avisa lo aplicado (y en cuántos endpoints); un error al guardar se muestra; «Descartar» recarga', async () => {
    apiMock.responder('GET /sipconf', sipconf());
    let n = 0;
    apiMock.responder('POST /sipconf', () => { n++; if (n === 1) return { timers_applied: 12 }; if (n === 2) return null; throw new Error('Rango RTP inválido'); });
    renderTel(<SipPanel />);
    await screen.findByDisplayValue('PBX-NG');
    const guardar = () => fireEvent.click(screen.getByRole('button', { name: 'Guardar y aplicar' }));
    guardar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Configuración SIP aplicada · temporizadores en 12 endpoints', 'ok'));
    guardar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Configuración SIP aplicada', 'ok'));
    guardar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No se pudo guardar', 'bad', { description: 'Rango RTP inválido' }));
    const antes = apiMock.llamadasA('GET /sipconf').length;
    fireEvent.click(screen.getByRole('button', { name: 'Descartar cambios' }));
    await waitFor(() => expect(apiMock.llamadasA('GET /sipconf').length).toBe(antes + 1));
  });

  it('la grabación global: prender avisa fuerte, apagar confirma, y con `aviso` no festeja', async () => {
    apiMock.responder('GET /sipconf', sipconf());
    let r = {};
    apiMock.responder('POST /extensions/record-all', () => r);
    renderTel(<SipPanel />);
    await screen.findByDisplayValue('PBX-NG');
    const sw = () => screen.getByText('Grabación global de llamadas').closest('.mantine-Card-root').querySelector('input');
    fireEvent.click(sw());
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Grabación global activada: se graban todas las llamadas', 'warn'));
    expect(apiMock.llamadasA('POST /extensions/record-all')[0].body).toEqual({ enabled: true });
    await waitFor(() => expect(sw().checked).toBe(true));
    fireEvent.click(sw());
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Grabación global desactivada', 'ok'));
    r = { aviso: 'Asterisk no tomó el cambio' };
    fireEvent.click(sw());
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Asterisk no tomó el cambio', 'bad', { description: 'Hasta entonces la central sigue como estaba.' }));
    r = () => { throw new Error('x'); };
    apiMock.fallar('POST /extensions/record-all', 403, 'Sólo admin');
    fireEvent.click(sw());
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Sólo admin', 'bad'));
  });
});

/* ─────────────────────────── /telefonos ─────────────────────────── */
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

describe('/telefonos', () => {
  function apiTelefonos(extra = {}) {
    return stubFetch({
      'GET /phones': [
        { id: 1, mac: '805ec0aabbcc', vendor: 'yealink', model: 'T31P', ext: '1001', label: 'Recepción', last_seen: hace(2) },
        { id: 2, mac: '000b82112233', vendor: 'grandstream', ext: '1002', last_seen: hace(60 * 24 * 3) },
        { id: 3, mac: '001565445566', vendor: 'yealink', ext: '1003' },
      ],
      'GET /phones/detectados': [
        { ext: '1001', marca: 'Yealink', modelo: 'T31P', ua: 'Yealink SIP-T31P', ip: '10.0.0.5', mac: '805ec0aabbcc', aprovisionado: true, agenda: true },
        { ext: '1004', marca: 'Grandstream', ua: 'Grandstream GRP2601', vendor: 'grandstream', agenda: true },
        { ext: '1005', marca: 'Fanvil', modelo: 'X3', ua: 'Fanvil X3', vendor: 'fanvil', mac: 'aa', agenda: true },
        { ext: '1006', marca: 'Cisco', ua: 'Cisco', agenda: false },
      ],
      'GET /settings': { prov_sip_server: '10.0.0.2', prov_agenda_titulo: 'Oficina', agenda_clientes: '0' },
      ...extra,
    });
  }

  it('lista los aprovisionados con su estado y el archivo que pide cada marca', async () => {
    apiTelefonos();
    renderTel(<Telefonos />);
    expect(await screen.findByText('805ec0aabbcc', { selector: 'td' })).toBeTruthy();
    expect(screen.getByText('805ec0aabbcc.cfg')).toBeTruthy();
    expect(screen.getByText('cfg000b82112233.xml')).toBeTruthy();
    expect(within(screen.getByText('805ec0aabbcc', { selector: 'td' }).closest('tr')).getByText('Aprovisionado')).toBeTruthy();
    expect(screen.getByText(/^Visto /)).toBeTruthy();
    expect(screen.getByText('Pendiente')).toBeTruthy();
    expect(screen.getByText('yealink · T31P')).toBeTruthy();
    expect(screen.getByDisplayValue('10.0.0.2')).toBeTruthy();
    expect(screen.getByDisplayValue('Oficina')).toBeTruthy();
    expect(screen.getByLabelText('Incluir clientes del CRM').checked).toBe(false);
    expect(screen.getByText(location.origin + '/prov/agenda.csv')).toBeTruthy();
  });

  it('los detectados: cuántos faltan, «Dar de alta» precarga lo que contó el teléfono (sin inventar la MAC)', async () => {
    const f = apiTelefonos({ 'POST /phones': {} });
    renderTel(<Telefonos />);
    expect(await screen.findByText(/2 sin aprovisionar/)).toBeTruthy();
    expect(screen.getByText('Sin libreta remota')).toBeTruthy();
    const [g, fv] = screen.getAllByRole('button', { name: 'Dar de alta' });
    fireEvent.click(g);
    expect(screen.getByText('Nuevo teléfono físico')).toBeTruthy();
    expect(screen.getByLabelText(/Dirección MAC/).value).toBe('');
    expect(screen.getByLabelText(/^Extensión/).value).toBe('1004');
    expect(campo('Fabricante').value).toBe('Grandstream');
    fireEvent.click(screen.getByRole('button', { name: 'Aprovisionar' }));
    expect(notifyMock.toast).toHaveBeenCalledWith('MAC e extensión son obligatorios', 'bad');
    expect(f.de('POST /phones')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(fv);
    expect(campo('Fabricante').value).toBe('Yealink');   // una marca que no aprovisionamos cae en Yealink
    expect(screen.getByLabelText(/Dirección MAC/).value).toBe('aa');
  });

  it('todos aprovisionados: lo dice; sin teléfonos invita a agregar; los ajustes por defecto', async () => {
    stubFetch({
      'GET /phones': [],
      'GET /phones/detectados': [{ ext: '1', marca: 'Yealink', ua: 'x', aprovisionado: true }],
      'GET /settings': {},
    });
    renderTel(<Telefonos />);
    expect(await screen.findByText('Todos los registrados están dados de alta en la central')).toBeTruthy();
    expect(screen.getByText(/Sin teléfonos/)).toBeTruthy();
    expect(screen.getByDisplayValue('Central')).toBeTruthy();
    expect(screen.getByLabelText('Incluir clientes del CRM').checked).toBe(true);
  });

  it('nuevo teléfono: POST con lo cargado y recarga la lista', async () => {
    const f = apiTelefonos({ 'POST /phones': {} });
    renderTel(<Telefonos />);
    await screen.findByText('805ec0aabbcc', { selector: 'td' });
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo teléfono' }));
    escribir(screen.getByLabelText(/Dirección MAC/), '001122334455');
    elegir(campo('Fabricante'), 'Grandstream');
    expect(screen.getByText('cfg001122334455.xml')).toBeTruthy();
    escribir(screen.getByLabelText(/Modelo/), 'GRP2601');
    escribir(screen.getByLabelText(/^Extensión/), '1009');
    escribir(screen.getByLabelText('Nombre a mostrar'), 'Caja');
    escribir(screen.getByLabelText(/Etiqueta de línea/), 'Caja 1');
    fireEvent.click(screen.getByRole('button', { name: 'Aprovisionar' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Teléfono aprovisionado (extensión 1009)', 'ok'));
    expect(f.de('POST /phones')[0].body).toEqual({ mac: '001122334455', vendor: 'grandstream', model: 'GRP2601', ext: '1009', label: 'Caja', line_label: 'Caja 1' });
    expect(f.de('GET /phones').length).toBe(2);
  });

  it('editar (por la MAC o el lápiz) guarda con PUT; los errores de la API o de red se muestran', async () => {
    let n = 0;
    const f = apiTelefonos({ 'PUT /phones/1': () => { n++; if (n === 1) return { error: 'MAC repetida' }; if (n === 2) throw new Error('red'); return {}; } });
    renderTel(<Telefonos />);
    fireEvent.click(await screen.findByText('805ec0aabbcc', { selector: 'td' }));
    expect(screen.getByText('Editar teléfono')).toBeTruthy();
    expect(screen.getByLabelText(/Dirección MAC/).disabled).toBe(true);
    const guardar = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Guardar' }));
    guardar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: MAC repetida', 'bad'));
    guardar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: red', 'bad'));
    guardar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Teléfono actualizado', 'ok'));
    expect(f.de('PUT /phones/1')).toHaveLength(3);
    const lapiz = screen.getByText('000b82112233').closest('tr').querySelectorAll('td:last-child button')[0];
    fireEvent.click(lapiz);
    expect(screen.getByLabelText(/^Extensión/).value).toBe('1002');
  });

  it('borrar pide confirmación y no dice «eliminado» si la API lo rechazó', async () => {
    const f = apiTelefonos();
    let falla = true;
    apiMock.responder('DELETE /phones/3', () => { if (falla) throw Object.assign(new Error('No tenés permiso para esta acción'), { status: 403 }); return null; });
    renderTel(<Telefonos />);
    await screen.findByText('001565445566');
    const borrar = () => fireEvent.click(screen.getByText('001565445566').closest('tr').querySelectorAll('td:last-child button')[1]);
    window.confirm.mockReturnValueOnce(false);
    borrar();
    expect(apiMock.llamadasA('DELETE /phones/3')).toHaveLength(0);
    borrar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No tenés permiso para esta acción', 'bad'));
    expect(notifyMock.toast).not.toHaveBeenCalledWith('Teléfono eliminado', 'info');
    falla = false;
    borrar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Teléfono eliminado', 'info'));
    await waitFor(() => expect(f.de('GET /phones')).toHaveLength(3));   // recarga después de cada intento
  });

  it('servidor SIP y libreta se guardan en settings; si falla, dice «Error»', async () => {
    let falla = false;
    const f = apiTelefonos({ 'POST /settings': () => (falla ? { error: 'x' } : {}) });
    renderTel(<Telefonos />);
    escribir(await screen.findByDisplayValue('10.0.0.2'), '10.0.0.3');
    fireEvent.click(screen.getByText('Servidor SIP para los teléfonos').closest('.mantine-Card-root').querySelector('button'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Servidor SIP guardado', 'ok'));
    escribir(screen.getByDisplayValue('Oficina'), '');
    fireEvent.click(screen.getByLabelText('Incluir clientes del CRM'));
    const guardarLibreta = () => fireEvent.click(screen.getByText('Libreta de la central').closest('.mantine-Card-root').querySelector('button'));
    guardarLibreta();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Libreta guardada · los teléfonos la toman en el próximo refresco', 'ok'));
    expect(f.de('POST /settings').map((p) => p.body)).toEqual([{ prov_sip_server: '10.0.0.3' }, { prov_agenda_titulo: 'Central', agenda_clientes: '1' }]);
    falla = true;
    guardarLibreta();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error', 'bad'));
    fireEvent.click(screen.getByText('Servidor SIP para los teléfonos').closest('.mantine-Card-root').querySelector('button'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledTimes(4));
  });

  it('con la red caída no rompe; sólo encuesta con la pestaña visible y deja de hacerlo al salir', async () => {
    const intervalos = [];
    /* Se atrapa sólo el intervalo de 30 s de la pantalla; los demás (los de waitFor) andan. */
    const si = globalThis.setInterval; const ci = globalThis.clearInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...a) => { if (ms === 30000) { intervalos.push({ fn, ms }); return 99; } return si(fn, ms, ...a); });
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation((id) => (id === 99 ? undefined : ci(id)));
    const f = stubFetch({ 'GET /phones': () => { throw new Error('red'); }, 'GET /phones/detectados': () => { throw new Error('red'); }, 'GET /settings': () => { throw new Error('red'); } });
    const { unmount } = renderTel(<Telefonos />);
    await waitFor(() => expect(f.pedidos.length).toBe(3));
    const poll = intervalos.find((x) => x.ms === 30000);
    expect(poll).toBeTruthy();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    poll.fn();
    expect(f.pedidos.length).toBe(3);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    poll.fn();
    await waitFor(() => expect(f.pedidos.length).toBe(5));
    unmount();
    expect(clear).toHaveBeenCalledWith(99);
    delete document.hidden;
  });
});

/* ─────────────────────────── /dialplan ─────────────────────────── */
const DIALPLAN = [
  "[ Context 'internal' created by 'pbx_config' ]",
  "  '1001' =>         1. Answer()                                  [extensions.conf:10]",
  '                    2. Dial(PJSIP/1001,30)                       [extensions.conf:11]',
  '                    3. Hangup()',
  "  '_0X.' =>         1. NoOp(salida)",
  '                    2. Raro',
  '-= 2 extensions (5 priorities) in 1 context. =-',
].join('\n');

describe('/dialplan', () => {
  it('convierte el texto en tabla, explica las aplicaciones y deja buscar', async () => {
    const f = stubFetch({ '/dialplan': { output: DIALPLAN } });
    renderTel(<Dialplan />);
    expect(await screen.findByText('1001')).toBeTruthy();
    expect(f.pedidos[0].path).toBe('/dialplan?context=internal');
    expect(screen.getByText('2 extensiones')).toBeTruthy();
    expect(screen.getByText('5 pasos')).toBeTruthy();
    expect(screen.getByText('PJSIP/1001,30')).toBeTruthy();
    expect(screen.getAllByText('sigue')).toHaveLength(3);
    expect(screen.getByText('Raro')).toBeTruthy();   // una aplicación que no está en el glosario igual se muestra
    expect(screen.getByText('Qué hace cada aplicación de este contexto')).toBeTruthy();
    expect(screen.getByText(/Llama a un destino/)).toBeTruthy();
    const buscar = screen.getByPlaceholderText('Buscar extensión / app / dato');
    escribir(buscar, 'pjsip');
    expect(screen.queryByText('salida')).toBeNull();
    expect(screen.getByText('PJSIP/1001,30')).toBeTruthy();
    escribir(buscar, 'noop');
    expect(screen.getByText('salida')).toBeTruthy();
    escribir(buscar, '_0X');
    expect(screen.getByText('_0X.')).toBeTruthy();
  });

  it('modo crudo muestra el texto tal cual; cambiar de contexto y recargar vuelven a pedir', async () => {
    const f = stubFetch({ '/dialplan': (req) => (req.path.endsWith('ivr') ? { output: '' } : { output: DIALPLAN }) });
    renderTel(<Dialplan />);
    await screen.findByText('1001');
    fireEvent.click(screen.getByLabelText('Texto crudo'));
    expect(screen.queryByPlaceholderText('Buscar extensión / app / dato')).toBeNull();
    expect(screen.getByText(/Context 'internal' created/)).toBeTruthy();
    fireEvent.click(screen.getByText('ivr'));
    await waitFor(() => expect(f.pedidos.map((p) => p.path)).toContain('/dialplan?context=ivr'));
    expect(await screen.findByText('Sin datos')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Texto crudo'));
    expect(screen.getByText(/Sin reglas en el contexto “ivr”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recargar' }));
    await waitFor(() => expect(f.pedidos.filter((p) => p.path.endsWith('ivr'))).toHaveLength(2));
  });

  it('un error de la API se muestra como texto; la red caída deja «Error»; contexto sin descripción no rompe', async () => {
    let n = 0;
    stubFetch({ '/dialplan': () => { n++; if (n === 1) return { error: 'agente caído' }; throw new Error('red'); } });
    renderTel(<Dialplan />);
    fireEvent.click(await screen.findByLabelText('Texto crudo'));
    expect(await screen.findByText('agente caído')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recargar' }));
    expect(await screen.findByText('Error')).toBeTruthy();
    fireEvent.click(screen.getByText('default'));
    expect(await screen.findByText(/Contexto por defecto de Asterisk/)).toBeTruthy();
  });
});
