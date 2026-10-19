import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import TextField from '@mui/material/TextField'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import InputAdornment from '@mui/material/InputAdornment'
import SearchOutlined from '@mui/icons-material/SearchOutlined'
import Button from '@mui/material/Button'
import { useTranslation } from '@/i18n'
import {
  createResponseRole, deleteResponseRole, fetchResponseRoles, updateResponseRole,
} from '@/api/alerts'
import { apiErrorMessage } from '@/api/client'
import styles from './SettingsPage.module.css'

const BLANK = {
  code: '', name_th: '', name_en: '', location: '', keyword: '', priority: 100,
}

// Location filter value for rules with no location condition (every line).
const ANY_LOCATION = '__any__'

// As the server compares locations: case and spaces dropped (response_roles._squash).
const squash = (v) => (v ?? '').replace(/\s+/g, '').toLowerCase()

const draftOf = (r) => ({
  id: r.id,
  code: r.code ?? '',
  name_th: r.name_th ?? '',
  name_en: r.name_en ?? '',
  location: r.location ?? '',
  keyword: r.keyword ?? '',
  priority: r.priority ?? 100,
})

const payloadOf = (d) => ({
  code: d.code.trim(),
  name_th: d.name_th.trim(),
  name_en: d.name_en.trim(),
  location: d.location.trim() || null,
  keyword: d.keyword.trim() || null,
  priority: Number.isFinite(Number(d.priority)) ? Math.round(Number(d.priority)) : 100,
})

const same = (a, b) => JSON.stringify(payloadOf(a)) === JSON.stringify(payloadOf(b))

let draftCounter = 0

/**
 * Settings → Response roles: who has to act on an alert.
 *
 * One rule per row, tried top to bottom (lowest priority number first) — the
 * first whose conditions all fit names the role shown beside the alert on the
 * report trend. Every condition is optional: a row with none is the default
 * role, and belongs at the bottom. An alert row tagged with a role's ID (the
 * source's role column, alert_messages.role_id) skips the rules — which is why
 * the ID is shown: it is the number a writer puts on the row.
 *
 * Severity is not a condition: how loud an alert is does not say whose job it
 * is. A role that must get an alert is tagged on it instead.
 *
 * The filter above the table narrows what is shown, never what is matched. Rows
 * added and not yet saved stay visible whatever it says, so a new rule cannot
 * vanish under a filter it does not fit yet.
 *
 * Each row saves on its own, like the connection list above: a rule is small
 * enough that a page-wide commit would only add a way to lose edits.
 */
export default function ResponseRoleSettings({ isAdmin, notify }) {
  const tr = useTranslation()
  const queryClient = useQueryClient()
  const { data: saved = [], isLoading } = useQuery({
    queryKey: ['response-roles'],
    queryFn: fetchResponseRoles,
  })

  // Drafts: every saved rule as an editable row, plus rules added but not saved.
  const [drafts, setDrafts] = useState([])
  useEffect(() => {
    setDrafts((prev) => [...saved.map(draftOf), ...prev.filter((d) => d.id == null)])
  }, [saved])

  const edit = (key, field) => (e) => setDrafts((rows) => rows.map((d) => (
    (d.id ?? d.tmp) === key ? { ...d, [field]: e.target.value } : d)))

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['response-roles'] })
    // The roles on messages already shown were matched against the old rules.
    queryClient.invalidateQueries({ queryKey: ['alert-messages'] })
  }

  const save = useMutation({
    mutationFn: (d) => (d.id == null ? createResponseRole(payloadOf(d)) : updateResponseRole(d.id, payloadOf(d))),
    onSuccess: (_row, d) => {
      if (d.id == null) setDrafts((rows) => rows.filter((r) => r.tmp !== d.tmp))
      refresh()
      notify('Response role saved.')
    },
    onError: (e) => notify(apiErrorMessage(e, 'Failed to save response role.'), 'error'),
  })
  const remove = useMutation({
    mutationFn: (d) => deleteResponseRole(d.id),
    onSuccess: () => {
      refresh()
      notify('Response role removed.')
    },
    onError: (e) => notify(apiErrorMessage(e, 'Failed to remove response role.'), 'error'),
  })

  const [locationFilter, setLocationFilter] = useState('')
  const [codeFilter, setCodeFilter] = useState('')
  const locations = useMemo(() => {
    const byKey = new Map()
    saved.forEach((r) => {
      if (r.location && !byKey.has(squash(r.location))) byKey.set(squash(r.location), r.location)
    })
    return [...byKey.values()].sort((a, b) => a.localeCompare(b))
  }, [saved])
  const filtering = locationFilter !== '' || codeFilter.trim() !== ''
  const shown = useMemo(() => {
    const code = codeFilter.trim().toLowerCase()
    return drafts.filter((d) => {
      if (d.id == null) return true
      if (locationFilter === ANY_LOCATION ? d.location.trim()
        : locationFilter && squash(d.location) !== squash(locationFilter)) return false
      return !code || [d.code, String(d.id)].some((v) => v.toLowerCase().includes(code))
    })
  }, [drafts, locationFilter, codeFilter])
  const shownSaved = shown.filter((d) => d.id != null).length

  const addRule = () => {
    draftCounter += 1
    setDrafts((rows) => [...rows, { ...BLANK, tmp: `new-${draftCounter}` }])
  }

  const readOnly = !isAdmin
  const busy = save.isPending || remove.isPending

  return (
    <>
      <p className={styles.fldHint}>{tr('Rules are tried from the lowest priority number down; the first whose conditions all fit names who acts on the alert. Leave a condition blank to match anything — a rule with no conditions is the default and belongs last. Location ignores case and spaces, so "Line 13" also matches "Line13".')}</p>
      <p className={styles.fldHint}>{tr('To send one alert to a particular role, write that role’s ID into the alert row’s role column (role_id). A tagged row skips the rules.')}</p>
      {!isAdmin && (
        <p className={styles.dsReadonly}>
          <span className={styles.led} /> {tr('Only administrators can change this.')}</p>
      )}

      <div className={styles.roleFilter} role="search" aria-label={tr('Filter response roles')}>
        <Select
          size="small"
          value={locationFilter}
          onChange={(e) => setLocationFilter(e.target.value)}
          displayEmpty
          inputProps={{ 'aria-label': tr('Location') }}
          className={styles.roleFilterLocation}
          renderValue={(v) => (v === '' ? tr('All locations')
            : v === ANY_LOCATION ? tr('Any location (blank)') : v)}
        >
          <MenuItem value="">{tr('All locations')}</MenuItem>
          <MenuItem value={ANY_LOCATION}>{tr('Any location (blank)')}</MenuItem>
          {locations.map((loc) => <MenuItem key={loc} value={loc}>{loc}</MenuItem>)}
        </Select>
        <TextField
          size="small"
          value={codeFilter}
          onChange={(e) => setCodeFilter(e.target.value)}
          placeholder={tr('Role code or ID')}
          className={styles.roleFilterCode}
          slotProps={{
            htmlInput: { 'aria-label': tr('Role code or ID'), spellCheck: false },
            input: {
              startAdornment: (
                <InputAdornment position="start"><SearchOutlined fontSize="small" /></InputAdornment>
              ),
            },
          }}
        />
        {filtering && (
          <>
            <span className={styles.roleFilterCount}>
              {tr('{shown} of {total} rules', { shown: shownSaved, total: saved.length })}
            </span>
            <Button size="small" onClick={() => { setLocationFilter(''); setCodeFilter('') }}>
              {tr('Clear')}
            </Button>
          </>
        )}
      </div>

      <div className={styles.roleWrap}>
        <table className={styles.roleTable}>
          <thead>
            <tr>
              <th>{tr('ID')}</th>
              <th>{tr('Priority')}</th>
              <th>{tr('Role code')}</th>
              <th>{tr('Name (Thai)')}</th>
              <th>{tr('Name (English)')}</th>
              <th>{tr('Location')}</th>
              <th>{tr('Keyword in message')}</th>
              {isAdmin && <th aria-label={tr('Actions')} />}
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => {
              const key = d.id ?? d.tmp
              const original = d.id != null ? saved.find((r) => r.id === d.id) : null
              const dirty = !original || !same(d, draftOf(original))
              const valid = d.code.trim() && d.name_th.trim() && d.name_en.trim()
              const cell = (field, label, props = {}) => (
                <TextField
                  size="small"
                  value={d[field]}
                  onChange={edit(key, field)}
                  disabled={readOnly}
                  slotProps={{ htmlInput: { 'aria-label': tr(label), spellCheck: false, ...props } }}
                />
              )
              return (
                <tr key={key}>
                  <td className={styles.roleId}>{d.id ?? tr('new')}</td>
                  <td className={styles.rolePriority}>{cell('priority', 'Priority', { inputMode: 'numeric' })}</td>
                  <td>{cell('code', 'Role code')}</td>
                  <td>{cell('name_th', 'Name (Thai)')}</td>
                  <td>{cell('name_en', 'Name (English)')}</td>
                  <td>{cell('location', 'Location')}</td>
                  <td>{cell('keyword', 'Keyword in message')}</td>
                  {isAdmin && (
                    <td className={styles.roleActions}>
                      <Button
                        size="small"
                        variant={dirty ? 'contained' : 'text'}
                        disabled={busy || !dirty || !valid}
                        onClick={() => save.mutate(d)}
                      >
                        {tr('Save')}
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        disabled={busy}
                        onClick={() => (d.id == null
                          ? setDrafts((rows) => rows.filter((r) => r.tmp !== d.tmp))
                          : remove.mutate(d))}
                      >
                        {tr('Delete')}
                      </Button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {!isLoading && drafts.length === 0 && (
        <p className={styles.dsEmpty}>{tr('No response roles yet — alerts show no one to act.')}</p>
      )}
      {drafts.length > 0 && shown.length === 0 && (
        <p className={styles.dsEmpty}>{tr('No rule fits this filter.')}</p>
      )}
      {isAdmin && (
        <div className={styles.alertActions}>
          <Button size="small" variant="outlined" onClick={addRule} disabled={busy}>
            {tr('+ Add rule')}
          </Button>
        </div>
      )}
    </>
  )
}
