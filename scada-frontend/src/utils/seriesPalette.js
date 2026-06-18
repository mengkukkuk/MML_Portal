/**
 * Shared color palette for multi-series panels.
 *
 * Used by both the panel editor (LivePage.vue) to preview each tag's swatch and
 * by the renderer (LivePanel.vue) to color each tag's series, so the colors a
 * user picks in the editor always match what they see on the chart.
 *
 * The first color equals LivePanel's legacy single-series accent (#4f8cff), so
 * existing single-tag panels look identical after the multi-tag upgrade.
 */
export const SERIES_PALETTE = [
  '#4f8cff', // accent blue (legacy single-series color)
  '#22c55e', // green
  '#e6a23c', // amber
  '#f56c6c', // red
  '#a78bfa', // violet
  '#2dd4bf', // teal
  '#f472b6', // pink
  '#facc15', // yellow
  '#38bdf8', // sky
  '#fb923c', // orange
]

/** Color for series index `i`, wrapping around the palette. */
export const colorAt = (i) => SERIES_PALETTE[((i % SERIES_PALETTE.length) + SERIES_PALETTE.length) % SERIES_PALETTE.length]
