import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'

export function ImportLayoutDialog({ open, onClose, onImport }) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Import layout JSON</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Choose an MML export or raw layout document. The active mimic name and URL identity stay unchanged. Import updates only the draft and still requires Save.
        </DialogContentText>
        <Button component="label" variant="outlined" sx={{ mt: 3 }}>
          Choose JSON file
          <input hidden type="file" accept="application/json,.json" onChange={onImport} />
        </Button>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  )
}

export function UnsavedChangesDialog({ open, onStay, onDiscard }) {
  return (
    <Dialog open={open} onClose={onStay}>
      <DialogTitle>Discard unsaved changes?</DialogTitle>
      <DialogContent><DialogContentText>Your draft has not been published. Discarding restores the current server revision.</DialogContentText></DialogContent>
      <DialogActions>
        <Button onClick={onStay}>Keep editing</Button>
        <Button color="error" onClick={onDiscard}>Discard draft</Button>
      </DialogActions>
    </Dialog>
  )
}

export function RevisionConflictDialog({ open, onContinue, onExport, onReload }) {
  return (
    <Dialog open={open} onClose={onContinue}>
      <DialogTitle>Layout changed on the server</DialogTitle>
      <DialogContent><DialogContentText>Another administrator published a newer revision. Your draft is intact and has not been overwritten.</DialogContentText></DialogContent>
      <DialogActions>
        <Button onClick={onContinue}>Continue editing</Button>
        <Button onClick={onExport}>Export draft</Button>
        <Button variant="contained" onClick={onReload}>Reload server version</Button>
      </DialogActions>
    </Dialog>
  )
}
