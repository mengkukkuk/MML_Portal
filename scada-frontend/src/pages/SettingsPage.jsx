import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Controller, useForm } from 'react-hook-form'
import TextField from '@mui/material/TextField'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import Switch from '@mui/material/Switch'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Alert from '@mui/material/Alert'
import Snackbar from '@mui/material/Snackbar'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined'
import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined'
import { useSettingsStore, THEMES } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import {
  fetchDatasources, createDatasource, updateDatasource, deleteDatasource, testDatasource,
} from '@/api/datasources'
import styles from './SettingsPage.module.css'

/**
 * SettingsPage — the control-console for portal-wide parameters (route: /settings).
 * Laid out as rack modules: APPEARANCE (color faceplate), ACQUISITION (poll
 * cadence + alerts), and DATA SOURCES (admin-managed saved DB connections).
 * Ported from SettingsPage.vue.
 *
 * Theme applies live via the settings store's applyTheme(); acquisition
 * prefs (pollSeconds/notifyOnCritical) are bound directly to the same store
 * (mirroring Pinia's mutable refs via useSettingsStore.setState) and only
 * persisted to localStorage when the commit bar's "Save changes" is clicked.
 * Connections live server-side (api/datasources) — list via TanStack Query,
 * each row/dialog can "Test connection" independently and saves on its own.
 */

const POLL_PRESETS = [
  { s: 5, label: '5s' },
  { s: 10, label: '10s' },
  { s: 30, label: '30s' },
  { s: 60, label: '1m' },
]
const DS_TYPES = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'timescaledb', label: 'TimescaleDB' },
]
const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

const BLANK_DS = {
  name: '',
  type: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: '',
  db_schema: 'public',
  username: 'postgres',
  password: '',
  sslmode: 'prefer',
}

function ledClass(kind) {
  if (kind === 'ok') return `${styles.led} ${styles.ledOk}`
  if (kind === 'warn') return `${styles.led} ${styles.ledWarn}`
  if (kind === 'crit') return `${styles.led} ${styles.ledCrit}`
  return styles.led
}

// Maps a test-connection async state (idle|testing|ok|error) to a LED class.
function testLedClass(state) {
  if (state === 'testing') return `${styles.led} ${styles.ledWarn} ${styles.ledPulse}`
  if (state === 'ok') return `${styles.led} ${styles.ledOk}`
  if (state === 'error') return `${styles.led} ${styles.ledCrit}`
  return styles.led
}

// pollSeconds/notifyOnCritical have no dedicated setter actions on the
// settings store (by design — see stores/settings.js) since Pinia's version
// bound them as directly-mutable refs. Zustand's store instance always
// exposes setState(), so this is the direct equivalent, kept local to this
// page since nothing else needs to write these fields pre-commit.
function setPollSeconds(v) {
  useSettingsStore.setState({ pollSeconds: v })
}
function setNotifyOnCritical(v) {
  useSettingsStore.setState({ notifyOnCritical: v })
}

export default function SettingsPage() {
  const theme = useSettingsStore((s) => s.theme)
  const applyTheme = useSettingsStore((s) => s.applyTheme)
  const pollSeconds = useSettingsStore((s) => s.pollSeconds)
  const notifyOnCritical = useSettingsStore((s) => s.notifyOnCritical)
  const savePrefsAction = useSettingsStore((s) => s.savePrefs)
  const role = useAuthStore((s) => s.user?.role ?? null)
  const isAdmin = role === 'admin'

  const [collapsed, setCollapsed] = useState({ appearance: true, acquisition: true, datasources: true })
  function toggle(key) {
    setCollapsed((c) => ({ ...c, [key]: !c[key] }))
  }

  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' })
  function notify(message, severity = 'success') {
    setSnackbar({ open: true, message, severity })
  }

  // --- Acquisition prefs: dirty tracking (theme commits instantly; connections
  //     save individually, so the commit bar governs poll/notify only) ---------
  const fingerprint = `${pollSeconds}|${notifyOnCritical}`
  const [savedPrefs, setSavedPrefs] = useState(fingerprint)
  const dirty = savedPrefs !== fingerprint

  function commit() {
    savePrefsAction()
    setSavedPrefs(fingerprint)
    notify('Settings committed')
  }

  // --- Data sources (server-side) --------------------------------------------
  const queryClient = useQueryClient()
  const {
    data: datasourcesRaw = [],
    isLoading: dsLoading,
    error: dsError,
  } = useQuery({ queryKey: ['datasources'], queryFn: fetchDatasources })
  const datasources = useMemo(
    () => [...datasourcesRaw].sort((a, b) => a.name.localeCompare(b.name)),
    [datasourcesRaw],
  )
  const invalidateDatasources = () => queryClient.invalidateQueries({ queryKey: ['datasources'] })

  const [rowTest, setRowTest] = useState({}) // id -> { state, message }

  const [dsDialogOpen, setDsDialogOpen] = useState(false)
  const [editingDsId, setEditingDsId] = useState(null) // null = create
  const [dsDialogError, setDsDialogError] = useState('')
  const [dsTest, setDsTest] = useState({ state: 'idle', message: '' })
  const [showPassword, setShowPassword] = useState(false)

  const {
    register, handleSubmit, reset, control, getValues,
    formState: { errors },
  } = useForm({ defaultValues: BLANK_DS })

  const dsDialogTitle = editingDsId ? 'Edit connection' : 'Add connection'
  const editingHasPassword = useMemo(
    () => datasources.find((d) => d.id === editingDsId)?.has_password,
    [datasources, editingDsId],
  )

  const createMutation = useMutation({
    mutationFn: createDatasource,
    onSuccess: () => {
      invalidateDatasources()
      notify('Connection saved.')
      setDsDialogOpen(false)
    },
    onError: (e) => setDsDialogError(e?.response?.data?.detail || 'Failed to save connection.'),
  })
  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => updateDatasource(id, payload),
    onSuccess: () => {
      invalidateDatasources()
      notify('Connection updated.')
      setDsDialogOpen(false)
    },
    onError: (e) => setDsDialogError(e?.response?.data?.detail || 'Failed to save connection.'),
  })
  const deleteMutation = useMutation({
    mutationFn: (id) => deleteDatasource(id),
    onSuccess: (_data, id) => {
      invalidateDatasources()
      setRowTest((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      notify('Connection deleted.')
      setDeleteTarget(null)
    },
    onError: (e) => setDeleteError(e?.response?.data?.detail || 'Delete failed.'),
  })
  const savingDs = createMutation.isPending || updateMutation.isPending

  function openCreateDs() {
    setEditingDsId(null)
    setDsDialogError('')
    reset(BLANK_DS)
    setDsTest({ state: 'idle', message: '' })
    setShowPassword(false)
    setDsDialogOpen(true)
  }
  function openEditDs(ds) {
    setEditingDsId(ds.id)
    setDsDialogError('')
    reset({
      name: ds.name,
      type: ds.type,
      host: ds.host,
      port: ds.port,
      database: ds.database,
      db_schema: ds.db_schema || 'public',
      username: ds.username,
      password: '', // blank = keep the stored secret
      sslmode: ds.sslmode,
    })
    setDsTest({ state: 'idle', message: '' })
    setShowPassword(false)
    setDsDialogOpen(true)
  }

  async function testInDialog() {
    setDsTest({ state: 'testing', message: 'Opening connection…' })
    const v = getValues()
    try {
      const r = await testDatasource({
        datasource_id: editingDsId ?? undefined,
        type: v.type,
        host: v.host,
        port: v.port,
        database: v.database,
        username: v.username,
        password: v.password || undefined,
        sslmode: v.sslmode,
      })
      setDsTest({
        state: r.ok ? 'ok' : 'error',
        message: r.server_version ? `${r.message} · ${r.server_version}` : r.message,
      })
    } catch (e) {
      setDsTest({ state: 'error', message: e?.response?.data?.detail || 'Test failed.' })
    }
  }

  function onSaveDs(values) {
    setDsDialogError('')
    const payload = {
      name: values.name.trim(),
      type: values.type,
      host: values.host.trim(),
      port: values.port,
      database: values.database.trim(),
      db_schema: (values.db_schema || '').trim() || 'public',
      username: values.username.trim(),
      sslmode: values.sslmode,
      ...(values.password ? { password: values.password } : {}),
    }
    if (editingDsId) updateMutation.mutate({ id: editingDsId, payload })
    else createMutation.mutate(payload)
  }

  async function testRow(ds) {
    setRowTest((prev) => ({ ...prev, [ds.id]: { state: 'testing', message: 'Opening connection…' } }))
    try {
      const r = await testDatasource({ datasource_id: ds.id })
      setRowTest((prev) => ({
        ...prev,
        [ds.id]: {
          state: r.ok ? 'ok' : 'error',
          message: r.server_version ? `${r.message} · ${r.server_version}` : r.message,
        },
      }))
    } catch (e) {
      setRowTest((prev) => ({
        ...prev,
        [ds.id]: { state: 'error', message: e?.response?.data?.detail || 'Test failed.' },
      }))
    }
  }

  // Delete-confirmation dialog (mirrors AccountsPage / LivePage's del-dialog).
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState('')
  function openDeleteDs(ds) {
    setDeleteError('')
    setDeleteTarget(ds)
  }
  function confirmDeleteDs() {
    if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
  }

  return (
    <div className={styles.cfg}>
      {/* ── Console header ─────────────────────────────────────────────── */}
      <header className={styles.cfgHead}>
        <div>
          <p className={styles.cfgEyebrow}>MML · SYSTEM CONFIGURATION</p>
          <h1 className={styles.cfgTitle}>Console Settings</h1>
        </div>
        <div className={styles.cfgSync}>
          <span className={ledClass(dirty ? 'warn' : 'ok')} />
          {dirty ? 'UNSAVED CHANGES' : 'CONFIG SYNCED'}
        </div>
      </header>

      {/* ── Module 1 · Appearance ──────────────────────────────────────── */}
      <section className={`${styles.mod} ${collapsed.appearance ? styles.modCollapsed : ''}`}>
        <header className={styles.modHead} onClick={() => toggle('appearance')}>
          <span className={styles.modTag}>Appearance</span>
          <span className={styles.modSub}>HMI color faceplate</span>
          <ChevronRightRounded
            className={`${styles.modChevron} ${!collapsed.appearance ? styles.modChevronOpen : ''}`}
          />
        </header>
        {!collapsed.appearance && (
          <div className={styles.modBody}>
            <p className={styles.fldLabel}>Color theme</p>
            <div className={styles.plates} role="group" aria-label="Color theme">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`${styles.plate} ${theme === t.id ? styles.plateActive : ''}`}
                  aria-pressed={theme === t.id}
                  onClick={() => applyTheme(t.id)}
                >
                  <span className={styles.plateScreen} style={{ background: t.preview.bg }}>
                    <span
                      className={styles.plateWin}
                      style={{ background: t.preview.panel, borderColor: t.preview.accent }}
                    >
                      <span className={styles.plateAccent} style={{ background: t.preview.accent }} />
                      <span className={styles.plateRow} style={{ background: t.preview.fg }} />
                      <span
                        className={`${styles.plateRow} ${styles.plateRowShort}`}
                        style={{ background: t.preview.fg }}
                      />
                      <span
                        className={styles.plateGauge}
                        style={{
                          borderColor: t.preview.accent,
                          boxShadow: `0 0 10px ${t.preview.accent}66`,
                        }}
                      />
                    </span>
                  </span>
                  <span className={styles.plateFoot}>
                    <span className={ledClass(theme === t.id ? 'ok' : '')} />
                    <span className={styles.plateName}>{t.name}</span>
                    <span className={styles.plateHex}>{t.preview.accent}</span>
                  </span>
                  <span className={styles.plateBlurb}>{t.blurb}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Module 2 · Acquisition ─────────────────────────────────────── */}
      <section className={`${styles.mod} ${collapsed.acquisition ? styles.modCollapsed : ''}`}>
        <header className={styles.modHead} onClick={() => toggle('acquisition')}>
          <span className={styles.modTag}>Acquisition</span>
          <span className={styles.modSub}>Default polling cadence</span>
          <ChevronRightRounded
            className={`${styles.modChevron} ${!collapsed.acquisition ? styles.modChevronOpen : ''}`}
          />
        </header>
        {!collapsed.acquisition && (
          <div className={styles.modBody}>
            <div className={styles.acqRow}>
              <div className={styles.acqLabel}>
                <p className={styles.fldLabel}>Default poll interval</p>
                <p className={styles.fldHint}>Sliding-window refresh used by Live &amp; Trends tiles.</p>
              </div>
              <div className={styles.acqCtl}>
                <TextField
                  size="small"
                  type="number"
                  className={styles.pollField}
                  value={pollSeconds}
                  slotProps={{ htmlInput: { min: 1, max: 3600 } }}
                  onChange={(e) => {
                    const raw = e.target.value
                    // Never coerce a transiently-blank number field to 0 —
                    // ignore until a real digit lands (matches el-input-number's
                    // clamped-to-min behaviour rather than MUI's Number('')===0).
                    if (raw === '') return
                    const n = Number(raw)
                    if (Number.isFinite(n)) setPollSeconds(Math.min(3600, Math.max(1, Math.round(n))))
                  }}
                />
                <span className={styles.acqUnit}>seconds</span>
                <div className={styles.chips}>
                  {POLL_PRESETS.map((p) => (
                    <button
                      key={p.s}
                      type="button"
                      className={`${styles.chip} ${pollSeconds === p.s ? styles.chipOn : ''}`}
                      onClick={() => setPollSeconds(p.s)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className={`${styles.acqRow} ${styles.acqRowDivider}`}>
              <div className={styles.acqLabel}>
                <p className={styles.fldLabel}>Critical-alarm notifications</p>
                <p className={styles.fldHint}>Surface a desktop toast when a critical alarm trips.</p>
              </div>
              <div className={styles.acqCtl}>
                <span className={ledClass(notifyOnCritical ? 'crit' : '')} />
                <Switch
                  checked={notifyOnCritical}
                  onChange={(e) => setNotifyOnCritical(e.target.checked)}
                />
                <span className={styles.acqState}>{notifyOnCritical ? 'ARMED' : 'OFF'}</span>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Module 3 · Data sources ────────────────────────────────────── */}
      <section className={`${styles.mod} ${collapsed.datasources ? styles.modCollapsed : ''}`}>
        <header className={styles.modHead} onClick={() => toggle('datasources')}>
          <span className={styles.modTag}>Data sources</span>
          <span className={styles.modSub}>Saved database connections</span>
          {isAdmin && (
            <Button
              className={styles.modAction}
              variant="contained"
              size="small"
              onClick={(e) => {
                e.stopPropagation()
                openCreateDs()
              }}
            >
              + Add connection
            </Button>
          )}
          <ChevronRightRounded
            className={`${styles.modChevron} ${!collapsed.datasources ? styles.modChevronOpen : ''}`}
          />
        </header>
        {!collapsed.datasources && (
          <div className={styles.modBody}>
            {!isAdmin && (
              <p className={styles.dsReadonly}>
                <span className={styles.led} /> Only administrators can manage connections.
              </p>
            )}

            {dsError && dsError?.response?.status !== 403 && (
              <Alert severity="error">Failed to load connections.</Alert>
            )}

            {datasources.length > 0 ? (
              <div className={styles.conns}>
                {datasources.map((ds) => (
                  <div className={styles.conn} key={ds.id}>
                    <span className={testLedClass(rowTest[ds.id]?.state)} />
                    <div className={styles.connMain}>
                      <span className={styles.connName}>
                        {ds.name}
                        <span className={styles.connType}>{ds.type}</span>
                      </span>
                      <span className={styles.connDsn}>
                        {ds.username}@{ds.host}:{ds.port}/{ds.database} · schema={ds.db_schema} · sslmode=
                        {ds.sslmode}
                      </span>
                      {rowTest[ds.id]?.message && (
                        <span className={styles.connResult}>{rowTest[ds.id].message}</span>
                      )}
                    </div>
                    {isAdmin && (
                      <div className={styles.connActions}>
                        <Button
                          size="small"
                          loading={rowTest[ds.id]?.state === 'testing'}
                          onClick={() => testRow(ds)}
                        >
                          Test
                        </Button>
                        <Button size="small" onClick={() => openEditDs(ds)}>
                          Edit
                        </Button>
                        <Button size="small" color="error" onClick={() => openDeleteDs(ds)}>
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              !dsLoading && (
                <p className={styles.dsEmpty}>
                  No saved connections yet.
                  {isAdmin && ' Add one to make it selectable when editing a Live panel.'}
                </p>
              )
            )}
          </div>
        )}
      </section>

      {/* ── Commit bar (acquisition only) ──────────────────────────────── */}
      <div className={styles.cfgBar}>
        <span className={styles.cfgBarhint}>
          Appearance applies instantly. Connections save on their own. Acquisition needs a commit.
        </span>
        <Button variant="contained" disabled={!dirty} onClick={commit}>
          Save changes
        </Button>
      </div>

      {/* ── Connection editor dialog ───────────────────────────────────── */}
      <Dialog open={dsDialogOpen} onClose={() => setDsDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{dsDialogTitle}</DialogTitle>
        <form onSubmit={handleSubmit(onSaveDs)}>
          <DialogContent sx={{ pt: '8px !important' }}>
            <div className={styles.dsGrid}>
              <div className={`${styles.fld} ${styles.fldSpan6}`}>
                <TextField
                  label="Name"
                  placeholder="e.g. Plant historian"
                  fullWidth
                  size="small"
                  error={!!errors.name}
                  helperText={errors.name ? 'Name is required.' : ' '}
                  {...register('name', { required: true })}
                />
              </div>
              <div className={`${styles.fld} ${styles.fldSpan2}`}>
                <FormControl fullWidth size="small">
                  <InputLabel id="dsf-type-label">Type</InputLabel>
                  <Controller
                    name="type"
                    control={control}
                    render={({ field }) => (
                      <Select labelId="dsf-type-label" label="Type" {...field}>
                        {DS_TYPES.map((o) => (
                          <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
                        ))}
                      </Select>
                    )}
                  />
                </FormControl>
              </div>
              <div className={`${styles.fld} ${styles.fldSpan3}`}>
                <TextField
                  label="Host"
                  placeholder="127.0.0.1"
                  fullWidth
                  size="small"
                  error={!!errors.host}
                  helperText={errors.host ? 'Host is required.' : ' '}
                  {...register('host', { required: true })}
                />
              </div>
              <div className={styles.fld}>
                <TextField
                  label="Port"
                  type="number"
                  fullWidth
                  size="small"
                  slotProps={{ htmlInput: { min: 1, max: 65535 } }}
                  error={!!errors.port}
                  helperText={errors.port ? 'Port must be 1–65535.' : ' '}
                  {...register('port', {
                    required: true,
                    valueAsNumber: true,
                    validate: (v) => (Number.isFinite(v) && v >= 1 && v <= 65535),
                  })}
                />
              </div>
              <div className={`${styles.fld} ${styles.fldSpan2}`}>
                <TextField
                  label="Database"
                  placeholder="mml"
                  fullWidth
                  size="small"
                  error={!!errors.database}
                  helperText={errors.database ? 'Database is required.' : ' '}
                  {...register('database', { required: true })}
                />
              </div>
              <div className={`${styles.fld} ${styles.fldSpan2}`}>
                <TextField
                  label="Schema"
                  placeholder="public"
                  fullWidth
                  size="small"
                  {...register('db_schema')}
                />
              </div>
              <div className={`${styles.fld} ${styles.fldSpan2}`}>
                <FormControl fullWidth size="small">
                  <InputLabel id="dsf-ssl-label">SSL mode</InputLabel>
                  <Controller
                    name="sslmode"
                    control={control}
                    render={({ field }) => (
                      <Select labelId="dsf-ssl-label" label="SSL mode" {...field}>
                        {SSL_MODES.map((m) => (
                          <MenuItem key={m} value={m}>{m}</MenuItem>
                        ))}
                      </Select>
                    )}
                  />
                </FormControl>
              </div>
              <div className={`${styles.fld} ${styles.fldSpan3}`}>
                <TextField
                  label="Username"
                  placeholder="postgres"
                  fullWidth
                  size="small"
                  error={!!errors.username}
                  helperText={errors.username ? 'Username is required.' : ' '}
                  {...register('username', { required: true })}
                />
              </div>
              <div className={`${styles.fld} ${styles.fldSpan3}`}>
                <TextField
                  label="Password"
                  type={showPassword ? 'text' : 'password'}
                  fullWidth
                  size="small"
                  placeholder={editingHasPassword ? '•••••• (unchanged)' : '••••••••'}
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">
                          <IconButton
                            size="small"
                            tabIndex={-1}
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                            onClick={() => setShowPassword((s) => !s)}
                          >
                            {showPassword ? <VisibilityOffOutlined fontSize="small" /> : <VisibilityOutlined fontSize="small" />}
                          </IconButton>
                        </InputAdornment>
                      ),
                    },
                  }}
                  {...register('password')}
                />
              </div>
            </div>
            {dsDialogError && <Alert severity="error" sx={{ mt: 2 }}>{dsDialogError}</Alert>}
          </DialogContent>

          <DialogActions>
            <div className={styles.dsDialogFoot}>
              <Button loading={dsTest.state === 'testing'} onClick={testInDialog}>
                Test connection
              </Button>
              <p className={`${styles.dsStatus} ${dsTest.state !== 'idle' ? styles.dsStatusShow : ''}`}>
                <span className={testLedClass(dsTest.state)} />
                <span className={styles.dsMsg}>{dsTest.message}</span>
              </p>
              <span className={styles.dsDialogSpacer} />
              <Button onClick={() => setDsDialogOpen(false)}>Cancel</Button>
              <Button type="submit" variant="contained" loading={savingDs}>Save</Button>
            </div>
          </DialogActions>
        </form>
      </Dialog>

      {/* Delete connection: small centred confirm dialog (matches AccountsPage / LivePage) */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete connection</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {deleteTarget && (
            <p className={styles.delDialogMsg}>
              Delete <strong>{deleteTarget.name}</strong>?
            </p>
          )}
          <p className={styles.delDialogHint}>
            Panels bound to it fall back to the app database. This cannot be undone.
          </p>
          {deleteError && <Alert severity="error">{deleteError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            loading={deleteMutation.isPending}
            onClick={confirmDeleteDs}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </div>
  )
}
