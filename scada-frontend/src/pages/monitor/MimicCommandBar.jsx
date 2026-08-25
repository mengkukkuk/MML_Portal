import UndoOutlined from '@mui/icons-material/UndoOutlined'
import RedoOutlined from '@mui/icons-material/RedoOutlined'
import RotateRightOutlined from '@mui/icons-material/RotateRightOutlined'
import DeleteOutlineOutlined from '@mui/icons-material/DeleteOutlineOutlined'
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined'
import FileUploadOutlined from '@mui/icons-material/FileUploadOutlined'
import FileDownloadOutlined from '@mui/icons-material/FileDownloadOutlined'
import SaveOutlined from '@mui/icons-material/SaveOutlined'
import styles from './EditorChrome.module.css'

function Command({ label, icon, ...props }) {
  return <button type="button" className={styles.command} {...props}>{icon}<span>{label}</span></button>
}

export default function MimicCommandBar({
  canUndo, canRedo, hasSelection, canRotate, dirty, saving,
  onUndo, onRedo, onRotate, onDelete, onReset, onImport, onExport, onCancel, onSave,
}) {
  return (
    <div className={styles.commandBar} role="toolbar" aria-label="Layout commands">
      <div className={styles.commandCluster}>
        <Command label="Undo" icon={<UndoOutlined fontSize="small" />} disabled={saving || !canUndo} onClick={onUndo} />
        <Command label="Redo" icon={<RedoOutlined fontSize="small" />} disabled={saving || !canRedo} onClick={onRedo} />
        <Command label="Rotate 90°" icon={<RotateRightOutlined fontSize="small" />} disabled={saving || !canRotate} onClick={onRotate} />
        <Command label="Delete" icon={<DeleteOutlineOutlined fontSize="small" />} disabled={saving || !hasSelection} onClick={onDelete} />
        <Command label="Reset" icon={<RestartAltOutlined fontSize="small" />} disabled={saving} onClick={onReset} />
        <Command label="Import" icon={<FileUploadOutlined fontSize="small" />} disabled={saving} onClick={onImport} />
        <Command label="Export" icon={<FileDownloadOutlined fontSize="small" />} disabled={saving} onClick={onExport} />
      </div>
      <div className={styles.saveCluster}>
        <span className={`${styles.dirtyState} ${dirty ? styles.dirtyStateOn : ''}`}>
          <span aria-hidden="true" />{dirty ? 'Unsaved changes' : 'No changes'}
        </span>
        <button type="button" className={styles.cancelButton} disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className={styles.saveButton} disabled={!dirty || saving} onClick={onSave}>
          <SaveOutlined fontSize="small" />{saving ? 'Saving…' : 'Save layout'}
        </button>
      </div>
    </div>
  )
}
