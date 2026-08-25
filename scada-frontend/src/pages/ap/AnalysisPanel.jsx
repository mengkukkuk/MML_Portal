import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import TroubleshootRoundedIcon from '@mui/icons-material/TroubleshootRounded'
import styles from './APPage.module.css'

const LOSS_TYPE_LABELS = {
  unplanned: 'Unplanned stop',
  quality: 'Quality loss',
  planned: 'Planned loss',
  observation: 'Observed pattern',
}

export default function AnalysisPanel({ incidents, insufficientHistory, onSelect }) {
  return (
    <section className={`${styles.workPanel} ${styles.analysisPanel}`} aria-labelledby="analysis-title">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Analysis</p>
          <h2 id="analysis-title">What happened, and what changed first</h2>
        </div>
        <TroubleshootRoundedIcon className={styles.analysisIcon} aria-hidden="true" />
      </header>

      {incidents.length > 0 ? (
        <div className={styles.incidentList}>
          {incidents.map((incident) => (
            <button
              key={incident.id}
              type="button"
              className={styles.incidentCard}
              onClick={() => onSelect('incident', incident.id)}
            >
              <span className={`${styles.statusPill} ${styles[`status_${incident.severity}`] ?? ''}`}>
                {LOSS_TYPE_LABELS[incident.lossType] ?? 'Observed'}
              </span>
              <span className={styles.cardTime}>{incident.occurred}</span>
              <strong>{incident.title}</strong>
              <span className={styles.cardMachine}>{incident.machine}</span>
              <span className={styles.cardSummary}>{incident.summary}</span>
              <span className={styles.cardMetrics}>
                <span><b>{incident.durationMinutes}</b> min affected</span>
                <span><b>{incident.lostUnits}</b> units lost</span>
                <span><b>{incident.similarIncidents}</b> similar</span>
              </span>
              <span className={styles.cardAction}>Inspect evidence <ArrowForwardRoundedIcon fontSize="small" /></span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <span>{insufficientHistory ? 'Historian coverage is insufficient' : 'No observed incidents'}</span>
          <p>
            {insufficientHistory
              ? 'Collect more operating history before relying on incident analysis.'
              : 'No production-loss incidents occurred for this machine in the selected period.'}
          </p>
        </div>
      )}
    </section>
  )
}
