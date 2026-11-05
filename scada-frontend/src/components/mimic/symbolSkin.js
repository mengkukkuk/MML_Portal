/**
 * symbolSkin — a picture drawn in place of a symbol's artwork.
 *
 * A skin is per node, not per type: `node.options.image = { assetId }`. It
 * replaces only what the symbol *looks like*. The node keeps its type, its data
 * binding, its ports, its size and rotation, and the balloon the canvas draws
 * beside it, so the drawing behaves exactly as before — it is the same
 * equipment, photographed.
 *
 * Kept free of imports so it can be unit-tested under plain `node --test`.
 */

/** Same ceiling the server enforces (MAX_ASSET_BYTES in mimic.py). */
export const SKIN_MAX_BYTES = 3 * 1024 * 1024

/** "850 KB" below a megabyte, "3.2 MB" above — the unit an admin thinks in. */
export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}

/**
 * What the file picker offers. Extensions are listed beside the MIME types
 * because Windows reports no type at all for some .bmp files, and a picker that
 * greys those out reads as "BMP is not supported".
 */
export const SKIN_ACCEPT = 'image/png,image/jpeg,image/gif,image/bmp,.png,.jpg,.jpeg,.gif,.bmp'

const BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
}

const BY_EXTENSION = {
  png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', bmp: 'bmp',
}

/**
 * 'png' | 'jpeg' | 'gif' | 'bmp', or null for anything else.
 *
 * A declared type that names some *other* format wins over the extension — a
 * WebP renamed to .png is not a PNG — but an empty or generic type falls back to
 * the extension. This is only fast feedback; the server sniffs the bytes and is
 * the real authority.
 */
export function skinFileKind(file) {
  const type = (file?.type ?? '').toLowerCase()
  if (BY_MIME[type]) return BY_MIME[type]
  if (type && type !== 'application/octet-stream') return null
  const ext = /\.([a-z0-9]+)$/i.exec(file?.name ?? '')?.[1]?.toLowerCase()
  return BY_EXTENSION[ext] ?? null
}

/** The uploaded asset a node is skinned with, or null for the drawn symbol. */
export function skinAssetId(node) {
  const id = node?.options?.image?.assetId
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Whether a symbol type has artwork to replace.
 *
 * The utility group (counter, table, display box, LED, annunciator) *is* its
 * reading: the face is the number, the word, or the lit lens. A picture there
 * would not restyle the symbol, it would delete it. `custom` symbols are already
 * pictures, authored in the library.
 */
export function isSkinnable(def) {
  return !!def && def.category !== 'utility' && def.category !== 'custom'
}

/** Options patch that skins a node (assetId given) or restores the drawing (null). */
export const skinPatch = (assetId) => ({ image: assetId == null ? undefined : { assetId } })

/** An error message for a file we will not even upload, or null if it may go. */
export function skinFileProblem(file) {
  if (!skinFileKind(file)) return `${file.name} is not a PNG, JPG, BMP or GIF image.`
  return null
}

/** A message when a (possibly converted) image is over the limit, else null. */
export function skinSizeProblem(name, bytes) {
  if (bytes <= SKIN_MAX_BYTES) return null
  return `${name} is ${formatSize(bytes)}. The limit is ${formatSize(SKIN_MAX_BYTES)}.`
}
