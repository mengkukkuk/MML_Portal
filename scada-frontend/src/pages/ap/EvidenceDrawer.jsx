import { useMemo } from 'react'
import Drawer from '@mui/material/Drawer'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import DataUsageRoundedIcon from '@mui/icons-material/DataUsageRounded'
import HistoryEduRoundedIcon from '@mui/icons-material/HistoryEduRounded'
import ModelTrainingRoundedIcon from '@mui/icons-material/ModelTrainingRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import EChart from '@/components/charts/EChart'
import styles from './APPage.module.css'

function evidenceOption(chart) {
  if (!chart) return {}
  return {
    animationDuration: 450,
    grid: { left: 48, right: 48, top: 28, bottom: 32 },
    tooltip: { trigger: 'axis', backgroundColor: '#172238', borderColor: 'rgba(255,255,255,.12)', textStyle: { color: '#e6edf7' } },
    legend: { top: 0, right: 0, textStyle: { color: '#8a99b3', fontSize: 10 } },
    xAxis: {
      type: 'category',
      data: chart.labels,
      boundaryGap: false,
      axisLabel: { color: '#8a99b3', fontSize: 10 },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,.1)' } },
    },
    yAxis: [
      {
        type: 'value',
        name: chart.series[0]?.unit ?? '',
        nameTextStyle: { color: '#8a99b3' },
        axisLabel: { color: '#8a99b3', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } },
      },
      {
        type: 'value',
        name: chart.series[1]?.unit ?? '',
        nameTextStyle: { color: '#8a99b3' },
        axisLabel: { color: '#8a99b3', fontSize: 10 },
        splitLine: { show: false },
      },
    ],
    series: chart.series.map((series) => ({
      name: series.name,
      type: 'line',
      data: series.values,
      yAxisIndex: series.axis ?? 0,
      showSymbol: false,
      smooth: 0.3,
      lineStyle: { color: series.color, width: 2 },
      itemStyle: { color: series.color },
      areaStyle: { color: `${series.color}18` },
    })),
  }
}

function IncidentEvidence({ entity }) {
  return (
    <>
      <div className={styles.drawerFacts}>
        <span><b>{entity.durationMinutes}</b><small>minutes affected</small></span>
        <span><b>{entity.lostUnits}</b><small>units lost</small></span>
        <span><b>{entity.similarIncidents}</b><small>similar incidents</small></span>
      </div>

      <section className={styles.drawerSection}>
        <h3>Likely contributors</h3>
        <p className={styles.drawerHint}>Associations from simulated historian evidence; engineer confirmation is required.</p>
        <ol className={styles.contributorList}>
          {entity.contributors.map((contributor) => (
            <li key={contributor.label}>
              <span>{contributor.label}</span>
              <span className={styles.contributorWeight}>{contributor.weight}% evidence</span>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.drawerSection}>
        <h3>Alarm sequence</h3>
        {entity.alarms.length > 0 ? (
          <ul className={styles.alarmSequence}>
            {entity.alarms.map((alarm) => (
              <li key={`${alarm.time}-${alarm.text}`}>
                <time>{alarm.time}</time>
                <span>{alarm.text}</span>
                <small>{alarm.severity}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.drawerHint}>No unplanned alarms occurred during this event.</p>
        )}
      </section>
    </>
  )
}

function PredictionEvidence({ entity, model }) {
  const ready = entity.status !== 'insufficient_data'
  return (
    <>
      <div className={styles.drawerFacts}>
        <span><b>{ready ? `${Math.round(entity.risk * 100)}%` : '—'}</b><small>predicted risk</small></span>
        <span><b>{entity.leadMinutes}m</b><small>forecast horizon</small></span>
        <span><b>{ready ? entity.unitsAtRisk : '—'}</b><small>units at risk</small></span>
      </div>

      <section className={styles.drawerSection}>
        <h3>Evidence increasing this risk</h3>
        <ul className={styles.evidenceList}>
          {entity.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}
        </ul>
      </section>

      <section className={styles.inspectionFocus}>
        <WarningAmberRoundedIcon fontSize="small" aria-hidden="true" />
        <div>
          <h3>{ready ? 'Inspection focus' : 'What is needed'}</h3>
          <p>{entity.focus}</p>
        </div>
      </section>

      <section className={styles.drawerSection}>
        <h3>Prototype model</h3>
        <dl className={styles.modelList}>
          <div><dt>Model</dt><dd>{model.name}</dd></div>
          <div><dt>Version</dt><dd>{model.version}</dd></div>
          <div><dt>Training data through</dt><dd>{model.trainedThrough}</dd></div>
          <div><dt>Validation</dt><dd>{model.validation}</dd></div>
        </dl>
        <p className={styles.drawerHint}>{model.disclaimer}</p>
      </section>
    </>
  )
}

export default function EvidenceDrawer({ open, type, entity, model, dataCoverage, onClose }) {
  const chartOption = useMemo(() => evidenceOption(entity?.chart), [entity?.chart])
  const isPrediction = type === 'prediction'

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { className: styles.drawerPaper } }}
      ModalProps={{ keepMounted: true }}
    >
      {entity ? (
        <div className={styles.drawerContent}>
          <header className={styles.drawerHeader}>
            <div>
              <p className={styles.eyebrow}>{isPrediction ? 'Prediction evidence' : 'Incident analysis'}</p>
              <h2>{entity.title}</h2>
              <p>{entity.machine}{entity.occurred ? ` · ${entity.occurred}` : ''}</p>
            </div>
            <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close evidence drawer">
              <CloseRoundedIcon />
            </button>
          </header>

          {entity.summary ? <p className={styles.drawerSummary}>{entity.summary}</p> : null}

          {isPrediction
            ? <PredictionEvidence entity={entity} model={model} />
            : <IncidentEvidence entity={entity} />}

          <section className={styles.drawerSection}>
            <h3>Historian trace · last 55 minutes</h3>
            {entity.chart ? (
              <>
                <p className={styles.chartSummary}>
                  {entity.chart.summary} The chart is simulated prototype evidence.
                </p>
                <EChart option={chartOption} height="250px" />
              </>
            ) : (
              <p className={styles.drawerHint}>No trace is shown because this machine does not have enough historian coverage.</p>
            )}
          </section>

          <footer className={styles.drawerTrust}>
            <DataUsageRoundedIcon fontSize="small" aria-hidden="true" />
            <span><b>{dataCoverage.percent}% data coverage</b>{dataCoverage.message}</span>
            {isPrediction ? <ModelTrainingRoundedIcon fontSize="small" aria-hidden="true" /> : <HistoryEduRoundedIcon fontSize="small" aria-hidden="true" />}
          </footer>
        </div>
      ) : null}
    </Drawer>
  )
}
