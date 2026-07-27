import { createTheme } from '@mui/material/styles'

/**
 * muiTheme — bridges MUI v7's palette system to styles/tokens.css.
 *
 * Two layers, because MUI runs alpha()/darken()/augmentColor() over palette
 * values and those color-math parsers throw on `var(--accent)`:
 *   - Literal hex for anything MUI does colour maths on (primary/success/
 *     warning/error, text.primary/secondary — since Button's own base styles
 *     unconditionally compute `alpha(theme.palette.text.primary,
 *     action.hoverOpacity)` for the text/outlined hover state — and divider,
 *     since TableCell's own base styles unconditionally compute
 *     `darken(alpha(theme.palette.divider, 1), 0.68)` for its border. In all
 *     three cases the color-math runs while the base style FUNCTION is being
 *     evaluated, before any styleOverrides are merged in, so overriding the
 *     resulting CSS property doesn't help — decomposeColor() has already
 *     thrown on `var(...)` by then. These must mirror the `cobalt` (default)
 *     values in tokens.css. They intentionally do NOT react to `data-theme`
 *     swaps; the `styleOverrides` below re-assert `var(--accent)` /
 *     `var(--fg)` / `var(--border-soft)` on the specific components where the
 *     visible chrome must track the active faceplate.
 *   - var(--...) only where MUI emits the value verbatim with no color math
 *     (background.default/paper) — these DO react live to `data-theme`
 *     changes on <html>.
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
    // Literal hex (cobalt default) — see file header. `MuiTableCell` below
    // re-asserts `var(--border-soft)` so visible borders still track
    // `data-theme` swaps.
    divider: 'rgba(255, 255, 255, 0.06)',
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
    MuiTableCell: {
      styleOverrides: {
        root: {
          // TableCell's own base styles unconditionally run
          // darken(alpha(theme.palette.divider, 1), ...) to compute this
          // border — alpha()/darken() throw on a raw `var(--border-soft)`
          // string. Re-assert the var literally, same workaround as
          // MuiButton/MuiSwitch/MuiTabs above.
          borderBottom: '1px solid var(--border-soft)',
        },
      },
    },
  },
})
