import { useState } from 'react'
import { useMatches, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import IconButton from '@mui/material/IconButton'
import MenuIcon from '@mui/icons-material/Menu'
import MenuOpenIcon from '@mui/icons-material/MenuOpen'
import PersonOutlined from '@mui/icons-material/PersonOutlined'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Divider from '@mui/material/Divider'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Alert from '@mui/material/Alert'
import ConnectionPill from '@/components/ConnectionPill/ConnectionPill.jsx'
import { useAuthStore } from '@/stores/auth'
import { changePassword } from '@/api/auth'
import styles from './AppHeader.module.css'

/**
 * AppHeader — top navigation bar rendered inside AppShell.
 * Shows the current page title (from the matched route's handle.title), the
 * ConnectionPill, and a user menu with "Change password" and "Sign out".
 * Props: collapsed (Boolean) — mirrors sidebar state to show Menu/MenuOpen icon.
 * onToggle() — requests sidebar collapse/expand from AppShell.
 */
export default function AppHeader({ collapsed, onToggle }) {
  const navigate = useNavigate()
  const matches = useMatches()
  const user = useAuthStore((s) => s.user)
  const signOut = useAuthStore((s) => s.signOut)

  const withTitle = [...matches].reverse().find((m) => m.handle?.title)
  const pageTitle = withTitle?.handle?.title || 'MML Portal'
  const displayName = user?.display_name || user?.username || 'Operator'

  const [anchorEl, setAnchorEl] = useState(null)
  const menuOpen = Boolean(anchorEl)

  async function handleSignOut() {
    setAnchorEl(null)
    await signOut()
    navigate('/login')
  }

  // --- Change password dialog ---
  const [pwVisible, setPwVisible] = useState(false)
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError] = useState('')
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm({ defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' } })

  function openChangePassword() {
    setAnchorEl(null)
    setPwError('')
    reset({ oldPassword: '', newPassword: '', confirmPassword: '' })
    setPwVisible(true)
  }

  async function submitChangePassword(values) {
    setPwError('')
    setPwLoading(true)
    try {
      await changePassword(values.oldPassword, values.newPassword)
      setPwVisible(false)
    } catch (e) {
      setPwError(e?.response?.data?.detail || 'Password change failed')
    } finally {
      setPwLoading(false)
    }
  }

  return (
    <div className={styles.header}>
      <div className={styles.left}>
        <IconButton
          className={styles.toggle}
          size="small"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggle}
        >
          {collapsed ? <MenuIcon fontSize="small" /> : <MenuOpenIcon fontSize="small" />}
        </IconButton>
        <h1 className={styles.title}>{pageTitle}</h1>
      </div>
      <div className={styles.right}>
        <ConnectionPill />
        <Button
          className={styles.user}
          onClick={(e) => setAnchorEl(e.currentTarget)}
          disableRipple
        >
          <PersonOutlined fontSize="small" />
          <span className={styles.userName}>{displayName}</span>
          <ArrowDropDownIcon fontSize="small" />
        </Button>
        <Menu anchorEl={anchorEl} open={menuOpen} onClose={() => setAnchorEl(null)}>
          <MenuItem onClick={openChangePassword}>Change password</MenuItem>
          <Divider />
          <MenuItem onClick={handleSignOut}>Sign out</MenuItem>
        </Menu>
      </div>

      <Dialog open={pwVisible} onClose={() => setPwVisible(false)} fullWidth maxWidth="xs">
        <DialogTitle>Change password</DialogTitle>
        <form onSubmit={handleSubmit(submitChangePassword)}>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              fullWidth
              {...register('oldPassword', { required: true })}
            />
            <TextField
              label="New password"
              type="password"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              fullWidth
              error={!!errors.newPassword}
              helperText={
                errors.newPassword ? 'New password must be at least 8 characters' : ' '
              }
              {...register('newPassword', { required: true, minLength: 8 })}
            />
            <TextField
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              fullWidth
              error={!!errors.confirmPassword}
              helperText={errors.confirmPassword ? 'Passwords do not match' : ' '}
              {...register('confirmPassword', {
                validate: (value) => value === watch('newPassword') || 'Passwords do not match',
              })}
            />
            {pwError && <Alert severity="error">{pwError}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setPwVisible(false)}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={pwLoading}>
              Change password
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </div>
  )
}
