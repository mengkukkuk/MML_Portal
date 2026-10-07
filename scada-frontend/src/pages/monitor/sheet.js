/** The default sheet, and the size every drawing falls back to. */
export const VIEW_W = 1600
export const VIEW_H = 900

/** A drawing's sheet size, falling back to Standard for older documents. */
export function sheetOf(layout) {
  return { w: layout?.viewBox?.w || VIEW_W, h: layout?.viewBox?.h || VIEW_H }
}
