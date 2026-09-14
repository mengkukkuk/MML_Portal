import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import DbStatusBanner from '@/components/DbStatusBanner/DbStatusBanner.jsx'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Snackbar from '@mui/material/Snackbar'
import { useAuthStore } from '@/stores/auth'
import { forgotPassword } from '@/api/auth'
import MmlLogo from '@/components/MmlLogo/MmlLogo.jsx'
import styles from './LoginPage.module.css'

/**
 * LoginPage — public full-screen login page (route: /login).
 * Left brand panel (decorative, hidden on mobile) + right form panel with:
 *   - Sign-in form (redirects to ?redirect= target after login)
 *   - "Create an Account" dialog (self-registration)
 *   - "Forgot password?" dialog (sends reset email via /api/auth/forgot-password)
 * Open-redirect is prevented the same (incomplete) way as the Vue version:
 * only paths starting with '/' are honoured — deliberately not hardened
 * further per the migration plan's risk note.
 */

export default function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const signIn = useAuthStore((s) => s.signIn)
  const signUp = useAuthStore((s) => s.signUp)
  const authError = useAuthStore((s) => s.error)
  const authLoading = useAuthStore((s) => s.loading)

  const {
    register: registerSignIn,
    handleSubmit: handleSignInSubmit,
  } = useForm({ defaultValues: { username: '', password: '' } })

  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' })
  function notify(message, severity = 'success') {
    setSnackbar({ open: true, message, severity })
  }

  async function handleLogin({ username, password }) {
    try {
      await signIn(username, password)
      // Guard: must be a string starting with '/' (no open redirect, no array)
      const raw = searchParams.get('redirect')
      const redirect = typeof raw === 'string' && raw.startsWith('/') ? raw : '/'
      navigate(redirect)
    } catch {
      // error is in auth store's `error` field
    }
  }

  // ── Register dialog ───────────────────────────────────────
  const [registerVisible, setRegisterVisible] = useState(false)
  const [registerForm, setRegisterForm] = useState({
    username: '',
    password: '',
    display_name: '',
    email: '',
  })
  const [registerError, setRegisterError] = useState('')

  function openRegister() {
    setRegisterError('')
    setRegisterForm({ username: '', password: '', display_name: '', email: '' })
    setRegisterVisible(true)
  }

  function updateRegisterField(field) {
    return (e) => setRegisterForm((f) => ({ ...f, [field]: e.target.value }))
  }

  async function handleRegister() {
    setRegisterError('')
    if (!registerForm.username.trim() || !registerForm.display_name.trim()) {
      setRegisterError('Username and display name are required')
      return
    }
    if (registerForm.password.length < 8) {
      setRegisterError('Password must be at least 8 characters')
      return
    }
    try {
      await signUp({
        username: registerForm.username.trim(),
        password: registerForm.password,
        display_name: registerForm.display_name.trim(),
        email: registerForm.email.trim() || null,
      })
      notify('Account created')
      setRegisterVisible(false)
      navigate('/')
    } catch {
      setRegisterError(useAuthStore.getState().error || 'Registration failed')
    }
  }

  // ── Forgot password dialog ────────────────────────────────
  const [forgotVisible, setForgotVisible] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)

  async function handleForgot() {
    if (!forgotEmail.trim()) {
      notify('Enter your email address', 'warning')
      return
    }
    setForgotLoading(true)
    try {
      const { message } = await forgotPassword(forgotEmail.trim())
      notify(message || 'If that email is registered, a reset link has been sent.')
      setForgotVisible(false)
      setForgotEmail('')
    } catch {
      // Endpoint is generic by design; show a neutral message on transport error
      notify('If that email is registered, a reset link has been sent.', 'info')
      setForgotVisible(false)
    } finally {
      setForgotLoading(false)
    }
  }

  return (
    <div className={styles['login-bg']}>
      {/* Background decoration layers */}
      <div className={styles['bg-grid']} aria-hidden="true" />
      <div className={styles['bg-glow-1']} aria-hidden="true" />
      <div className={styles['bg-glow-2']} aria-hidden="true" />
      <div className={styles['bg-scan']} aria-hidden="true" />

      {/* Corner brackets */}
      <div className={`${styles.bracket} ${styles['bracket--tl']}`} aria-hidden="true" />
      <div className={`${styles.bracket} ${styles['bracket--tr']}`} aria-hidden="true" />
      <div className={`${styles.bracket} ${styles['bracket--bl']}`} aria-hidden="true" />
      <div className={`${styles.bracket} ${styles['bracket--br']}`} aria-hidden="true" />

      {/* ── Main card ──────────────────────────────────── */}
      <div className={styles['login-card']}>
        {/* LEFT: MML brand */}
        <aside className={styles['brand-panel']} aria-label="MML Portal">
          <div className={styles['brand-identity']} title="Powered by Engineering Off-Site">
            <MmlLogo className={styles['brand-logo']} orbitClassName={styles['brand-orbit']} />
            <h1 className={styles['brand-title']}>MML Portal</h1>
            <p className={styles['brand-credit']}>
              <span>Powered by</span>
              <strong>Engineering Off-Site</strong>
            </p>
          </div>
        </aside>

        {/* RIGHT: Login form */}
        <main className={styles['form-panel']}>
          {/* Header */}
          <div className={styles['form-header']}>
            <div className={styles['form-header__icon']}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="26"
                height="26"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            </div>
            <h2 className={styles['form-header__title']}>System Access</h2>
            <p className={styles['form-header__sub']}>Authorized Personnel Only</p>
          </div>

          {/* Credentials form */}
          <form onSubmit={handleSignInSubmit(handleLogin)} noValidate>
            <TextField
              label="Username"
              placeholder="Enter username"
              autoComplete="username"
              size="medium"
              fullWidth
              margin="normal"
              {...registerSignIn('username')}
            />

            <TextField
              label="Password"
              type="password"
              placeholder="Enter password"
              autoComplete="current-password"
              size="medium"
              fullWidth
              margin="normal"
              {...registerSignIn('password')}
            />

            {/* Says the database is down *before* a sign-in attempt, so the
                failure does not look like a wrong password. */}
            <DbStatusBanner />

            {authError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {authError}
              </Alert>
            )}

            <Button type="submit" variant="contained" size="large" loading={authLoading} fullWidth>
              Sign In
            </Button>

            <Button
              variant="outlined"
              size="large"
              fullWidth
              className={styles['form-btn-register']}
              onClick={openRegister}
            >
              Create an Account
            </Button>

            <Button
              variant="text"
              className={styles['form-btn-forgot']}
              onClick={() => setForgotVisible(true)}
            >
              Forgot password?
            </Button>
          </form>
        </main>
      </div>

      {/* ── Dialogs ────────────────────────────────────────── */}

      <Dialog open={registerVisible} onClose={() => setRegisterVisible(false)} fullWidth maxWidth="xs">
        <DialogTitle>Create an account</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleRegister()
          }}
        >
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
            <TextField
              label="Username"
              placeholder="Choose a username"
              autoComplete="username"
              fullWidth
              value={registerForm.username}
              onChange={updateRegisterField('username')}
            />
            <TextField
              label="Display name"
              placeholder="Your full name"
              fullWidth
              value={registerForm.display_name}
              onChange={updateRegisterField('display_name')}
            />
            <TextField
              label="Password"
              type="password"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              fullWidth
              value={registerForm.password}
              onChange={updateRegisterField('password')}
            />
            <TextField
              label="Email (optional)"
              placeholder="name@example.com"
              autoComplete="email"
              fullWidth
              value={registerForm.email}
              onChange={updateRegisterField('email')}
            />
            {registerError && <Alert severity="error">{registerError}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRegisterVisible(false)}>Cancel</Button>
            <Button type="submit" variant="contained" loading={authLoading}>
              Create account
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={forgotVisible} onClose={() => setForgotVisible(false)} fullWidth maxWidth="xs">
        <DialogTitle>Reset password</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleForgot()
          }}
        >
          <DialogContent>
            <p className={styles['forgot-hint']}>
              Enter your account email. If it matches a user, a reset link will be sent.
            </p>
            <TextField
              label="Email"
              placeholder="name@example.com"
              autoComplete="email"
              fullWidth
              value={forgotEmail}
              onChange={(e) => setForgotEmail(e.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setForgotVisible(false)}>Cancel</Button>
            <Button type="submit" variant="contained" loading={forgotLoading}>
              Send reset link
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </div>
  )
}
