/* La cara del softphone embebido (`app/Softphone.jsx`), que usan el panel de agente y el
 * de supervisión. Se fija lo que el operador toca: marcar y llamar (sólo registrado), el
 * buscador de contactos con su presencia, la pantalla de llamada (nombre del directorio,
 * «VÍA TURN» o «DIRECTO», REC), los controles que se apagan hasta que la llamada está
 * establecida, la transferencia, el aviso de entrante con video, y el diálogo de
 * dispositivos (micrófono, salida y cámara guardados para las próximas llamadas). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import Softphone from '../app/Softphone.jsx';
import { crearSpFalso, instalarMedios } from './helpers/nucleo-sip.js';
import { instalarStorage } from './helpers/nucleo-render.jsx';

let st, medios;
beforeEach(() => { st = instalarStorage(); medios = instalarMedios(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete navigator.mediaDevices; });

const DIR = [
  { ext: '101', name: 'Yo', status: 'online' },
  { ext: '102', name: 'Ana Pérez', status: 'online' },
  { ext: '103', name: 'Beto', status: 'in_call' },
  { ext: '104', status: 'offline' },
  { ext: '105', name: 'Carla', status: 'unavailable' },
];
const tecla = (k) => screen.getAllByRole('button').find((b) => b.querySelector('span') && b.querySelector('span').textContent === k);
const botonesLlamar = () => { const v = document.querySelector('button[style*="3a9bff"]'); return { video: v, audio: v.nextElementSibling, borrar: v.nextElementSibling.nextElementSibling }; };

describe('marcador', () => {
  it('marca con el teclado (con tono), borra y llama por audio o video', () => {
    const sp = crearSpFalso();
    render(<Softphone sp={sp} />);
    ['2', '0', '0'].forEach((k) => fireEvent.click(tecla(k)));
    expect(sp.tone).toHaveBeenCalledWith('2');
    expect(screen.getByText('200')).toBeTruthy();
    fireEvent.click(botonesLlamar().borrar);
    expect(screen.getByText('20')).toBeTruthy();
    fireEvent.click(botonesLlamar().audio);
    expect(sp.placeCall).toHaveBeenCalledWith('20', false);
    fireEvent.click(tecla('1'));
    fireEvent.click(botonesLlamar().video);
    expect(sp.placeCall).toHaveBeenLastCalledWith('201', true);
  });

  it('el número no pasa de 28 dígitos; sin registro o sin número no llama', () => {
    const sp = crearSpFalso({ reg: 'connecting' });
    const { container } = render(<Softphone sp={sp} dark />);
    for (let i = 0; i < 30; i++) fireEvent.click(tecla('9'));
    expect(container.textContent).toContain('9'.repeat(28));
    expect(container.textContent).not.toContain('9'.repeat(29));
    fireEvent.click(botonesLlamar().audio);
    expect(sp.placeCall).not.toHaveBeenCalled();
    const sp2 = crearSpFalso();
    render(<Softphone sp={sp2} />);
    fireEvent.click(botonesLlamar().audio);
    expect(sp2.placeCall).not.toHaveBeenCalled();
  });
});

describe('buscador de contactos', () => {
  it('al enfocar lista los contactos (en línea primero, sin uno mismo) y cuenta los conectados', () => {
    const sp = crearSpFalso();
    render(<Softphone sp={sp} directory={DIR} />);
    expect(document.body.textContent).toContain(' 2');
    fireEvent.focus(screen.getByPlaceholderText('Buscar o ver contactos…'));
    expect(screen.getByText('CONTACTOS')).toBeTruthy();
    const nombres = [...document.querySelectorAll('.sf-res')].map((r) => r.textContent);
    expect(nombres[0]).toContain('Ana Pérez');
    expect(nombres[1]).toContain('Beto');
    expect(nombres.join()).not.toContain('Yo');
    expect(screen.getByText('Extensión 104')).toBeTruthy();
    expect(screen.getByText('AP')).toBeTruthy();
  });

  it('filtra por nombre o número, llama por audio o video y limpia la búsqueda', () => {
    const sp = crearSpFalso();
    render(<Softphone sp={sp} directory={DIR} />);
    const q = screen.getByPlaceholderText('Buscar o ver contactos…');
    fireEvent.focus(q);
    fireEvent.change(q, { target: { value: 'bet' } });
    expect(screen.queryByText('CONTACTOS')).toBeNull();
    expect(document.querySelectorAll('.sf-res')).toHaveLength(1);
    const fila = document.querySelector('.sf-res');
    fireEvent.click(fila.querySelectorAll('button')[0]);
    expect(sp.placeCall).toHaveBeenLastCalledWith('103', true);
    fireEvent.focus(q);
    fireEvent.change(q, { target: { value: '105' } });
    fireEvent.click(document.querySelector('.sf-res').querySelectorAll('button')[1]);
    expect(sp.placeCall).toHaveBeenLastCalledWith('105', false);
    fireEvent.focus(q);
    fireEvent.change(q, { target: { value: '102' } });
    fireEvent.click(document.querySelector('.sf-res'));
    expect(sp.placeCall).toHaveBeenLastCalledWith('102', false);
    fireEvent.change(q, { target: { value: 'zzz' } });
    fireEvent.click(q.parentElement.querySelector('button'));
    expect(q.value).toBe('');
  });

  it('se esconde un ratito después de salir', () => {
    vi.useFakeTimers();
    render(<Softphone sp={crearSpFalso()} directory={DIR} />);
    const caja = screen.getByPlaceholderText('Buscar o ver contactos…').closest('div').parentElement;
    fireEvent.mouseEnter(caja);
    expect(screen.getByText('CONTACTOS')).toBeTruthy();
    fireEvent.mouseLeave(caja);
    fireEvent.blur(screen.getByPlaceholderText('Buscar o ver contactos…'));
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText('CONTACTOS')).toBeNull();
  });
});

describe('en llamada', () => {
  it('sonando: «Llamando…», controles apagados hasta establecer; colgar siempre anda', () => {
    const sp = crearSpFalso({ call: 'Establishing', callInfo: { dir: 'out', number: '102' } });
    render(<Softphone sp={sp} directory={DIR} />);
    expect(screen.getByText('Ana Pérez')).toBeTruthy();
    expect(screen.getByText('102')).toBeTruthy();
    expect(screen.getByText('Llamando…')).toBeTruthy();
    expect(screen.getByText('Silenciar').closest('button').disabled).toBe(true);
    expect(screen.getByText('Teclado').closest('button').disabled).toBe(true);
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.style.width === '66px'));
    expect(sp.hangup).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Buscar o ver contactos…')).toBeNull();
  });

  it('entrante sin atender todavía dice «Entrante…»; un número sin nombre muestra el ícono', () => {
    render(<Softphone sp={crearSpFalso({ call: 'Initial', callInfo: { dir: 'in', number: '0991234' } })} />);
    expect(screen.getByText('Entrante…')).toBeTruthy();
    expect(screen.getByText('0991234')).toBeTruthy();
  });

  it('establecida: reloj, ecualizador, REC, ruta del audio y controles activos', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const sp = crearSpFalso({ call: 'Established', callInfo: { dir: 'out', number: '300', since: 100000 - 65000 }, recording: true, usingRelay: true, muted: true, speaker: true });
    const { rerender } = render(<Softphone sp={sp} />);
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.getByText('01:05')).toBeTruthy();
    expect(screen.getByText('REC')).toBeTruthy();
    expect(screen.getByText('VÍA TURN')).toBeTruthy();
    fireEvent.click(screen.getByText('Silenciar').closest('button'));
    expect(sp.toggleMute).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Espera').closest('button'));
    expect(sp.toggleHold).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Altavoz').closest('button'));
    expect(sp.toggleSpeaker).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Teclado').closest('button'));
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '#'));
    expect(sp.tone).toHaveBeenCalledWith('#');
    fireEvent.click(screen.getByText('Teclado').closest('button'));
    rerender(<Softphone sp={{ ...sp, usingRelay: false, held: true, toggleSpeaker: undefined, callInfo: { dir: 'out', number: '300' } }} />);
    expect(screen.getByText('DIRECTO')).toBeTruthy();
    expect(screen.getAllByText('En espera').length).toBeGreaterThan(0);
    expect(screen.getByText('Reanudar')).toBeTruthy();
    expect(screen.queryByText('Altavoz')).toBeNull();
  });

  it('el reloj vuelve a cero sin hora de inicio', () => {
    vi.useFakeTimers();
    render(<Softphone sp={crearSpFalso({ call: 'Established', callInfo: { number: '1' } })} />);
    expect(screen.getByText('00:00')).toBeTruthy();
  });

  it('transferir: sólo dígitos, Enter o botón, y cancelar o tocar afuera cierra', () => {
    const sp = crearSpFalso({ call: 'Established', callInfo: { number: '300' } });
    render(<Softphone sp={sp} />);
    fireEvent.click(screen.getByText('Transferir').closest('button'));
    const inp = screen.getByPlaceholderText('Ej 1001');
    fireEvent.change(inp, { target: { value: '10a2*' } });
    expect(inp.value).toBe('102*');
    fireEvent.keyDown(inp, { key: 'Enter' });
    expect(sp.transfer).toHaveBeenCalledWith('102*');
    expect(screen.queryByPlaceholderText('Ej 1001')).toBeNull();
    fireEvent.click(screen.getByText('Transferir').closest('button'));
    fireEvent.keyDown(screen.getByPlaceholderText('Ej 1001'), { key: 'a' });
    const boton = screen.getAllByText('Transferir').at(-1);
    expect(boton.disabled).toBe(true);
    fireEvent.click(boton);
    fireEvent.click(screen.getByText('Cancelar'));
    expect(screen.queryByPlaceholderText('Ej 1001')).toBeNull();
    fireEvent.click(screen.getByText('Transferir').closest('button'));
    fireEvent.change(screen.getByPlaceholderText('Ej 1001'), { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Transferir llamada').parentElement.parentElement);
    expect(screen.queryByPlaceholderText('Ej 1001')).toBeNull();
    expect(sp.transfer).toHaveBeenCalledTimes(1);
  });
});

describe('llamada entrante', () => {
  const inc = (user) => ({ remoteIdentity: { uri: { user } } });

  it('audio: muestra quién llama (con nombre del directorio), tarjeta extra, atender o rechazar', () => {
    const sp = crearSpFalso({ incoming: inc('102') });
    render(<Softphone sp={sp} directory={DIR} onIncomingCard={(n) => <div>ficha de {n}</div>} />);
    expect(screen.getByText('LLAMADA ENTRANTE')).toBeTruthy();
    expect(screen.getByText('Ana Pérez')).toBeTruthy();
    expect(screen.getByText('ficha de 102')).toBeTruthy();
    expect(screen.queryByText('Video')).toBeNull();
    fireEvent.click(screen.getByText('Atender').previousElementSibling);
    expect(sp.acceptIncoming).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByText('Rechazar').previousElementSibling);
    expect(sp.rejectIncoming).toHaveBeenCalled();
  });

  it('video: ofrece atender con video o sólo audio; sin identidad dice «Desconocido»', () => {
    const sp = crearSpFalso({ incoming: { remoteIdentity: null }, incomingVideo: true });
    render(<Softphone sp={sp} />);
    expect(screen.getByText('VIDEOLLAMADA')).toBeTruthy();
    expect(screen.getByText('Desconocido')).toBeTruthy();
    fireEvent.click(screen.getByText('Video').previousElementSibling);
    expect(sp.acceptIncoming).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText('Audio').previousElementSibling);
    expect(sp.acceptIncoming).toHaveBeenLastCalledWith(false);
  });
});

describe('dispositivos', () => {
  const abrir = async () => { fireEvent.click(screen.getByTitle('Ajustes de audio y video')); await act(async () => {}); };

  it('lista micrófonos, salidas y cámaras; guarda la elección y aplica la salida', async () => {
    medios.mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'm1', label: 'Mic USB' }, { kind: 'audioinput', deviceId: 'm2', label: '' },
      { kind: 'audiooutput', deviceId: 's1', label: 'Parlantes' }, { kind: 'videoinput', deviceId: 'c1', label: 'Webcam' },
    ]);
    st.local.setItem('pbxng_dev_mic', 'm2');
    // El <audio> real del componente pisa audioRef.current: el espía va en el prototipo.
    const audio = { setSinkId: vi.fn(async () => {}) };
    window.HTMLMediaElement.prototype.setSinkId = audio.setSinkId;
    const sp = crearSpFalso();
    render(<Softphone sp={sp} />);
    await abrir();
    expect(screen.getByText('Dispositivos de audio y video')).toBeTruthy();
    expect(screen.getByText('Mic USB')).toBeTruthy();
    expect(screen.getByText('Micrófono 2')).toBeTruthy();
    const [mic, spk, cam] = document.querySelectorAll('select');
    expect(mic.value).toBe('m2');
    fireEvent.change(mic, { target: { value: 'm1' } });
    fireEvent.change(spk, { target: { value: 's1' } });
    expect(audio.setSinkId).toHaveBeenCalledWith('s1');
    fireEvent.change(cam, { target: { value: 'c1' } });
    fireEvent.click(screen.getByText('Guardar'));
    expect(st.local.getItem('pbxng_dev_mic')).toBe('m1');
    expect(st.local.getItem('pbxng_dev_spk')).toBe('s1');
    expect(st.local.getItem('pbxng_dev_cam')).toBe('c1');
    expect(audio.setSinkId).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Dispositivos de audio y video')).toBeNull();
    delete window.HTMLMediaElement.prototype.setSinkId;
  });

  it('sin permiso lo pide con un aviso; sin salidas lo explica; cancelar o tocar afuera cierra', async () => {
    medios.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('NotAllowed'));
    medios.mediaDevices.enumerateDevices.mockRejectedValueOnce(new Error('x'));
    render(<Softphone sp={crearSpFalso()} />);
    await abrir();
    expect(screen.getByText('Permití el acceso a micrófono y cámara para poder elegirlos.')).toBeTruthy();
    expect(screen.getByText('Tu navegador no permite elegir la salida (usa la del sistema).')).toBeTruthy();
    fireEvent.click(screen.getByText('Dispositivos de audio y video'));
    expect(screen.getByText('Dispositivos de audio y video')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancelar'));
    expect(screen.queryByText('Dispositivos de audio y video')).toBeNull();
    await abrir();
    fireEvent.click(screen.getByText('Dispositivos de audio y video').closest('div[style*="fixed"]'));
    expect(screen.queryByText('Dispositivos de audio y video')).toBeNull();
  });

  it('probar la cámara muestra la vista previa y la apaga al ocultar', async () => {
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
    render(<Softphone sp={crearSpFalso()} />);
    await abrir();
    fireEvent.click(screen.getByText('Probar'));
    await act(async () => {});
    expect(medios.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ video: true });
    expect(document.querySelector('video')).toBeTruthy();
    expect(play).toHaveBeenCalled();
    const stream = await medios.mediaDevices.getUserMedia.mock.results.at(-1).value;
    fireEvent.change(document.querySelectorAll('select')[2], { target: { value: '' } });
    fireEvent.click(screen.getByText('Ocultar'));
    await act(async () => {});
    expect(stream.getTracks()[0].stop).toHaveBeenCalled();
  });

  it('cámara elegida en la vista previa, errores de storage, de salida y de cámara no rompen', async () => {
    st.local.setItem('pbxng_dev_cam', 'c9');
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => { throw new Error('autoplay'); });
    medios.mediaDevices.enumerateDevices.mockResolvedValue([{ kind: 'audiooutput', deviceId: 's1' }]);
    window.HTMLMediaElement.prototype.setSinkId = vi.fn(async () => { throw new Error('x'); });
    const sp = crearSpFalso();
    render(<Softphone sp={sp} />);
    await abrir();
    fireEvent.click(screen.getByText('Probar'));
    await act(async () => {});
    expect(medios.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ video: { deviceId: { ideal: 'c9' } } });
    fireEvent.change(document.querySelectorAll('select')[1], { target: { value: 's1' } });
    fireEvent.change(document.querySelectorAll('select')[1], { target: { value: '' } });
    st.local.setItem = () => { throw new Error('lleno'); };
    medios.mediaDevices.getUserMedia.mockRejectedValue(new Error('sin cámara'));
    fireEvent.click(screen.getByText('Ocultar'));
    fireEvent.click(screen.getByText('Probar'));
    await act(async () => {});
    fireEvent.change(document.querySelectorAll('select')[1], { target: { value: 's1' } });
    fireEvent.click(screen.getByText('Guardar'));
    await act(async () => {});
    st.local.getItem = () => { throw new Error('bloqueado'); };
    const sp2 = crearSpFalso({ audioRef: null });
    render(<Softphone sp={sp2} />);
    fireEvent.click(screen.getAllByTitle('Ajustes de audio y video').at(-1));
    await act(async () => {});
    fireEvent.change(document.querySelectorAll('select')[1], { target: { value: 's1' } });
    fireEvent.click(screen.getByText('Guardar'));
    expect(screen.queryByText('Dispositivos de audio y video')).toBeNull();
    window.HTMLMediaElement.prototype.setSinkId = () => { throw new Error('sync'); };
    fireEvent.click(screen.getAllByTitle('Ajustes de audio y video').at(-1));
    await act(async () => {});
    fireEvent.change(document.querySelectorAll('select')[1], { target: { value: 's1' } });
    fireEvent.click(screen.getByText('Guardar'));
    delete window.HTMLMediaElement.prototype.setSinkId;
  });
});
