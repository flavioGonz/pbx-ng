/* ============================================================================
 *  Horarios, feriados y modo noche (/horarios y el control NightMode).
 *
 *  Lo que se fija:
 *   - el modo noche muestra el estado que CALCULA la API (no el reloj del navegador), y
 *     al forzarlo avisa qué pasa con las llamadas; si la base quedó al día pero la central
 *     no (`aviso`), no festeja; si falla, el control vuelve a donde estaba;
 *   - un horario se guarda sólo si tiene nombre y tramos válidos (un tramo que termina
 *     antes de empezar se rechaza con la explicación de cómo cruzar la medianoche), y la
 *     semana de un vistazo pinta los días cubiertos — incluidos rangos que dan la vuelta;
 *   - un feriado anual se guarda como MM-DD y uno puntual con su fecha completa.
 *  Si esto se equivoca la central atiende con la oficina cerrada o manda al buzón en
 *  horario de atención, que es lo primero que nota un cliente.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());

import { apiMock, notifyMock, resetNucleo } from './helpers/nucleo-render.jsx';
import { renderTel, escribir, elegir } from './helpers/telefonia-render.jsx';
import NightModeCard, { NightModeChip, textoEstado } from '../app/NightMode.jsx';
import HorariosPage from '../app/horarios/page.jsx';

beforeEach(() => {
  resetNucleo();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('textoEstado', () => {
  it('arma la frase del estado con la hora de cambio o el motivo', () => {
    expect(textoEstado(null)).toBe('');
    expect(textoEstado({ estado: 'abierto', hasta: '18:00' })).toBe('Ahora: abierto hasta las 18:00');
    expect(textoEstado({ estado: 'cerrado', motivo: 'feriado' })).toBe('Ahora: cerrado · feriado');
    expect(textoEstado({ estado: 'cerrado' })).toBe('Ahora: cerrado');
  });
});

describe('NightModeChip', () => {
  it('no dibuja nada sin datos o con error (instalación vieja o rol sin permiso)', async () => {
    apiMock.fallar('GET /nightmode', 404, 'No encontrado');
    renderTel(<NightModeChip />);
    await waitFor(() => expect(apiMock.llamadas).toHaveLength(1));
    expect(screen.queryByText('Abierto')).toBeNull();
    expect(screen.queryByText('Modo noche')).toBeNull();
  });

  it('dice «Abierto» o «Modo noche» según el estado calculado', async () => {
    apiMock.responder('GET /nightmode', { estado: 'abierto', modo: 'auto' });
    const { unmount } = renderTel(<NightModeChip />);
    expect(await screen.findByText('Abierto')).toBeTruthy();
    unmount();
    apiMock.responder('GET /nightmode', { estado: 'cerrado', modo: 'cerrado' });
    renderTel(<NightModeChip />);
    expect(await screen.findByText('Modo noche')).toBeTruthy();
  });

  it('una respuesta sin estado no dibuja nada', async () => {
    apiMock.responder('GET /nightmode', { modo: 'auto' });
    renderTel(<NightModeChip />);
    await waitFor(() => expect(apiMock.llamadas).toHaveLength(1));
    expect(screen.queryByText('Abierto')).toBeNull();
  });
});

describe('NightModeCard', () => {
  it('si la API no lo tiene, lo explica', async () => {
    apiMock.fallar('GET /nightmode', 404, 'No encontrado');
    renderTel(<NightModeCard />);
    expect(await screen.findByText('Modo noche no disponible')).toBeTruthy();
    expect(screen.getByText('No encontrado')).toBeTruthy();
  });

  it('muestra el estado y si está forzado; forzar avisa qué pasa con las llamadas', async () => {
    let modo = 'auto';
    apiMock.responder('GET /nightmode', () => ({ estado: 'abierto', modo, hasta: '18:00' }));
    apiMock.responder('PUT /nightmode', ({ body }) => { modo = body.modo; return {}; });
    renderTel(<NightModeCard />);
    expect(await screen.findByText('La central está abierta')).toBeTruthy();
    expect(screen.getByText('Ahora: abierto hasta las 18:00')).toBeTruthy();
    expect(screen.queryByText('forzado a mano')).toBeNull();
    expect(screen.getByText(/no se sueltan solos a medianoche/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Cerrado'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Forzado CERRADO: entra por el destino de fuera de hora', 'ok'));
    expect(apiMock.llamadasA('PUT /nightmode')[0].body).toEqual({ modo: 'cerrado' });
    fireEvent.click(screen.getByLabelText('Abierto'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Forzado ABIERTO: entra por el destino normal', 'ok'));
    fireEvent.click(screen.getByLabelText('Automático'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Modo noche automático: manda el horario', 'ok'));
    expect(apiMock.llamadasA('GET /nightmode').length).toBeGreaterThanOrEqual(4);   // recarga después de cada cambio
  });

  it('forzado y compacto: el aviso de `aviso` no festeja; si falla vuelve al modo anterior', async () => {
    apiMock.responder('GET /nightmode', { estado: 'cerrado', modo: 'cerrado', motivo: 'forzado' });
    let r = { aviso: 'La central no tomó el cambio' };
    apiMock.responder('PUT /nightmode', () => r);
    renderTel(<NightModeCard compacto />);
    expect(await screen.findByText('La central está cerrada')).toBeTruthy();
    expect(screen.getByText('forzado a mano')).toBeTruthy();
    expect(screen.queryByText(/no se sueltan solos/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Automático'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('La central no tomó el cambio', 'bad', { description: 'Mientras tanto la central sigue como estaba.' }));
    r = () => { throw new Error('x'); };
    apiMock.fallar('PUT /nightmode', 403, 'Sólo admin');
    fireEvent.click(screen.getByLabelText('Abierto'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Sólo admin', 'bad'));
    await waitFor(() => expect(screen.getByLabelText('Cerrado').checked).toBe(true));
  });

  it('sin modo en la respuesta el control queda en Automático', async () => {
    apiMock.responder('GET /nightmode', { estado: 'abierto' });
    renderTel(<NightModeCard />);
    await screen.findByText('La central está abierta');
    expect(screen.getByLabelText('Automático').checked).toBe(true);
  });
});

describe('/horarios — horarios', () => {
  const oficina = { id: 1, nombre: 'Oficina', activo: true, tramos: [{ dias: 'mon-fri', desde: '09:00', hasta: '18:00' }, { dias: 'sat', desde: '09:00', hasta: '13:00' }] };

  function base(horarios) {
    apiMock.responder('GET /nightmode', { estado: 'abierto', modo: 'auto' });
    apiMock.responder('GET /horarios', horarios);
    apiMock.responder('GET /feriados', []);
  }
  const semana = (card) => Object.fromEntries(['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((d) => [d, within(card).getByText(d).parentElement.textContent.replace(d, '')]));

  it('sin horarios invita a crear uno; crear manda el horario de oficina por defecto', async () => {
    base([]);
    apiMock.responder('POST /horarios', {});
    renderTel(<HorariosPage />);
    expect(await screen.findByText(/Todavía no hay horarios/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo horario' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Horario creado: ajustá los tramos y guardá', 'ok'));
    expect(apiMock.llamadasA('POST /horarios')[0].body).toEqual({ nombre: 'Horario de oficina', activo: true, tramos: [{ dias: 'mon-fri', desde: '09:00', hasta: '18:00' }] });
  });

  it('si crear o listar falla, avisa', async () => {
    apiMock.responder('GET /nightmode', { estado: 'abierto' });
    apiMock.fallar('GET /horarios', 500, 'Base caída');
    apiMock.fallar('POST /horarios', 403, 'Sólo admin');
    renderTel(<HorariosPage />);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Base caída', 'bad'));
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo horario' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Sólo admin', 'bad'));
  });

  it('la semana de un vistazo pinta los días cubiertos, también rangos que dan la vuelta y listas', async () => {
    base([
      oficina,
      { id: 2, nombre: 'Guardia', tramos: [{ dias: 'fri-mon', desde: '20:00', hasta: '23:00' }] },
      { id: 3, nombre: 'Rara', activo: false, tramos: [{ dias: 'tue, thu', desde: '10:00', hasta: '11:00' }, { dias: 'xyz', desde: '1', hasta: '2' }, { dias: 'wed-zzz', desde: '3', hasta: '4' }, { desde: '5', hasta: '6' }] },
      { id: 4, tramos: 'no-lista' },
    ]);
    renderTel(<HorariosPage />);
    await screen.findByDisplayValue('Oficina');
    const card = (n) => screen.getByDisplayValue(n).closest('.mantine-Card-root');
    expect(semana(card('Oficina'))).toEqual({ Lun: '09:00–18:00', Mar: '09:00–18:00', Mié: '09:00–18:00', Jue: '09:00–18:00', Vie: '09:00–18:00', Sáb: '09:00–13:00', Dom: 'cerrado' });
    expect(semana(card('Guardia'))).toMatchObject({ Vie: '20:00–23:00', Sáb: '20:00–23:00', Dom: '20:00–23:00', Lun: '20:00–23:00', Mar: 'cerrado' });
    expect(semana(card('Rara'))).toMatchObject({ Mar: '10:00–11:00', Jue: '10:00–11:00', Mié: '3–4', Lun: 'cerrado' });
    expect(within(card('Rara')).getByText('xyz de 1 a 2')).toBeTruthy();   // días que el panel no conoce, tal cual
    const sinNombre = screen.getByText('#4').closest('.mantine-Card-root');
    expect(within(sinNombre).getByText(/Sin tramos: con este horario la central queda SIEMPRE cerrada/)).toBeTruthy();
  });

  it('editar tramos (agregar, duplicar, cambiar, quitar) y guardar manda exactamente lo que se ve', async () => {
    base([oficina]);
    apiMock.responder('PUT /horarios/1', {});
    const { container } = renderTel(<HorariosPage />);
    const nombre = await screen.findByLabelText('Nombre del horario');
    escribir(nombre, ' Atención ');
    fireEvent.click(screen.getByLabelText('Activo'));
    const tramos = () => Array.from(container.querySelectorAll('input[type=time]'));
    fireEvent.click(screen.getByRole('button', { name: 'Agregar tramo' }));
    expect(tramos()).toHaveLength(6);
    const filaTramo = (i) => tramos()[i * 2].closest('.mantine-Group-root');
    fireEvent.click(within(filaTramo(1)).getAllByRole('button')[0]);   // duplicar el sábado
    expect(tramos()).toHaveLength(8);
    escribir(tramos()[4], '14:00');
    escribir(tramos()[5], '16:00');
    fireEvent.click(within(filaTramo(3)).getAllByRole('button')[1]);   // quitar el agregado
    elegir(within(filaTramo(2)).getAllByRole('textbox')[0], 'Domingo');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(apiMock.llamadasA('PUT /horarios/1')).toHaveLength(1));
    expect(apiMock.llamadasA('PUT /horarios/1')[0].body).toEqual({
      nombre: 'Atención', activo: false,
      tramos: [{ dias: 'mon-fri', desde: '09:00', hasta: '18:00' }, { dias: 'sat', desde: '09:00', hasta: '13:00' }, { dias: 'sun', desde: '14:00', hasta: '16:00' }],
    });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Horario «Atención» guardado', 'ok'));
  });

  it('valida nombre y tramos antes de mandar; el error de la API se muestra', async () => {
    base([oficina]);
    apiMock.fallar('PUT /horarios/1', 409, 'Nombre repetido');
    const { container } = renderTel(<HorariosPage />);
    const nombre = await screen.findByLabelText('Nombre del horario');
    const guardar = () => fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    escribir(nombre, '  ');
    guardar();
    expect(notifyMock.toast).toHaveBeenCalledWith('Poné un nombre al horario', 'bad');
    escribir(nombre, 'Oficina');
    const t = container.querySelectorAll('input[type=time]');
    escribir(t[1], '');
    guardar();
    expect(notifyMock.toast).toHaveBeenCalledWith('Cada tramo necesita hora de inicio y de fin', 'bad');
    expect(screen.getByText('Lunes a viernes de 09:00 a —')).toBeTruthy();
    escribir(t[1], '08:00');
    guardar();
    expect(notifyMock.toast).toHaveBeenCalledWith('El tramo 09:00–08:00 termina antes de empezar', 'bad', { description: 'Para un horario que cruza la medianoche usá dos tramos.' });
    expect(apiMock.llamadasA('PUT /horarios/1')).toHaveLength(0);
    escribir(t[1], '18:00');
    guardar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Nombre repetido', 'bad'));
  });

  it('borrar pide confirmación (dice qué pasa con las rutas) y avisa si falla', async () => {
    base([oficina, { id: 2, tramos: [] }]);
    apiMock.responder('DELETE /horarios/1', {});
    apiMock.fallar('DELETE /horarios/2', 500, 'en uso');
    renderTel(<HorariosPage />);
    await screen.findByDisplayValue('Oficina');
    const borrar = (id) => {
      const card = screen.getByText('#' + id).closest('.mantine-Card-root');
      fireEvent.click(within(card).getAllByRole('button')[1]);   // [Guardar, Borrar horario, …tramos]
    };
    window.confirm.mockReturnValueOnce(false);
    borrar(1);
    expect(apiMock.llamadasA('DELETE /horarios/1')).toHaveLength(0);
    expect(window.confirm.mock.calls[0][0]).toMatch(/Las rutas que lo usen quedan sin horario/);
    borrar(1);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Horario borrado', 'info'));
    borrar(2);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('en uso', 'bad'));
    expect(window.confirm.mock.calls.at(-1)[0]).toMatch(/«2»/);
  });
});

describe('/horarios — feriados', () => {
  function base(feriados) {
    apiMock.responder('GET /nightmode', { estado: 'abierto', modo: 'auto' });
    apiMock.responder('GET /horarios', []);
    apiMock.responder('GET /feriados', feriados);
  }
  const irAFeriados = () => fireEvent.click(screen.getByRole('tab', { name: 'Feriados' }));

  it('lista anuales (día y mes) y puntuales (fecha); sin feriados lo dice', async () => {
    base([{ id: 1, nombre: 'Año Nuevo', anual: true, md: '01-01' }, { id: 2, anual: false, fecha: '2026-11-02' }, { id: 3 }]);
    renderTel(<HorariosPage />);
    irAFeriados();
    expect(await screen.findByText('Año Nuevo')).toBeTruthy();
    expect(screen.getByText('01-01 · todos los años')).toBeTruthy();
    expect(screen.getAllByText('Feriado')).toHaveLength(2);
    expect(screen.getByText('· todos los años')).toBeTruthy();   // anual sin día cargado: no inventa uno
    expect(screen.getByText(/2026|02\/11/)).toBeTruthy();
  });

  it('sin feriados lo dice; un error de la API se muestra', async () => {
    apiMock.responder('GET /nightmode', { estado: 'abierto' });
    apiMock.responder('GET /horarios', []);
    apiMock.fallar('GET /feriados', 500, 'Base caída');
    renderTel(<HorariosPage />);
    irAFeriados();
    expect(await screen.findByText('Sin feriados cargados.')).toBeTruthy();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Base caída', 'bad'));
  });

  it('agregar valida fecha y nombre; anual guarda MM-DD y puntual la fecha completa', async () => {
    base([]);
    apiMock.responder('POST /feriados', {});
    const { container } = renderTel(<HorariosPage />);
    irAFeriados();
    const agregar = () => fireEvent.click(screen.getByRole('button', { name: 'Agregar feriado' }));
    const fecha = () => container.querySelector('input[type=date]');
    await screen.findByText('Sin feriados cargados.');
    agregar();
    expect(notifyMock.toast).toHaveBeenCalledWith('Elegí la fecha', 'bad');
    escribir(fecha(), '2026-12-25');
    agregar();
    expect(notifyMock.toast).toHaveBeenCalledWith('Poné un nombre (por ejemplo «Año Nuevo»)', 'bad');
    escribir(screen.getByLabelText('Nombre'), ' Navidad ');
    expect(screen.getByText('Se usa sólo el día y el mes')).toBeTruthy();
    agregar();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Feriado agregado', 'ok'));
    expect(apiMock.llamadasA('POST /feriados')[0].body).toEqual({ anual: true, md: '12-25', nombre: 'Navidad' });
    expect(screen.getByLabelText('Nombre').value).toBe('');
    fireEvent.click(screen.getByLabelText('Sólo esta fecha'));
    expect(screen.getByText('Fecha exacta')).toBeTruthy();
    escribir(fecha(), '2026-11-20');
    escribir(screen.getByLabelText('Nombre'), 'Paro');
    agregar();
    await waitFor(() => expect(apiMock.llamadasA('POST /feriados')).toHaveLength(2));
    expect(apiMock.llamadasA('POST /feriados')[1].body).toEqual({ anual: false, fecha: '2026-11-20', nombre: 'Paro' });
  });

  it('si agregar falla se muestra el motivo; borrar confirma y avisa (o muestra el error)', async () => {
    base([{ id: 7, md: '05-01' }, { id: 8, fecha: '2026-01-06', anual: false }]);
    apiMock.fallar('POST /feriados', 409, 'Ya existe');
    apiMock.responder('DELETE /feriados/7', {});
    apiMock.fallar('DELETE /feriados/8', 500, 'no se pudo');
    const { container } = renderTel(<HorariosPage />);
    irAFeriados();
    await screen.findByText('05-01 · todos los años');
    escribir(container.querySelector('input[type=date]'), '2026-05-01');
    escribir(screen.getByLabelText('Nombre'), 'Trabajadores');
    fireEvent.click(screen.getByRole('button', { name: 'Agregar feriado' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Ya existe', 'bad'));
    const borrar = (txt) => fireEvent.click(screen.getByText(txt).closest('.mantine-Group-root').parentElement.parentElement.querySelector('button'));
    window.confirm.mockReturnValueOnce(false);
    borrar('05-01 · todos los años');
    expect(apiMock.llamadasA('DELETE /feriados/7')).toHaveLength(0);
    expect(window.confirm.mock.calls[0][0]).toBe('¿Borrar «05-01»?');
    borrar('05-01 · todos los años');
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Feriado borrado', 'info'));
    const filaPuntual = screen.getAllByText('Feriado').at(-1).closest('.mantine-Group-root').parentElement;
    fireEvent.click(filaPuntual.querySelector('button'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('no se pudo', 'bad'));
    expect(window.confirm.mock.calls.at(-1)[0]).toBe('¿Borrar «2026-01-06»?');
  });
});
