import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import PercentRoundedIcon from '@mui/icons-material/PercentRounded'
import ProductionQuantityLimitsOutlinedIcon from '@mui/icons-material/ProductionQuantityLimitsOutlined'
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded'
import styles from './APPage.module.css'

const ICONS = {
  availability: SpeedRoundedIcon,
  loss: AccessTimeRoundedIcon,
  units: Inventory2OutlinedIcon,
  reject: ProductionQuantityLimitsOutlinedIcon,
  risk: PercentRoundedIcon,
}

export default function OutcomeStrip({ outcomes }) {
  return (
    <section className={styles.outcomes} aria-label="Business outcomes">
      {outcomes.map((item) => {
        const Icon = ICONS[item.id] ?? SpeedRoundedIcon
        return (
          <article key={item.id} className={`${styles.outcome} ${styles[`outcome_${item.tone}`] ?? ''}`}>
            <div className={styles.outcomeTopline}>
              <span>{item.label}</span>
              <Icon fontSize="small" aria-hidden="true" />
            </div>
            <p className={styles.outcomeValue}>
              {item.value}<span>{item.unit}</span>
            </p>
            <p className={styles.outcomeMeta}>{item.meta}</p>
          </article>
        )
      })}
    </section>
  )
}

