/* ============================================================================
 *  Rutas: entrantes (DID → destino, con horario), salientes (patrón → troncal), el
 *  failover de troncal y las rutas estáticas de red del núcleo.
 *
 *  Lo que se fija:
 *   - /rutas explica si todo pasa por el SBC-NG o va directo a las troncales, y «Generar
 *     rutas sugeridas» crea SOLO lo que falta (no duplica la salida por 0 ni pisa las
 *     entradas que ya había), avisando si falló;
 *   - las columnas cuentan lo que importa: horario por nombre, destino de fuera de hora
 *     (o «buzón»), salida por SBC-NG o por troncal, cadena de respaldos;
 *   - el failover muestra por dónde está saliendo AHORA cada ruta y deja reordenar,
 *     quitar y agregar respaldos (máximo cinco) mandando el orden exacto en el PUT;
 *   - las rutas estáticas validan antes de mandar, editan con borrar+agregar y no dicen
 *     «quitada» si el agente rechazó el pedido;
 *   - el resumen de DID marca los números que todavía no tienen ruta.
 *  Es el lugar donde se decide a dónde entra y por dónde sale cada llamada: un orden de
 *  respaldos al revés es una factura cara, y un DID sin ruta es un cliente que no entra.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

import { apiMock, notifyMock, resetNucleo } from './helpers/nucleo-render.jsx';
import { renderTel, stubFetch, escribir, elegir, campo } from './helpers/telefonia-render.jsx';
import Rutas from '../app/rutas/page.jsx';
import RedirSalientes from '../app/rutas-salientes/page.jsx';
import RedirEntrantes from '../app/rutas-entrantes/page.jsx';
import FailoverSalida from '../app/FailoverSalida.jsx';
import RoutesPanel from '../app/RoutesPanel.jsx';
import DidOverview from '../app/DidOverview.jsx';

beforeEach(() => {
  resetNucleo();
  replace.mockClear();
  vi.stubGlobal('confirm', vi.fn(() => true));
  stubFetch({});
});

describe('redirecciones viejas', () => {
  it('/rutas-salientes y /rutas-entrantes mandan a /rutas', () => {
    renderTel(<RedirSalientes />);
    renderTel(<RedirEntrantes />);
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith('/rutas');
  });
});

describe('DidOverview', () => {
  it('sin troncales con DID no dibuja nada', async () => {
    stubFetch({ 'GET /trunks': [{ name: 'a', dids: [] }], 'GET /routes/inbound': [] });
    renderTel(<DidOverview />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Números (DID) de tus troncales')).toBeNull();
  });

  it('cruza los DID de cada troncal con las rutas entrantes y cuenta los que no tienen ruta', async () => {
    stubFetch({
      'GET /trunks': [{ name: 'antel', logo: 'data:image/png;base64,xx', dids: ['2400', 2401] }, { name: 'claro', dids: ['099'] }, { name: 'sin-dids' }],
      'GET /routes/inbound': [{ did: '2400', dest_type: 'ivr', dest_value: '9000' }, { did: '099', dest_type: 'raro', dest_value: 'x' }],
    });
    renderTel(<DidOverview />);
    expect(await screen.findByText('Números (DID) de tus troncales')).toBeTruthy();
    expect(screen.getByText('2 ruteados')).toBeTruthy();
    expect(screen.getByText('1 sin ruta')).toBeTruthy();
    expect(screen.getByText('IVR → 9000')).toBeTruthy();
    expect(screen.getByText('raro → x')).toBeTruthy();   // un tipo que el panel no conoce se muestra tal cual
    expect(screen.getAllByText('sin ruta')).toHaveLength(1);
  });

  it('si la API contesta algo que no es lista (o se cae), no rompe', async () => {
    stubFetch({ 'GET /trunks': { error: 'x' }, 'GET /routes/inbound': () => { throw new Error('red'); } });
    renderTel(<DidOverview />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Números (DID) de tus troncales')).toBeNull();
  });
});

const rutaFailover = (extra = {}) => ({
  id: 7, name: 'Nacional', pattern: '0X.', principal: 'to-sbc', backups: ['antel', 'claro'],
  intento_seg: 20, total_seg: 45,
  cadena: [
    { trunk: 'to-sbc', rol: 'principal', estado: 'caida', en_uso: false, sbc: true, detalle: 'no responde' },
    { trunk: 'antel', rol: 'respaldo', estado: 'ok', en_uso: true },
    { trunk: 'claro', rol: 'respaldo', estado: 'ok', en_uso: false },
  ],
  en_uso: 'antel', en_respaldo: true, ...extra,
});

describe('FailoverSalida', () => {
  it('sin rutas lo dice; el error de la API va a un toast', async () => {
    apiMock.fallar('GET /routes/outbound/failover', 500, 'AMI caído');
    renderTel(<FailoverSalida />);
    expect(screen.getByText(/Sin rutas salientes/)).toBeTruthy();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('AMI caído', 'bad'));
  });

  it('muestra la cadena, por dónde sale ahora y avisa cuando el respaldo saltea al SBC-NG', async () => {
    apiMock.responder('GET /routes/outbound/failover', [
      rutaFailover(),
      rutaFailover({ id: 8, name: '', pattern: '9X.', principal: 'antel', backups: [], cadena: [{ trunk: 'antel', rol: 'principal', estado: 'ok', en_uso: false }], en_uso: null, en_respaldo: false, prevista: 'antel' }),
      rutaFailover({ id: 9, name: 'Muerta', sin_salida: true }),
      rutaFailover({ id: 10, name: 'Directa', principal: 'antel', backups: ['claro'], en_uso: 'antel', en_respaldo: false, cadena: [{ trunk: 'antel', rol: 'principal', estado: 'ok', en_uso: true }] }),
      rutaFailover({ id: 11, name: 'Nueva', en_uso: null, prevista: null, cadena: [] }),
    ]);
    renderTel(<FailoverSalida />);
    expect(await screen.findByText('Nacional')).toBeTruthy();
    expect(screen.getByText('antel (respaldo)')).toBeTruthy();
    expect(screen.getByText('sin respaldo')).toBeTruthy();
    expect(screen.getByText('sin llamadas todavía · saldría por antel')).toBeTruthy();
    expect(screen.getByText('sin llamadas todavía')).toBeTruthy();
    expect(screen.getByText('ninguna responde')).toBeTruthy();
    expect(screen.getAllByText(/Si cae el SBC-NG estas llamadas salen directo/).length).toBeGreaterThan(0);
    expect(screen.getByText('—')).toBeTruthy();   // ruta sin nombre
  });

  it('edita los respaldos: reordena, quita, agrega y manda el orden exacto con los tiempos', async () => {
    apiMock.responder('GET /routes/outbound/failover', [rutaFailover()]);
    apiMock.responder('GET /trunks', [
      { name: 'antel', kind: 'asterisk' }, { name: 'claro', kind: 'asterisk' },
      { name: 'movistar', kind: 'asterisk', provider_host: 'sip.mov' }, { name: 'to-sbc', kind: 'sbc' },
      { name: 'web', kind: 'webrtc' },
    ]);
    apiMock.responder('PUT /routes/outbound/7', {});
    const { container } = renderTel(<FailoverSalida />);
    await screen.findByText('Nacional');
    fireEvent.click(container.querySelector('tbody button'));
    expect(screen.getByText('Respaldos de Nacional')).toBeTruthy();
    const drawer = screen.getByText('troncal principal (se cambia en la tabla de arriba)').closest('.mantine-Stack-root');
    // Bajar el primero (antel) → claro, antel.
    const filas = () => within(drawer).getAllByText(/^\d\.$/).map((n) => n.closest('.mantine-Group-root').parentElement);
    const botones = (i) => filas()[i].querySelectorAll('button');
    expect(botones(0)[0].disabled).toBe(true);    // el primero no sube
    fireEvent.click(botones(0)[1]);
    fireEvent.click(botones(1)[1]);               // el último no baja: no cambia nada
    // Agregar movistar (las webrtc y las ya usadas no se ofrecen).
    const sel = screen.getByPlaceholderText('Agregar una troncal de respaldo');
    fireEvent.click(sel);
    const ofrecidas = screen.getAllByRole('option', { hidden: true }).map((o) => o.textContent);
    expect(ofrecidas).toEqual(['movistar (sip.mov)']);
    elegir(sel, 'movistar (sip.mov)');
    // Quitar claro (ahora primero).
    fireEvent.click(botones(0)[2]);
    escribir(screen.getByLabelText('Por intento (s)'), '30');
    escribir(screen.getByLabelText('Tope total (s)'), '');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(apiMock.llamadasA('PUT /routes/outbound/7')).toHaveLength(1));
    expect(apiMock.llamadasA('PUT /routes/outbound/7')[0].body).toEqual({ backups: ['antel', 'movistar'], intento_seg: 30, total_seg: 45 });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Respaldos guardados · el dialplan ya quedó escrito', 'ok'));
  });

  it('con cinco respaldos no deja agregar más; sin respaldos lo explica; el error del PUT se muestra', async () => {
    apiMock.responder('GET /routes/outbound/failover', [
      rutaFailover({ id: 1, name: '', pattern: '00X.', principal: 'to-sbc', backups: ['a', 'b', 'c', 'd', 'to-sbc2'] }),
      rutaFailover({ id: 2, name: 'Vacía', backups: [] }),
    ]);
    apiMock.fallar('PUT /routes/outbound/1', 400, 'Respaldo repetido');
    const { container } = renderTel(<FailoverSalida />);
    await screen.findByText('Vacía');
    const engranajes = container.querySelectorAll('tbody button');
    fireEvent.click(engranajes[0]);
    expect(screen.getByText('Respaldos de _00X.')).toBeTruthy();
    expect(screen.getByPlaceholderText('Agregar una troncal de respaldo').disabled).toBe(true);
    expect(screen.getByText(/Máximo cinco respaldos/)).toBeTruthy();
    escribir(screen.getByLabelText('Por intento (s)'), '');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Respaldo repetido', 'bad'));
    expect(apiMock.llamadasA('PUT /routes/outbound/1')[0].body.intento_seg).toBe(20);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(engranajes[1]);
    expect(screen.getByText(/Todavía no hay respaldos/)).toBeTruthy();
  });
});

describe('FailoverSalida — cajón', () => {
  it('el SBC-NG como respaldo se marca distinto; una ruta sin nombre ni patrón no rompe el título; Escape cierra', async () => {
    apiMock.responder('GET /routes/outbound/failover', [rutaFailover({ id: 3, name: '', pattern: undefined, principal: 'antel', backups: ['to-sbc'] })]);
    const { container } = renderTel(<FailoverSalida />);
    await screen.findByText('antel (respaldo)');
    fireEvent.click(container.querySelector('tbody button'));
    expect(screen.getByText('Respaldos de _')).toBeTruthy();
    expect(screen.getAllByText('to-sbc').length).toBeGreaterThan(0);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Respaldos de _')).toBeNull());
  });
});

describe('RoutesPanel (rutas estáticas del núcleo)', () => {
  it('una respuesta del agente sin listas no rompe; editar una ruta con sólo destino deja lo demás vacío; Escape cierra', async () => {
    apiMock.responder('GET /asterisk/net', {});
    const { unmount } = renderTel(<RoutesPanel />);
    expect(await screen.findByText(/Sin rutas estáticas/)).toBeTruthy();
    unmount();
    apiMock.responder('GET /asterisk/net', { managed: [{ id: 'r9', dest: '8.8.8.8', dev: 'eth0' }], ifaces: [{ name: 'eth0' }] });
    const { container } = renderTel(<RoutesPanel />);
    await screen.findByText('8.8.8.8');
    fireEvent.click(container.querySelectorAll('tbody button')[0]);
    expect(screen.getByLabelText(/Gateway/).value).toBe('');
    expect(campo(/Interfaz de salida/).value).toBe('eth0');
    // Limpiar la interfaz (botón de borrar del Select) la deja vacía otra vez.
    const limpiar = campo(/Interfaz de salida/).closest('.mantine-InputWrapper-root').querySelector('button');
    fireEvent.click(limpiar);
    expect(campo(/Interfaz de salida/).value).toBe('');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Editar ruta')).toBeNull());
  });

  it('sin rutas lo explica; si el agente no contesta queda la tabla vacía', async () => {
    apiMock.fallar('GET /asterisk/net', 502, 'agente caído');
    renderTel(<RoutesPanel />);
    expect(await screen.findByText(/Sin rutas estáticas/)).toBeTruthy();
  });

  it('lista las rutas y valida destino + (gateway o interfaz) antes de mandar', async () => {
    apiMock.responder('GET /asterisk/net', { managed: [{ id: 'r1', dest: '10.0.0.0/8', gw: '172.26.30.1', note: 'LAN' }, { id: 'r2', dest: '1.2.3.4', dev: 'eth1' }], ifaces: [{ name: 'eth0' }, { name: 'eth1' }] });
    renderTel(<RoutesPanel />);
    expect(await screen.findByText('10.0.0.0/8')).toBeTruthy();
    expect(screen.getByText('LAN')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nueva ruta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agregar ruta' }));
    expect(notifyMock.toast).toHaveBeenCalledWith('Indicá destino y gateway o interfaz', 'bad');
    expect(apiMock.llamadasA('POST /asterisk/route')).toHaveLength(0);
  });

  it('agregar manda action add con lo cargado (interfaz elegida de la lista)', async () => {
    apiMock.responder('GET /asterisk/net', { managed: [], ifaces: [{ name: 'eth0' }, { name: 'eth1' }] });
    apiMock.responder('POST /asterisk/route', {});
    renderTel(<RoutesPanel />);
    await screen.findByText(/Sin rutas estáticas/);
    fireEvent.click(screen.getByRole('button', { name: 'Nueva ruta' }));
    escribir(screen.getByLabelText(/Destino \(red\/host\)/), '200.40.10.0/24');
    escribir(screen.getByLabelText(/Gateway/), '');
    elegir(campo(/Interfaz de salida/), 'eth1');
    escribir(screen.getByLabelText(/Nota/), 'WAN');
    fireEvent.click(screen.getByRole('button', { name: 'Agregar ruta' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Ruta agregada (se aplica en segundos)', 'ok'));
    expect(apiMock.llamadasA('POST /asterisk/route')[0].body).toEqual({ action: 'add', dest: '200.40.10.0/24', gw: '', dev: 'eth1', note: 'WAN' });
  });

  it('editar = borrar y volver a agregar; si el borrado falla no se agrega la duplicada', async () => {
    apiMock.responder('GET /asterisk/net', { managed: [{ id: 'r1', dest: '10.0.0.0/8', gw: '172.26.30.1' }], ifaces: [] });
    apiMock.responder('POST /asterisk/route', ({ body }) => { if (body.action === 'del') throw Object.assign(new Error('el agente no quiso'), { status: 500 }); return {}; });
    const { container } = renderTel(<RoutesPanel />);
    await screen.findByText('10.0.0.0/8');
    fireEvent.click(container.querySelectorAll('tbody button')[0]);
    expect(screen.getByText('Editar ruta')).toBeTruthy();
    expect(screen.getByLabelText(/Gateway/).value).toBe('172.26.30.1');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('el agente no quiso', 'bad'));
    expect(apiMock.llamadasA('POST /asterisk/route').map((c) => c.body.action)).toEqual(['del']);
  });

  it('editar con éxito avisa «Ruta actualizada»; cancelar cierra el cajón', async () => {
    apiMock.responder('GET /asterisk/net', { managed: [{ id: 'r1', dest: '10.0.0.0/8', gw: '172.26.30.1' }], ifaces: [] });
    apiMock.responder('POST /asterisk/route', {});
    const { container } = renderTel(<RoutesPanel />);
    await screen.findByText('10.0.0.0/8');
    fireEvent.click(container.querySelectorAll('tbody button')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Ruta actualizada', 'ok'));
    expect(apiMock.llamadasA('POST /asterisk/route').map((c) => c.body.action)).toEqual(['del', 'add']);
    fireEvent.click(screen.getByRole('button', { name: 'Nueva ruta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Nueva ruta estática')).toBeNull());
  });

  it('quitar pide confirmación y no festeja si el agente rechaza', async () => {
    apiMock.responder('GET /asterisk/net', { managed: [{ id: 'r1', dest: '10.0.0.0/8', gw: 'x' }], ifaces: [] });
    let falla = true;
    apiMock.responder('POST /asterisk/route', () => { if (falla) throw new Error('rechazado'); return {}; });
    const { container } = renderTel(<RoutesPanel />);
    await screen.findByText('10.0.0.0/8');
    const quitar = () => fireEvent.click(container.querySelectorAll('tbody button')[1]);
    window.confirm.mockReturnValueOnce(false);
    quitar();
    expect(apiMock.llamadasA('POST /asterisk/route')).toHaveLength(0);
    quitar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('rechazado', 'bad'));
    expect(notifyMock.toast).not.toHaveBeenCalledWith('Ruta quitada', 'info');
    falla = false;
    quitar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Ruta quitada', 'info'));
  });
});

describe('/rutas', () => {
  function apiBase({ sbc = false, inbound = [], outbound = [] } = {}) {
    apiMock.responder('GET /sbc-link', { active: sbc });
    apiMock.responder('GET /horarios', [{ id: 1, nombre: 'Oficina' }, { id: 2, activo: false, nombre: 'Viejo' }, { id: 3 }]);
    apiMock.responder('GET /trunks', [{ name: 'antel', kind: 'asterisk', provider_host: 'sip.antel' }, { name: 'to-sbc', kind: 'sbc' }, { name: 'web', kind: 'webrtc' }]);
    apiMock.responder('GET /routes/inbound', inbound);
    apiMock.responder('GET /routes/outbound', outbound);
    apiMock.responder('GET /routes/outbound/failover', []);
  }

  it('sin SBC explica el ruteo directo; las entrantes muestran horario y destino de fuera de hora', async () => {
    apiBase({ inbound: [
      { id: 1, did: '2400', name: 'Principal', dest_type: 'ivr', dest_value: '9000', horario_id: 1, dest_cerrado_type: 'cola', dest_cerrado_value: 'noche' },
      { id: 2, did: '2401', name: 'Sin hora', dest_type: 'interno', dest_value: '1001' },
      { id: 3, did: '2402', name: 'Buzón', dest_type: 'otro', dest_value: 'x', horario_id: 99 },
      { id: 4, did: '2403', name: 'Def', dest_type: 'interno', dest_value: '1', horario_id: 3, dest_cerrado_value: '1009' },
    ] });
    renderTel(<Rutas />);
    expect(screen.getByText('Ruteo directo a las troncales de operador')).toBeTruthy();
    expect(await screen.findByText('2400')).toBeTruthy();
    expect(screen.getByText('Oficina')).toBeTruthy();
    expect(screen.getByText('Cola · noche')).toBeTruthy();
    expect(screen.getByText('siempre')).toBeTruthy();
    expect(screen.getByText('#99')).toBeTruthy();
    expect(screen.getByText('buzón')).toBeTruthy();
    expect(screen.getByText('Horario 3')).toBeTruthy();
    expect(screen.getByText('interno · 1009')).toBeTruthy();
    expect(screen.getByText('otro')).toBeTruthy();   // tipo desconocido, tal cual
  });

  it('editar una entrante convierte el horario a texto para el Select («0» = sin horario)', async () => {
    apiBase({ inbound: [{ id: 2, did: '2401', name: 'Sin hora', dest_type: 'interno', dest_value: '1001' }] });
    apiMock.responder('PUT /routes/inbound/2', {});
    const { container } = renderTel(<Rutas />);
    await screen.findByText('2401');
    fireEvent.click(container.querySelector('tbody button'));
    expect(screen.getByDisplayValue('Sin horario · siempre al mismo destino')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(apiMock.llamadasA('PUT /routes/inbound/2')).toHaveLength(1));
    expect(apiMock.llamadasA('PUT /routes/inbound/2')[0].body).toMatchObject({ horario_id: '0', dest_cerrado_type: 'interno', dest_cerrado_value: '' });
  });

  it('con SBC, las salientes dicen por dónde salen y muestran la cadena de respaldo', async () => {
    apiBase({ sbc: true, outbound: [
      { id: 1, name: 'Nacional', pattern: '0X.', trunk: 'to-sbc', backups: ['antel', 'claro'] },
      { id: 2, name: 'Directa', pattern: '9X.', trunk: 'antel', backups: [] },
      { id: 3, name: 'Vieja', pattern: '8X.' },
    ] });
    renderTel(<Rutas />);
    expect(await screen.findByText('Todo entra y sale por el SBC-NG')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Salientes' }));
    expect(await screen.findByText('Nacional')).toBeTruthy();
    expect(screen.getByText('_0X.')).toBeTruthy();
    expect(screen.getAllByText('SBC-NG')).toHaveLength(2);
    expect(screen.getByText('antel → claro')).toBeTruthy();
    expect(screen.getByText('antel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Nuevo/ }));
    expect(screen.getByText('Por defecto sale por el SBC (to-sbc). Podés elegir otra troncal.')).toBeTruthy();
    // Las webrtc no son salida a la calle; el SBC se rotula como tal.
    fireEvent.click(campo('Salida por (troncal)'));
    expect(screen.getAllByRole('option', { hidden: true }).map((o) => o.textContent)).toEqual(['antel (sip.antel)', 'SBC · to-sbc']);
  });

  it('generar sugeridas crea la salida por 0 y la entrada por defecto si faltan', async () => {
    apiBase({ sbc: true });
    apiMock.responder('POST /routes/outbound', {});
    apiMock.responder('POST /routes/inbound', {});
    renderTel(<Rutas />);
    await waitFor(() => expect(apiMock.llamadasA('GET /sbc-link')).toHaveLength(1));
    await screen.findByText('Todo entra y sale por el SBC-NG');
    fireEvent.click(screen.getByRole('button', { name: 'Generar rutas sugeridas' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith(expect.stringMatching(/^Generadas 2 ruta/), 'ok'));
    expect(apiMock.llamadasA('POST /routes/outbound')[0].body).toEqual({ name: 'Salida por 0 (SBC)', pattern: '0X.', strip: 1 });
    expect(apiMock.llamadasA('POST /routes/inbound')[0].body).toMatchObject({ did: '_X.', dest_type: 'interno' });
  });

  it('generar no duplica: si ya hay salida por 0 y entradas, no crea nada', async () => {
    apiBase({ outbound: [{ id: 1, pattern: '_0X.' }, { id: 2 }], inbound: [{ id: 1, did: '1' }] });
    renderTel(<Rutas embedded />);
    expect(screen.queryByText('Enrutamiento de llamadas de las troncales · entrantes (DID) y salientes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Generar rutas sugeridas' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Ya había rutas; no se generó nada nuevo', 'ok'));
    expect(apiMock.llamadasA('POST /routes/outbound')).toHaveLength(0);
  });

  it('generar sin SBC usa el nombre directo; si la API no contesta las listas, igual crea; si el alta falla, avisa', async () => {
    apiBase();
    apiMock.fallar('GET /routes/inbound', 500, 'x');
    apiMock.fallar('GET /routes/outbound', 500, 'x');
    apiMock.fallar('POST /routes/inbound', 403, 'No tenés permiso para esta acción');
    apiMock.responder('POST /routes/outbound', {});
    renderTel(<Rutas />);
    fireEvent.click(screen.getByRole('button', { name: 'Generar rutas sugeridas' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No se pudo generar: No tenés permiso para esta acción', 'bad'));
    expect(apiMock.llamadasA('POST /routes/outbound')[0].body.name).toBe('Salida por 0');
  });

  it('borrar una entrante y editar/borrar una saliente van a la ruta de esa fila', async () => {
    apiBase({ inbound: [{ id: 5, did: '2405', name: 'x', dest_type: 'interno', dest_value: '1' }], outbound: [{ id: 6, name: 'Sal', pattern: '0X.', trunk: 'antel' }] });
    apiMock.responder('DELETE /routes/inbound/5', null);
    apiMock.responder('DELETE /routes/outbound/6', null);
    apiMock.responder('PUT /routes/outbound/6', {});
    const { container } = renderTel(<Rutas />);
    await screen.findByText('2405');
    let fila = container.querySelectorAll('tbody button');
    fireEvent.click(fila[fila.length - 1]);
    await waitFor(() => expect(apiMock.llamadasA('DELETE /routes/inbound/5')).toHaveLength(1));
    fireEvent.click(screen.getByRole('tab', { name: 'Salientes' }));
    await screen.findByText('Sal');
    fila = screen.getByText('Sal').closest('tr').querySelectorAll('button');
    fireEvent.click(fila[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(apiMock.llamadasA('PUT /routes/outbound/6')).toHaveLength(1));
    fireEvent.click(screen.getByText('Sal').closest('tr').querySelectorAll('button')[1]);
    await waitFor(() => expect(apiMock.llamadasA('DELETE /routes/outbound/6')).toHaveLength(1));
  });

  it('generar con la API de salientes devolviendo algo raro (no lista) igual crea la salida por 0', async () => {
    apiBase({ inbound: [{ id: 1, did: '1' }] });
    apiMock.responder('GET /routes/outbound', { error: 'raro' });
    apiMock.responder('POST /routes/outbound', {});
    renderTel(<Rutas />);
    fireEvent.click(screen.getByRole('button', { name: 'Generar rutas sugeridas' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith(expect.stringMatching(/^Generadas 1 ruta/), 'ok'));
  });

  it('sin troncales ni horarios cargados (la API no contestó), los selects quedan con lo mínimo', async () => {
    apiMock.responder('GET /sbc-link', null);
    renderTel(<Rutas />);
    fireEvent.click(screen.getByRole('button', { name: /Nuevo/ }));
    expect(screen.getByText('Ruteo directo a las troncales de operador')).toBeTruthy();
    fireEvent.click(campo('Horario de atención'));
    expect(screen.getAllByRole('option', { hidden: true }).map((o) => o.textContent)).toContain('Sin horario · siempre al mismo destino');
  });
});
