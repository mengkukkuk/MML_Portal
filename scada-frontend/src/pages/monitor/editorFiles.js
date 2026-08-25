import { LAYOUT_VERSION } from './defaultLayout.js'

export const MIMIC_EXPORT_KIND = 'mml-mimic'
export const MIMIC_EXPORT_VERSION = 1

function assertLayout(doc) {
  if ((doc?.version ?? 1) > LAYOUT_VERSION) {
    throw new Error(`Unsupported MML layout version: ${doc.version}.`)
  }
  const valid = doc && typeof doc === 'object'
    && Array.isArray(doc.nodes) && Array.isArray(doc.edges)
    && doc.viewBox && Number.isFinite(doc.viewBox.w) && doc.viewBox.w > 0
    && Number.isFinite(doc.viewBox.h) && doc.viewBox.h > 0
    && doc.nodes.every((node) => node && typeof node.id === 'string'
      && Number.isFinite(node.x) && Number.isFinite(node.y)
      && Number.isFinite(node.w) && node.w > 0
      && Number.isFinite(node.h) && node.h > 0
      && typeof node.type === 'string')
  if (!valid) throw new Error('The selected file is not a supported MML layout document.')

  const nodeIds = new Set(doc.nodes.map((node) => node.id))
  if (nodeIds.size !== doc.nodes.length) {
    throw new Error('The selected layout contains duplicate symbol identifiers.')
  }
  const edgeIds = new Set()
  const validEdges = doc.edges.every((edge) => {
    if (!edge || typeof edge.id !== 'string' || edgeIds.has(edge.id)) return false
    edgeIds.add(edge.id)
    return typeof edge.from?.port === 'string' && nodeIds.has(edge.from?.node)
      && typeof edge.to?.port === 'string' && nodeIds.has(edge.to?.node)
      && (edge.flowNode == null || nodeIds.has(edge.flowNode))
  })
  if (!validEdges) {
    throw new Error('The selected layout contains an invalid wire or endpoint.')
  }
}

export function createMimicExport(active, doc, now = new Date()) {
  return {
    kind: MIMIC_EXPORT_KIND,
    exportVersion: MIMIC_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    slug: active.slug,
    name: active.name,
    doc: structuredClone(doc),
  }
}

export function parseMimicImport(value, active) {
  let doc = value
  if (value?.kind === MIMIC_EXPORT_KIND) {
    if (value.exportVersion !== MIMIC_EXPORT_VERSION) {
      throw new Error(`Unsupported MML export version: ${value.exportVersion}.`)
    }
    doc = value.doc
  }
  assertLayout(doc)
  return {
    ...structuredClone(doc),
    name: active.name,
    viewBox: structuredClone(doc.viewBox),
    nodes: structuredClone(doc.nodes),
    edges: structuredClone(doc.edges),
  }
}

export function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
