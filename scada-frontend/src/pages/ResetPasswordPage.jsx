import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import { resetPassword } from '@/api/auth'
import styles from './ResetPasswordPage.module.css'

/**
 * ResetPasswordPage — password reset form (route: /reset-password).
 * Reads the one-time JWT from the `?token=` query parameter (set by the
 * email link generated in mailer.py). Validates token presence before
 * showing the form; on success redirects to /login.
 */
export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm({ defaultValues: { newPassword: '', confirmPassword: '' } })

  async function handleReset(values) {
    setError('')
    setLoading(true)
    try {
      await resetPassword(token, values.newPassword)
      navigate('/login')
    } catch (e) {
      setError(e?.response?.data?.detail || 'Reset failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.loginBg}>
      <div className={styles.loginBox}>
        <div className={styles.brand}>
          <span className={styles.logo}>⚙</span>
          <h1 className={styles.title}>Reset password</h1>
        </div>

        {!token ? (
          <Alert severity="error">
            This reset link is missing its token. Request a new one from the login page.
          </Alert>
        ) : (
          <form onSubmit={handleSubmit(handleReset)} noValidate>
            <TextField
              label="New password"
              type="password"
              placeholder="At least 8 characters"
              size="medium"
              fullWidth
              margin="normal"
              error={!!errors.newPassword}
              helperText={errors.newPassword ? 'Password must be at least 8 characters' : ' '}
              {...register('newPassword', { required: true, minLength: 8 })}
            />
            <TextField
              label="Confirm password"
              type="password"
              placeholder="Re-enter password"
              size="medium"
              fullWidth
              margin="normal"
              error={!!errors.confirmPassword}
              helperText={errors.confirmPassword ? 'Passwords do not match' : ' '}
              {...register('confirmPassword', {
                validate: (value) => value === watch('newPassword') || 'Passwords do not match',
              })}
            />

            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            <Button type="submit" variant="contained" size="large" loading={loading} fullWidth>
              Reset password
            </Button>
          </form>
        )}

        <Link className={styles.link} to="/login">
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
