'use client';
import { SlotText } from 'slot-text/react';

export default function Slot({ value, options, style, ...rest }) {
  const t = value == null ? '' : String(value);
  return <SlotText text={t} options={options} style={{ display: 'inline-flex', ...style }} {...rest} />;
}
