import KpiStrip from '../KpiStrip'
import { statusLabelOf } from '../monitorStatus'
import { dotClassFor } from './statusDot'
import styles from '../MonitorPage.module.css'

/**
 * The banner full screen adds back.
 *
 * Going full screen drops the page header, and with it the first two things
 * anyone reading a mimic from across a control room needs: which plant this
 * is, and whether it is running.
 *
 * `tools` is the view-mode control cluster. It moves into this bar rather
 * than floating over the sheet, because on a wall display the drawing is the
 * whole point and every overlay is sitting on top of something an operator
 * wanted to see — in the bottom corner it covered a station's own label.
 * Between the title and the status is dead space the banner already owns.
 */
export default function FullscreenHead({
  fullscreen, name, kpis, tags, status, tools = null,
}) {
  if (!fullscreen) return null
  return (
    <header className={styles.fsHead}>
      <div className={styles.fsTitle}>
        <span className={styles.fsEyebrow}>Process mimic</span>
        <h2 className={styles.fsName}>{name}</h2>
      </div>
      {/* Full screen drops the page header, and with it the strip. A wall
        * display is exactly when these figures are wanted most, so the banner
        * carries them for the same reason it carries the title and the status.
        * Read-only here: the editor is never full screen. */}
      <KpiStrip kpis={kpis} tags={tags} inBanner />
      {tools}
      <span className={styles.fsState}>
        <span className={`${styles.dot} ${dotClassFor(status)}`} />
        {statusLabelOf(status)}
      </span>
    </header>
  )
}
