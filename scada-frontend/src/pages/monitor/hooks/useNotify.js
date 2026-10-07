import { useCallback, useState } from 'react'

/** The page's one snackbar: `notify(message, severity)` from anywhere, rendered by MonitorDialogs. */
export default function useNotify() {
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' })
  const notify = useCallback((message, severity = 'success') => {
    setSnackbar({ open: true, message, severity })
  }, [])
  const closeSnackbar = useCallback(() => setSnackbar((s) => ({ ...s, open: false })), [])
  return { snackbar, notify, closeSnackbar }
}
