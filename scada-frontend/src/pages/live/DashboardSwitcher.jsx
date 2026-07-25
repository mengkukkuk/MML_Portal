import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import FormControl from '@mui/material/FormControl'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import TextField from '@mui/material/TextField'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Alert from '@mui/material/Alert'
import { createDashboard, updateDashboard, deleteDashboard } from '@/api/dashboards'
import styles from './DashboardSwitcher.module.css'

/**
 * DashboardSwitcher — the Live page's board-select dropdown + "Manage"
 * dialog (rename / delete / create). Ported from LivePage.vue's
 * openManage/addDashboard/renameDashboard/confirmRename/removeDashboard
 * (script lines 938-1028) and their three small dialogs (template lines
 * 1524-1586).
 *
 * Owns its own create/rename/delete mutations and invalidates the shared
 * `['dashboards']` query on success; LivePage.jsx's effect that reconciles
 * `activeDashboardId` against the (now-refetched) `dashboards` list handles
 * falling back to another board if the active one was just deleted — this
 * component never needs to know the fallback target itself.
 */
export default function DashboardSwitcher({
  dashboards, activeDashboardId, switching, canManage, onSelect,
}) {
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['dashboards'] })

  const [manageOpen, setManageOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [manageError, setManageError] = useState('')

  const [renameTarget, setRenameTarget] = useState(null)
  const [renameTitle, setRenameTitle] = useState('')

  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState('')

  const createMut = useMutation({
    mutationFn: createDashboard,
    onSuccess: (created) => {
      invalidate()
      setNewTitle('')
      onSelect(created.id)
    },
    onError: (e) => setManageError(e?.response?.data?.detail || 'Failed to create dashboard.'),
  })
  const renameMut = useMutation({
    mutationFn: ({ id, payload }) => updateDashboard(id, payload),
    onSuccess: () => { invalidate(); setRenameTarget(null) },
    onError: (e) => setManageError(e?.response?.data?.detail || 'Failed to rename dashboard.'),
  })
  const deleteMut = useMutation({
    mutationFn: deleteDashboard,
    onSuccess: () => { invalidate(); setDeleteTarget(null) },
    onError: (e) => setDeleteError(e?.response?.data?.detail || 'Failed to delete dashboard.'),
  })

  function openManage() {
    setManageError('')
    setNewTitle('')
    setManageOpen(true)
  }

  function addDashboard() {
    const title = newTitle.trim()
    if (!title) { setManageError('Name is required.'); return }
    setManageError('')
    createMut.mutate({ title, position: dashboards.length })
  }

  function openRename(dash) {
    setManageError('')
    setRenameTarget(dash)
    setRenameTitle(dash.title)
  }

  function confirmRename() {
    const title = renameTitle.trim()
    if (!title) { setManageError('Name is required.'); return }
    renameMut.mutate({ id: renameTarget.id, payload: { title } })
  }

  function openDelete(dash) {
    if (dashboards.length <= 1) { setManageError('At least one dashboard must remain.'); return }
    setDeleteError('')
    setDeleteTarget(dash)
  }

  return (
    <div className={styles.wrap}>
      {dashboards.length ? (
        <FormControl size="small" className={styles.select}>
          <Select
            value={activeDashboardId ?? ''}
            disabled={switching}
            onChange={(e) => onSelect(Number(e.target.value))}
          >
            {dashboards.map((d) => (
              <MenuItem key={d.id} value={d.id}>{d.title}</MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : (
        <h2 className={styles.heading}>Live Dashboard</h2>
      )}
      {canManage && (
        <Button size="small" onClick={openManage}>Manage</Button>
      )}

      <Dialog open={manageOpen} onClose={() => setManageOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Manage dashboards</DialogTitle>
        <DialogContent className={styles.manageContent}>
          <Table size="small">
            <TableBody>
              {dashboards.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.title}</TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => openRename(d)}>Rename</Button>
                    <Button size="small" color="error" disabled={dashboards.length <= 1} onClick={() => openDelete(d)}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className={styles.newRow}>
            <TextField
              size="small"
              fullWidth
              placeholder="New dashboard name"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addDashboard() }}
            />
            <Button variant="contained" loading={createMut.isPending} onClick={addDashboard}>Add</Button>
          </div>
          {manageError && <Alert severity="error">{manageError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setManageOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!renameTarget} onClose={() => setRenameTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Rename dashboard</DialogTitle>
        <DialogContent className={styles.renameContent}>
          <TextField
            autoFocus
            fullWidth
            label="New name"
            value={renameTitle}
            onChange={(e) => setRenameTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmRename() }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)}>Cancel</Button>
          <Button variant="contained" loading={renameMut.isPending} onClick={confirmRename}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete dashboard</DialogTitle>
        <DialogContent className={styles.manageContent}>
          <p>
            Delete &quot;{deleteTarget?.title}&quot; and all its panels? This cannot be undone.
          </p>
          {deleteError && <Alert severity="error">{deleteError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained" loading={deleteMut.isPending} onClick={() => deleteMut.mutate(deleteTarget.id)}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  )
}
