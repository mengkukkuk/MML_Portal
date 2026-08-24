import Alert from '@mui/material/Alert'
import { useConnectionStore } from '@/stores/connection'

/**
 * DbStatusBanner — states the database situation when it is not the normal one.
 *
 * Two cases, and the difference matters to whoever is reading it:
 *  - database unreachable: the app is up but nothing will load or save.
 *  - running on a fallback: everything works, but writes are landing in a
 *    different database and will not appear in the primary when it returns.
 *
 * Renders nothing in the healthy case, so it costs a signed-in operator no
 * screen space on a normal day.
 */
export default function DbStatusBanner() {
  const dbOk = useConnectionStore((s) => s.dbOk)
  const dbFallback = useConnectionStore((s) => s.dbFallback)
  const apiReachable = useConnectionStore((s) => s.apiReachable)

  if (!apiReachable) {
    return (
      <Alert severity="error" square>
        Cannot reach the server. Data on this page may be out of date.
      </Alert>
    )
  }

  if (!dbOk) {
    return (
      <Alert severity="error" square>
        Database unreachable — pages will not load or save until the connection
        is restored.
      </Alert>
    )
  }

  if (dbFallback) {
    return (
      <Alert severity="warning" square>
        Running on the fallback database. Changes saved now stay on the fallback
        and are not copied to the primary.
      </Alert>
    )
  }

  return null
}
