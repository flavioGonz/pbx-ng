/* Formateo compartido (`app/fmt.js`). Es lo que el operador LEE en cada tabla: una
 * duración, un tamaño de disco, si un servicio «responde» o «no se pudo comprobar».
 * Se fija acá porque un cambio de redondeo o de color se propaga a todas las pantallas
 * a la vez, y el caso que dio origen a `estadoInfra`/`estadoNodo` fue justamente un
 * verde inventado sobre algo que nadie había medido. */
import { describe, it, expect } from 'vitest';
import {
  fmtDur, fmtReloj, fmtFecha, fmtHora, fmtFechaHora, fmtBytes, fmtPct, fmtUptime,
  fmtInputFechaHora, codecLabel, banderaCC, estadoColor, estadoInfra, estadoNodo, metricasClonadas,
} from '../app/fmt.js';

describe('duraciones', () => {
  it('fmtDur: minutos y segundos, sin negativos ni basura', () => {
    expect(fmtDur(65)).toBe('1m 5s');
    expect(fmtDur(45.9)).toBe('45s');
    expect(fmtDur(-3)).toBe('0s');
    expect(fmtDur('x')).toBe('0s');
    expect(fmtDur(undefined)).toBe('0s');
  });
  it('fmtReloj: MM:SS, H:MM:SS desde la hora y guion si no hay dato', () => {
    expect(fmtReloj(5)).toBe('00:05');
    expect(fmtReloj(3725)).toBe('1:02:05');
    expect(fmtReloj(null)).toBe('—');
    expect(fmtReloj(-1)).toBe('—');
    expect(fmtReloj('abc')).toBe('00:00');
  });
  it('fmtUptime: días, horas y minutos', () => {
    expect(fmtUptime(90061)).toBe('1d 1h 1m');
    expect(fmtUptime(3660)).toBe('1h 1m');
    expect(fmtUptime('nada')).toBe('0h 0m');
    expect(fmtUptime(-50)).toBe('0h 0m');
  });
});

describe('fechas', () => {
  const d = new Date(2026, 8, 8, 14, 5, 32);
  it('aceptan Date, epoch en ms e ISO; lo vacío o inválido es guion', () => {
    expect(fmtFecha(d)).toBe(d.toLocaleDateString('es-UY'));
    expect(fmtFecha(d.getTime())).toBe(d.toLocaleDateString('es-UY'));
    expect(fmtFecha(d.toISOString())).toBe(d.toLocaleDateString('es-UY'));
    expect(fmtFecha(null)).toBe('—');
    expect(fmtFecha('')).toBe('—');
    expect(fmtFecha('no-es-fecha')).toBe('—');
  });
  it('fmtFecha largo trae el mes en letras', () => {
    expect(fmtFecha(d, { largo: true })).toMatch(/setiembre|septiembre/);
  });
  it('fmtHora en 24 h, con o sin segundos', () => {
    expect(fmtHora(d)).toMatch(/^14:05$/);
    expect(fmtHora(d, { segundos: true })).toMatch(/^14:05:32$/);
    expect(fmtHora(undefined)).toBe('—');
  });
  it('fmtFechaHora: día/mes y hora, sin año', () => {
    const t = fmtFechaHora(d);
    expect(t).toMatch(/^0?8\/0?9/);
    expect(t).toContain('14:05');
    expect(t).not.toContain('2026');
    expect(fmtFechaHora('x')).toBe('—');
  });
  it('fmtInputFechaHora: el formato exacto que exige datetime-local, en hora local', () => {
    expect(fmtInputFechaHora(d)).toBe('2026-09-08T14:05');
    expect(fmtInputFechaHora(null)).toBe('');
  });
});

describe('números', () => {
  it('fmtBytes: una decimal debajo de 10, unidades hasta TB y negativos', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(fmtBytes(-2048)).toBe('-2.0 KB');
    expect(fmtBytes(5 * 1024 ** 5)).toBe('5120 TB');
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes('')).toBe('—');
    expect(fmtBytes('abc')).toBe('—');
  });
  it('fmtPct: «no se pudo calcular» no es 0 %', () => {
    expect(fmtPct(0)).toBe('0 %');
    expect(fmtPct(82.5)).toBe('82,5 %');
    expect(fmtPct(1 / 3, { decimales: 2 })).toBe('0,33 %');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct('')).toBe('—');
    expect(fmtPct('x')).toBe('—');
  });
});

describe('etiquetas', () => {
  it('codecLabel: nombre comercial, mayúsculas si es desconocido, guion si no hay', () => {
    expect(codecLabel('ULAW')).toBe('G.711 µ-law');
    expect(codecLabel(' opus ')).toBe('Opus');
    expect(codecLabel('amr')).toBe('AMR');
    expect(codecLabel('')).toBe('—');
    expect(codecLabel(null)).toBe('—');
  });
  it('banderaCC: sólo ISO de dos letras', () => {
    expect(banderaCC('UY')).toBe('https://flagcdn.com/uy.svg');
    expect(banderaCC('ar', { formato: 'png' })).toBe('https://flagcdn.com/ar.png');
    expect(banderaCC('URY')).toBe('');
    expect(banderaCC(null)).toBe('');
  });
  it('estadoColor: los tres vocabularios de la API y un color por defecto', () => {
    expect(estadoColor('Online')).toBe('teal');
    expect(estadoColor('down')).toBe('red');
    expect(estadoColor('sbc')).toBe('grape');
    expect(estadoColor('pending')).toBe('yellow');
    expect(estadoColor('busy')).toBe('orange');
    expect(estadoColor('raro')).toBe('gray');
    expect(estadoColor(undefined, 'blue')).toBe('blue');
  });
});

describe('estadoInfra: interruptor (deseado) contra servicio (corriendo)', () => {
  it('sin medición no se afirma nada', () => {
    expect(estadoInfra({ sondeado: false, deseado: true })).toMatchObject({ color: 'gray', medido: false, texto: 'no se pudo comprobar' });
    expect(estadoInfra({ sondeado: false, deseado: true, motivo: 'sin host' }).detalle).toBe('sin host');
    expect(estadoInfra({ sondeado: false, deseado: false })).toMatchObject({ texto: 'apagado', detalle: '' });
  });
  it('sin sonda: «encendido · no se puede comprobar» o apagado según el interruptor', () => {
    expect(estadoInfra(null, { deseado: true })).toMatchObject({ color: 'gray', medido: false, texto: 'encendido · no se puede comprobar' });
    expect(estadoInfra(undefined)).toMatchObject({ texto: 'apagado', detalle: '' });
  });
  it('lo provee otro servidor: responde o no responde, aunque el interruptor esté en OFF', () => {
    expect(estadoInfra({ local: false, corriendo: true })).toMatchObject({ color: 'teal', texto: 'lo provee otro servidor · responde', detalle: '' });
    expect(estadoInfra({ local: false, corriendo: true, motivo: 'sbc' }).detalle).toBe('sbc');
    expect(estadoInfra({ local: false, corriendo: false })).toMatchObject({ color: 'red', detalle: '' });
    expect(estadoInfra({ local: false, corriendo: false, motivo: 'x' })).toMatchObject({ color: 'red', detalle: 'x' });
  });
  it('encendido y caído es rojo; apagado y corriendo es amarillo', () => {
    expect(estadoInfra({ deseado: true, corriendo: false })).toMatchObject({ color: 'red', texto: 'encendido, pero el servicio no responde', detalle: '' });
    expect(estadoInfra({ deseado: true, corriendo: false, motivo: 'caído' }).detalle).toBe('caído');
    expect(estadoInfra({ deseado: false, corriendo: true }).color).toBe('yellow');
    expect(estadoInfra({ deseado: false, corriendo: true, motivo: 'm' }).detalle).toBe('m');
  });
  it('los dos de acuerdo', () => {
    expect(estadoInfra({ deseado: true, corriendo: true })).toMatchObject({ color: 'teal', texto: 'encendido y respondiendo', detalle: '' });
    expect(estadoInfra({ deseado: true, corriendo: true, motivo: 'ok' }).detalle).toBe('ok');
    expect(estadoInfra({ deseado: false, corriendo: false })).toMatchObject({ color: 'gray', medido: true, texto: 'apagado' });
  });
});

describe('estadoNodo y metricasClonadas', () => {
  it('nodo ausente, sin agente o sin métricas: gris y no medido', () => {
    expect(estadoNodo(null).medido).toBe(false);
    expect(estadoNodo({ ok: false }).detalle).toMatch(/no contestó/);
    expect(estadoNodo({ ok: false, motivo: 'timeout' }).detalle).toBe('timeout');
    expect(estadoNodo({ ok: true }).texto).toBe('respondió, pero sin datos');
  });
  it('con cualquier métrica, o con disco, está en línea', () => {
    expect(estadoNodo({ cpu_pct: 3 })).toMatchObject({ color: 'teal', medido: true });
    expect(estadoNodo({ disk: { pct: 1 } }).texto).toBe('en línea');
  });
  it('detecta nodos que reportan la misma máquina física y deja afuera los incompletos', () => {
    const firma = { mem_total_mb: 35000, ncpu: 12, uptime_s: 999 };
    const r = metricasClonadas([
      { id: 'a', name: 'A', ...firma }, { id: 'b', name: 'B', ...firma },
      { id: 'c', name: 'C', mem_total_mb: 1, ncpu: 1, uptime_s: 2 },
      { id: 'd', ok: false, ...firma }, { id: 'e', mem_total_mb: 1 }, null,
    ]);
    expect(r.grupos).toHaveLength(1);
    expect(r.grupos[0].nodos.map((n) => n.id)).toEqual(['a', 'b']);
    expect([...r.ids]).toEqual(['a', 'b']);
    expect(metricasClonadas().grupos).toEqual([]);
  });
});
