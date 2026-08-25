// Reflect the persisted theme before first paint to avoid a flash of the
// default palette. This must run before createRoot/render — moving it into
// a useEffect causes a visible flash of the cobalt theme, made worse by the
// 0.35s body background-color transition in styles/tokens.css.
const savedTheme = localStorage.getItem('mml.theme') || 'cobalt'
document.documentElement.dataset.theme = savedTheme

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'

// react-grid-layout / react-resizable stylesheets must be imported before
// ./styles/index.css or the resize grip is invisible. Not used until
// Phase 6 (LivePage), but the import order matters from the start so it's
// never forgotten later.
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import './fonts.css'
import './styles/index.css'

import { queryClient } from './lib/queryClient'
import { muiTheme } from './theme/muiTheme'
import App from './App.jsx'

createRoot(document.getElementById('app')).render(
  <StrictMode>
    <StyledEngineProvider injectFirst>
      <ThemeProvider theme={muiTheme}>
        <CssBaseline />
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </ThemeProvider>
    </StyledEngineProvider>
  </StrictMode>,
)
