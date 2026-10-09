/* React Flow de mentira para jsdom (el real mide el DOM y pide ResizeObserver de verdad).
 * Pinta cada nodo con su `nodeTypes[tipo]` dentro de un botón «nodo <id>» para poder
 * simular el clic sobre un nodo, y deja botones para el clic en el lienzo y para conectar. */
import { useState } from 'react';

export function ReactFlow({ nodes = [], edges = [], nodeTypes = {}, onNodeClick, onPaneClick, onConnect, onNodesChange, onEdgesChange, children }) {
  return (
    <div data-testid="flow">
      {nodes.map((n) => {
        const T = nodeTypes[n.type];
        return (
          <div key={n.id} role="button" aria-label={'nodo ' + n.id} onClick={(e) => onNodeClick && onNodeClick(e, n)}>
            {T ? <T id={n.id} data={n.data} selected={false} /> : null}
          </div>
        );
      })}
      <div data-testid="aristas">{edges.map((e) => <span key={e.id} data-testid={'arista-' + e.id}>{e.source}→{e.target}:{String(e.label ?? '')}</span>)}</div>
      <button type="button" onClick={() => onPaneClick && onPaneClick()}>lienzo</button>
      <button type="button" onClick={() => onConnect && onConnect({ source: 'entry', target: 'zz' })}>conectar</button>
      <button type="button" onClick={() => { onNodesChange && onNodesChange([]); onEdgesChange && onEdgesChange([]); }}>cambios</button>
      {children}
    </div>
  );
}
export const Background = () => null;
export const Controls = () => null;
export const MiniMap = () => null;
export const Handle = () => null;
export const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' };
export const MarkerType = { ArrowClosed: 'arrowclosed', Arrow: 'arrow' };
export const ReactFlowProvider = ({ children }) => children;
export function useNodesState(inicial) { const [v, set] = useState(inicial); return [v, set, () => {}]; }
export function useEdgesState(inicial) { const [v, set] = useState(inicial); return [v, set, () => {}]; }
export const addEdge = (e, es) => [...es, { id: 'e-' + e.source + '-' + e.target, ...e }];
export const applyNodeChanges = (c, ns) => ns;
export const applyEdgeChanges = (c, es) => es;
export const useReactFlow = () => ({ fitView() {}, screenToFlowPosition: (p) => p });
