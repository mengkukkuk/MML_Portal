import { useState } from 'react'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import Chip from '@mui/material/Chip'
import { useAuthStore } from '@/stores/auth'
import { useLicenseStore } from '@/stores/license'
import { apiErrorMessage } from '@/api/client'
import styles from './ActivateLicensePage.module.css'

const REASON_MESSAGES = {
  missing: 'No valid license is installed on this server.',
  blocked: 'This license has expired and its grace period has ended.',
}

/**
 * ActivateLicensePage — full-screen replacement for the entire app while the
 * license is missing/blocked (rendered by App.jsx in place of RouterProvider,
 * so there is no router context here — no useNavigate/useSearchParams).
 *
 * Behavior varies by auth state:
 *   - not signed in     → block reason + an inline sign-in form (there is no
 *                          /login route to send them to while blocked, so
 *                          this page IS the login screen in that state)
 *   - signed in, non-admin → block reason only, no way to act
 *   - signed in, admin  → paste/upload form; success flips the license store
 *                          reactively and App.jsx swaps back to the router
 */
export default function ActivateLicensePage() {
  const isLoggedIn = useAuthStore((s) => s.hasToken)
  const role = useAuthStore((s) => s.user?.role ?? null)
  const signIn = useAuthStore((s) => s.signIn)
  const authError = useAuthStore((s) => s.error)
  const authLoading = useAuthStore((s) => s.loading)

  const licenseState = useLicenseStore((s) => s.state)
  const activate = useLicenseStore((s) => s.activate)
  const activateLoading = useLicenseStore((s) => s.loading)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [formError, setFormError] = useState('')

  const isAdmin = isLoggedIn && role === 'admin'
  const reasonMessage = REASON_MESSAGES[licenseState] || 'This product is not licensed.'

  async function handleSignIn(e) {
    e.preventDefault()
    try {
      await signIn(username, password)
    } catch {
      // error surfaced via authError
    }
  }

  async function handleActivate(e) {
    e.preventDefault()
    setFormError('')
    if (!file && !text.trim()) {
      setFormError('Paste a license or choose a .lic file.')
      return
    }
    try {
      await activate({ text: text.trim() || undefined, file: file || undefined })
      // On success the license store flips to valid/grace and App.jsx
      // unmounts this page in favor of the router — nothing else to do here.
    } catch (err) {
      setFormError(apiErrorMessage(err, 'License activation failed'))
    }
  }

  return (
    <div className={styles.bg}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1 className={styles.title}>MML Portal</h1>
          <p className={styles.subtitle}>License Required</p>
        </div>

        <Alert severity="error" sx={{ mb: 3 }}>
          {reasonMessage} Contact your administrator to activate a license.
        </Alert>

        {!isLoggedIn && (
          <form onSubmit={handleSignIn} className={styles.form}>
            <p className={styles.hint}>Sign in as an administrator to activate a license.</p>
            <TextField
              label="Username"
              autoComplete="username"
              fullWidth
              margin="normal"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              fullWidth
              margin="normal"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {authError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {authError}
              </Alert>
            )}
            <Button type="submit" variant="contained" size="large" loading={authLoading} fullWidth>
              Sign In
            </Button>
          </form>
        )}

        {isLoggedIn && !isAdmin && (
          <p className={styles.hint}>
            You are signed in, but only an administrator can activate a license.
          </p>
        )}

        {isAdmin && (
          <form onSubmit={handleActivate} className={styles.form}>
            <TextField
              label="License text"
              placeholder="Paste the license token here"
              multiline
              minRows={4}
              fullWidth
              margin="normal"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (e.target.value) setFile(null)
              }}
            />
            <div className={styles.fileRow}>
              <Button variant="outlined" component="label">
                Choose .lic file
                <input
                  type="file"
                  accept=".lic,text/plain"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null
                    setFile(f)
                    if (f) setText('')
                  }}
                />
              </Button>
              {file && <Chip label={file.name} onDelete={() => setFile(null)} size="small" />}
            </div>
            {formError && (
              <Alert severity="error" sx={{ mt: 2, mb: 1 }}>
                {formError}
              </Alert>
            )}
            <Button
              type="submit"
              variant="contained"
              size="large"
              loading={activateLoading}
              fullWidth
              sx={{ mt: 2 }}
            >
              Activate License
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
