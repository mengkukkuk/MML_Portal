import styles from './CollapseHeader.module.css'

/**
 * The clickable header of a collapsible group, shared by the Alarms active
 * grid, the Alarms log stack and the Events log stack.
 *
 * Exists because those three used a clickable <header> with a nested <button>
 * for the +/- glyph: only the 20px glyph was reachable by keyboard, nothing
 * announced open/closed state, and the two handlers needed a stopPropagation
 * to avoid toggling twice. Adding a third nesting level would have cloned that
 * three more times, so the header itself is now the button and the glyph is
 * decorative.
 *
 * Styling stays with the caller — each page owns its own CSS module and the
 * rows/tiles look nothing alike — so this only contributes the reset that stops
 * a <button> from inheriting the browser's centred, 13px, bordered defaults in
 * place of the flex row the page CSS expects.
 */
export default function CollapseHeader({
  open,
  onToggle,
  controls,
  className = '',
  children,
  ...rest
}) {
  return (
    <button
      type="button"
      className={`${styles.head} ${className}`}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      {...rest}
    >
      {children}
    </button>
  )
}

/** The +/- glyph. Purely decorative: aria-expanded on the header already
 * carries the state, so announcing "plus button" on top of it is noise. */
export function CollapseMark({ open, className = '' }) {
  return (
    <span className={`${styles.mark} ${className}`} aria-hidden="true">
      {open ? '−' : '+'}
    </span>
  )
}
