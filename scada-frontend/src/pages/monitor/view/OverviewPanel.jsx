import { useCallback, useState } from 'react'
import Button from '@mui/material/Button'
import ExpandLessOutlined from '@mui/icons-material/ExpandLessOutlined'
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined'
import MimicSwitcher from '../MimicSwitcher'
import { statusLabelOf } from '../monitorStatus'
import CadenceControl from './CadenceControl'
import { dotClassFor } from './statusDot'
import styles from '../MonitorPage.module.css'

/** Where the overview panel remembers whether it was folded away. */
const OVERVIEW_KEY = 'mml.monitor.overviewOpen'

/**
 * Whether the overview panel above the drawing is open.
 *
 * A view preference, not part of the document: two operators watching the
 * same plant may reasonably want different amounts of chrome, and folding the
 * panel must never look like an edit to the drawing. Kept per browser for the
 * same reason — and read defensively, because a private window or blocked
 * site data makes every one of these accessors throw.
 */
function useOverviewOpen() {
  const [overviewOpen, setOverviewOpen] = useState(() => {
    try {
      return localStorage.getItem(OVERVIEW_KEY) !== 'closed'
    } catch {
      return true
    }
  })
  const toggleOverview = useCallback(() => {
    setOverviewOpen((open) => {
      try {
        localStorage.setItem(OVERVIEW_KEY, open ? 'closed' : 'open')
      } catch { /* private mode — the preference just does not persist */ }
      return !open
    })
  }, [])
  return [overviewOpen, toggleOverview]
}

/**
 * The overview: which drawing this is, whether it is running, how often
 * it polls, and the headline numbers — one panel rather than three
 * loose rows, and foldable, because on a mimic the drawing is the point
 * and everything above it is competing with the thing you came to see.
 *
 * What survives the fold is deliberate. The name and the running state
 * stay: a control-room display that cannot say which plant it shows, or
 * that it is in alarm, is worse than one with no panel at all. Edit
 * layout stays because hiding the primary action behind a disclosure is
 * how an admin concludes the page is broken. The cadence, the connected
 * count and the KPI strip fold away — settings and detail, all of them
 * still one click from view.
 */
export default function OverviewPanel({
  drawings, status, subtitle, cadence, showEdit, onEdit, kpiStrip,
}) {
  const [overviewOpen, toggleOverview] = useOverviewOpen()
  const {
    layouts, activeSlug, activeName, canManage, switchDisabled, onSelect,
  } = drawings

  return (
    <section
      className={`${styles.overview} ${overviewOpen ? '' : styles.overviewClosed}`}
      aria-label="Mimic overview"
    >
      <header className={styles.bar}>
        <div className={styles.titleWrap}>
          <MimicSwitcher
            layouts={layouts}
            activeSlug={activeSlug}
            activeName={activeName}
            canManage={canManage}
            // A draft belongs to one server revision. Switching drawings is
            // disabled until the administrator saves or cancels the session.
            disabled={switchDisabled}
            onSelect={onSelect}
          />
          {overviewOpen && <p className={styles.sub}>{subtitle}</p>}
        </div>

        <span className={styles.plantState}>
          <span className={`${styles.dot} ${dotClassFor(status)}`} />
          {statusLabelOf(status)}
        </span>

        <div className={styles.actions}>
          {overviewOpen && <CadenceControl {...cadence} />}

          {showEdit && (
            <Button
              variant="outlined"
              color="inherit"
              onClick={onEdit}
            >
              Edit layout
            </Button>
          )}

          <button
            type="button"
            className={styles.overviewToggle}
            aria-expanded={overviewOpen}
            aria-controls="mimic-overview-detail"
            title={overviewOpen ? 'Collapse overview' : 'Expand overview'}
            aria-label={overviewOpen ? 'Collapse overview' : 'Expand overview'}
            onClick={toggleOverview}
          >
            {overviewOpen ? <ExpandLessOutlined fontSize="small" /> : <ExpandMoreOutlined fontSize="small" />}
          </button>
        </div>
      </header>

      {/* `hidden` rather than unmounted: the strip's bindings ride the shared
        * poller either way, and remounting it on every fold would restart its
        * entry in the snapshot for no gain. */}
      <div id="mimic-overview-detail" hidden={!overviewOpen}>
        {kpiStrip}
      </div>
    </section>
  )
}
