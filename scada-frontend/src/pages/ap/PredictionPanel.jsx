import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import OnlinePredictionRoundedIcon from '@mui/icons-material/OnlinePredictionRounded'
import styles from './APPage.module.css'

const BAND_LABELS = { high: 'High', watch: 'Watch', stable: 'Stable', unknown: 'Unavailable' }

export default function PredictionPanel({ predictions, horizon, onSelect }) {
  return (
    <section className={`${styles.workPanel} ${styles.predictionPanel}`} aria-labelledby="prediction-title">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Prediction · next {horizon}m</p>
          <h2 id="prediction-title">Production risks to investigate</h2>
        </div>
        <OnlinePredictionRoundedIcon className={styles.predictionIcon} aria-hidden="true" />
      </header>

      <div className={styles.predictionList}>
        {predictions.map((prediction) => {
          const ready = prediction.status !== 'insufficient_data'
          const percent = ready ? Math.round(prediction.risk * 100) : null
          return (
            <button
              key={prediction.id}
              type="button"
              className={`${styles.predictionCard} ${styles[`prediction_${prediction.band}`] ?? ''}`}
              onClick={() => onSelect('prediction', prediction.id)}
            >
              <span
                className={styles.riskDial}
                style={ready ? { '--risk': `${percent * 3.6}deg` } : undefined}
                aria-label={ready ? `${percent} percent risk` : 'Prediction unavailable'}
              >
                <b>{ready ? percent : '—'}</b>
                <small>{ready ? '%' : 'N/A'}</small>
              </span>
              <span className={styles.predictionBody}>
                <span className={`${styles.statusPill} ${styles[`status_${prediction.band}`] ?? ''}`}>
                  {BAND_LABELS[prediction.band]}
                </span>
                <strong>{prediction.title}</strong>
                <span className={styles.cardMachine}>{prediction.machine}</span>
                <span className={styles.predictionImpact}>
                  {ready
                    ? `${prediction.unitsAtRisk} units at risk · ${prediction.expectedMinutes[0]}–${prediction.expectedMinutes[1]} min impact`
                    : prediction.evidence[0]}
                </span>
                <span className={styles.cardAction}>Inspect evidence <ArrowForwardRoundedIcon fontSize="small" /></span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

