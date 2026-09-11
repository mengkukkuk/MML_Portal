import { createTheme } from '@mui/material/styles'

/**
 * buildMuiTheme — bridges MUI v7's palette system to styles/tokens.css.
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
 *     thrown on `var(...)` by then. These intentionally do NOT track the
 *     *specific* faceplate (cobalt vs graphite vs carbon all render MUI's
 *     own chrome with the same dark-mode literals) — the `styleOverrides`
 *     below re-assert `var(--accent)` / `var(--fg)` / `var(--border-soft)`
 *     on the components where visible chrome must track the active
 *     faceplate exactly.
 *   - var(--...) only where MUI emits the value verbatim with no color math
 *     (background.default/paper) — these DO react live to `data-theme`
 *     changes on <html>.
 *
 * `mode` ('dark' | 'light') is the one thing that *does* have to track the
 * active faceplate: MUI's `palette.mode` drives its own internal defaults
 * (action hover/disabled overlays, elevation overlays, Backdrop, focus
 * rings) independently of every field listed above, and light-mode text
 * literals rendered under `mode: 'dark'` — or vice versa — would compute
 * hover/disabled states for the wrong background. `main.jsx` re-derives this
 * theme (memoized) whenever the settings store's `theme.mode` changes.
 *
 * <StyledEngineProvider injectFirst> (see main.jsx) is required alongside
 * this theme — otherwise emotion's <style> tags are appended after
 * index.css and CssBaseline paints over `body { background: var(--bg-app) }`.
 */
const LITERALS = {
  dark: {
    // Mirrors the `cobalt` block in tokens.css.
    primary: '#3aa0ff',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
    textPrimary: '#e6edf7',
    textSecondary: '#8a99b3',
    divider: 'rgba(255, 255, 255, 0.06)',
  },
  light: {
    // Mirrors the `paper` block in tokens.css.
    primary: '#2b5c8a',
    success: '#2e7d5b',
    warning: '#b8810f',
    error: '#be3b2b',
    textPrimary: '#161d21',
    textSecondary: '#5c686e',
    divider: 'rgba(22, 29, 33, 0.08)',
  },
}

export function buildMuiTheme(mode = 'dark') {
  const L = LITERALS[mode] ?? LITERALS.dark
  return createTheme({
    cssVariables: false,
    palette: {
      mode,
      primary: { main: L.primary },
      success: { main: L.success },
      warning: { main: L.warning },
      error: { main: L.error },
      background: {
        default: 'var(--bg-app)',
        paper: 'var(--bg-panel)',
      },
      text: {
        // Literal hex (see file header). `MuiCssBaseline` below re-asserts
        // `var(--fg)` on <body> so the base text color still tracks
        // `data-theme` swaps via normal CSS cascade/inheritance; only text
        // explicitly styled via `color: 'text.primary'` in sx/styleOverrides
        // (rather than inherited) stays pinned to this mode's literal shade.
        primary: L.textPrimary,
        secondary: L.textSecondary,
      },
      // Literal hex (see file header). `MuiTableCell` below re-asserts
      // `var(--border-soft)` so visible borders still track `data-theme`
      // swaps.
      divider: L.divider,
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
}
