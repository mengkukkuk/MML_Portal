import styles from './blocks.module.css'

/**
 * ReportBlock — the frame every block renders inside: title, optional note,
 * and a `page-break-inside: avoid` hook (see styles/print.css) so a block never
 * splits across two printed pages.
 */
export default function ReportBlock({ title, note, children, className }) {
  return (
    <section
      className={`${styles.block} report-block ${className ?? ''}`}
      data-report-block=""
    >
      {(title || note) && (
        <header className={styles['block__head']}>
          {title && <h3 className={styles['block__title']}>{title}</h3>}
          {note && <span className={styles['block__note']}>{note}</span>}
        </header>
      )}
      {children}
    </section>
  )
}
