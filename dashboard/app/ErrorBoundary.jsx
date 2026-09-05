'use client';
/* Red de contención para errores de render dentro de una pantalla.
 *
 * Sin esto, un `undefined.map` en cualquier página tira abajo TODO el árbol de React
 * (menú incluido) y el usuario queda frente a una pantalla en blanco sin poder ir a
 * otra sección. Envolviendo sólo el contenido del shell, el menú sigue vivo y se puede
 * navegar o recargar. Tiene que ser class component: React todavía no expone
 * `componentDidCatch` para funciones. */
import { Component } from 'react';
import { Card, Stack, Group, Text, Button, Code, ThemeIcon } from '@mantine/core';
import { IconBug, IconRefresh } from '@tabler/icons-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // La consola es el único rastro que queda: acá no hay logger de frontend.
    try { console.error('[pbxng] error de render:', error, info && info.componentStack); } catch (_) {}
  }

  componentDidUpdate(prev) {
    /* Al cambiar de ruta (el shell nos pasa `resetKey` = pathname) se vuelve a intentar
     * el render: el error era de UNA pantalla, no hay motivo para seguir mostrándolo en
     * la siguiente. */
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const msg = (error && (error.message || String(error))) || 'Error desconocido';
    return (
      <Card withBorder radius="md" p="lg" maw={640} mx="auto" mt="xl">
        <Stack gap="sm">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={40} radius="md" variant="light" color="red"><IconBug size={22} /></ThemeIcon>
            <div>
              <Text fw={700}>Algo se rompió en esta pantalla</Text>
              <Text fz="sm" c="dimmed">El resto del panel sigue funcionando. Podés recargar o ir a otra sección desde el menú.</Text>
            </div>
          </Group>
          <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg}</Code>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => this.setState({ error: null })}>Reintentar</Button>
            <Button leftSection={<IconRefresh size={16} />} onClick={() => { try { location.reload(); } catch (_) {} }}>Recargar</Button>
          </Group>
        </Stack>
      </Card>
    );
  }
}
