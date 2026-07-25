import Button from '@mui/material/Button'
import { useNavigate } from 'react-router-dom'
import styles from './NotFoundPage.module.css'

/**
 * NotFoundPage — 404 fallback rendered for any unmatched route.
 * Shows a large "404" heading and a button that navigates back to the overview.
 */
export default function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <div className={styles.nf}>
      <h1 className={styles.code}>404</h1>
      <p className={styles.msg}>That route doesn't exist.</p>
      <Button variant="contained" onClick={() => navigate('/', { replace: true })}>
        Back to overview
      </Button>
    </div>
  )
}
