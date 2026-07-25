import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Controller, useForm } from 'react-hook-form'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Paper from '@mui/material/Paper'
import Chip from '@mui/material/Chip'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import TextField from '@mui/material/TextField'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import InputLabel from '@mui/material/InputLabel'
import FormControl from '@mui/material/FormControl'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import RefreshIcon from '@mui/icons-material/Refresh'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import { fetchUsers, createUser, updateUser, deleteUser } from '@/api/users'
import styles from './AccountsPage.module.css'

/**
 * AccountsPage — admin-only user management page (route: /accounts).
 * Lists all users in a table and provides Create / Edit / Delete actions via
 * dialogs. Role gating (admin-only) is enforced upstream by
 * handle.requiresRole in router/routes.jsx + RequireAuth — this page assumes
 * it is only ever rendered for an admin. Ported from AccountsPage.vue
 * (Pinia useUsersStore) onto TanStack Query (list + mutations).
 */

const BLANK_FORM = { username: '', password: '', role: 'operator', display_name: '', email: '' }

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

export default function AccountsPage() {
  const queryClient = useQueryClient()
  const {
    data: list = [],
    isFetching,
    error: listError,
    refetch,
  } = useQuery({ queryKey: ['users'], queryFn: fetchUsers })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState('create') // 'create' | 'edit'
  const [editingId, setEditingId] = useState(null)
  const [dialogError, setDialogError] = useState('')

  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState('')

  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' })
  function notify(message, severity = 'success') {
    setSnackbar({ open: true, message, severity })
  }

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm({ defaultValues: BLANK_FORM })

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: ['users'] })

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      invalidateUsers()
      notify('User created')
      setDialogOpen(false)
    },
    onError: (e) => setDialogError(e?.response?.data?.detail || 'Save failed'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => updateUser(id, payload),
    onSuccess: () => {
      invalidateUsers()
      notify('User updated')
      setDialogOpen(false)
    },
    onError: (e) => setDialogError(e?.response?.data?.detail || 'Save failed'),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => {
      invalidateUsers()
      notify('User deleted')
      setDeleteTarget(null)
    },
    onError: (e) => setDeleteError(e?.response?.data?.detail || 'Delete failed'),
  })

  const submitting = createMutation.isPending || updateMutation.isPending

  function openCreate() {
    setDialogMode('create')
    setEditingId(null)
    setDialogError('')
    reset(BLANK_FORM)
    setDialogOpen(true)
  }

  function openEdit(row) {
    setDialogMode('edit')
    setEditingId(row.id)
    setDialogError('')
    reset({
      username: row.username,
      password: '',
      role: row.role,
      display_name: row.display_name,
      email: row.email || '',
    })
    setDialogOpen(true)
  }

  function onSubmit(values) {
    setDialogError('')
    if (dialogMode === 'create') {
      createMutation.mutate({
        username: values.username.trim(),
        password: values.password,
        role: values.role,
        display_name: values.display_name.trim(),
        email: values.email.trim() || null,
      })
    } else {
      updateMutation.mutate({
        id: editingId,
        payload: {
          role: values.role,
          display_name: values.display_name.trim(),
          email: values.email.trim() || null,
        },
      })
    }
  }

  function confirmDelete(row) {
    setDeleteError('')
    setDeleteTarget(row)
  }

  function handleDelete() {
    if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h2 className={styles.title}>Accounts</h2>
        <div className={styles.actions}>
          <Button startIcon={<RefreshIcon />} onClick={() => refetch()} loading={isFetching}>
            Refresh
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            Add user
          </Button>
        </div>
      </header>

      {listError && (
        <Alert severity="error">
          {listError?.response?.data?.detail || listError?.message || 'Failed to load users'}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="medium">
          <TableHead>
            <TableRow>
              <TableCell width={80}>ID</TableCell>
              <TableCell>Username</TableCell>
              <TableCell>Display name</TableCell>
              <TableCell width={120}>Role</TableCell>
              <TableCell>Email</TableCell>
              <TableCell>Created</TableCell>
              <TableCell width={120} align="right">
                Actions
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {list.map((row) => (
              <TableRow key={row.id} hover>
                <TableCell>{row.id}</TableCell>
                <TableCell>{row.username}</TableCell>
                <TableCell>{row.display_name}</TableCell>
                <TableCell>
                  <Chip
                    label={row.role}
                    color={row.role === 'admin' ? 'error' : 'default'}
                    size="small"
                  />
                </TableCell>
                <TableCell>{row.email || '—'}</TableCell>
                <TableCell>{formatDate(row.created_at)}</TableCell>
                <TableCell align="right">
                  <IconButton size="small" aria-label="Edit user" onClick={() => openEdit(row)}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    color="error"
                    aria-label="Delete user"
                    onClick={() => confirmDelete(row)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>{dialogMode === 'create' ? 'Add user' : 'Edit user'}</DialogTitle>
        <form onSubmit={handleSubmit(onSubmit)}>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
            <TextField
              label="Username"
              placeholder="Login username"
              disabled={dialogMode === 'edit'}
              fullWidth
              error={!!errors.username}
              helperText={errors.username ? 'Username is required' : ' '}
              {...register('username', { required: dialogMode === 'create' })}
            />
            {dialogMode === 'create' && (
              <TextField
                label="Password"
                type="password"
                placeholder="At least 8 characters"
                fullWidth
                {...register('password')}
              />
            )}
            <TextField
              label="Display name"
              placeholder="Full name"
              fullWidth
              error={!!errors.display_name}
              helperText={errors.display_name ? 'Display name is required' : ' '}
              {...register('display_name', { required: true })}
            />
            <FormControl fullWidth>
              <InputLabel id="accounts-role-label">Role</InputLabel>
              <Controller
                name="role"
                control={control}
                render={({ field }) => (
                  <Select labelId="accounts-role-label" label="Role" {...field}>
                    <MenuItem value="operator">operator</MenuItem>
                    <MenuItem value="admin">admin</MenuItem>
                  </Select>
                )}
              />
            </FormControl>
            <TextField
              label="Email (optional)"
              placeholder="name@example.com"
              fullWidth
              {...register('email')}
            />
            {dialogError && <Alert severity="error">{dialogError}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" loading={submitting}>
              {dialogMode === 'create' ? 'Create' : 'Save'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete user</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <p className={styles.confirmText}>
            Delete user "{deleteTarget?.username}"? This cannot be undone.
          </p>
          {deleteError && <Alert severity="error">{deleteError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            loading={deleteMutation.isPending}
            onClick={handleDelete}
          >
            Delete
          </Button>
        </DialogActions>
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
