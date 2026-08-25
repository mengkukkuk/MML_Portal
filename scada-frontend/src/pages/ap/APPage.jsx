import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import AutoGraphRoundedIcon from '@mui/icons-material/AutoGraphRounded'
import DataUsageRoundedIcon from '@mui/icons-material/DataUsageRounded'
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined'
import APFilters from './APFilters'
import AnalysisPanel from './AnalysisPanel'
import EvidenceDrawer from './EvidenceDrawer'
import OutcomeStrip from './OutcomeStrip'
import PredictionPanel from './PredictionPanel'
import TimeLens from './TimeLens'
import { AP_LINES, fetchAPDashboard } from './apFixtures'
import styles from './APPage.module.css'

const DEFAULT_FILTERS = { range: '24h', line: 'line-2', machine: 'all', horizon: 60 }

export default function APPage() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [activeEvidence, setActiveEvidence] = useState(null)
  const { data, isPending } = useQuery({
    queryKey: ['ap-prototype', filters],
    queryFn: () => fetchAPDashboard(filters),
    staleTime: Infinity,
  })

  const lineName = AP_LINES.find((line) => line.value === filters.line)?.label ?? 'Packaging line'
  const entity = activeEvidence && data
    ? activeEvidence.type === 'incident'
      ? data.incidents.find((item) => item.id === activeEvidence.id)
      : data.predictions.find((item) => item.id === activeEvidence.id)
    : null

  const changeFilters = (nextFilters) => {
    setFilters(nextFilters)
    setActiveEvidence(null)
  }

  const selectEvidence = (type, id) => setActiveEvidence({ type, id })

  if (isPending || !data) {
    return <div className={styles.loading} role="status">Preparing simulated historian analysis…</div>
  }

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}><AutoGraphRoundedIcon fontSize="small" /> A&P control desk</p>
          <h1>Analysis <span>&</span> Prediction</h1>
          <p>Understand production loss from historian evidence, then see which conditions may threaten the next run.</p>
        </div>
        <div className={styles.heroStatus}>
          <span className={styles.prototypePill}><ScienceOutlinedIcon fontSize="small" /> Prototype · simulated historian data</span>
          <span>{lineName}</span>
          <time dateTime={data.generatedAt}>Snapshot 13:50 ICT</time>
        </div>
      </header>

      <APFilters filters={filters} onChange={changeFilters} />
      <OutcomeStrip outcomes={data.outcomes} />
      <TimeLens timeline={data.timeline} onSelect={selectEvidence} />

      <div className={styles.workspace}>
        <AnalysisPanel
          incidents={data.incidents}
          insufficientHistory={data.dataCoverage.status === 'insufficient'}
          onSelect={selectEvidence}
        />
        <PredictionPanel predictions={data.predictions} horizon={filters.horizon} onSelect={selectEvidence} />
      </div>

      <footer className={`${styles.trustStrip} ${styles[`coverage_${data.dataCoverage.status}`] ?? ''}`}>
        <DataUsageRoundedIcon aria-hidden="true" />
        <div>
          <b>{data.dataCoverage.percent}% historian coverage</b>
          <span>{data.dataCoverage.message}</span>
        </div>
        <div className={styles.modelStamp}>
          <span>{data.model.name}</span>
          <span>{data.model.version} · {data.model.validation}</span>
        </div>
      </footer>

      <EvidenceDrawer
        open={Boolean(entity)}
        type={activeEvidence?.type}
        entity={entity}
        model={data.model}
        dataCoverage={data.dataCoverage}
        onClose={() => setActiveEvidence(null)}
      />
    </main>
  )
}
