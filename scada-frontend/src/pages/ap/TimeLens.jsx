import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import OnlinePredictionRoundedIcon from '@mui/icons-material/OnlinePredictionRounded'
import styles from './APPage.module.css'

function positionFor(item, timeline) {
  if (item.minutes < 0) {
    return 50 - (Math.abs(item.minutes) / timeline.pastWindow) * 46
  }
  return 50 + (item.minutes / timeline.futureWindow) * 46
}

function LensMarker({ item, timeline, onSelect }) {
  const position = positionFor(item, timeline)
  return (
    <button
      type="button"
      className={`${styles.lensMarker} ${styles[`lensMarker_${item.entityType}`]} ${styles[`lensMarker_${item.tone}`] ?? ''}`}
      style={{ '--lens-position': `${position}%`, '--lens-lane': item.lane }}
      aria-label={`${item.entityType === 'incident' ? 'Observed' : 'Predicted'}: ${item.title}, ${item.label}`}
      onClick={() => onSelect(item.entityType, item.entityId)}
    >
      <span className={styles.markerDot} aria-hidden="true" />
      <span className={styles.markerLabel}>{item.label}</span>
      <span className={styles.markerTitle}>{item.title}</span>
    </button>
  )
}

function ForecastWindow({ item, timeline }) {
  const position = positionFor(item, timeline)
  const width = (item.windowMinutes / timeline.futureWindow) * 46
  return (
    <span
      className={`${styles.forecastWindow} ${styles[`forecastWindow_${item.tone}`] ?? ''}`}
      style={{ '--window-start': `${position}%`, '--window-width': `${width}%` }}
      aria-hidden="true"
    />
  )
}

export default function TimeLens({ timeline, onSelect }) {
  const hasEvents = timeline.past.length > 0 || timeline.future.length > 0

  return (
    <section className={styles.timeLens} aria-labelledby="time-lens-title">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Evidence horizon</p>
          <h2 id="time-lens-title">From observed loss to emerging risk</h2>
        </div>
        <p className={styles.sectionNote}>Select any marker to inspect its historian evidence.</p>
      </header>

      <div className={styles.lensLabels} aria-hidden="true">
        <span><HistoryRoundedIcon fontSize="small" /> Analysis · what happened</span>
        <span>Prediction · what may happen <OnlinePredictionRoundedIcon fontSize="small" /></span>
      </div>

      <div className={styles.lensPlot}>
        <div className={styles.lensPast} aria-hidden="true" />
        <div className={styles.lensFuture} aria-hidden="true" />
        <div className={styles.nowLine} aria-hidden="true"><span>Now</span></div>
        {timeline.future.map((item) => <ForecastWindow key={`window-${item.id}`} item={item} timeline={timeline} />)}
        {hasEvents ? (
          [...timeline.past, ...timeline.future].map((item) => (
            <LensMarker key={item.id} item={item} timeline={timeline} onSelect={onSelect} />
          ))
        ) : (
          <p className={styles.lensEmpty}>No usable historian events in this period.</p>
        )}
      </div>

      <div className={styles.lensScale} aria-hidden="true">
        <span>-{Math.round(timeline.pastWindow / 60)}h</span>
        <span>Historian</span>
        <span>Next {timeline.futureWindow}m</span>
      </div>
    </section>
  )
}
