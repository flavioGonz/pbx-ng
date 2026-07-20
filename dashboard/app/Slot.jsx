'use client';
import { useEffect, useState } from 'react';
import { SlotText } from 'slot-text/react';

// SlotText anima cada digito y produce un DOM distinto del que genera el prerender del
// servidor -> React tira "hydration mismatch" (errores #418 / #423). Por eso en el primer
// render (el que React compara contra el HTML del servidor) mostramos texto plano y recien
// despues de montar en el navegador pasamos al componente animado.
export default function Slot({ value, options, style, ...rest }) {
  const t = value == null ? '' : String(value);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span style={{ display: 'inline-flex', ...style }} {...rest}>{t}</span>;
  return <SlotText text={t} options={options} style={{ display: 'inline-flex', ...style }} {...rest} />;
}
