import { cloneDefaultLayout } from './defaultLayout'
import { SYMBOLS } from '@/components/mimic/symbols'

const KEY = 'mml.mimic.boiler-1'
const VERSION = 1

/**
 * Layout persistence. localStorage only — /monitor has no backend and no
 * `src/api/*` module. The document shape is deliberately serialisable and
 * flat so a later `mimic_layouts` table is a mechanical swap: one api
 * wrapper replaces this file and nothing above it changes.
 */

function isValid(doc) {
  if (!doc || doc.version !== VERSION || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
    return false
  }
  return doc.nodes.every((n) => (
    n && typeof n.id === 'string' && SYMBOLS[n.type]
      && Number.isFinite(n.x) && Number.isFinite(n.y)
      && Number.isFinite(n.w) && Number.isFinite(n.h)
  ))
}

/** Returns the stored layout, or a fresh copy of the seed. Never throws. */
export function loadLayout() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return cloneDefaultLayout()
    const doc = JSON.parse(raw)
    // A layout saved against an older symbol registry can reference a type
    // that no longer exists. Fall back rather than render a broken mimic.
    if (!isValid(doc)) return cloneDefaultLayout()
    return doc
  } catch {
    return cloneDefaultLayout()
  }
}

export function saveLayout(layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...layout, version: VERSION }))
    return true
  } catch {
    return false
  }
}

export function resetLayout() {
  try {
    localStorage.removeItem(KEY)
  } catch { /* private mode — the in-memory reset below still applies */ }
  return cloneDefaultLayout()
}
