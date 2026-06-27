'use client';
import { createTheme } from '@mantine/core';

export const theme = createTheme({
  primaryColor: 'pbx',
  primaryShade: 5,
  defaultRadius: 'md',
  fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  fontFamilyMonospace: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
  headings: { fontFamily: 'Inter, system-ui, sans-serif', fontWeight: '700' },
  colors: {
    pbx: ['#e9f2ff', '#cfe0fb', '#9dbef3', '#6a9aec', '#437fe6', '#2f74e6', '#1f63d8', '#1750c2', '#0f3f9e', '#06306f'],
    dark: ['#e8ebf0', '#c2c9d6', '#8b94a3', '#5e6776', '#3a4150', '#262d3a', '#161d28', '#0d1117', '#090d14', '#05080d'],
    slate: ['#f6f8fc', '#eef1f7', '#dfe4ee', '#c7cede', '#9aa4ba', '#6b7691', '#505b76', '#3c465c', '#2a3346', '#1b2233'],
  },
  components: {
    Modal: { defaultProps: { radius: 'lg', centered: true, size: 'lg', overlayProps: { blur: 3, backgroundOpacity: 0.5 } } },
    Card: {
      defaultProps: { withBorder: true, radius: 'lg' },
      styles: { root: { background: 'light-dark(#ffffff, #161d28)', borderColor: 'light-dark(#e6eaf2, rgba(120,130,150,.14))', boxShadow: 'none' } },
    },
    Paper: { styles: { root: { background: 'light-dark(#ffffff, #161d28)', borderColor: 'light-dark(#e6eaf2, rgba(120,130,150,.14))' } } },
    Badge: { defaultProps: { radius: 'xl' } },
    Button: { defaultProps: { radius: 'md' } },
    ActionIcon: { defaultProps: { radius: 'md' } },
    ThemeIcon: { defaultProps: { radius: 'md' } },
    Tooltip: {
      defaultProps: { withArrow: true, color: 'dark.6', radius: 'md', openDelay: 180, transitionProps: { transition: 'pop', duration: 140 } },
      styles: { tooltip: { fontSize: 12, fontWeight: 500, padding: '6px 10px', border: '1px solid rgba(120,130,150,.3)' } },
    },
    Table: { styles: { th: { color: 'light-dark(var(--mantine-color-slate-6), var(--mantine-color-dark-2))', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' } } },
    Modal: { defaultProps: { radius: 'lg', overlayProps: { blur: 6, backgroundOpacity: 0.5 } } },
    Tabs: { styles: { tab: { fontWeight: 600 } } },
  },
});
