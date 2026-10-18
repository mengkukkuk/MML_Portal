import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import TextField from '@mui/material/TextField'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Button from '@mui/material/Button'
import { useTranslation } from '@/i18n'
import {
  createResponseRole, deleteResponseRole, fetchResponseRoles, updateResponseRole,
} from '@/api/alerts'
import { apiErrorMessage } from '@/api/client'
import styles from './SettingsPage.module.css'

const BLANK = {
  code: '', name_th: '', name_en: '', severity: '', location: '', keyword: '', priority: 100,
}

const draftOf = (r) => ({
  id: r.id,
  code: r.code ?? '',
  name_th: r.name_th ?? '',
  name_en: r.name_en ?? '',
  severity: r.severity ?? '',
  location: r.location ?? '',
  keyword: r.keyword ?? '',
  priority: r.priority ?? 100,
})

const payloadOf = (d) => ({
  code: d.code.trim(),
  name_th: d.name_th.trim(),
  name_en: d.name_en.trim(),
  severity: d.severity || null,
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
 * role, and belongs at the bottom. An alert row that names its own role (the
 * source's role column) skips the rules and is shown by that role's names.
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

  const addRule = () => {
    draftCounter += 1
    setDrafts((rows) => [...rows, { ...BLANK, tmp: `new-${draftCounter}` }])
  }

  const readOnly = !isAdmin
  const busy = save.isPending || remove.isPending

  return (
    <>
      <p className={styles.fldHint}>{tr('Rules are tried from the lowest priority number down; the first whose conditions all fit names who acts on the alert. Leave a condition blank to match anything — a rule with no conditions is the default and belongs last. Location ignores case and spaces, so "Line 13" also matches "Line13".')}</p>
      {!isAdmin && (
        <p className={styles.dsReadonly}>
          <span className={styles.led} /> {tr('Only administrators can change this.')}</p>
      )}

      <div className={styles.roleWrap}>
        <table className={styles.roleTable}>
          <thead>
            <tr>
              <th>{tr('Priority')}</th>
              <th>{tr('Role code')}</th>
              <th>{tr('Name (Thai)')}</th>
              <th>{tr('Name (English)')}</th>
              <th>{tr('Severity')}</th>
              <th>{tr('Location')}</th>
              <th>{tr('Keyword in message')}</th>
              {isAdmin && <th aria-label={tr('Actions')} />}
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => {
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
                  <td className={styles.rolePriority}>{cell('priority', 'Priority', { inputMode: 'numeric' })}</td>
                  <td>{cell('code', 'Role code')}</td>
                  <td>{cell('name_th', 'Name (Thai)')}</td>
                  <td>{cell('name_en', 'Name (English)')}</td>
                  <td>
                    <Select
                      size="small"
                      value={d.severity}
                      onChange={edit(key, 'severity')}
                      disabled={readOnly}
                      displayEmpty
                      inputProps={{ 'aria-label': tr('Severity') }}
                    >
                      <MenuItem value="">{tr('Any')}</MenuItem>
                      <MenuItem value="crit">{tr('Critical')}</MenuItem>
                      <MenuItem value="warn">{tr('Warning')}</MenuItem>
                      <MenuItem value="info">{tr('Info')}</MenuItem>
                    </Select>
                  </td>
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
