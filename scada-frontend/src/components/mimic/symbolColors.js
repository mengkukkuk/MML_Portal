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
 * (`--sym-accent`, `--sym-fill`, `--sym-fill-elev`), read by
 * symbols.module.css with the app theme as fallback. Outlines are not among
 * them: linework is always ink (`--sym-ink`), so a painted sheet keeps one pen. They are deliberately not
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

/**
 * How strongly the colour fills a symbol's body, 0–100 (%). The ink outline
 * and the coloured accents are unaffected, so even 0 leaves a readable,
 * coloured symbol — only the body wash changes. 12 is the original tint.
 */
export const DEFAULT_FILL_OPACITY = 12

/** A stored opacity is untrusted too: a whole number in 0..100, else null. */
export function cleanOpacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** The category's fill opacity on this drawing, override first. */
export function categoryOpacity(theme, category) {
  return cleanOpacity(theme?.opacities?.[category]) ?? DEFAULT_FILL_OPACITY
}

/** The colour this symbol is drawn in, or null for the app's default look. */
export function resolveSymbolColor(node, def, theme) {
  return resolveSymbolPaint(node, def, theme)?.color ?? null
}

/**
 * Colour and fill opacity together, from the same layer: a symbol with its own
 * colour uses its own opacity, one following its category uses the category's.
 * Mixing layers (own colour, category opacity) would make the category slider
 * quietly change a symbol someone deliberately painted apart from it.
 */
export function resolveSymbolPaint(node, def, theme) {
  const own = cleanHex(node?.options?.color)
  if (own) {
    return { color: own, opacity: cleanOpacity(node?.options?.colorOpacity) ?? DEFAULT_FILL_OPACITY }
  }
  if (!theme?.byCategory) return null
  const color = categoryColor(theme, def?.category)
  return color ? { color, opacity: categoryOpacity(theme, def?.category) } : null
}

/**
 * The CSS custom properties that paint one symbol. The body is the colour
 * mixed into the panel at `opacity`%, so the default tint keeps the readout
 * text inside a body legible on every palette colour — including white and
 * yellow; a high opacity is a deliberate choice for a bold, solid look. The
 * raised parts (plinths, housings) take twice the wash, capped at solid, so
 * they stay distinguishable from the body at every setting.
 */
export function symbolColorStyle(hex, opacity = DEFAULT_FILL_OPACITY) {
  const color = cleanHex(hex)
  if (!color) return undefined
  const fill = cleanOpacity(opacity) ?? DEFAULT_FILL_OPACITY
  return {
    '--sym-accent': color,
    '--sym-fill': `color-mix(in srgb, ${color} ${fill}%, var(--bg-panel))`,
    '--sym-fill-elev': `color-mix(in srgb, ${color} ${Math.min(100, fill * 2)}%, var(--bg-elev))`,
  }
}
