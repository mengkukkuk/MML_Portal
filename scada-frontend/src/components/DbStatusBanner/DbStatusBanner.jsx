import Alert from '@mui/material/Alert'
import { useConnectionStore } from '@/stores/connection'

/**
 * DbStatusBanner — states the database situation when it is not the normal one.
 *
 * Only ever describes the app/config database (localhost) and the API itself.
 * An unreachable *plant* datasource is not shown here: it affects one source's
 * data, not the product, and is surfaced next to that data instead.
 *
 * Renders nothing in the healthy case, so it costs a signed-in operator no
 * screen space on a normal day.
 */
export default function DbStatusBanner() {
  const dbOk = useConnectionStore((s) => s.dbOk)
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

  return null
}
