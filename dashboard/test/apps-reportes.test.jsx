/* Reportes de call center (/reportes).
 *
 * Es el informe que alguien firma, así que se fija: qué rango y filtros viajan a la API
 * (y que un rango fuera del tope de 92 días no se mande), cómo se pinta el nivel de
 * servicio (sin dato es gris, no rojo), los avisos de «sin eventos» / «registro más nuevo
 * que el rango» / «sin horario», que las descargas pasen por la capa de API con token, y
 * que el envío programado por correo sea sólo de admin y guarde lo que se editó. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderNG, fetchFalso, estado } from './helpers/apps-render.jsx';

const notify = vi.hoisted(() => {
  const toast = vi.fn();
  const toastPromise = vi.fn((p, o) => p.then(() => toast(o.success, 'ok'), (e) => toast(o.error(e), 'bad')));
  return { toast, toastPromise };
});
const sesion = vi.hoisted(() => ({ admin: true }));
vi.mock('../app/notify', () => notify);
vi.mock('../app/auth', () => ({ useEsAdmin: () => sesion.admin }));

import ReportesPage from '../app/reportes/page';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const menos = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };

const INFORME = {
  sla_seg: 20, agentes_tope: 200, agentes_truncado: true,
  horario: { nombre: 'Oficina' },
  fuente: { sin_datos: false, rango_incompleto: true, primer_evento: '2026-09-01T00:00:00', sin_horario: false },
  totales: { ofrecidas: 120, atendidas: 100, abandonadas: 20, abandono_pct: 16.7, sla_pct: 85, espera_media: 12, espera_max: 95, habla_media: 130, habla_total: 13000, fuera_horario: 4 },
  colas: [
    { cola: 'ventas', label: 'Ventas', ofrecidas: 80, atendidas: 70, abandonadas: 10, abandono_pct: 12.5, otras_salidas: 0, sla_pct: 65, espera_media: 10, espera_max: 60, habla_media: 120, fuera_horario: 2 },
    { cola: 'soporte', label: 'soporte', ofrecidas: 40, atendidas: 30, abandonadas: 10, abandono_pct: 25, otras_salidas: 1, sla_pct: 40, espera_media: 5, espera_max: 30, habla_media: 60, fuera_horario: null },
    { cola: 'nueva', label: 'nueva', ofrecidas: 0, atendidas: 0, abandonadas: 0, abandono_pct: null, otras_salidas: 0, sla_pct: null, espera_media: 0, espera_max: 0, habla_media: 0, fuera_horario: 0 },
  ],
  agentes: [{ agente: '1001', nombre: 'Ana', atendidas: 60, sin_respuesta: 2, espera_media: 8, habla_media: 125, habla_max: 600, habla_total: 7500 }, { agente: '1002', atendidas: 40, sin_respuesta: 0 }],
};
const PROG = [
  { id: 1, nombre: 'Diario gerencia', periodo: 'diario', hora: 8, sla_seg: 20, destinatarios: 'g@x.com', enabled: true, last_run_at: '2026-10-07T08:00:00' },
  { id: 2, nombre: 'Semanal', periodo: 'semanal', dia: 3, hora: 9, sla_seg: 30, cola: 'ventas', enabled: false },
  { id: 3, nombre: 'Mensual', periodo: 'mensual', hora: 7, sla_seg: 20, enabled: false },
];

let f;
const rutas = (extra = {}) => ({
  'GET /ccreport': INFORME,
  'GET /queues': [{ name: 'ventas', label: 'Ventas' }, { name: 'soporte' }],
  'GET /ccreport/schedules': PROG,
  ...extra,
});
beforeEach(() => {
  notify.toast.mockReset(); notify.toastPromise.mockClear();
  sesion.admin = true;
  f = fetchFalso(rutas());
  vi.stubGlobal('fetch', f);
  URL.createObjectURL = vi.fn(() => 'blob:rep');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.useRealTimers(); });

const elegir = async (label, opcion, dentro = document.body) => {
  fireEvent.click([...dentro.querySelectorAll('input')].find((i) => i.labels?.[0]?.textContent.startsWith(label) || i.getAttribute('aria-label') === label) || screen.getByRole('textbox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: opcion }));
};

describe('informe', () => {
  it('al entrar pide la última semana con SLA 20 y muestra totales, colas y agentes', async () => {
    renderNG(<ReportesPage />);
    expect(await screen.findByText('Por cola')).toBeTruthy();
    expect(f.de('GET', '/ccreport?')[0].ruta).toBe(`/ccreport?from=${menos(7)}&to=${menos(0)}&sla=20`);
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('Abandonadas · 16,7 %')).toBeTruthy();
    expect(screen.getByText('Nivel de servicio · < 20 s')).toBeTruthy();
    expect(screen.getByText('Fuera de horario · Oficina')).toBeTruthy();
    expect(screen.getByText('Espera media · máx. 1m 35s')).toBeTruthy();
    // nivel de servicio: verde ≥80, amarillo ≥60, rojo debajo, gris sin dato
    const badge = (txt) => screen.getByText(txt, { selector: '.mantine-Badge-label' }).closest('.mantine-Badge-root').style.getPropertyValue('--badge-color') || screen.getByText(txt, { selector: '.mantine-Badge-label' }).closest('.mantine-Badge-root').getAttribute('style');
    expect(badge('65 %')).toContain('yellow');
    expect(badge('40 %')).toContain('red');
    expect(badge('—')).toContain('gray');
    // la etiqueta de la cola y su nombre técnico cuando difieren
    expect(screen.getAllByText('Ventas').find((e) => e.closest('tr')).nextSibling.textContent).toBe('ventas');
    const soporte = screen.getAllByText('soporte').find((e) => e.closest('tr'));
    expect(soporte.nextSibling).toBeNull();
    expect(soporte.closest('tr').textContent).toMatch(/—$/);
    expect(screen.getByText('Ana')).toBeTruthy();
    expect(screen.getByText(/Se muestran los primeros 200/)).toBeTruthy();
    expect(screen.getByText('El período pedido es más viejo que el registro')).toBeTruthy();
    expect(screen.getByText(/1 de setiembre de 2026|1 de septiembre de 2026/)).toBeTruthy();
  });

  it('sin eventos de cola avisa (y no muestra el aviso de rango); sin horario también avisa', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ccreport': { ...INFORME, horario: null, agentes_truncado: false, fuente: { sin_datos: true, rango_incompleto: true, sin_horario: true }, totales: { ...INFORME.totales, sla_pct: null, fuera_horario: null }, colas: [], agentes: [] } })));
    renderNG(<ReportesPage />);
    expect(await screen.findByText('Todavía no hay eventos de cola')).toBeTruthy();
    expect(screen.queryByText('El período pedido es más viejo que el registro')).toBeNull();
    expect(screen.getByText('Sin horario de atención configurado')).toBeTruthy();
    expect(screen.getByText('Sin llamadas de cola en el período.')).toBeTruthy();
    expect(screen.getByText('Ningún agente atendió llamadas de cola en el período.')).toBeTruthy();
    expect(screen.getByText('Fuera de horario · sin horario')).toBeTruthy();
    expect(screen.queryByText(/Se muestran los primeros/)).toBeNull();
  });

  it('regenera con cola y SLA elegidos; un error lo muestra y limpia el informe', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'GET /ccreport': () => (n++ ? estado(400, { error: 'Rango inválido' }) : INFORME) }));
    vi.stubGlobal('fetch', f);
    renderNG(<ReportesPage />);
    await screen.findByText('Por cola');
    await elegir('Cola', 'Ventas');
    fireEvent.change(screen.getAllByRole('textbox', { name: /Nivel de servicio/ })[0], { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Generar/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Rango inválido', 'bad'));
    expect(f.de('GET', '/ccreport?')[1].ruta).toBe(`/ccreport?from=${menos(7)}&to=${menos(0)}&sla=30&cola=ventas`);
    expect(screen.queryByText('Por cola')).toBeNull();
    expect(screen.getByRole('button', { name: /CSV/ }).disabled).toBe(true);
    // volver a «Todas» y SLA vacío → 20
    await elegir('Cola', 'Todas las colas');
    fireEvent.change(screen.getAllByRole('textbox', { name: /Nivel de servicio/ })[0], { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Generar/ }));
    await waitFor(() => expect(f.de('GET', '/ccreport?').length).toBe(3));
    expect(f.de('GET', '/ccreport?')[2].ruta).toBe(`/ccreport?from=${menos(7)}&to=${menos(0)}&sla=20`);
  });

  it('un rango fuera de 1..92 días no se puede pedir y dice cuántos días eligió', async () => {
    renderNG(<ReportesPage />);
    await screen.findByText('Por cola');
    const desde = screen.getByLabelText('Desde');
    fireEvent.change(desde, { target: { value: menos(100) } });
    expect(screen.getByRole('button', { name: /Generar/ }).disabled).toBe(true);
    expect(screen.getByText(/el rango elegido es de 101 días/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: menos(200) } });
    expect(screen.getByText(/el rango elegido es de -99 días/)).toBeTruthy();
    fireEvent.change(desde, { target: { value: '' } });
    expect(screen.queryByText(/el rango elegido/)).toBeNull();
    expect(screen.getByRole('button', { name: /Generar/ }).disabled).toBe(true);
  });

  it('un rango que ya entra mal al montar avisa en vez de pedir', async () => {
    const real = Date;
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-10-08T12:00:00') });
    // si la fecha de "hoy" no se puede calcular, el rango es NaN: no se pide nada
    const getDate = vi.spyOn(real.prototype, 'getDate').mockReturnValue(NaN);
    renderNG(<ReportesPage />);
    getDate.mockRestore();
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('El rango tiene que ir de 1 a 92 días', 'bad'));
    expect(f.de('GET', '/ccreport?').length).toBe(0);
  });

  it('CSV: se baja con token y con el rango en el nombre; si falla lo dice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const nombres = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { nombres.push(this.download); });
    let n = 0;
    f = fetchFalso(rutas({ 'GET /ccreport/csv': () => (n++ ? estado(500) : new Response(new Blob(['a,b']), { status: 200, headers: { 'content-type': 'text/csv' } })) }));
    vi.stubGlobal('fetch', f);
    renderNG(<ReportesPage />);
    await screen.findByText('Por cola');
    fireEvent.click(screen.getByRole('button', { name: /CSV/ }));
    await waitFor(() => expect(nombres).toEqual([`callcenter-${menos(7)}_${menos(0)}.csv`]));
    act(() => { vi.advanceTimersByTime(1100); });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:rep');
    await elegir('Cola', 'Ventas');
    fireEvent.click(screen.getByRole('button', { name: /CSV/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No se pudo exportar', 'bad', { description: 'Error del servidor' }));
    expect(f.de('GET', '/ccreport/csv')[1].ruta).toContain('&cola=ventas');
  });

  it('CSV con cola elegida la pone en el nombre del archivo', async () => {
    const nombres = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { nombres.push(this.download); });
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ccreport/csv': () => new Response('x', { status: 200 }) })));
    renderNG(<ReportesPage />);
    await screen.findByText('Por cola');
    await elegir('Cola', 'Ventas');
    fireEvent.click(screen.getByRole('button', { name: /CSV/ }));
    await waitFor(() => expect(nombres[0]).toBe(`callcenter-${menos(7)}_${menos(0)}-ventas.csv`));
  });

  it('Informe PDF: abre el HTML en otra pestaña; si el navegador la bloquea o la API falla, avisa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abrir = vi.fn(() => ({}));
    vi.stubGlobal('open', abrir);
    let n = 0;
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ccreport/report': () => (n++ === 2 ? estado(502) : new Response('<html>informe</html>', { status: 200, headers: { 'content-type': 'text/html' } })) })));
    renderNG(<ReportesPage />);
    await screen.findByText('Por cola');
    fireEvent.click(screen.getByRole('button', { name: /Informe PDF/ }));
    await waitFor(() => expect(abrir).toHaveBeenCalledWith('blob:rep', '_blank'));
    act(() => { vi.advanceTimersByTime(60001); });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:rep');
    abrir.mockReturnValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: /Informe PDF/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('El navegador bloqueó la ventana: permití las ventanas emergentes para este sitio', 'warn'));
    fireEvent.click(screen.getByRole('button', { name: /Informe PDF/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No se pudo generar el informe', 'bad', { description: 'Error del servidor' }));
  });
});

describe('envío programado', () => {
  it('el supervisor no lo ve ni se le pide a la API', async () => {
    sesion.admin = false;
    renderNG(<ReportesPage />);
    await screen.findByText('Por cola');
    expect(screen.queryByText('Envío programado por correo')).toBeNull();
    expect(f.de('GET', '/ccreport/schedules').length).toBe(0);
  });

  it('lista cada programación según su período', async () => {
    renderNG(<ReportesPage />);
    expect(await screen.findByDisplayValue('Diario gerencia')).toBeTruthy();
    expect(screen.getByText(/Último envío: .*2026/)).toBeTruthy();
    expect(screen.getByText('Activa')).toBeTruthy();
    expect(screen.getAllByText('Pausada').length).toBe(2);
    expect(screen.getByDisplayValue('todos')).toBeTruthy();                 // diario: todos los días
    expect(screen.getByDisplayValue('Miércoles')).toBeTruthy();             // semanal
    expect(screen.getByRole('textbox', { name: /Día del mes/ }).value).toBe('1');   // mensual sin día → 1
  });

  it('edita y guarda: el PUT lleva lo que se cambió', async () => {
    f = fetchFalso(rutas({ 'PUT /ccreport/schedules/2': {} }));
    vi.stubGlobal('fetch', f);
    renderNG(<ReportesPage />);
    const tarjeta = (await screen.findByDisplayValue('Semanal')).closest('.mantine-Card-root');
    const campo = (label) => [...tarjeta.querySelectorAll('input')].find((i) => i.labels?.[0]?.textContent.startsWith(label));
    fireEvent.change(campo('Nombre'), { target: { value: 'Semanal ventas' } });
    fireEvent.click(tarjeta.querySelector('input[type=checkbox]'));
    fireEvent.change(campo('Hora de envío'), { target: { value: '' } });
    fireEvent.change(campo('Nivel de servicio'), { target: { value: '' } });
    fireEvent.change(campo('Destinatarios'), { target: { value: 'a@b.com' } });
    fireEvent.click(campo('Día de la semana'));
    fireEvent.click(await screen.findByRole('option', { name: 'Viernes' }));
    fireEvent.click(campo('Cola'));
    fireEvent.click((await screen.findAllByRole('option', { name: 'Todas las colas' })).pop());
    fireEvent.click([...tarjeta.querySelectorAll('button')].find((b) => b.textContent === 'Guardar'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Programación guardada'));
    expect(f.de('PUT', '/ccreport/schedules/2')[0].cuerpo).toMatchObject({ nombre: 'Semanal ventas', enabled: true, hora: 0, sla_seg: 20, destinatarios: 'a@b.com', dia: 5, cola: '' });
    await waitFor(() => expect(f.de('GET', '/ccreport/schedules').length).toBe(2));
  });

  it('cambiar de período cambia cómo se elige el día', async () => {
    f = fetchFalso(rutas({ 'PUT /ccreport/schedules/1': estado(400, { error: 'Destinatario inválido' }) }));
    vi.stubGlobal('fetch', f);
    renderNG(<ReportesPage />);
    const tarjeta = (await screen.findByDisplayValue('Diario gerencia')).closest('.mantine-Card-root');
    const campo = (label) => [...tarjeta.querySelectorAll('input')].find((i) => i.labels?.[0]?.textContent.startsWith(label));
    fireEvent.click(campo('Cada cuánto'));
    fireEvent.click((await screen.findAllByRole('option', { name: /Una vez por mes/ })).pop());
    fireEvent.change(campo('Día del mes'), { target: { value: '15' } });
    fireEvent.change(campo('Día del mes'), { target: { value: '' } });
    fireEvent.click(campo('Cada cuánto'));
    fireEvent.click((await screen.findAllByRole('option', { name: /Una vez por semana/ })).pop());
    expect(campo('Día de la semana').value).toBe('Lunes');
    fireEvent.click(campo('Cola'));
    fireEvent.click((await screen.findAllByRole('option', { name: 'soporte' })).pop());
    fireEvent.click([...tarjeta.querySelectorAll('button')].find((b) => b.textContent === 'Guardar'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Destinatario inválido', 'bad'));
    expect(f.de('PUT', '/ccreport/schedules/1')[0].cuerpo).toMatchObject({ periodo: 'semanal', dia: 1, cola: 'soporte' });
  });

  it('probar, borrar y crear pasan por la API y avisan', async () => {
    f = fetchFalso(rutas({ 'POST /ccreport/schedules/1/test': {}, 'POST /ccreport/schedules/3/test': estado(502, { error: 'SMTP caído' }), 'DELETE /ccreport/schedules/1': null, 'POST /ccreport/schedules': { id: 9 } }));
    vi.stubGlobal('fetch', f);
    renderNG(<ReportesPage />);
    await screen.findByDisplayValue('Diario gerencia');
    const [probar1, , probar3] = screen.getAllByRole('button', { name: /Probar envío/ });
    fireEvent.click(probar1);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Informe enviado: revisá la casilla', 'ok'));
    fireEvent.click(probar3);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('SMTP caído', 'bad'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Borrar programación' })[0]);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Programación borrada', 'ok'));
    fireEvent.click(screen.getByRole('button', { name: /Nueva programación/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Programación creada (nace pausada: completá los destinatarios y activala)', 'ok'));
    // nace pausada y sin destinatarios: no manda nada hasta que alguien la complete
    expect(f.llamadas.find((l) => l.metodo === 'POST' && l.ruta === '/ccreport/schedules').cuerpo).toEqual({ nombre: 'Informe diario', periodo: 'diario', hora: 8, sla_seg: 20, destinatarios: '', enabled: false });
    await waitFor(() => expect(f.de('GET', '/ccreport/schedules').length).toBe(3));
  });

  it('si borrar o crear fallan, el motivo de la API llega al aviso', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'DELETE /ccreport/schedules/2': estado(403), 'POST /ccreport/schedules': estado(500, { error: 'Base caída' }) })));
    renderNG(<ReportesPage />);
    await screen.findByDisplayValue('Semanal');
    fireEvent.click(screen.getAllByRole('button', { name: 'Borrar programación' })[1]);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No tenés permiso para esta acción', 'bad'));
    fireEvent.click(screen.getByRole('button', { name: /Nueva programación/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Base caída', 'bad'));
  });

  it('sin programaciones invita a crear una; mientras carga lo dice', async () => {
    let soltar;
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ccreport/schedules': () => new Promise((r) => { soltar = r; }) })));
    renderNG(<ReportesPage />);
    expect(screen.getByText('Cargando…')).toBeTruthy();
    await act(async () => { soltar({ error: 'no es lista' }); });
    expect(await screen.findByText(/No hay envíos programados/)).toBeTruthy();
  });
});
