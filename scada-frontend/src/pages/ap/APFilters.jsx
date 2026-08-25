import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { AP_HORIZONS, AP_LINES, AP_RANGES } from './apFixtures'
import styles from './APPage.module.css'

export default function APFilters({ filters, onChange }) {
  const selectedLine = AP_LINES.find((line) => line.value === filters.line) ?? AP_LINES[0]

  const updateLine = (line) => {
    onChange({ ...filters, line, machine: 'all' })
  }

  return (
    <section className={styles.filters} aria-label="A&P filters">
      <div className={styles.filterLead}>
        <TuneRoundedIcon fontSize="small" aria-hidden="true" />
        <span>Time lens</span>
      </div>

      <div className={styles.segmented} aria-label="Historian period">
        {AP_RANGES.map((range) => (
          <button
            key={range.value}
            type="button"
            className={filters.range === range.value ? styles.segmentActive : styles.segment}
            aria-pressed={filters.range === range.value}
            onClick={() => onChange({ ...filters, range: range.value })}
          >
            {range.value}
          </button>
        ))}
      </div>

      <label className={styles.selectLabel}>
        <span>Line</span>
        <select value={filters.line} onChange={(event) => updateLine(event.target.value)}>
          {AP_LINES.map((line) => (
            <option key={line.value} value={line.value}>{line.label}</option>
          ))}
        </select>
      </label>

      <label className={styles.selectLabel}>
        <span>Machine</span>
        <select
          value={filters.machine}
          onChange={(event) => onChange({ ...filters, machine: event.target.value })}
        >
          {selectedLine.machines.map((machine) => (
            <option key={machine.value} value={machine.value}>{machine.label}</option>
          ))}
        </select>
      </label>

      <div className={styles.horizonControl}>
        <span className={styles.filterLabel}>Prediction horizon</span>
        <div className={styles.segmented} aria-label="Prediction horizon">
          {AP_HORIZONS.map((horizon) => (
            <button
              key={horizon}
              type="button"
              className={filters.horizon === horizon ? styles.segmentActive : styles.segment}
              aria-pressed={filters.horizon === horizon}
              onClick={() => onChange({ ...filters, horizon })}
            >
              {horizon}m
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

