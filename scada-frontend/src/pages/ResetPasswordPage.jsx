import { useTranslation } from '@/i18n'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import { resetPassword } from '@/api/auth'
import LanguageSelect from '@/components/LanguageSelect/LanguageSelect.jsx'
import styles from './ResetPasswordPage.module.css'

/**
 * ResetPasswordPage — password reset form (route: /reset-password).
 * Reads the one-time JWT from the `?token=` query parameter (set by the
 * email link generated in mailer.py). Validates token presence before
 * showing the form; on success redirects to /login.
 */
export default function ResetPasswordPage() {
  const tr = useTranslation()
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
        <LanguageSelect />
        <div className={styles.brand}>
          <span className={styles.logo}>⚙</span>
          <h1 className={styles.title}>{tr("Reset password")}</h1>
        </div>

        {!token ? (
          <Alert severity="error">{tr("This reset link is missing its token. Request a new one from the login page.")}</Alert>
        ) : (
          <form onSubmit={handleSubmit(handleReset)} noValidate>
            <TextField
              label={tr("New password")}
              type="password"
              placeholder={tr("At least 8 characters")}
              size="medium"
              fullWidth
              margin="normal"
              error={!!errors.newPassword}
              helperText={errors.newPassword ? tr("Password must be at least 8 characters") : ' '}
              {...register('newPassword', { required: true, minLength: 8 })}
            />
            <TextField
              label={tr("Confirm password")}
              type="password"
              placeholder={tr("Re-enter password")}
              size="medium"
              fullWidth
              margin="normal"
              error={!!errors.confirmPassword}
              helperText={errors.confirmPassword ? tr("Passwords do not match") : ' '}
              {...register('confirmPassword', {
                validate: (value) => value === watch('newPassword') || tr("Passwords do not match"),
              })}
            />

            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {tr(error)}
              </Alert>
            )}

            <Button type="submit" variant="contained" size="large" loading={loading} fullWidth>{tr("Reset password")}</Button>
          </form>
        )}

        <Link className={styles.link} to="/login">{tr("Back to sign in")}</Link>
      </div>
    </div>
  )
}
