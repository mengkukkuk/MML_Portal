import { useConnectionStore } from '@/stores/connection'
import styles from './ConnectionPill.module.css'

const LABELS = {
  connected: 'Live',
  degraded: 'Degraded',
  offline: 'Offline',
}

/**
 * ConnectionPill — small status badge shown in AppHeader.
 * Reads connection.status from useConnectionStore ('connected' | 'degraded'
 * | 'offline') and renders a coloured pulsing dot with a Live / Degraded /
 * Offline label. No props; purely reactive to the store.
 */
export default function ConnectionPill() {
  const status = useConnectionStore((s) => s.status)
  const label = LABELS[status] || 'Unknown'

  return (
    <div
      className={styles.pill}
      data-status={status}
      role="status"
      aria-label={`Connection ${label}`}
    >
      <span className={styles.dot} />
      <span className={styles.text}>{label}</span>
    </div>
  )
}
