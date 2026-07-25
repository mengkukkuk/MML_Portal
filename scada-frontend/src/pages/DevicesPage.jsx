import { useQuery } from '@tanstack/react-query'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Paper from '@mui/material/Paper'
import Chip from '@mui/material/Chip'
import LinearProgress from '@mui/material/LinearProgress'
import Button from '@mui/material/Button'
import RefreshIcon from '@mui/icons-material/Refresh'
import { fetchDevices } from '@/api/devices'
import styles from './DevicesPage.module.css'

/**
 * DevicesPage — device inventory table (route: /devices).
 * Fetches the device list via TanStack Query on mount and displays ID,
 * name, location, status (online/degraded/offline), CPU progress bar, and
 * uptime. Refresh button re-fetches from the backend. Ported from
 * DevicesPage.vue, which drove the same list off useDevicesStore (Pinia).
 */

const CHIP_COLOR = {
  online: 'success',
  degraded: 'warning',
  offline: 'error',
}

export default function DevicesPage() {
  const { data: list = [], isFetching, refetch } = useQuery({
    queryKey: ['devices'],
    queryFn: fetchDevices,
  })

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h2 className={styles.title}>Devices</h2>
        <Button
          variant="contained"
          startIcon={<RefreshIcon />}
          onClick={() => refetch()}
          loading={isFetching}
        >
          Refresh
        </Button>
      </header>

      <TableContainer component={Paper} variant="outlined">
        <Table size="medium">
          <TableHead>
            <TableRow>
              <TableCell width={120}>ID</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Location</TableCell>
              <TableCell width={130}>Status</TableCell>
              <TableCell width={180}>CPU</TableCell>
              <TableCell width={120}>Uptime</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {list.map((row) => (
              <TableRow key={row.id} hover>
                <TableCell>{row.id}</TableCell>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.location}</TableCell>
                <TableCell>
                  <Chip
                    label={row.status}
                    color={CHIP_COLOR[row.status] || 'default'}
                    size="small"
                  />
                </TableCell>
                <TableCell>
                  <div className={styles.cpuCell}>
                    <LinearProgress
                      className={styles.cpuBar}
                      variant="determinate"
                      value={row.cpu}
                    />
                    <span className={styles.cpuText}>{row.cpu}%</span>
                  </div>
                </TableCell>
                <TableCell>{row.uptime}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  )
}
