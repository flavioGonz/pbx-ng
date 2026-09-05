'use client';
/* Notificaciones de PBX-NG — una sola puerta de entrada para toda la app.
 *
 * Por debajo usa sileo (toasts con fisica), y le pone nuestra iconografia SVG animada.
 * La firma vieja toast(mensaje, tipo, opts) se mantiene tal cual: las ~155 llamadas que
 * ya existen siguen funcionando, pero ahora todas salen con el mismo estilo.
 *
 *   toast('Cola guardada', 'ok')
 *   toast('No se pudo guardar', 'bad', { description: e.message })
 *   notifyCall({ state: 'ring', from: '2001', to: '1001' })
 */
import { sileo } from 'sileo';
import { createElement } from 'react';
import NotifyIcon, { COLORS } from './NotifyIcons';

/* El `fill` de sileo es el FONDO del toast. Antes le pasábamos el color del estado
 * (verde, rojo…) y sileo pinta el título con ese mismo color: texto verde sobre fondo
 * verde, ilegible. El fondo ahora sigue al tema del panel (oscuro/claro) y el color del
 * estado queda para el título, el icono y la barra, que es donde se lee. */
export function toastFill() {
  try {
    const dark = document.documentElement.getAttribute('data-mantine-color-scheme') !== 'light';
    return dark ? '#161d2c' : '#ffffff';
  } catch (_) { return '#161d2c'; }
}

// tipos viejos -> estados de sileo
const MAP = { ok: 'success', bad: 'error', error: 'error', warn: 'warning', info: 'info', action: 'action', load: 'loading' };
const KIND = { success: 'success', error: 'error', warning: 'warning', info: 'info', action: 'action', loading: 'loading' };

export function toast(message, type = 'ok', opts = {}) {
  if (typeof window === 'undefined') return;
  const state = MAP[type] || (KIND[type] ? type : 'info');
  const kind = opts.icon || state;
  const o = {
    title: message,
    description: opts.description || opts.desc,
    type: state === 'loading' ? 'loading' : state,
    position: opts.position || 'top-center',
    duration: opts.duration === undefined ? (state === 'error' ? 5200 : 3400) : opts.duration,
    icon: createElement(NotifyIcon, { kind }),
    fill: toastFill(),
    roundness: 14,
    button: opts.button,
  };
  const fn = sileo[state] || sileo.info;
  return fn(o);
}

/* Eventos de telefonia: mismo estilo, icono propio y color propio.
   state: ring | talking | waiting | hangup | agent | security  */
export function notifyCall({ state = 'ring', from, to, detail, duration }) {
  const T = {
    ring:     { t: 'Llamada entrante', d: `${from || '?'} → ${to || '?'}`, s: 'info' },
    talking:  { t: 'En conversación',  d: `${from || '?'} ↔ ${to || '?'}`, s: 'success' },
    waiting:  { t: 'En espera',        d: `${from || '?'} esperando en cola`, s: 'warning' },
    hangup:   { t: 'Llamada finalizada', d: `${from || '?'} → ${to || '?'}`, s: 'info' },
    agent:    { t: 'Agente', d: detail || '', s: 'info' },
    security: { t: 'Seguridad', d: detail || '', s: 'error' },
  }[state] || { t: 'Evento', d: detail || '', s: 'info' };

  return sileo[T.s]({
    title: T.t,
    description: detail || T.d,
    type: T.s,
    position: 'top-center',
    duration: duration === undefined ? 4200 : duration,
    icon: createElement(NotifyIcon, { kind: state }),
    fill: toastFill(),
    roundness: 14,
  });
}

// Para operaciones largas: un solo toast que pasa de "cargando" a "listo" o "falló".
export function toastPromise(promise, { loading, success, error }) {
  return sileo.promise(promise, {
    loading: { title: loading, type: 'loading', icon: createElement(NotifyIcon, { kind: 'loading' }), fill: toastFill() },
    success: (d) => ({ title: typeof success === 'function' ? success(d) : success, type: 'success', icon: createElement(NotifyIcon, { kind: 'success' }), fill: toastFill() }),
    error: (e) => ({ title: typeof error === 'function' ? error(e) : error, description: String((e && e.message) || ''), type: 'error', icon: createElement(NotifyIcon, { kind: 'error' }), fill: toastFill() }),
    position: 'top-center',
  });
}

export const dismiss = (id) => sileo.dismiss(id);
