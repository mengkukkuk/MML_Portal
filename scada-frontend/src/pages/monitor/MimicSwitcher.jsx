import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import TextField from '@mui/material/TextField'
import Alert from '@mui/material/Alert'
import { fetchMimicLayout, saveMimicLayout, deleteMimicLayout } from '@/api/mimic'
import { emptyLayout } from './layoutDoc'
import styles from './MimicSwitcher.module.css'

/**
 * MimicSwitcher — the drawing-select control that stands in for the page
 * title, plus the admin Manage dialog behind it.
 *
 * Ported from pages/live/DashboardSwitcher, with one structural difference: a
 * mimic is keyed by slug, not by an integer id the server hands back. The slug
 * is derived from the name once, at create time, and never moves again — it is
 * what the ?mimic= parameter carries, so a rename that changed it would break
 * every link an operator had saved.
 *
 * That makes create the one dangerous operation: PUT is an upsert, so a slug
 * that collides would silently overwrite a commissioned drawing. The collision
 * is caught here, before the request.
 */

/**
 * Name → slug, matching the backend's SLUG_RE (^[a-z0-9][a-z0-9_-]{0,63}$).
 * Returns '' when nothing survives, which the caller reports rather than
 * sending a slug the server will reject.
 */
export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '')
}

export default function MimicSwitcher({
  layouts, activeSlug, activeName, canManage, disabled, onSelect,
}) {
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['mimic-layouts'] })

  const [manageOpen, setManageOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [manageError, setManageError] = useState('')

  const [renameTarget, setRenameTarget] = useState(null)
  const [renameName, setRenameName] = useState('')

  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState('')

  const createMut = useMutation({
    mutationFn: ({ slug, name }) => saveMimicLayout(slug, name, emptyLayout(name)),
    onSuccess: (created) => {
      invalidate()
      setNewName('')
      onSelect(created.slug)
    },
    onError: (e) => setManageError(e?.response?.data?.detail || 'Failed to create the mimic.'),
  })

  // The PUT is a full upsert, so a rename has to carry the drawing back with
  // it. Read the current document first — the row being renamed is often not
  // the one open on the canvas, so there is nothing in local state to reuse.
  const renameMut = useMutation({
    mutationFn: async ({ slug, name }) => {
      const current = await fetchMimicLayout(slug)
      return saveMimicLayout(slug, name, { ...current.doc, name })
    },
    onSuccess: (saved) => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['mimic-layout', saved.slug] })
      setRenameTarget(null)
    },
    onError: (e) => setManageError(e?.response?.data?.detail || 'Failed to rename the mimic.'),
  })

  const deleteMut = useMutation({
    mutationFn: deleteMimicLayout,
    onSuccess: () => { invalidate(); setDeleteTarget(null) },
    onError: (e) => setDeleteError(e?.response?.data?.detail || 'Failed to delete the mimic.'),
  })

  function openManage() {
    setManageError('')
    setNewName('')
    setManageOpen(true)
  }

  function addMimic() {
    const name = newName.trim()
    if (!name) { setManageError('Name is required.'); return }
    const slug = slugify(name)
    if (!slug) { setManageError('Use at least one letter or digit in the name.'); return }
    if (layouts.some((l) => l.slug === slug)) {
      setManageError(`“${slug}” is already taken — saving would overwrite that drawing.`)
      return
    }
    setManageError('')
    createMut.mutate({ slug, name })
  }

  function openRename(layout) {
    setManageError('')
    setRenameTarget(layout)
    setRenameName(layout.name)
  }

  function confirmRename() {
    const name = renameName.trim()
    if (!name) { setManageError('Name is required.'); return }
    renameMut.mutate({ slug: renameTarget.slug, name })
  }

  function openDelete(layout) {
    if (layouts.length <= 1) { setManageError('At least one mimic must remain.'); return }
    setDeleteError('')
    setDeleteTarget(layout)
  }

  return (
    <div className={styles.wrap}>
      {layouts.length ? (
        <div className={styles.selectWrap}>
          <select
            className={styles.select}
            aria-label="Mimic drawing"
            value={activeSlug ?? ''}
            disabled={disabled}
            onChange={(e) => onSelect(e.target.value)}
          >
            {layouts.map((l) => (
              <option key={l.slug} value={l.slug}>{l.name}</option>
            ))}
          </select>
          <span className={styles.chevron} aria-hidden="true">▾</span>
        </div>
      ) : (
        <h2 className={styles.heading}>{activeName}</h2>
      )}

      {canManage && (
        <Button size="small" disabled={disabled} onClick={openManage}>Manage</Button>
      )}

      <Dialog open={manageOpen} onClose={() => setManageOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Manage mimics</DialogTitle>
        <DialogContent className={styles.dialogContent}>
          <ul className={styles.rows}>
            {layouts.map((l) => (
              <li key={l.slug} className={styles.row}>
                <span className={styles.rowName}>
                  {l.name}
                  <span className={styles.rowSlug}>{l.slug}</span>
                </span>
                <span className={styles.rowActions}>
                  <Button size="small" onClick={() => openRename(l)}>Rename</Button>
                  <Button
                    size="small"
                    color="error"
                    disabled={layouts.length <= 1}
                    onClick={() => openDelete(l)}
                  >
                    Delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>

          <div className={styles.newRow}>
            <TextField
              size="small"
              fullWidth
              placeholder="New mimic name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addMimic() }}
              helperText={newName.trim() ? `URL: ?mimic=${slugify(newName.trim()) || '—'}` : ' '}
            />
            <Button variant="contained" loading={createMut.isPending} onClick={addMimic}>Add</Button>
          </div>

          {manageError && <Alert severity="error">{manageError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setManageOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!renameTarget} onClose={() => setRenameTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Rename mimic</DialogTitle>
        <DialogContent className={styles.dialogContent}>
          <TextField
            autoFocus
            fullWidth
            label="New name"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmRename() }}
            helperText={`The address stays ?mimic=${renameTarget?.slug ?? ''} — saved links keep working.`}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)}>Cancel</Button>
          <Button variant="contained" loading={renameMut.isPending} onClick={confirmRename}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete mimic</DialogTitle>
        <DialogContent className={styles.dialogContent}>
          <p className={styles.confirm}>
            Delete “{deleteTarget?.name}” with its symbols, pipes and bindings? This cannot be undone.
          </p>
          {deleteError && <Alert severity="error">{deleteError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            loading={deleteMut.isPending}
            onClick={() => deleteMut.mutate(deleteTarget.slug)}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  )
}
