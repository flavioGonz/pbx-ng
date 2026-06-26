'use client';
// Notificaciones top-center animadas (Toaster propio). API: toast(message, type, opts)
export function toast(message, type = 'ok', opts = {}) {
  if (typeof window === 'undefined') return;
  const id = Math.random().toString(36).slice(2);
  const { description, duration } = opts;
  window.dispatchEvent(new CustomEvent('pbx:toast', { detail: { id, message, type, desc: description, duration } }));
  return id;
}
