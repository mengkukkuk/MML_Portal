import { useEffect, useState } from 'react'
import styles from './AppHeader.module.css'

/** Browser-local time; isolate ticking state from the header's menus and forms. */
export default function HeaderClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const pad = (value) => String(value).padStart(2, '0')
  const date = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

  return (
    <time className={styles.clock} dateTime={now.toISOString()} aria-live="off">
      {date} {time}
    </time>
  )
}
