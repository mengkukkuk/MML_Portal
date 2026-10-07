import { useCallback } from 'react'
import { blankKpi } from '../kpiBoxes'

/**
 * What the binding, headline-number and production-log dialogs do to the draft
 * when they are saved.
 *
 * Every one of these goes through `commitLayout`, so the strip and the log
 * settings join the same draft, undo stack and unsaved-changes guard as the
 * drawing itself. Nothing here is written straight to the server.
 */
export default function useDialogActions({
  layout, commitLayout, kpis, ui, notify,
}) {
  const {
    bindingNode, setBindingNode, editingKpi, setEditingKpi, setProductionSettingsOpen,
  } = ui

  // --- binding dialog ------------------------------------------------------
  const openBinding = useCallback((node) => setBindingNode(node), [setBindingNode])

  const applyBinding = useCallback(({ tagId, label, binding }) => {
    const next = {
      ...layout,
      nodes: layout.nodes.map((n) => (n.id === bindingNode.id
        ? { ...n, tagId, label, binding }
        : n)),
    }
    commitLayout(next)
    setBindingNode(null)
    notify(binding ? 'Binding updated in the draft.'
      : bindingNode.binding ? 'Symbol disconnected in the draft.'
        : 'Symbol updated in the draft (no data source).')
  }, [bindingNode, commitLayout, layout, notify, setBindingNode])

  // --- production log ------------------------------------------------------
  const applyProductionLog = useCallback((binding) => {
    commitLayout((previous) => ({ ...previous, productionLog: binding }))
    setProductionSettingsOpen(false)
    notify(binding ? 'Production log settings updated in the draft.' : 'Production log removed from the draft.')
  }, [commitLayout, notify, setProductionSettingsOpen])

  // --- headline numbers ----------------------------------------------------
  const commitKpis = useCallback((next) => {
    commitLayout((previous) => ({ ...previous, kpis: next }))
  }, [commitLayout])

  const addKpi = useCallback(() => {
    const kpi = blankKpi()
    commitKpis([...kpis, kpi])
    // Opened straight away: an empty box prints an em-dash, and adding one is
    // only ever the first half of the thing an admin came to do.
    setEditingKpi(kpi)
  }, [commitKpis, kpis, setEditingKpi])

  const applyKpi = useCallback((next) => {
    commitKpis(kpis.map((kpi) => (kpi.id === next.id ? next : kpi)))
    setEditingKpi(null)
    notify('Headline number updated in the draft.')
  }, [commitKpis, kpis, notify, setEditingKpi])

  const removeKpi = useCallback(() => {
    if (!editingKpi) return
    commitKpis(kpis.filter((kpi) => kpi.id !== editingKpi.id))
    setEditingKpi(null)
    notify('Headline number removed from the draft.')
  }, [commitKpis, editingKpi, kpis, notify, setEditingKpi])

  return {
    openBinding, applyBinding, applyProductionLog, commitKpis, addKpi, applyKpi, removeKpi,
  }
}
