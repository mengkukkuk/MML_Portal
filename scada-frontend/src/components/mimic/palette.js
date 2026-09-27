/**
 * The lens colours a lamp can be fitted with, laid out as a honeycomb by the
 * inspector: five rows of 3·4·5·4·3.
 *
 * Since the symbol colour picker these are also the colours any mimic
 * symbol can be painted in (see symbolColors.js). Kept in a plain module,
 * not Led.jsx, so node --test can import it.
 *
 * Nineteen is a centred hexagonal number, which is why the honeycomb comes out
 * as a regular hexagon rather than a ragged block — the shape is a consequence
 * of the count, not a decoration applied to it.
 *
 * A hand-picked wheel rather than a full RGB field on purpose. These are
 * indicator lenses: every entry has to stay legible as a small disc on a dark
 * panel, and an unrestricted picker's first offering is a dark navy that
 * disappears into the sheet. Ordered by hue so "a bit more orange" is a step
 * sideways, with the neutrals last because they are a different kind of choice.
 */
export const LED_PALETTE = [
  ['#ff3b30', '#ff6b35', '#ff9500'],
  ['#ffcc00', '#d4e157', '#7ed321', '#34c759'],
  ['#00d09c', '#00c7be', '#32ade6', '#007aff', '#5856d6'],
  ['#af52de', '#d65edb', '#ff2d92', '#ff375f'],
  ['#ffffff', '#c7c7cc', '#8e8e93'],
]
