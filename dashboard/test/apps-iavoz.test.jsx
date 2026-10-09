/* IA & Voz (/ia-voz): la barra de solapas ordenada por DÓNDE CORRE cada cosa.
 *
 * Se fija que cada solapa monte lo suyo (Agentes, Motor local, Nube, Audios, Logs) y que
 * la insignia de arriba conteste las dos preguntas de todos los días: «¿esto sale a
 * internet y se factura?» (Nube) o «¿corre en mi servidor, sin costo?» (Motor local). */
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderNG } from './helpers/apps-render.jsx';

// Las pantallas de adentro tienen sus propias pruebas; acá importa cuál se monta.
vi.mock('../app/ai-agents/page', () => ({ default: () => <div>pantalla agentes</div> }));
vi.mock('../app/voz/page', () => ({ default: ({ section }) => <div>consola de voz: {section}</div> }));
vi.mock('../app/ProveedoresNube', () => ({ default: () => <div>proveedores nube</div> }));

import IaVoz from '../app/ia-voz/page';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

describe('IA & Voz', () => {
  it('arranca en Agentes y cada solapa monta su pantalla con la insignia que corresponde', () => {
    renderNG(<IaVoz />);
    expect(screen.getByText('pantalla agentes')).toBeTruthy();
    expect(screen.getByText('pbx-ng')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Motor local/ }));
    expect(screen.getByText('consola de voz: local')).toBeTruthy();
    expect(screen.getByText('Corre en tu servidor · sin costo')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Nube/ }));
    expect(screen.getByText('proveedores nube')).toBeTruthy();
    expect(screen.getByText('Sale a internet · se factura')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Audios del sistema/ }));
    expect(screen.getByText('consola de voz: sys')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Logs/ }));
    expect(screen.getByText('consola de voz: logs')).toBeTruthy();
    expect(screen.getByText('pbx-ng')).toBeTruthy();
    // el icono de la solapa activa es el único que se anima
    const activos = [...document.querySelectorAll('[role="tab"] svg.pbxng-ico')].map((s) => s.getAttribute('data-activo'));
    expect(activos).toEqual(['0', '0', '0']);
    fireEvent.click(screen.getByRole('tab', { name: /Agentes/ }));
    expect([...document.querySelectorAll('[role="tab"] svg.pbxng-ico')][0].getAttribute('data-activo')).toBe('1');
  });
});
