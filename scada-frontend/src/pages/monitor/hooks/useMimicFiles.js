import { useCallback } from 'react'
import { symbolDef } from '@/components/mimic/symbols'
import { createMimicExport, downloadJson, parseMimicImport } from '../editorFiles'
import { editLock, migrateLayout } from '../layoutDoc'

/**
 * Export the draft as a `.mml.json` file and import one back into it.
 *
 * An import is validated against *this* server before it touches the draft:
 * a layout that names a custom symbol this server does not have, or a wire on a
 * port its symbol does not draw, would otherwise be saved and then fail to
 * render for every operator.
 */
export default function useMimicFiles({
  layout, activeSlug, activeName, customSymbols, commitLayout, notify,
  setSelectedId, setSelectedEdgeId, setImportOpen,
}) {
  const exportDraft = useCallback(() => {
    const envelope = createMimicExport({ slug: activeSlug, name: activeName }, layout)
    downloadJson(`${activeSlug || 'mimic'}.mml.json`, envelope)
  }, [activeName, activeSlug, layout])

  const importDraft = useCallback(async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const parsed = parseMimicImport(JSON.parse(await file.text()), { slug: activeSlug, name: activeName })
      const migrated = migrateLayout(parsed)
      if (!migrated) throw new Error('The selected file is not a supported MML layout document.')
      const imported = {
        ...layout,
        viewBox: migrated.viewBox,
        nodes: migrated.nodes,
        edges: migrated.edges,
        name: activeName,
      }
      const importLock = editLock(imported)
      if (importLock) throw new Error(importLock)
      const importedNodes = new Map(imported.nodes.map((node) => [node.id, node]))
      const customIds = new Set(customSymbols.map((symbol) => symbol.id))
      const missingCustom = imported.nodes.find((node) => (
        node.type === 'custom'
        && (!Number.isInteger(node.symbolId) || !customIds.has(node.symbolId))
      ))
      if (missingCustom) {
        throw new Error('The selected layout references a custom symbol that is not installed on this server.')
      }
      const badPort = imported.edges.some((edge) => (
        !symbolDef(importedNodes.get(edge.from.node))?.ports?.[edge.from.port]
        || !symbolDef(importedNodes.get(edge.to.node))?.ports?.[edge.to.port]
      ))
      if (badPort) throw new Error('The selected layout contains a wire attached to an unsupported symbol port.')
      commitLayout(imported)
      setSelectedId(null)
      setSelectedEdgeId(null)
      setImportOpen(false)
      notify('Layout imported into the draft.', 'success')
    } catch (error) {
      notify(error.message || 'The selected file could not be imported.', 'error')
    } finally {
      event.target.value = ''
    }
  }, [
    activeName, activeSlug, commitLayout, customSymbols, layout, notify,
    setImportOpen, setSelectedEdgeId, setSelectedId,
  ])

  return { exportDraft, importDraft }
}
