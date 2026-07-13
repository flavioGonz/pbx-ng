import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { hydrateSecure } from './config.js';

// Muestra el error en pantalla en vez de dejar todo en blanco (facilita el soporte)
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { try { console.error('[app] crash', err, info); } catch (_) {} }
  render() {
    if (this.state.err) {
      return (
        <div style={{ fontFamily: 'Segoe UI, system-ui, sans-serif', padding: 24, color: '#0b1220' }}>
          <h2 style={{ color: '#ef4444', margin: '0 0 8px' }}>Ocurrió un error en la app</h2>
          <div style={{ fontSize: 13, color: '#667089', marginBottom: 12 }}>Copiá esto para diagnóstico:</div>
          <pre style={{ background: '#0f1a30', color: '#a9c2ea', padding: 14, borderRadius: 10, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{String(this.state.err && (this.state.err.stack || this.state.err.message || this.state.err))}</pre>
          <button onClick={() => location.reload()} style={{ marginTop: 14, background: '#2f80ff', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', cursor: 'pointer' }}>Reiniciar</button>
        </div>
      );
    }
    return this.props.children;
  }
}

try {
  window.addEventListener('error', (e) => { try { console.error('[app] window.error', e.error || e.message); } catch (_) {} });
  window.addEventListener('unhandledrejection', (e) => { try { console.error('[app] unhandledrejection', e.reason); } catch (_) {} });
} catch (_) {}

hydrateSecure().finally(() => { createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>); });
