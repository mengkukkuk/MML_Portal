import { useQueryClient } from '@tanstack/react-query'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import Portal from '@mui/material/Portal'
import SymbolBindingDialog from '../SymbolBindingDialog'
import KpiBindingDialog from '../KpiBindingDialog'
import ProductionLogDialog from '../ProductionLogDialog'
import CustomSymbolDialog from '../CustomSymbolDialog'
import { ImportLayoutDialog, RevisionConflictDialog, UnsavedChangesDialog } from '../EditorDialogs'

/**
 * Every modal and the snackbar the Monitor page can raise, in one place.
 *
 * All of them open into `overlayHost` (the full-screen element, or `<body>`
 * when windowed) — a dialog portalled outside the full-screen subtree would be
 * invisible there and trap focus. `ui` is `useMonitorUi`'s state; `actions` is
 * `useDialogActions`'s result; `lifecycle` is `useEditLifecycle`'s; `files` is
 * `useMimicFiles`'s.
 */
export default function MonitorDialogs({
  ui, actions, lifecycle, files, overlayHost, layout, snackbar, onCloseSnackbar, notify,
  onReloadServerRevision,
}) {
  const queryClient = useQueryClient()

  return (
    <>
      <SymbolBindingDialog
        open={!!ui.bindingNode}
        node={ui.bindingNode}
        container={overlayHost}
        onClose={() => ui.setBindingNode(null)}
        onSave={actions.applyBinding}
      />

      <KpiBindingDialog
        open={!!ui.editingKpi}
        kpi={ui.editingKpi}
        container={overlayHost}
        onClose={() => ui.setEditingKpi(null)}
        onSave={actions.applyKpi}
        onRemove={actions.removeKpi}
      />

      <ProductionLogDialog
        open={ui.productionSettingsOpen}
        binding={layout?.productionLog ?? null}
        container={overlayHost}
        onClose={() => ui.setProductionSettingsOpen(false)}
        onSave={actions.applyProductionLog}
      />

      <CustomSymbolDialog
        open={ui.authoring}
        container={overlayHost}
        onClose={() => ui.setAuthoring(false)}
        onSaved={(row) => {
          queryClient.invalidateQueries({ queryKey: ['mimic-symbols'] })
          ui.setAuthoring(false)
          notify(`“${row.name}” added to the symbol library.`)
        }}
      />

      <ImportLayoutDialog
        open={ui.importOpen}
        container={overlayHost}
        onClose={() => ui.setImportOpen(false)}
        onImport={files.importDraft}
      />
      <UnsavedChangesDialog
        open={ui.unsavedOpen}
        container={overlayHost}
        onStay={lifecycle.keepEditing}
        onDiscard={lifecycle.discardUnsaved}
      />
      <RevisionConflictDialog
        open={ui.conflictOpen}
        container={overlayHost}
        onContinue={() => ui.setConflictOpen(false)}
        onExport={files.exportDraft}
        onReload={onReloadServerRevision}
      />

      {/* Snackbar is the one overlay here that is not a modal, so it has no
        * container of its own to redirect — it is portalled explicitly for the
        * same reason the dialogs are. */}
      <Portal container={overlayHost}>
        <Snackbar
          open={snackbar.open}
          autoHideDuration={4000}
          onClose={onCloseSnackbar}
          anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        >
          <Alert
            severity={snackbar.severity}
            onClose={onCloseSnackbar}
            sx={{ width: '100%' }}
          >
            {snackbar.message}
          </Alert>
        </Snackbar>
      </Portal>
    </>
  )
}
