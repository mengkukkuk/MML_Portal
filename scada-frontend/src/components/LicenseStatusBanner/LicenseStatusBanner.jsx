import Alert from '@mui/material/Alert'
import { useLicenseStore } from '@/stores/license'

/**
 * LicenseStatusBanner — states the license situation when it is not the
 * normal one (far from expiry). Mirrors DbStatusBanner's "render null when
 * healthy" contract, so it costs a signed-in operator no screen space on a
 * normal day.
 *
 * The hard-blocked state never reaches here: App.jsx swaps the whole app out
 * for ActivateLicensePage before AppShell (and this banner) ever mounts.
 */
export default function LicenseStatusBanner() {
  const state = useLicenseStore((s) => s.state)
  const warn = useLicenseStore((s) => s.warn)
  const daysToExpiry = useLicenseStore((s) => s.days_to_expiry)
  const daysUntilHardBlock = useLicenseStore((s) => s.days_until_hard_block)
  const expiresAt = useLicenseStore((s) => s.expires_at)

  if (!warn) return null

  if (state === 'grace') {
    return (
      <Alert severity="error" square>
        License expired{expiresAt ? ` on ${new Date(expiresAt).toLocaleDateString()}` : ''}.
        {daysUntilHardBlock != null
          ? ` ${daysUntilHardBlock} day${daysUntilHardBlock === 1 ? '' : 's'} remain before the system locks.`
          : ' Contact your administrator to renew.'}
      </Alert>
    )
  }

  return (
    <Alert severity="warning" square>
      License expires in {daysToExpiry != null ? `${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}` : 'soon'}.
      Contact your administrator to renew.
    </Alert>
  )
}
