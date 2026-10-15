import { useCallback } from 'react'
import { blankKpi, withKpiWidth } from '../kpiBoxes'
import { blankNotice, NOTICE_LIMIT } from '../noticeBox'

/**
 * What the binding, headline-number, message-box and production-log dialogs do
 * to the draft when they are saved.
 *
 * Every one of these goes through `commitLayout`, so the strip and the log
 * settings join the same draft, undo stack and unsaved-changes guard as the
 * drawing itself. Nothing here is written straight to the server.
 */
export default function useDialogActions({
  layout, commitLayout, kpis, notices, ui, notify,
}) {
  const {
    bindingNode, setBindingNode, editingKpi, setEditingKpi, editingNotice, setEditingNotice,
    setProductionSettingsOpen,
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

  // A width change is a draft edit like any other (undoable, saved with the
  // document). No toast: it is a direct manipulation and the box moving is the
  // confirmation. `null` puts the box back to automatic.
  const resizeKpi = useCallback((id, width) => {
    commitKpis(kpis.map((kpi) => (kpi.id === id ? withKpiWidth(kpi, width) : kpi)))
  }, [commitKpis, kpis])

  const removeKpi = useCallback(() => {
    if (!editingKpi) return
    commitKpis(kpis.filter((kpi) => kpi.id !== editingKpi.id))
    setEditingKpi(null)
    notify('Headline number removed from the draft.')
  }, [commitKpis, editingKpi, kpis, notify, setEditingKpi])

  // --- message boxes (attention strip) --------------------------------------
  const commitNotices = useCallback((next) => {
    commitLayout((previous) => ({ ...previous, notices: next }))
  }, [commitLayout])

  const addNotice = useCallback(() => {
    if (notices.length >= NOTICE_LIMIT) return
    const notice = blankNotice()
    commitNotices([...notices, notice])
    // Opened straight away, like a new KPI box: adding one is only ever the
    // first half of what an admin came to do.
    setEditingNotice(notice)
  }, [commitNotices, notices, setEditingNotice])

  const applyNotice = useCallback((next) => {
    commitNotices(notices.map((n) => (n.id === next.id ? next : n)))
    setEditingNotice(null)
    notify('Message box updated in the draft.')
  }, [commitNotices, notices, notify, setEditingNotice])

  // The inline title edit. A direct manipulation like a KPI resize: undoable,
  // saved with the document, no toast — the title changing is the confirmation.
  const renameNotice = useCallback((id, patch) => {
    commitNotices(notices.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  }, [commitNotices, notices])

  const removeNotice = useCallback(() => {
    if (!editingNotice) return
    commitNotices(notices.filter((n) => n.id !== editingNotice.id))
    setEditingNotice(null)
    notify('Message box removed from the draft.')
  }, [commitNotices, editingNotice, notices, notify, setEditingNotice])

  return {
    openBinding, applyBinding, applyProductionLog, commitKpis, addKpi, applyKpi, resizeKpi, removeKpi,
    addNotice, applyNotice, renameNotice, removeNotice,
  }
}
