'use client';
/* ============================================================================
 *  PBX-NG · Paginado de listas largas
 *
 *  POR QUÉ EXISTE: las pantallas del panel pintan la lista completa que llega en
 *  el snapshot del socket. Con 20 internos eso no se nota; con 540 —una central
 *  real, migrada de una Issabel— el navegador tiene que crear miles de nodos en
 *  cada refresco del snapshot (y el snapshot llega solo, cada pocos segundos),
 *  así que la pantalla tarda en aparecer, el scroll salta y escribir en el
 *  buscador se siente pegajoso. No es la central: es la tabla.
 *
 *  La solución es cortar lo que se PINTA, no lo que se filtra: los contadores,
 *  los KPI y la búsqueda siguen mirando la lista entera, y la tabla muestra una
 *  página. Así «3 en llamada» sigue diciendo la verdad aunque esos tres estén en
 *  la página 7.
 *
 *  Se resuelve en el cliente a propósito: la lista ya está en memoria (viene del
 *  snapshot, que es la fuente de verdad del estado en vivo). Paginar en el
 *  servidor obligaría a pedir cada página por HTTP y perdería el tiempo real,
 *  que es justamente lo que hace útil esta pantalla.
 *
 *  Uso:
 *    const pg = usePaginar(filtrados, { clave: filtro + '|' + q });
 *    ...
 *    {pg.visibles.map(...)}
 *    <Paginar pg={pg} rotulo="internos" />
 * ==========================================================================*/
import { useState, useMemo, useEffect } from 'react';
import { Group, Text, Select, Pagination } from '@mantine/core';

/* Umbral por debajo del cual no se pagina nada: una central chica no tiene por
 * qué ver controles que no necesita. */
export const SIN_PAGINAR = 60;

const TAMANOS = ['25', '50', '100', '250', 'todos'];

export function usePaginar(items, { porPaginaInicial = 50, clave = '' } = {}) {
  const lista = Array.isArray(items) ? items : [];
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState(String(porPaginaInicial));

  /* Cambió el filtro o el texto buscado → volver a la primera página. Sin esto,
   * buscar algo estando en la página 7 muestra una tabla vacía y parece que el
   * buscador no encuentra nada. */
  useEffect(() => { setPagina(1); }, [clave]);

  const todos = porPagina === 'todos';
  const tam = todos ? (lista.length || 1) : Number(porPagina);
  const totalPaginas = Math.max(1, Math.ceil(lista.length / tam));

  /* La lista se encoge sola (alguien borró un interno, o el filtro dejó menos
   * elementos): si la página actual ya no existe, caer a la última que sí. */
  const act = Math.min(pagina, totalPaginas);
  useEffect(() => { if (act !== pagina) setPagina(act); }, [act, pagina]);

  const visibles = useMemo(
    () => (todos ? lista : lista.slice((act - 1) * tam, act * tam)),
    [lista, act, tam, todos]);

  return {
    pagina: act, setPagina, porPagina, setPorPagina, totalPaginas,
    visibles, total: lista.length,
    desde: lista.length === 0 ? 0 : (act - 1) * tam + 1,
    hasta: todos ? lista.length : Math.min(act * tam, lista.length),
  };
}

export default function Paginar({ pg, rotulo = 'filas', minimo = SIN_PAGINAR }) {
  if (!pg || pg.total <= minimo) return null;
  return (
    <Group justify="space-between" mt="md" wrap="wrap" gap="sm">
      <Text size="sm" c="dimmed">{pg.desde}–{pg.hasta} de {pg.total} {rotulo}</Text>
      <Group gap="sm" wrap="nowrap">
        <Select size="xs" w={118} aria-label={'Cuántos ' + rotulo + ' por página'}
          value={pg.porPagina} onChange={(v) => { if (v) { pg.setPorPagina(v); pg.setPagina(1); } }}
          data={TAMANOS.map(t => ({ value: t, label: t === 'todos' ? 'Todos' : t + ' por pág.' }))}
          comboboxProps={{ withinPortal: true }} allowDeselect={false} />
        {pg.totalPaginas > 1 && (
          <Pagination size="sm" color="pbx" withEdges
            total={pg.totalPaginas} value={pg.pagina} onChange={pg.setPagina} />
        )}
      </Group>
    </Group>
  );
}
