import { useEffect, useState } from 'react'
import Popover from '@mui/material/Popover'
import FormControl from '@mui/material/FormControl'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import SettingsIcon from '@mui/icons-material/Settings'
import TuneIcon from '@mui/icons-material/Tune'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CloseIcon from '@mui/icons-material/Close'
import { useTranslation } from '@/i18n'
import { apiErrorMessage } from '@/api/client'
import { KPI_POLL_INTERVALS } from '@/pages/live/kpiPayload'
import { POLL_INTERVALS } from './usePanelSeries'
import { useKpiSummary } from './useKpiSummary'
import LossMeter from './blocks/LossMeter'
import AndonBoard from './blocks/AndonBoard'
import LossWaterfall from './blocks/LossWaterfall'
import styles from './LivePanel.module.css'
import blockStyles from './blocks/Blocks.module.css'

const KPI_POLL_CHOICES = POLL_INTERVALS.filter((it) => KPI_POLL_INTERVALS.includes(it.value))

const PERIOD_LABELS = { today: 'Today', week: 'This week', month: 'This month' }

/**
 * KpiPanel — a Live grid tile for a management block (source 'kpi'): Loss
 * meter, Andon board or Loss waterfall.
 *
 * Same chrome as LivePanel (frosted tile, drag handle, heartbeat pill, gear)
 * so the blocks sit naturally beside trends and gauges, but none of its series
 * pipeline: the figures come whole from /kpi/summary (useKpiSummary), computed
 * on the server. The gear's Edit opens the side inspector (KpiInspector) rather
 * than the chart editor dialog; while it is open, `draft` makes this tile
 * preview the unsaved settings.
 */
export default function KpiPanel({
  panel,
  draft = null,
  canManage = false,
  canChangePollInterval = false,
  editMode = false,
  refreshSignal = 0,
  onEdit,
  onDuplicate,
  onDelete,
  onPollIntervalChange,
  onUpdated,
}) {
  const tr = useTranslation()
  const shown = draft ? { ...panel, title: draft.title } : panel
  const query = useKpiSummary(panel, { draft, refreshSignal })
  const summary = query.data
  const [gearAnchor, setGearAnchor] = useState(null)
  const gearOpen = !!gearAnchor
  const closeGear = () => setGearAnchor(null)

  useEffect(() => {
    if (query.dataUpdatedAt) onUpdated?.(query.dataUpdatedAt)
  }, [query.dataUpdatedAt, onUpdated])

  const pollSeconds = panel.poll_interval_seconds || 60
  const pollLabel = POLL_INTERVALS.find((it) => it.value === pollSeconds)?.label || `${pollSeconds}s`
  const bound = draft ? !!draft.table_name : !!panel.table_name
  const kpi = (draft?.kpi || panel.options?.kpi) ?? {}
  const machines = summary?.families?.length

  return (
    <article className={styles.panel}>
      {query.isFetching && <span className={styles.panel__progress} aria-hidden="true" />}

      <header className={styles.panel__head}>
        <div className={styles.panel__titlewrap}>
          {editMode && canManage && (
            <button
              type="button"
              className={`${styles.panel__drag} panel__drag`}
              title="Drag to move"
              aria-label="Drag to move panel"
            >
              ⠿
            </button>
          )}
          <h3 className={styles.panel__title}>{shown.title}</h3>
        </div>

        <div className={styles.panel__actions}>
          <span
            className={`${styles.panel__live} ${query.isFetching ? styles['panel__live--busy'] : ''}`}
            title={`Live · refreshing every ${pollLabel}`}
          >
            <span className={styles.panel__livedot} />
            {pollLabel}
          </span>
          <button
            type="button"
            className={`${styles.panel__gear} ${gearOpen ? styles['panel__gear--active'] : ''}`}
            title="Panel settings"
            aria-label="Panel settings"
            onClick={(e) => setGearAnchor(e.currentTarget)}
          >
            <SettingsIcon fontSize="small" />
          </button>
          <Popover
            open={gearOpen}
            anchorEl={gearAnchor}
            onClose={closeGear}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            slotProps={{ paper: { className: styles.gearpopPaper } }}
          >
            <div className={styles.gearpop}>
              <div className={styles.gearpop__row}>
                <span className={styles.gearpop__label}>Poll interval</span>
                <FormControl size="small" className={styles.gearpop__control} disabled={!canChangePollInterval}>
                  <Select
                    value={KPI_POLL_INTERVALS.includes(pollSeconds) ? pollSeconds : 60}
                    disabled={!canChangePollInterval}
                    onChange={(e) => onPollIntervalChange?.(panel, Number(e.target.value))}
                  >
                    {KPI_POLL_CHOICES.map((it) => (
                      <MenuItem key={it.value} value={it.value}>{it.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </div>
              {canManage && (
                <>
                  <div className={styles.gearpop__divider} />
                  <button type="button" className={styles.gearpop__action} onClick={() => { closeGear(); onEdit?.(panel) }}>
                    <TuneIcon fontSize="inherit" /> {tr('Block settings')}
                  </button>
                  <button type="button" className={styles.gearpop__action} onClick={() => { closeGear(); onDuplicate?.(panel) }}>
                    <ContentCopyIcon fontSize="inherit" /> Duplicate
                  </button>
                  <button
                    type="button"
                    className={`${styles.gearpop__action} ${styles['gearpop__action--danger']}`}
                    onClick={() => { closeGear(); onDelete?.(panel) }}
                  >
                    <CloseIcon fontSize="inherit" /> Delete
                  </button>
                </>
              )}
            </div>
          </Popover>
        </div>
      </header>

      {bound && (
        <div className={styles.panel__meta}>
          <span className={blockStyles.foot} style={{ marginTop: 0 }}>
            {tr(PERIOD_LABELS[kpi.period] || 'Today')}
            {machines ? ` · ${tr('{n} machines', { n: machines })}` : ''}
          </span>
        </div>
      )}

      <div className={blockStyles.body}>
        {!bound && (
          <p className={blockStyles.empty}>
            {canManage ? tr('Choose a table in block settings to start.') : tr('This block is not set up yet.')}
          </p>
        )}
        {bound && query.error && !summary && (
          <p className={styles.panel__error}>{apiErrorMessage(query.error, 'Failed to load figures.')}</p>
        )}
        {bound && query.isPending && !summary && <p className={blockStyles.empty}>{tr('Loading…')}</p>}
        {bound && summary && panel.chart_type === 'lossmeter' && <LossMeter summary={summary} mode={kpi.mode} />}
        {bound && summary && panel.chart_type === 'andon' && <AndonBoard summary={summary} />}
        {bound && summary && panel.chart_type === 'waterfall' && <LossWaterfall summary={summary} />}
      </div>
    </article>
  )
}
