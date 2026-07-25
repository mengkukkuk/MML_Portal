import { createTheme } from '@mui/material/styles'

/**
 * muiTheme — bridges MUI v7's palette system to styles/tokens.css.
 *
 * Two layers, because MUI runs alpha()/darken()/augmentColor() over palette
 * values and those color-math parsers throw on `var(--accent)`:
 *   - Literal hex for anything MUI does colour maths on (primary/success/
 *     warning/error, and — discovered the hard way — text.primary/secondary,
 *     since Button's own base styles unconditionally compute
 *     `alpha(theme.palette.text.primary, action.hoverOpacity)` for the
 *     text/outlined hover state, before any styleOverrides ever run). These
 *     must mirror the `cobalt` (default) values in tokens.css. They
 *     intentionally do NOT react to `data-theme` swaps; the `styleOverrides`
 *     below re-assert `var(--accent)` / `var(--fg)` on the specific
 *     components where the visible chrome must track the active faceplate.
 *   - var(--...) only where MUI emits the value verbatim with no color math
 *     (background.default/paper, divider) — these DO react live to
 *     `data-theme` changes on <html>.
 *
 * <StyledEngineProvider injectFirst> (see main.jsx) is required alongside
 * this theme — otherwise emotion's <style> tags are appended after
 * index.css and CssBaseline paints over `body { background: var(--bg-app) }`.
 */
export const muiTheme = createTheme({
  cssVariables: false,
  palette: {
    mode: 'dark',
    primary: { main: '#3aa0ff' },
    success: { main: '#22c55e' },
    warning: { main: '#f59e0b' },
    error: { main: '#ef4444' },
    background: {
      default: 'var(--bg-app)',
      paper: 'var(--bg-panel)',
    },
    text: {
      // Literal hex (cobalt defaults) — see file header. `MuiCssBaseline`
      // below re-asserts `var(--fg)` on <body> so the base text color still
      // tracks `data-theme` swaps via normal CSS cascade/inheritance; only
      // text explicitly styled via `color: 'text.primary'` in sx/styleOverrides
      // (rather than inherited) will stay pinned to the cobalt shade.
      primary: '#e6edf7',
      secondary: '#8a99b3',
    },
    divider: 'var(--border-soft)',
  },
  typography: {
    fontFamily: 'var(--font-sans)',
    fontSize: 14,
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: 'var(--bg-app)',
          color: 'var(--fg)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        containedPrimary: {
          backgroundColor: 'var(--accent)',
          '&:hover': {
            backgroundColor: 'var(--accent)',
            filter: 'brightness(1.08)',
          },
        },
        outlinedPrimary: {
          borderColor: 'var(--accent)',
          color: 'var(--accent)',
        },
        textPrimary: {
          color: 'var(--accent)',
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          '&.Mui-checked': {
            color: 'var(--accent)',
          },
          '&.Mui-checked + .MuiSwitch-track': {
            backgroundColor: 'var(--accent)',
          },
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: {
          backgroundColor: 'var(--accent)',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
  },
})
