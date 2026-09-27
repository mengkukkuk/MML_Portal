/**
 * Symbol colours — how a mimic symbol picks up a colour from the palette.
 *
 * Two layers, most specific first:
 *   1. the symbol's own colour  — `node.options.color`, set in the inspector;
 *   2. its category's colour    — only when the drawing has "colour by
 *      category" on (`layout.theme.byCategory`), from
 *      `layout.theme.categories[category]` or CATEGORY_COLORS below.
 * With neither, a symbol draws exactly as it always did — this is opt-in, so
 * no existing drawing changes colour on upgrade.
 *
 * Every colour is one of the LED lens hexes (LED_PALETTE): one palette for the
 * whole sheet, so a lamp and the pump it reports on can be made to match.
 *
 * A colour reaches the drawing as CSS custom properties on the symbol's group
 * (`--sym-accent`, `--sym-stroke`, `--sym-fill`, `--sym-fill-elev`), read by
 * symbols.module.css with the app theme as fallback. They are deliberately not
 * `--accent`: the selection halo and resize grips live inside the same group
 * and must keep the app's accent whatever colour the equipment is painted.
 *
 * Status still wins. `.statusWarn .body` / `.statusCrit .body` outrank the
 * plain `.body` rule, so a painted pump in alarm still turns amber or red — a
 * presentation colour must never hide a fault.
 */

import { LED_PALETTE } from './palette.js'

/** Picked from LED_PALETTE so the defaults are colours the picker can show. */
export const CATEGORY_COLORS = {
  process: '#007aff',
  electrical: '#ffcc00',
  automation: '#5856d6',
  vision: '#00c7be',
  water: '#32ade6',
  tobacco: '#ff9500',
  dcim: '#34c759',
  utility: '#8e8e93',
  custom: '#af52de',
}

const HEX_RE = /^#[0-9a-f]{6}$/i

/** Every hex the palette offers, for validating a colour read off a document. */
export const PALETTE_HEXES = new Set(LED_PALETTE.flat().map((h) => h.toLowerCase()))

/**
 * A colour from a saved drawing is untrusted text: it ends up inside a CSS
 * value, so anything but a plain #rrggbb is dropped rather than interpolated.
 */
export function cleanHex(value) {
  return typeof value === 'string' && HEX_RE.test(value) ? value.toLowerCase() : null
}

/** The category colour a drawing uses, override first. */
export function categoryColor(theme, category) {
  if (!category) return null
  return cleanHex(theme?.categories?.[category]) ?? CATEGORY_COLORS[category] ?? null
}

/** The colour this symbol is drawn in, or null for the app's default look. */
export function resolveSymbolColor(node, def, theme) {
  const own = cleanHex(node?.options?.color)
  if (own) return own
  if (!theme?.byCategory) return null
  return categoryColor(theme, def?.category)
}

/**
 * The CSS custom properties that paint one symbol. The body keeps the panel as
 * its base and takes only a tint of the colour, so the readout text inside a
 * body stays legible on every palette colour — including white and yellow.
 */
export function symbolColorStyle(hex) {
  const color = cleanHex(hex)
  if (!color) return undefined
  return {
    '--sym-accent': color,
    '--sym-stroke': color,
    '--sym-fill': `color-mix(in srgb, ${color} 12%, var(--bg-panel))`,
    '--sym-fill-elev': `color-mix(in srgb, ${color} 24%, var(--bg-elev))`,
  }
}
