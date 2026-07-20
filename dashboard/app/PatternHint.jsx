'use client';
/* PatternHint - el patron de marcado de Asterisk explicado en criollo, al pasar el mouse.
   Un "_0X." no le dice nada a nadie: esto lo traduce a "marca 0 y despues el numero", muestra
   que significa cada simbolo y da ejemplos de numeros que caen (y que no caen) en la ruta. */
import { HoverCard, Badge, Text, Group, Stack, Divider, Code, ThemeIcon } from '@mantine/core';
import { IconAsterisk, IconCheck, IconX } from '@tabler/icons-react';

const SIMBOLOS = {
  X: { que: 'un dígito', de: '0 a 9' },
  Z: { que: 'un dígito', de: '1 a 9 (no puede ser 0)' },
  N: { que: 'un dígito', de: '2 a 9' },
  '.': { que: 'uno o más caracteres', de: 'cualquier cosa, hasta el final' },
  '!': { que: 'cero o más caracteres', de: 'marca ya, sin esperar más dígitos' },
};

// Descompone el patron en tokens legibles.
function tokens(p) {
  const t = []; let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '[') {
      const fin = p.indexOf(']', i);
      const set = p.slice(i + 1, fin < 0 ? p.length : fin);
      t.push({ sim: '[' + set + ']', que: 'un dígito', de: 'sólo ' + set.split('').join(', ') });
      i = fin < 0 ? p.length : fin + 1;
    } else if (SIMBOLOS[c.toUpperCase()]) {
      t.push({ sim: c.toUpperCase(), ...SIMBOLOS[c.toUpperCase()] });
      i++;
    } else {
      // digitos literales seguidos
      let lit = '';
      while (i < p.length && !SIMBOLOS[p[i].toUpperCase()] && p[i] !== '[') { lit += p[i]; i++; }
      if (lit) t.push({ sim: lit, que: 'literal', de: 'hay que marcar exactamente ' + lit });
    }
  }
  return t;
}

// Un ejemplo de numero que hace match.
function ejemplo(p) {
  let out = '', i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '[') { const fin = p.indexOf(']', i); out += (p[i + 1] || '5'); i = fin < 0 ? p.length : fin + 1; continue; }
    const u = c.toUpperCase();
    if (u === 'X') out += '4';
    else if (u === 'Z') out += '9';
    else if (u === 'N') out += '6';
    else if (u === '.') out += '12345';
    else if (u === '!') out += '';
    else out += c;
    i++;
  }
  return out;
}

function resumen(p, strip, prepend) {
  const t = tokens(p);
  const lit = t[0] && t[0].que === 'literal' ? t[0].sim : null;
  let s = lit
    ? `Cae en esta ruta todo lo que empiece con ${lit}`
    : 'Cae en esta ruta todo lo que coincida con el patrón';
  const fijos = t.filter(x => x.que === 'un dígito').length;
  if (fijos) s += `, seguido de ${fijos} dígito${fijos > 1 ? 's' : ''}`;
  if (p.includes('.')) s += ' y el resto del número';
  s += '.';
  if (Number(strip) > 0) s += ` Antes de salir se le quitan los primeros ${strip} dígito${strip > 1 ? 's' : ''}.`;
  if (prepend) s += ` Y se le antepone ${prepend}.`;
  return s;
}

export default function PatternHint({ pattern, strip, prepend, color = 'pbx' }) {
  const p = String(pattern || '').replace(/^_/, '');
  if (!p) return <Text c="dimmed">—</Text>;
  const t = tokens(p);
  const ej = ejemplo(p);
  const salida = (() => {
    let n = ej;
    if (Number(strip) > 0) n = n.slice(Number(strip));
    if (prepend) n = String(prepend) + n;
    return n;
  })();

  return (
    <HoverCard width={370} shadow="lg" radius="md" openDelay={120} closeDelay={80} withArrow position="right"
      transitionProps={{ transition: 'pop', duration: 190, timingFunction: 'cubic-bezier(.2,.9,.3,1.2)' }}>
      <HoverCard.Target>
        <Badge variant="light" color={color} ff="monospace" style={{ cursor: 'help' }}>_{p}</Badge>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap={9}>
          <Group gap={7} wrap="nowrap">
            <ThemeIcon size={26} radius="md" variant="light" color={color}><IconAsterisk size={15} /></ThemeIcon>
            <div>
              <Text fw={700} size="sm" ff="monospace">_{p}</Text>
              <Text size="xs" c="dimmed">Patrón de marcado</Text>
            </div>
          </Group>
          <Text size="xs">{resumen(p, strip, prepend)}</Text>
          <Divider />
          <Stack gap={4}>
            {t.map((x, i) => (
              <Group key={i} gap={8} wrap="nowrap">
                <Code style={{ minWidth: 34, textAlign: 'center' }}>{x.sim}</Code>
                <Text size="xs" c="dimmed"><b style={{ color: 'var(--mantine-color-text)' }}>{x.que}</b> — {x.de}</Text>
              </Group>
            ))}
          </Stack>
          <Divider />
          <Group gap={8} wrap="nowrap">
            <ThemeIcon size={20} radius="xl" variant="light" color="teal"><IconCheck size={12} /></ThemeIcon>
            <Text size="xs">Si marcan <Code>{ej}</Code>, sale por acá {salida !== ej ? <>como <Code>{salida}</Code></> : 'tal cual'}.</Text>
          </Group>
          <Group gap={8} wrap="nowrap">
            <ThemeIcon size={20} radius="xl" variant="light" color="red"><IconX size={12} /></ThemeIcon>
            <Text size="xs" c="dimmed">Lo que no coincida con el patrón busca otra ruta; si no hay ninguna, la llamada falla.</Text>
          </Group>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
