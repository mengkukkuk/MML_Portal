import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Snackbar from '@mui/material/Snackbar'
import { useAuthStore } from '@/stores/auth'
import { forgotPassword } from '@/api/auth'
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

const TABS = [
  { id: 'status', label: 'STATUS' },
  { id: 'load', label: 'LOAD' },
  { id: 'comm', label: 'COMM' },
]
const TAB_INTERVAL_MS = 3500

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

  // ── Slide nav tabs (brand panel) ─────────────────────────
  const [activeTab, setActiveTab] = useState(0)
  const timerRef = useRef(null)

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setActiveTab((t) => (t + 1) % TABS.length)
    }, TAB_INTERVAL_MS)
    return () => clearInterval(timerRef.current)
  }, [])

  function setTab(i) {
    setActiveTab(i)
    clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setActiveTab((t) => (t + 1) % TABS.length)
    }, TAB_INTERVAL_MS)
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
        {/* LEFT: Brand / status panel */}
        <aside className={styles['brand-panel']}>
          {/* Gear logo */}
          <div className={styles['brand-icon']}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#3aa0ff"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
              <path
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83
                     0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0
                     01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2
                     0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2
                     2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2
                     2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2
                     2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2
                     2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51
                     1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
              />
            </svg>
          </div>

          <h1 className={styles['brand-title']}>MML Portal</h1>
          <p className={styles['brand-subtitle']}>MML Unified Systems</p>

          {/* ── Slide nav tab panel ──────────────────────── */}
          <div className={styles['info-tabs']}>
            {/* Tab bar */}
            <div className={styles['tab-bar']} role="tablist">
              {TABS.map((tab, i) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`${styles['tab-btn']} ${activeTab === i ? styles['tab-btn--active'] : ''}`}
                  role="tab"
                  aria-selected={activeTab === i}
                  onClick={() => setTab(i)}
                >
                  {tab.label}
                </button>
              ))}
              <div
                className={styles['tab-bar__indicator']}
                style={{ transform: `translateX(${activeTab * 100}%)` }}
                aria-hidden="true"
              />
            </div>

            {/* Sliding panels */}
            <div className={styles['tab-content-wrap']}>
              <div
                className={styles['tab-slides']}
                style={{ transform: `translateX(calc(-${activeTab} * 100%))` }}
              >
                {/* STATUS slide */}
                <div className={styles['tab-slide']} role="tabpanel" aria-hidden={activeTab !== 0}>
                  <div className={styles['slide-header']}>— SYSTEM STATUS —</div>
                  <div className={styles['slide-item']}>
                    <span className={`${styles.led} ${styles['led--ok']}`} />
                    <span>Core Systems Online</span>
                  </div>
                  <div className={styles['slide-item']}>
                    <span className={`${styles.led} ${styles['led--ok']}`} />
                    <span>Database Connected</span>
                  </div>
                  <div className={styles['slide-item']}>
                    <span className={`${styles.led} ${styles['led--ok']}`} />
                    <span>Monitoring Active</span>
                  </div>
                </div>

                {/* LOAD slide (gauge) */}
                <div
                  className={`${styles['tab-slide']} ${styles['tab-slide--gauge']}`}
                  role="tabpanel"
                  aria-hidden={activeTab !== 1}
                >
                  <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="100" cy="100" r="92" stroke="rgba(58,160,255,0.06)" strokeWidth="0.75" />
                    <circle cx="100" cy="100" r="86" stroke="rgba(58,160,255,0.04)" strokeWidth="0.75" />
                    <path
                      d="M 60 169.3 A 80 80 0 1 1 140 169.3"
                      stroke="rgba(58,160,255,0.12)"
                      strokeWidth="10"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 60 169.3 A 80 80 0 1 1 156.6 43.4"
                      stroke="rgba(58,160,255,0.18)"
                      strokeWidth="18"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 60 169.3 A 80 80 0 1 1 156.6 43.4"
                      stroke="#3aa0ff"
                      strokeWidth="10"
                      strokeLinecap="round"
                    />
                    <g transform="translate(100,100)">
                      <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.45)" strokeWidth="1.5" transform="rotate(120)" />
                      <line x1="73" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.25)" strokeWidth="1" transform="rotate(157.5)" />
                      <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.45)" strokeWidth="1.5" transform="rotate(195)" />
                      <line x1="73" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.25)" strokeWidth="1" transform="rotate(232.5)" />
                      <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.55)" strokeWidth="2" transform="rotate(270)" />
                      <line x1="73" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.25)" strokeWidth="1" transform="rotate(307.5)" />
                      <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.45)" strokeWidth="1.5" transform="rotate(345)" />
                      <line x1="73" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.25)" strokeWidth="1" transform="rotate(22.5)" />
                      <line x1="70" y1="0" x2="83" y2="0" stroke="rgba(58,160,255,0.45)" strokeWidth="1.5" transform="rotate(60)" />
                    </g>
                    <g transform="translate(100,100) rotate(315)">
                      <line x1="-10" y1="0" x2="62" y2="0" stroke="#3aa0ff" strokeWidth="2.5" strokeLinecap="round" />
                      <circle cx="0" cy="0" r="6" fill="rgba(11,22,44,0.9)" stroke="#3aa0ff" strokeWidth="2" />
                      <circle cx="0" cy="0" r="2.5" fill="#3aa0ff" />
                    </g>
                    <text x="100" y="108" textAnchor="middle" fill="#e6edf7" fontSize="26" fontWeight="700" fontFamily="ui-monospace,Menlo,monospace">
                      65%
                    </text>
                    <text x="100" y="126" textAnchor="middle" fill="rgba(138,153,179,0.65)" fontSize="9.5" fontFamily="ui-monospace,Menlo,monospace" letterSpacing="2">
                      SYSTEM LOAD
                    </text>
                    <text x="54" y="186" textAnchor="middle" fill="rgba(91,106,134,0.6)" fontSize="9" fontFamily="ui-monospace,Menlo,monospace">
                      0
                    </text>
                    <text x="146" y="186" textAnchor="middle" fill="rgba(91,106,134,0.6)" fontSize="9" fontFamily="ui-monospace,Menlo,monospace">
                      100
                    </text>
                  </svg>
                </div>

                {/* COMM slide */}
                <div className={styles['tab-slide']} role="tabpanel" aria-hidden={activeTab !== 2}>
                  <div className={styles['slide-header']}>— COMMUNICATIONS —</div>
                  <div className={styles['comm-metric']}>
                    <span className={styles['comm-metric__label']}>UPTIME</span>
                    <div className={styles['comm-metric__track']}>
                      <div className={styles['comm-metric__fill']} style={{ width: '99.8%' }} />
                    </div>
                    <span className={styles['comm-metric__val']}>99.8%</span>
                  </div>
                  <div className={styles['comm-metric']}>
                    <span className={styles['comm-metric__label']}>DATA RT</span>
                    <div className={styles['comm-metric__track']}>
                      <div
                        className={`${styles['comm-metric__fill']} ${styles['comm-metric__fill--cyan']}`}
                        style={{ width: '48%' }}
                      />
                    </div>
                    <span className={styles['comm-metric__val']}>2.4K/s</span>
                  </div>
                  <div className={styles['comm-metric']}>
                    <span className={styles['comm-metric__label']}>LATENCY</span>
                    <div className={styles['comm-metric__track']}>
                      <div
                        className={`${styles['comm-metric__fill']} ${styles['comm-metric__fill--green']}`}
                        style={{ width: '12%' }}
                      />
                    </div>
                    <span className={styles['comm-metric__val']}>12 ms</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className={styles['brand-footer']}>
            <span className={styles['brand-version']}>v2.4.1</span>
            <span>MML Industrial Automation</span>
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
                stroke="#3aa0ff"
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
