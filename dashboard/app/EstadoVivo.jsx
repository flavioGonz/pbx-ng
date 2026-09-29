'use client';
/* ============================================================================
 *  La insignia de estado de un interno, EN VIVO.
 *
 *  Dos cosas que llegan por caminos distintos y no hay que confundir:
 *    · el REGISTRO (`e.status` del snapshot): ¿el aparato está conectado a la central?
 *    · la ACTIVIDAD (`st.act` del carril rápido): ¿qué está haciendo ahora mismo?
 *  Un interno sin registrar no tiene actividad que mostrar, y por eso «Desconectado»
 *  gana siempre.
 *
 *  Y aparte están las MARCAS —DND, pausa de agente, desvío—, que no son un estado sino
 *  algo puesto encima: se puede estar en llamada Y pausado, o libre Y con DND. Por eso
 *  van como insignias chicas al lado y no reemplazan a la principal. La única excepción
 *  es cuando el interno está libre: ahí la marca ES la noticia («Pausado» dice más que
 *  «Registrado») y se muestra como principal.
 * ==========================================================================*/
import { Badge, Group, Tooltip } from '@mantine/core';
import { IconMoonOff, IconPlayerPause, IconArrowForward } from '@tabler/icons-react';

/* Un solo <style> para toda la app: el punto que late cuando algo está timbrando. */
const LATIDO = `@keyframes pbxng-latido { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.65); opacity: .45 } }`;
export function EstiloLatido() { return <style>{LATIDO}</style>; }

const ACT = {
  en_llamada: { txt: 'En llamada', col: 'orange', dot: '#f59e0b' },
  en_llamada_timbrando: { txt: 'En llamada + otra', col: 'orange', dot: '#f59e0b' },
  timbrando: { txt: 'Timbrando', col: 'blue', dot: '#3b82f6', late: true },
  en_espera: { txt: 'En espera', col: 'violet', dot: '#8b5cf6' },
  libre: { txt: 'Registrado', col: 'teal', dot: '#22c55e' },
  desconectado: { txt: 'Desconectado', col: 'gray', dot: '#9aa3b2' },
};
const DESVIO = { incondicional: 'Desviado siempre', ocupado: 'Desviado si ocupado', sin_respuesta: 'Desviado si no atiende', sigueme: 'Sígueme' };

const Punto = ({ color, late }) => (
  <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color,
    animation: late ? 'pbxng-latido 1s ease-in-out infinite' : undefined }} />
);

/* Qué estado mostrar, resuelto en un solo lugar para que la tabla, el cajón y los
 * contadores de arriba no puedan decir cosas distintas del mismo interno. */
export function resolverEstado(e, st) {
  const registrado = e && (e.status === 'online' || e.status === 'in_call');
  const act = !registrado ? 'desconectado' : ((st && st.act) || (e && e.channels > 0 ? 'en_llamada' : 'libre'));
  const enLlamada = act === 'en_llamada' || act === 'en_llamada_timbrando' || act === 'en_espera';
  return {
    registrado, act, enLlamada,
    timbrando: act === 'timbrando',
    dnd: !!(registrado && st && st.dnd),
    pausa: !!(registrado && st && st.pausa),
    pausaMotivo: (st && st.pausa_motivo) || '',
    desvio: registrado && st && st.desvio ? st.desvio : null,
    desvioA: (st && st.desvio_a) || null,
    colas: (st && st.colas) || [],
  };
}

export default function EstadoVivo({ e, st, size = 'sm' }) {
  const r = resolverEstado(e, st);
  /* Con el interno libre, la marca manda: «Pausado» o «No molestar» es lo que alguien
   * necesita ver de un vistazo; «Registrado» no aporta nada al lado de eso. */
  let principal = ACT[r.act] || ACT.desconectado;
  let ayuda = null;
  if (r.act === 'libre') {
    if (r.dnd) { principal = { txt: 'No molestar', col: 'red', dot: '#ef4444' }; ayuda = 'El interno rechaza las llamadas entrantes (DND).'; }
    else if (r.pausa) { principal = { txt: 'Pausado', col: 'yellow', dot: '#eab308' }; ayuda = 'Pausado en sus colas' + (r.pausaMotivo ? ' · ' + r.pausaMotivo : '') + (r.colas.length ? ' (' + r.colas.join(', ') + ')' : '') + '. Sigue pudiendo recibir llamadas directas.'; }
    else if (r.desvio) { principal = { txt: DESVIO[r.desvio] || 'Desviado', col: 'cyan', dot: '#06b6d4' }; ayuda = 'Las llamadas van a ' + (r.desvioA || '?') + '.'; }
  }
  const marcas = [];
  if (r.act !== 'libre' && r.registrado) {
    if (r.dnd) marcas.push(<Tooltip key="dnd" label="No molestar puesto" withArrow><Badge size="xs" variant="light" color="red" leftSection={<IconMoonOff size={10} />}>DND</Badge></Tooltip>);
    if (r.pausa) marcas.push(<Tooltip key="p" label={'Pausado en sus colas' + (r.pausaMotivo ? ' · ' + r.pausaMotivo : '')} withArrow><Badge size="xs" variant="light" color="yellow" leftSection={<IconPlayerPause size={10} />}>Pausa</Badge></Tooltip>);
    if (r.desvio) marcas.push(<Tooltip key="d" label={(DESVIO[r.desvio] || 'Desviado') + ' a ' + (r.desvioA || '?')} withArrow><Badge size="xs" variant="light" color="cyan" leftSection={<IconArrowForward size={10} />}>{r.desvioA || 'desvío'}</Badge></Tooltip>);
  }
  const insignia = (
    <Badge size={size} variant="light" color={principal.col} leftSection={<Punto color={principal.dot} late={principal.late} />}
      style={ayuda ? { cursor: 'help' } : undefined}>{principal.txt}</Badge>
  );
  return (
    <Group gap={6} wrap="nowrap">
      {ayuda ? <Tooltip label={ayuda} withArrow multiline w={250}>{insignia}</Tooltip> : insignia}
      {marcas}
    </Group>
  );
}

/* Lo mismo en una línea de texto, para donde no entra una insignia. */
export function textoEstado(e, st) {
  const r = resolverEstado(e, st);
  if (!r.registrado) return 'Desconectado';
  const base = (ACT[r.act] || ACT.libre).txt;
  const extra = [r.dnd ? 'DND' : null, r.pausa ? 'pausado' : null, r.desvio ? 'desvío a ' + (r.desvioA || '?') : null].filter(Boolean);
  return extra.length ? base + ' · ' + extra.join(' · ') : base;
}
