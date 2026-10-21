import PaidOutlinedIcon from '@mui/icons-material/PaidOutlined'
import TrafficOutlinedIcon from '@mui/icons-material/TrafficOutlined'
import WaterfallChartOutlinedIcon from '@mui/icons-material/WaterfallChartOutlined'
import { useTranslation } from '@/i18n'
import { MANAGEMENT_BLOCKS } from './kpiPayload'
import { VIZ_TYPE_META } from './panelPayload'
import { VIZ_ICONS } from './PanelEditorDialog'
import styles from './BlockPalette.module.css'

const BLOCK_ICONS = {
  lossmeter: PaidOutlinedIcon,
  andon: TrafficOutlinedIcon,
  waterfall: WaterfallChartOutlinedIcon,
}

/**
 * BlockPalette — the Edit Layout toolbox: drag a card onto the grid, or click
 * it (Enter/Space from the keyboard) to add it in the next free slot.
 *
 * Management blocks come first and land already bound and live (see
 * kpiPayload.defaultKpiPanel); a classic chart type opens the panel editor
 * pre-set to that type, since it needs columns chosen before it can draw.
 * The dragged type is reported through `onDragType` so the grid can size its
 * drop ghost to match.
 */
export default function BlockPalette({ onAdd, onDragType }) {
  const tr = useTranslation()

  function card(item, Icon, kind) {
    return (
      <button
        key={item.value}
        type="button"
        className={`${styles.card} ${kind === 'kpi' ? styles['card--kpi'] : ''}`}
        draggable
        // Firefox will not start a drag without data on the transfer.
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', item.value)
          e.dataTransfer.effectAllowed = 'copy'
          onDragType?.(item.value)
        }}
        onDragEnd={() => onDragType?.(null)}
        onClick={() => onAdd?.(item.value)}
        title={tr(item.hint)}
      >
        {Icon && <Icon fontSize="small" className={styles.card__icon} />}
        <span className={styles.card__label}>{tr(item.label)}</span>
      </button>
    )
  }

  return (
    <section className={styles.palette} aria-label={tr('Block palette')}>
      <p className={styles.hint}>{tr('Drag a block onto the grid, or click to add it')}</p>
      <div className={styles.group}>
        <span className={styles.group__title}>{tr('Management')}</span>
        <div className={styles.cards}>
          {MANAGEMENT_BLOCKS.map((b) => card(b, BLOCK_ICONS[b.icon], 'kpi'))}
        </div>
      </div>
      <div className={styles.group}>
        <span className={styles.group__title}>{tr('Charts')}</span>
        <div className={styles.cards}>
          {VIZ_TYPE_META.map((v) => card(v, VIZ_ICONS[v.icon], 'chart'))}
        </div>
      </div>
    </section>
  )
}
