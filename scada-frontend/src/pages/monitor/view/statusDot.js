import styles from '../MonitorPage.module.css'

/** The CSS-module class for the plant-state dot. Shared by the page header and the full screen banner. */
export const dotClassFor = (status) => (
  status === 'crit' ? styles.dotCrit : status === 'warn' ? styles.dotWarn : ''
)
