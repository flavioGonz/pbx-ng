/* Clientes: la lista unida (los de la central y los de este aparato), la ficha, y el alta
 * de clientes y cámaras con el destino elegido a mano.
 *
 * Lo delicado acá es el DESTINO. Una URL RTSP lleva usuario y clave de la cámara adentro:
 * nada se sube a la central sin que alguien lo elija, un cliente local nunca se intenta
 * crear en la central, y un error de la central no puede perder lo que el técnico acaba de
 * escribir. También el buscador ONVIF, que es lo que evita adivinar el path del canal. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { montar, avanzar, estado, store, mApi, mConfig, CFG_OK, irA } from './helpers/pantallas-app.jsx';

vi.mock('../src/useSip.js', async () => (await import('./helpers/pantallas-app.jsx')).mUseSip);
vi.mock('../src/useSipNative.js', async () => (await import('./helpers/pantallas-app.jsx')).mUseSipNative);
vi.mock('../src/config.js', async () => (await import('./helpers/pantallas-app.jsx')).mConfig);
vi.mock('../src/api.js', async () => (await import('./helpers/pantallas-app.jsx')).mApi);
vi.mock('../src/prov.js', async () => (await import('./helpers/pantallas-app.jsx')).mProv);
vi.mock('../src/ice.js', async () => (await import('./helpers/pantallas-app.jsx')).mIce);
vi.mock('../src/sounds.js', async () => (await import('./helpers/pantallas-app.jsx')).mSounds);
vi.mock('../src/anim.js', async () => (await import('./helpers/pantallas-app.jsx')).mAnim);
vi.mock('qrcode', async () => (await import('./helpers/pantallas-app.jsx')).mQrcode);
vi.mock('jsqr', async () => (await import('./helpers/pantallas-app.jsx')).mJsqr);

afterEach(() => { vi.useRealTimers(); });

const LOCAL = { id: 'loc_a', name: 'Almacén Local', phones: ['2070'], devices: [{ id: 'loc_d1', label: 'Puerta', type: 'intercom', rtsp: 'rtsp://u:p@10.0.0.9/1' }] };
const SISTEMA = [{ id: 'c1', name: 'Casa Pérez', doc: 'RUT 1234' }, { id: 'c2', name: 'Bar Zeta' }];
const FICHA = {
  id: 'c1', name: 'Casa Pérez', doc: 'RUT 1234', address: 'Av. Italia 1', notes: 'Perro bravo',
  phones: ['099111', 2080],
  persons: [{ name: 'Ana', role: 'Dueña', phone: '099222' }, { name: 'Beto' }],
  spaces: [{ name: 'Garaje', notes: 'portón' }, { name: 'Azotea' }],
  devices: [{ id: 'd1', label: 'Frente', type: 'camera' }, { id: 'd2', label: 'Sin tipo' }],
};
const escribir = (el, v) => fireEvent.change(el, { target: { value: v } });

describe('lista de clientes', () => {
  it('sin central ni clientes ofrece cargar uno o conectarse', async () => {
    await montar({ cfg: CFG_OK });
    irA('Clientes');
    expect(screen.getByText('Todavía no hay clientes')).toBeTruthy();
    expect(screen.getByText(/Podés cargarlos en este teléfono/)).toBeTruthy();
    fireEvent.click(screen.getByText('Conectarme al sistema'));
    expect(screen.getByText('Registro')).toBeTruthy();
  });

  it('con central vacía no ofrece conectarse otra vez', async () => {
    await montar({ cfg: CFG_OK, central: true });
    irA('Clientes');
    await avanzar(0);
    expect(screen.getByText(/La central no tiene ninguno cargado/)).toBeTruthy();
    expect(screen.queryByText('Conectarme al sistema')).toBeNull();
    fireEvent.click(screen.getByText('Agregar un cliente'));
    expect(screen.getByText('Agregar cliente')).toBeTruthy();
  });

  it('mientras la central no contesta dice «Cargando…»; si falla queda vacía', async () => {
    mApi.clientsFull.mockReturnValueOnce(new Promise(() => {}));
    await montar({ cfg: CFG_OK, central: true });
    irA('Clientes');
    expect(screen.getByText('Cargando…')).toBeTruthy();
  });

  it('una falla de la central deja la lista del aparato', async () => {
    mApi.clientsFull.mockRejectedValue(new Error('500'));
    await montar({ cfg: CFG_OK, central: true, clientes: [LOCAL] });
    irA('Clientes');
    await avanzar(0);
    expect(screen.getByText('Almacén Local')).toBeTruthy();
  });

  it('junta los de la central y los del aparato, ordenados, y busca por nombre o documento', async () => {
    mApi.clientsFull.mockResolvedValue(SISTEMA);
    await montar({ cfg: CFG_OK, central: true, clientes: [LOCAL, { id: 'loc_b', devices: [] }] });
    irA('Clientes');
    await avanzar(0);
    const nombres = Array.from(document.querySelectorAll('.ph-row div[style] > div:first-child')).map((e) => e.textContent);
    expect(nombres.slice(0, 4)).toEqual(['', 'Almacén Local', 'Bar Zeta', 'Casa Pérez']);
    expect(screen.getByText('RUT 1234')).toBeTruthy();
    expect(screen.getByText('del sistema')).toBeTruthy();
    expect(screen.getAllByText('de este teléfono').length).toBe(2);
    const q = screen.getByPlaceholderText('Buscar cliente…');
    escribir(q, 'rut');
    expect(screen.queryByText('Bar Zeta')).toBeNull();
    expect(screen.getByText('Casa Pérez')).toBeTruthy();
    escribir(q, 'nada');
    expect(screen.getByText('Sin resultados')).toBeTruthy();
    fireEvent.click(screen.getByText('×'));
    expect(screen.getByText('Bar Zeta')).toBeTruthy();
    expect(screen.getByText('Elegí un cliente para ver su ficha.')).toBeTruthy();
  });
});

describe('ficha del cliente', () => {
  async function abrirFicha(detalle = FICHA) {
    mApi.clientsFull.mockResolvedValue(SISTEMA);
    mApi.clientDetail.mockResolvedValue(detalle);
    await montar({ cfg: CFG_OK, central: true, clientes: [LOCAL] });
    irA('Clientes');
    await avanzar(0);
    fireEvent.click(screen.getByText('Casa Pérez'));
    expect(screen.getByText('Cargando ficha…')).toBeTruthy();
    await avanzar(0);
  }

  it('Datos: dirección, notas y teléfonos que se llaman con un toque', async () => {
    await abrirFicha();
    expect(mApi.clientDetail).toHaveBeenCalledWith('c1');
    expect(screen.getByText('Doc: RUT 1234')).toBeTruthy();
    expect(screen.getByText('2 personas')).toBeTruthy();
    expect(screen.getByText('Av. Italia 1')).toBeTruthy();
    expect(screen.getByText('Perro bravo')).toBeTruthy();
    fireEvent.click(screen.getByText('099111'));
    expect(estado.web.placeCall).toHaveBeenCalledWith('099111', false);
    irA('Clientes');
    await avanzar(0);
    fireEvent.click(screen.getByText('2080').closest('.ph-row').querySelector('button'));
    expect(estado.web.placeCall).toHaveBeenLastCalledWith('2080', false);
  });

  it('Personas y Espacios, con sus datos; los vacíos lo dicen', async () => {
    await abrirFicha();
    fireEvent.click(screen.getByText('Personas'));
    expect(screen.getByText('Dueña · 099222')).toBeTruthy();
    fireEvent.click(screen.getByText('Ana').closest('.ph-row').querySelector('button'));
    expect(estado.web.placeCall).toHaveBeenCalledWith('099222', false);
    irA('Clientes');
    await avanzar(0);
    fireEvent.click(screen.getByText('Espacios'));
    expect(screen.getByText('Garaje')).toBeTruthy();
    expect(screen.getByText('portón')).toBeTruthy();
    fireEvent.click(screen.getByText('Bar Zeta'));
    await avanzar(0);
    // al cambiar de cliente vuelve a «Datos»
    expect(mApi.clientDetail).toHaveBeenLastCalledWith('c2');
    expect(screen.getByText('Av. Italia 1')).toBeTruthy();
    expect(screen.queryByText('portón')).toBeNull();
  });

  it('una ficha sin nada dice qué falta en cada solapa', async () => {
    await abrirFicha({ id: 'c1', name: 'Casa Pérez', notes: 'sólo notas' });
    expect(screen.getByText('sólo notas')).toBeTruthy();
    fireEvent.click(screen.getByText('Personas'));
    expect(screen.getByText('Sin personas autorizadas.')).toBeTruthy();
    fireEvent.click(screen.getByText('Espacios'));
    expect(screen.getByText('Sin espacios.')).toBeTruthy();
    fireEvent.click(screen.getByText('Dispositivos'));
    expect(screen.getByText('Sin dispositivos.')).toBeTruthy();
  });

  it('si la ficha no llega se muestra vacía en vez de quedar cargando', async () => {
    mApi.clientsFull.mockResolvedValue(SISTEMA);
    mApi.clientDetail.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(null);
    await montar({ cfg: CFG_OK, central: true });
    irA('Clientes');
    await avanzar(0);
    fireEvent.click(screen.getByText('Casa Pérez'));
    await avanzar(0);
    expect(screen.getByText('Sin datos generales.')).toBeTruthy();
    fireEvent.click(screen.getByText('Bar Zeta'));
    await avanzar(0);
    expect(screen.getByText('Sin datos generales.')).toBeTruthy();
  });

  it('Dispositivos: «Ver en vivo» lleva a Intercom con ese cliente', async () => {
    await abrirFicha();
    fireEvent.click(screen.getByText('Dispositivos'));
    expect(screen.getByText('camera · del sistema')).toBeTruthy();
    expect(screen.getByText('dispositivo · del sistema')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Ver en vivo')[0]);
    await avanzar(0);
    expect(mApi.clientStreams).toHaveBeenCalledWith('c1');
    expect(screen.getByText('Casa Pérez', { selector: 'div' })).toBeTruthy();
  });

  it('un cliente del aparato se abre sin preguntarle a nadie y se le puede quitar una cámara', async () => {
    await montar({ cfg: CFG_OK, clientes: [LOCAL] });
    irA('Clientes');
    fireEvent.click(screen.getByText('Almacén Local'));
    expect(mApi.clientDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Dispositivos'));
    expect(screen.getByText('intercom · de este teléfono')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Quitar de este teléfono'));
    expect(store.clientes[0].devices).toEqual([]);
    expect(screen.getByText('Sin dispositivos.')).toBeTruthy();
  });
});

describe('alta de cliente', () => {
  it('sin central queda en el aparato, con los teléfonos separados', async () => {
    await montar({ cfg: CFG_OK });
    irA('Clientes');
    fireEvent.click(screen.getByText('+'));
    expect(screen.getByText(/No hay sesión con el sistema/)).toBeTruthy();
    fireEvent.click(screen.getByText('Guardar'));
    expect(screen.getByText('Falta el nombre.')).toBeTruthy();
    escribir(screen.getByPlaceholderText('Ej. Edificio Rambla 1200'), '  Edificio Sur ');
    escribir(screen.getByPlaceholderText('2001, 099123456'), '2001, 099;  2002');
    fireEvent.keyDown(screen.getByPlaceholderText('Ej. Edificio Rambla 1200'), { key: 'a' });
    fireEvent.keyDown(screen.getByPlaceholderText('Ej. Edificio Rambla 1200'), { key: 'Enter' });
    await avanzar(0);
    expect(mConfig.setClientesLocales).toHaveBeenLastCalledWith([{ id: expect.stringMatching(/^loc_/), name: 'Edificio Sur', phones: ['2001', '099', '2002'], devices: [] }]);
    expect(mApi.clientCreate).not.toHaveBeenCalled();
    expect(screen.queryByText('Agregar cliente')).toBeNull();
    // queda abierto en su ficha
    expect(screen.getAllByText('Edificio Sur').length).toBe(2);
  });

  it('con central se crea allá; si la central lo rechaza se puede guardar acá', async () => {
    mApi.clientCreate.mockRejectedValueOnce(new Error('nombre duplicado')).mockResolvedValueOnce({ id: 'c9', name: 'Nuevo SA' }).mockRejectedValueOnce({});
    await montar({ cfg: CFG_OK, central: true });
    irA('Clientes');
    await avanzar(0);
    fireEvent.click(screen.getByText('+'));
    escribir(screen.getByPlaceholderText('Ej. Edificio Rambla 1200'), 'Nuevo SA');
    fireEvent.click(screen.getByText('Guardar'));
    await avanzar(0);
    expect(mApi.clientCreate).toHaveBeenCalledWith({ name: 'Nuevo SA', phones: [] });
    expect(screen.getByText('La central no lo aceptó: nombre duplicado. Podés guardarlo en este teléfono.')).toBeTruthy();
    fireEvent.click(screen.getByText('Guardar'));
    await avanzar(0);
    expect(screen.queryByText('Agregar cliente')).toBeNull();
    expect(mApi.clientDetail).toHaveBeenCalledWith('c9');
    // tercer intento: error sin mensaje
    fireEvent.click(screen.getByText('+'));
    escribir(screen.getByPlaceholderText('Ej. Edificio Rambla 1200'), 'Otro');
    fireEvent.click(screen.getByText('Guardar'));
    await avanzar(0);
    expect(screen.getByText(/La central no lo aceptó: error\./)).toBeTruthy();
    fireEvent.click(screen.getByText('Sólo en este teléfono'));
    fireEvent.click(screen.getByText('Guardar'));
    await avanzar(0);
    expect(store.clientes.map((c) => c.name)).toEqual(['Otro']);
  });

  it('se cierra con la X o tocando afuera, y el error no queda para la próxima', async () => {
    await montar({ cfg: CFG_OK });
    irA('Clientes');
    fireEvent.click(screen.getByText('+'));
    fireEvent.click(screen.getByText('Guardar'));
    fireEvent.click(screen.getByText('Agregar cliente').parentElement.querySelector('button'));
    expect(screen.queryByText('Agregar cliente')).toBeNull();
    fireEvent.click(screen.getByText('+'));
    expect(screen.queryByText('Falta el nombre.')).toBeNull();
    fireEvent.click(screen.getByText('Dónde queda'));
    expect(screen.getByText('Agregar cliente')).toBeTruthy();
    fireEvent.click(document.querySelector('[style*="z-index: 110"]'));
    expect(screen.queryByText('Agregar cliente')).toBeNull();
  });
});

describe('alta de cámara', () => {
  async function fichaSistema(sphone) {
    mApi.clientsFull.mockResolvedValue(SISTEMA);
    mApi.clientDetail.mockResolvedValue({ id: 'c1', name: 'Casa Pérez', phones: ['099111'] });
    await montar({ cfg: CFG_OK, central: true, sphone });
    irA('Clientes');
    await avanzar(0);
    fireEvent.click(screen.getByText('Casa Pérez'));
    await avanzar(0);
    fireEvent.click(screen.getByText('Dispositivos'));
    fireEvent.click(screen.getByText(/Agregar cámara/));
  }
  const url = () => screen.getByPlaceholderText(/rtsp:\/\/usuario:clave@/);

  it('valida la URL antes de mandar nada', async () => {
    await fichaSistema();
    expect(screen.getByText('Casa Pérez', { selector: 'b' })).toBeTruthy();
    fireEvent.click(screen.getByText('Guardar'));
    expect(screen.getByText('Falta la URL de la cámara.')).toBeTruthy();
    escribir(url(), 'ftp://10.0.0.1/x');
    fireEvent.click(screen.getByText('Guardar'));
    expect(screen.getByText(/Tiene que empezar con rtsp:\/\//)).toBeTruthy();
    expect(mApi.clientDeviceAdd).not.toHaveBeenCalled();
  });

  it('a la central va con etiqueta, tipo y URL; la ficha se vuelve a pedir', async () => {
    await fichaSistema();
    escribir(screen.getByPlaceholderText('Ej. Portero frente'), 'Portero');
    fireEvent.change(document.querySelectorAll('select')[document.querySelectorAll('select').length - 1], { target: { value: 'intercom' } });
    escribir(url(), ' rtsp://u:p@10.0.0.2/1 ');
    const pedidas = mApi.clientDetail.mock.calls.length;
    fireEvent.click(screen.getByText('Guardar'));
    await avanzar(0);
    expect(mApi.clientDeviceAdd).toHaveBeenCalledWith('c1', { label: 'Portero', type: 'intercom', rtsp_url: 'rtsp://u:p@10.0.0.2/1' });
    expect(screen.queryByText('Agregar cámara', { selector: 'div' })).toBeNull();
    expect(mApi.clientDetail.mock.calls.length).toBeGreaterThan(pedidas);
  });

  it('si la central la rechaza no se pierde: se puede dejar en el aparato', async () => {
    mApi.clientDeviceAdd.mockRejectedValueOnce(new Error('RTSP inválida')).mockRejectedValueOnce({});
    await fichaSistema();
    escribir(url(), 'rtsp://10.0.0.2/1');
    fireEvent.click(screen.getByText('Guardar'));
    await avanzar(0);
    expect(screen.getByText('La central no la aceptó: RTSP inválida. Podés guardarla en este teléfono.')).toBeTruthy();
    fireEvent.click(screen.getByText('Guardar'));
    await avanzar(0);
    expect(screen.getByText(/La central no la aceptó: error\./)).toBeTruthy();
    fireEvent.click(screen.getByText('Sólo en este teléfono'));
    fireEvent.click(screen.getByText('Guardar'));
    await avanzar(0);
    // copia local del cliente del sistema, con su nombre y teléfonos, y la cámara colgada
    expect(store.clientes).toEqual([{ id: expect.stringMatching(/^loc_/), name: 'Casa Pérez', phones: ['099111'], devices: [{ id: expect.stringMatching(/^loc_/), label: 'Cámara', type: 'camera', rtsp: 'rtsp://10.0.0.2/1' }] }]);
  });

  it('en un cliente del aparato la cámara queda en el aparato, sin opción de central', async () => {
    await montar({ cfg: CFG_OK, central: true, clientes: [LOCAL] });
    irA('Clientes');
    await avanzar(0);
    fireEvent.click(screen.getByText('Almacén Local'));
    fireEvent.click(screen.getByText('Dispositivos'));
    fireEvent.click(screen.getByText(/Agregar cámara/));
    expect(screen.getByText(/Este cliente también es de este teléfono/)).toBeTruthy();
    escribir(url(), 'http://10.0.0.3/mjpg');
    fireEvent.click(screen.getByText('Guardar'));
    await avanzar(0);
    expect(mApi.clientDeviceAdd).not.toHaveBeenCalled();
    expect(store.clientes[0].devices.map((d) => d.rtsp)).toEqual(['rtsp://u:p@10.0.0.9/1', 'http://10.0.0.3/mjpg']);
    expect(store.clientes[0].id).toBe('loc_a');
  });

  it('«Probar» sin el softphone de escritorio lo dice', async () => {
    await fichaSistema();
    expect(screen.getByText('Probar').disabled).toBe(true);
    escribir(url(), 'rtsp://10.0.0.2/1');
    fireEvent.click(screen.getByText('Probar'));
    expect(screen.getByText('Probar necesita el softphone de escritorio.')).toBeTruthy();
    // cambiar la URL borra el resultado de la prueba anterior
    escribir(url(), 'rtsp://10.0.0.2/2');
    expect(screen.queryByText('Probar necesita el softphone de escritorio.')).toBeNull();
  });

  it('«Probar» en Electron dice si da video, por qué no, o el error', async () => {
    const camaraProbar = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => setTimeout(() => r({ ok: true, codec: 'video/mp4; codecs="avc1.640029"' }), 30)))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, motivo: '401: clave incorrecta' })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce({});
    await fichaSistema({ camaraProbar });
    escribir(url(), 'rtsp://10.0.0.2/1');
    fireEvent.click(screen.getByText('Probar'));
    expect(screen.getByText('Probando…')).toBeTruthy();
    await avanzar(40);
    expect(camaraProbar).toHaveBeenCalledWith('rtsp://10.0.0.2/1');
    expect(screen.getByText('✓ Da video · avc1.640029')).toBeTruthy();
    fireEvent.click(screen.getByText('Probar')); await avanzar(0);
    expect(screen.getByText('✓ Da video')).toBeTruthy();
    fireEvent.click(screen.getByText('Probar')); await avanzar(0);
    expect(screen.getByText('401: clave incorrecta')).toBeTruthy();
    fireEvent.click(screen.getByText('Probar')); await avanzar(0);
    expect(screen.getByText('timeout')).toBeTruthy();
    fireEvent.click(screen.getByText('Probar')); await avanzar(0);
    expect(screen.getByText('error')).toBeTruthy();
  });
});

describe('buscar la cámara por ONVIF', () => {
  const EQUIPOS = [{ xaddr: 'http://10.0.0.20/onvif/device_service', host: '10.0.0.20', nombre: 'Hikvision', modelo: 'DS-2CD' }, { xaddr: 'http://10.0.0.21/x', host: '10.0.0.21' }];
  const PERFILES = [{ nombre: 'Principal', rtsp: 'rtsp://10.0.0.20/101', resolucion: '1920x1080', codec: 'H264', fps: 25 }, { nombre: 'Secundario', rtsp: 'rtsp://10.0.0.20/102' }];
  async function abrirAlta(extra) {
    const sphone = { onvifDescubrir: vi.fn(() => Promise.resolve({ ok: true, equipos: EQUIPOS })), onvifPerfiles: vi.fn(() => Promise.resolve({ ok: true, perfiles: PERFILES })), ...extra };
    await montar({ cfg: CFG_OK, clientes: [{ id: 'loc_a', name: 'Almacén', devices: [] }], sphone });
    irA('Clientes');
    fireEvent.click(screen.getByText('Almacén'));
    fireEvent.click(screen.getByText('Dispositivos'));
    fireEvent.click(screen.getByText(/Agregar cámara/));
    return window.sphone;
  }

  it('en la PWA no aparece', async () => {
    await montar({ cfg: CFG_OK, clientes: [{ id: 'loc_a', name: 'Almacén', devices: [] }] });
    irA('Clientes');
    fireEvent.click(screen.getByText('Almacén'));
    fireEvent.click(screen.getByText('Dispositivos'));
    fireEvent.click(screen.getByText(/Agregar cámara/));
    expect(screen.queryByText(/Buscar la cámara en la red/)).toBeNull();
  });

  it('encuentra, pide la clave, lista los canales y completa la URL y la etiqueta', async () => {
    const sp = await abrirAlta();
    fireEvent.click(screen.getByText(/Buscar la cámara en la red/));
    expect(screen.getByText('Buscando… (unos segundos)')).toBeTruthy();
    await avanzar(0);
    expect(sp.onvifDescubrir).toHaveBeenCalledWith(4500);
    expect(screen.getByText('10.0.0.20 · DS-2CD')).toBeTruthy();
    fireEvent.click(screen.getByText('Hikvision'));
    expect(screen.getByText('Usuario de la cámara')).toBeTruthy();
    expect(screen.getByText('Hikvision · 10.0.0.20')).toBeTruthy();
    escribir(screen.getByPlaceholderText('usuario'), 'operador');
    escribir(screen.getByPlaceholderText('clave'), 'secreto');
    fireEvent.keyDown(screen.getByPlaceholderText('clave'), { key: 'a' });
    fireEvent.keyDown(screen.getByPlaceholderText('clave'), { key: 'Enter' });
    expect(screen.getByText('Consultando…')).toBeTruthy();
    await avanzar(0);
    expect(sp.onvifPerfiles).toHaveBeenCalledWith({ xaddr: EQUIPOS[0].xaddr, user: 'operador', pass: 'secreto' });
    expect(screen.getByText('Elegí el canal')).toBeTruthy();
    expect(screen.getByText('1920x1080 · H264 · 25 fps')).toBeTruthy();
    fireEvent.click(screen.getByText('Atrás'));
    expect(screen.getByText('Usuario de la cámara')).toBeTruthy();
    fireEvent.click(screen.getByText('Ver los canales'));
    await avanzar(0);
    fireEvent.click(screen.getByText('Principal'));
    expect(screen.getByPlaceholderText(/rtsp:\/\/usuario:clave@/).value).toBe('rtsp://10.0.0.20/101');
    expect(screen.getByPlaceholderText('Ej. Portero frente').value).toBe('Hikvision · Principal');
    expect(screen.getByText(/Buscar la cámara en la red/)).toBeTruthy();
  });

  it('un equipo sin nombre usa la IP y la etiqueta escrita a mano no se pisa', async () => {
    await abrirAlta();
    escribir(screen.getByPlaceholderText('Ej. Portero frente'), 'Mía');
    fireEvent.click(screen.getByText(/Buscar la cámara en la red/));
    await avanzar(0);
    fireEvent.click(screen.getAllByText('10.0.0.21')[0]);
    expect(screen.getByText('10.0.0.21 · 10.0.0.21')).toBeTruthy();
    fireEvent.click(screen.getByText('Ver los canales'));
    await avanzar(0);
    fireEvent.click(screen.getByText('Secundario'));
    expect(screen.getByPlaceholderText('Ej. Portero frente').value).toBe('Mía');
  });

  it('si nadie contesta explica por qué y deja poner la IP a mano', async () => {
    const sp = await abrirAlta({ onvifDescubrir: vi.fn(() => Promise.resolve({ ok: true })) });
    fireEvent.click(screen.getByText(/Buscar la cámara en la red/));
    await avanzar(0);
    expect(screen.getByText(/No contestó ninguna/)).toBeTruthy();
    fireEvent.click(screen.getByText('Usar'));
    expect(screen.queryByText('Usuario de la cámara')).toBeNull();
    escribir(screen.getByPlaceholderText('IP de la cámara'), ' 10.0.0.30 ');
    fireEvent.click(screen.getByText('Usar'));
    expect(screen.getByText('10.0.0.30')).toBeTruthy();
    fireEvent.click(screen.getByText('Ver los canales'));
    await avanzar(0);
    expect(sp.onvifPerfiles).toHaveBeenCalledWith({ xaddr: 'http://10.0.0.30/onvif/device_service', user: 'admin', pass: '' });
  });

  it('los errores de la búsqueda y de los perfiles se muestran', async () => {
    const sp = await abrirAlta({
      onvifDescubrir: vi.fn().mockResolvedValueOnce({ ok: false, motivo: 'sin red' }).mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('explotó')).mockRejectedValueOnce({}),
      onvifPerfiles: vi.fn().mockResolvedValueOnce({ ok: false, motivo: '401' }).mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce({}).mockResolvedValueOnce({ ok: true }),
    });
    fireEvent.click(screen.getByText(/Buscar la cámara en la red/));
    await avanzar(0);
    expect(screen.getByText('sin red')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Buscar de nuevo')); await avanzar(0);
    expect(screen.getByText('no se pudo buscar')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Buscar de nuevo')); await avanzar(0);
    expect(screen.getByText('explotó')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Buscar de nuevo')); await avanzar(0);
    expect(screen.getByText('error')).toBeTruthy();
    escribir(screen.getByPlaceholderText('IP de la cámara'), '10.0.0.30');
    fireEvent.click(screen.getByText('Usar'));
    const ver = () => { fireEvent.click(screen.getByText('Ver los canales')); return avanzar(0); };
    await ver(); expect(screen.getByText('401')).toBeTruthy();
    await ver(); expect(screen.getByText('no se pudieron leer los perfiles')).toBeTruthy();
    await ver(); expect(screen.getByText('timeout')).toBeTruthy();
    await ver(); expect(screen.getByText('error')).toBeTruthy();
    await ver();
    expect(screen.getByText('Elegí el canal')).toBeTruthy();
    expect(sp.onvifPerfiles).toHaveBeenCalledTimes(5);
    fireEvent.click(screen.getByText('Atrás'));
    fireEvent.click(screen.getByText('Atrás'));
    expect(screen.getByText('Cámaras en esta red')).toBeTruthy();
    fireEvent.click(screen.getAllByText('×').find((b) => b.tagName === 'BUTTON' && b.closest('[style*="dashed"]') === null && b.parentElement.textContent.includes('Cámaras en esta red')));
    expect(screen.getByText(/Buscar la cámara en la red/)).toBeTruthy();
  });
});
