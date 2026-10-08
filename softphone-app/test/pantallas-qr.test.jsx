/* El diálogo «Configurar por QR»: escanear con la webcam, pegar el código o el link de
 * enrolamiento, y mostrar el QR propio para configurar otro equipo.
 *
 * Es el camino que usa el técnico para dejar un puesto andando en un minuto. En una PC sin
 * webcam tiene que ir directo a «Pegar código» (no a una cámara negra); un link de
 * enrolamiento se canjea contra la central y su error se muestra; y al reconocer un QR la
 * cámara se apaga en el acto. «Mi QR» lleva la clave del interno: lo avisa. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { mProv, mQrcode, mJsqr } from './helpers/pantallas-app.jsx';
import { esponja, RELOJES } from './helpers/pantallas-medios.js';
import QrProvision from '../src/QrProvision.jsx';

vi.mock('../src/prov.js', async () => (await import('./helpers/pantallas-app.jsx')).mProv);
vi.mock('qrcode', async () => (await import('./helpers/pantallas-app.jsx')).mQrcode);
vi.mock('jsqr', async () => (await import('./helpers/pantallas-app.jsx')).mJsqr);

const getContextOriginal = HTMLCanvasElement.prototype.getContext;
const anchoOriginal = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoWidth');
const altoOriginal = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoHeight');
let pista;
function camaras({ hay = true, falla = null, enumerar = true } = {}) {
  pista = { stop: vi.fn() };
  const md = {
    getUserMedia: vi.fn(() => (falla ? Promise.reject(falla) : Promise.resolve({ getTracks: () => [pista] }))),
  };
  if (enumerar) md.enumerateDevices = vi.fn(() => Promise.resolve(hay ? [{ kind: 'audioinput' }, { kind: 'videoinput' }] : [{ kind: 'audioinput' }]));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: md });
  return md;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: RELOJES });
  HTMLCanvasElement.prototype.getContext = () => esponja({ getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get() { return 320; } });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get() { return 240; } });
});
afterEach(() => {
  vi.useRealTimers();
  HTMLCanvasElement.prototype.getContext = getContextOriginal;
  delete navigator.mediaDevices;
  delete navigator.clipboard;
  if (anchoOriginal) Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', anchoOriginal);
  if (altoOriginal) Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', altoOriginal);
});
const pasar = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const CFG = { ext: '2001', pass: 'x', wss: 'wss://p/ws', domain: 'p' };
const montar = (p = {}) => { const onApply = vi.fn(), onClose = vi.fn(); const r = render(<QrProvision cfg={CFG} onApply={onApply} onClose={onClose} {...p} />); return { ...r, onApply, onClose }; };

describe('sin cámara', () => {
  it('sin API de medios va directo a «Pegar código»', async () => {
    delete navigator.mediaDevices;
    montar();
    await pasar();
    expect(screen.getByPlaceholderText('https://pbx.tu-dominio.com/enroll?token=...')).toBeTruthy();
  });

  it('sin webcam también; volver a «Escanear» explica cómo seguir', async () => {
    camaras({ hay: false });
    montar();
    await pasar();
    expect(screen.getByPlaceholderText('https://pbx.tu-dominio.com/enroll?token=...')).toBeTruthy();
    fireEvent.click(screen.getByText('Escanear'));
    expect(screen.getByText('No hay cámara disponible')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Pegar código')[1]);
    expect(screen.getByPlaceholderText('https://pbx.tu-dominio.com/enroll?token=...')).toBeTruthy();
  });

  it('si la cámara no abre lo dice y propone pegar', async () => {
    camaras({ falla: new Error('Permission denied') });
    montar();
    await pasar();
    expect(screen.getByText('No se pudo abrir la cámara: Permission denied — usá "Pegar código".')).toBeTruthy();
    expect(screen.getByText('No hay cámara disponible')).toBeTruthy();
  });

  it('un error sin mensaje se muestra igual', async () => {
    camaras({ falla: 'NotReadable' });
    montar();
    await pasar();
    expect(screen.getByText(/No se pudo abrir la cámara: NotReadable/)).toBeTruthy();
  });

  it('un rechazo nulo de la cámara se informa igual', async () => {
    camaras({ falla: null });
    navigator.mediaDevices.getUserMedia = vi.fn(() => Promise.reject(null));
    montar();
    await pasar();
    expect(screen.getByText(/No se pudo abrir la cámara: null/)).toBeTruthy();
  });

  it('si la lista de cámaras llega después de cerrar, se ignora', async () => {
    const md = camaras({ hay: false });
    let soltar; md.enumerateDevices = vi.fn(() => new Promise((r) => { soltar = r; }));
    const { unmount } = montar();
    unmount();
    soltar([]);
    await pasar();
    expect(screen.queryByText('No hay cámara disponible')).toBeNull();
  });

  it('cerrar antes de saber si hay cámara no cambia nada', async () => {
    const md = camaras();
    let soltar; md.enumerateDevices = vi.fn(() => new Promise((r, j) => { soltar = j; }));
    const { unmount } = montar();
    unmount();
    soltar(new Error('tarde'));
    await pasar();
    expect(md.getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('escanear', () => {
  it('reconoce un QR de aprovisionamiento, apaga la cámara y aplica', async () => {
    camaras();
    mJsqr.default.mockReturnValueOnce(null).mockReturnValueOnce({ data: 'texto cualquiera' }).mockReturnValueOnce({ data: 'pbxng://prov#' + JSON.stringify({ ext: '3001' }) });
    const { onApply, container } = montar();
    await pasar();
    expect(container.querySelector('video').srcObject).toBeTruthy();
    expect(screen.getByText(/Apuntá la cámara al QR/)).toBeTruthy();
    await pasar(100);
    expect(onApply).toHaveBeenCalledWith({ ext: '3001' });
    expect(pista.stop).toHaveBeenCalled();
    expect(mJsqr.default).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 1, 1, { inversionAttempts: 'dontInvert' });
  });

  it('un link de enrolamiento se canjea; si es inválido o falla lo dice', async () => {
    camaras();
    const link = 'https://pbx/enroll?token=abc';
    mJsqr.default.mockReturnValue({ data: link });
    mProv.resolveEnroll.mockResolvedValueOnce({ ext: '4001' });
    let r = montar();
    await pasar(50);
    expect(mProv.resolveEnroll).toHaveBeenCalledWith(link);
    expect(r.onApply).toHaveBeenCalledWith({ ext: '4001' });
    r.unmount();
    mProv.resolveEnroll.mockResolvedValueOnce(null);
    r = montar();
    await pasar(50);
    expect(screen.getByText('El link no es válido.')).toBeTruthy();
    r.unmount();
    mProv.resolveEnroll.mockRejectedValueOnce(new Error('token vencido'));
    r = montar();
    await pasar(50);
    expect(screen.getByText('token vencido')).toBeTruthy();
    r.unmount();
    mProv.resolveEnroll.mockRejectedValueOnce('sin red');
    montar();
    await pasar(50);
    expect(screen.getByText('sin red')).toBeTruthy();
  });

  it('mientras el video no tiene tamaño sigue esperando, y al cerrar apaga la cámara', async () => {
    camaras();
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get() { return 0; } });
    const { unmount } = montar();
    await pasar(100);
    expect(mJsqr.default).not.toHaveBeenCalled();
    unmount();
    expect(pista.stop).toHaveBeenCalled();
  });

  it('si la cámara abre pero el diálogo ya no tiene video, igual escanea sin romper', async () => {
    camaras();
    const { onClose, container } = montar();
    fireEvent.click(screen.getByText('Mi QR'));
    await pasar(50);
    expect(container.querySelector('video')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('pegar código', () => {
  async function pegar(txt) {
    camaras({ hay: false });
    const r = montar();
    await pasar();
    fireEvent.change(screen.getByPlaceholderText('https://pbx.tu-dominio.com/enroll?token=...'), { target: { value: txt } });
    return r;
  }

  it('un código pbxng:// se aplica directo', async () => {
    const { onApply } = await pegar('  pbxng://prov#' + JSON.stringify({ ext: '5' }) + ' ');
    fireEvent.click(screen.getByText('Configurar'));
    expect(onApply).toHaveBeenCalledWith({ ext: '5' });
  });

  it('un link de enrolamiento se canjea mostrando que está trabajando', async () => {
    mProv.resolveEnroll.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r({ ext: '6' }), 30)));
    const { onApply } = await pegar('https://pbx/enroll?token=x');
    fireEvent.click(screen.getByText('Configurar'));
    expect(screen.getByText('Configurando…').disabled).toBe(true);
    await pasar(40);
    expect(onApply).toHaveBeenCalledWith({ ext: '6' });
  });

  it('un link que no devuelve config, o que falla, lo explica', async () => {
    mProv.resolveEnroll.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('403')).mockRejectedValueOnce('crudo');
    const { onApply } = await pegar('https://pbx/enroll?token=x');
    fireEvent.click(screen.getByText('Configurar')); await pasar();
    expect(screen.getByText('El link no devolvió una configuración válida.')).toBeTruthy();
    fireEvent.click(screen.getByText('Configurar')); await pasar();
    expect(screen.getByText('403')).toBeTruthy();
    fireEvent.click(screen.getByText('Configurar')); await pasar();
    expect(screen.getByText('crudo')).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('cualquier otra cosa dice qué formatos sirven', async () => {
    await pegar('hola');
    fireEvent.click(screen.getByText('Configurar'));
    expect(screen.getByText(/Código inválido/)).toBeTruthy();
    // cambiar de solapa borra el error
    fireEvent.click(screen.getByText('Pegar código'));
    expect(screen.queryByText(/Código inválido/)).toBeNull();
  });

  it('vacío también es inválido', async () => {
    camaras({ hay: false });
    montar({});
    await pasar();
    fireEvent.change(screen.getByPlaceholderText('https://pbx.tu-dominio.com/enroll?token=...'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Configurar'));
    expect(screen.getByText(/Código inválido/)).toBeTruthy();
  });
});

describe('mi QR', () => {
  it('muestra el QR del interno, avisa que lleva la clave y lo copia', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    camaras({ hay: false });
    montar();
    await pasar();
    fireEvent.click(screen.getByText('Mi QR'));
    expect(screen.getByText('Generando…')).toBeTruthy();
    await pasar();
    expect(mQrcode.default.toDataURL).toHaveBeenCalledWith('pbxng://prov#' + JSON.stringify(CFG), expect.objectContaining({ errorCorrectionLevel: 'M' }));
    expect(screen.getByAltText('QR')).toBeTruthy();
    expect(screen.getByText(/Incluye la contraseña del interno/)).toBeTruthy();
    fireEvent.click(screen.getByText('Copiar código'));
    expect(writeText).toHaveBeenCalledWith('pbxng://prov#' + JSON.stringify(CFG));
    expect(screen.getByText('Copiado ✓').style.color).toBe('rgb(43, 217, 90)');
  });

  it('si el QR no se puede generar queda el aviso, y sin portapapeles no explota', async () => {
    mQrcode.default.toDataURL.mockRejectedValueOnce(new Error('muy largo'));
    camaras({ hay: false });
    montar();
    await pasar();
    fireEvent.click(screen.getByText('Mi QR'));
    await pasar();
    expect(screen.getByText('Generando…')).toBeTruthy();
    fireEvent.click(screen.getByText('Copiar código'));
    expect(screen.queryByText('Copiado ✓')).toBeNull();
  });
});

describe('cerrar', () => {
  it('con la cruz o tocando afuera, no tocando adentro', async () => {
    camaras({ hay: false });
    const { onClose, container } = montar();
    await pasar();
    fireEvent.click(screen.getByText('Configurar por QR'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('✕'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.firstChild);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
