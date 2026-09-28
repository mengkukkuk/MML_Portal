import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import TextField from '@mui/material/TextField'
import ArrowDownwardOutlined from '@mui/icons-material/ArrowDownwardOutlined'
import ArrowUpwardOutlined from '@mui/icons-material/ArrowUpwardOutlined'
import DeleteOutlined from '@mui/icons-material/DeleteOutlined'

import { deleteTemplate, fetchTemplate, updateTemplate, createTemplate } from '@/api/reports'
import { apiErrorMessage } from '@/api/client'
import { PRESETS } from '@/components/report/reportRange'
import { COLUMNS as SUMMARY_COLUMN_DEFS, DEFAULT_COLUMNS as DEFAULT_SUMMARY_COLUMNS } from '@/components/report/blocks/SummaryTable'
import { useTranslation } from '@/i18n'
import styles from './ReportBuilderPage.module.css'

/**
 * ReportBuilderPage — admin-only template editor (route: /reports/:id/edit).
 *
 * A separate route rather than an inline mode on ReportPage: editing swaps the
 * whole page into a different task, and sharing an edit URL with another admin
 * is a real workflow. Non-admins never reach here — the route carries
 * `requiresRole: 'admin'`, which RequireAuth enforces before render.
 *
 * Blocks are an ordered list, not a free canvas. The stack order *is* the
 * reading order and the print pagination order, which is why reordering is
 * up/down buttons rather than drag-and-drop: the target is unambiguous, and it
 * works from a keyboard on a plant terminal.
 */

// `tab` mirrors ReportPage's BLOCK_TAB: which of the page's two tabs a block
// lands on. Shown here so an admin adding a block knows where it will appear.
const BLOCK_TYPES = {
  kpi: {
    label: 'KPI Strip',
    hint: 'Defects, batches, defects per batch, top defect, defect rate',
    tab: 'QC Summary',
    defaults: { width: 'full', options: { targetDefectPct: 2 } },
  },
  defect_trend: {
    label: 'Defects Over Time',
    hint: 'Defects per hour/day/week, stacked by defect type',
    tab: 'QC Summary',
    defaults: { width: 'full', options: {} },
  },
  pareto: {
    label: 'Defect Pareto',
    hint: 'Ranked defect types with cumulative %',
    tab: 'QC Summary',
    defaults: { width: 'half', options: { topN: 10, rankBy: 'count' } },
  },
  exceptions: {
    label: 'Quality Exceptions',
    hint: 'Cameras over the warn/critical defect-rate threshold',
    tab: 'QC Summary',
    defaults: { width: 'half', options: { warnPct: 2, critPct: 5, topN: 10 } },
  },
  summary_table: {
    label: 'Camera Summary',
    hint: 'One row per camera with a totals footer',
    tab: 'QC Summary',
    defaults: { width: 'full', options: {} },
  },
  batch_matrix: {
    label: 'Batch x Camera Matrix',
    hint: 'camera_batch_work: one row per batch, one column per camera',
    tab: 'Engineering',
    defaults: { width: 'full', options: {} },
  },
  defect_grid: {
    label: 'Camera x Defect Type',
    hint: 'Each camera\'s defect slots, named from its own labels',
    tab: 'Engineering',
    defaults: { width: 'full', options: {} },
  },
  timeline: {
    label: 'Camera Defect Timeline',
    hint: 'Defects per period heatmap, one row per camera',
    tab: 'Engineering',
    defaults: { width: 'full', options: {} },
  },
  raw_log: {
    label: 'Defect Batch Log',
    hint: 'Raw camera_defect_logs rows with named defects',
    tab: 'Engineering',
    defaults: { width: 'full', options: { pageSize: 50 } },
  },
}

const WIDTHS = [
  { value: 'full', label: 'Full width' },
  { value: 'half', label: 'Half' },
  { value: 'third', label: 'Third' },
]

const SUMMARY_COLUMNS = Object.keys(SUMMARY_COLUMN_DEFS)

let idCounter = 0
const newBlockId = () => `b${Date.now().toString(36)}${(idCounter += 1)}`

function errorText(error) {
  if (!error) return ''
  return apiErrorMessage(error, error?.message || String(error))
}

export default function ReportBuilderPage() {
  const tr = useTranslation()
  const { templateId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [form, setForm] = useState(null)
  const [saveError, setSaveError] = useState('')

  const templateQuery = useQuery({
    queryKey: ['report', 'template', templateId],
    queryFn: () => fetchTemplate(templateId),
    enabled: !!templateId,
  })

  // Seed the working copy once. Deliberately not kept in sync with the query
  // afterwards — a background refetch overwriting unsaved edits would be a
  // silent data loss. With no :templateId (the /reports/new route) there is
  // nothing to fetch, so the blank form is seeded immediately.
  useEffect(() => {
    if (form) return
    if (!templateId) {
      setForm({ name: '', description: '', blocks: [], preset: 'last7d', is_default: false, filters: {} })
      return
    }
    if (!templateQuery.data) return
    const t = templateQuery.data
    setForm({
      name: t.name ?? '',
      description: t.description ?? '',
      blocks: (t.blocks ?? []).map((b) => ({ ...b, id: b.id ?? newBlockId() })),
      preset: t.default_filters?.preset ?? 'last7d',
      is_default: !!t.is_default,
      // Kept whole so saving round-trips keys this form doesn't edit — notably
      // `layout`, the server's one-time block-upgrade stamp. Dropping it would
      // make the next boot re-add blocks an admin just removed.
      filters: t.default_filters ?? {},
    })
  }, [templateId, templateQuery.data, form])

  const saveMutation = useMutation({
    mutationFn: (payload) =>
      templateId ? updateTemplate(templateId, payload) : createTemplate(payload),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['report'] })
      navigate(`/reports/${saved.id}`)
    },
    onError: (e) => setSaveError(errorText(e)),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteTemplate(templateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['report'] })
      navigate('/reports')
    },
    onError: (e) => setSaveError(errorText(e)),
  })

  const usedTypes = useMemo(
    () => new Set((form?.blocks ?? []).map((b) => b.type)),
    [form],
  )

  if ((templateId && templateQuery.isLoading) || !form) {
    return (
      <div className={styles.page}>
        <p className={styles.empty}>
          {templateQuery.error ? errorText(templateQuery.error) : tr('Loading template…')}
        </p>
      </div>
    )
  }

  function patchBlock(id, patch) {
    setForm((f) => ({
      ...f,
      blocks: f.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    }))
  }

  function patchOptions(id, patch) {
    setForm((f) => ({
      ...f,
      blocks: f.blocks.map((b) =>
        b.id === id ? { ...b, options: { ...(b.options ?? {}), ...patch } } : b,
      ),
    }))
  }

  function addBlock(type) {
    const def = BLOCK_TYPES[type]
    setForm((f) => ({
      ...f,
      blocks: [
        ...f.blocks,
        {
          id: newBlockId(),
          type,
          title: tr(def.label),
          width: def.defaults.width,
          options: { ...def.defaults.options },
        },
      ],
    }))
  }

  function move(index, delta) {
    const target = index + delta
    setForm((f) => {
      if (target < 0 || target >= f.blocks.length) return f
      const blocks = [...f.blocks]
      ;[blocks[index], blocks[target]] = [blocks[target], blocks[index]]
      return { ...f, blocks }
    })
  }

  function removeBlock(id) {
    setForm((f) => ({ ...f, blocks: f.blocks.filter((b) => b.id !== id) }))
  }

  function save() {
    setSaveError('')
    if (!form.name.trim()) {
      setSaveError(tr('A template needs a name.'))
      return
    }
    saveMutation.mutate({
      name: form.name.trim(),
      description: form.description,
      blocks: form.blocks,
      default_filters: { ...form.filters, preset: form.preset },
      is_default: form.is_default,
    })
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h2 className={styles.title}>{templateId ? tr('Edit report template') : tr('New report template')}</h2>
        <div className={styles.actions}>
          <Button size="small" onClick={() => navigate(templateId ? `/reports/${templateId}` : '/reports')}>
            {tr('Cancel')}
          </Button>
          <Button
            size="small"
            variant="contained"
            loading={saveMutation.isPending}
            onClick={save}
          >
            {tr('Save')}
          </Button>
        </div>
      </header>

      {saveError && <p className={styles.error}>{saveError}</p>}

      <section className={styles.card}>
        <div className={styles.row}>
          <TextField
            size="small"
            label={tr('Name')}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className={styles.grow}
          />
          <FormControl size="small" className={styles.preset}>
            <Select
              value={form.preset}
              onChange={(e) => setForm((f) => ({ ...f, preset: e.target.value }))}
            >
              {Object.entries(PRESETS).map(([key, p]) => (
                <MenuItem key={key} value={key}>
                  {tr('Default range: {range}', { range: tr(p.label) })}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </div>
        <TextField
          size="small"
          label={tr('Description')}
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          fullWidth
        />
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={form.is_default}
              onChange={(e) => setForm((f) => ({ ...f, is_default: e.target.checked }))}
            />
          }
          label={tr('Open this template when /reports is visited')}
        />
      </section>

      <section className={styles.card}>
        <h3 className={styles.subtitle}>{tr('Add a block')}</h3>
        <div className={styles.palette}>
          {Object.entries(BLOCK_TYPES).map(([type, def]) => (
            <button
              key={type}
              type="button"
              className={styles.paletteItem}
              onClick={() => addBlock(type)}
            >
              <span className={styles.paletteLabel}>
                {tr(def.label)}
                {usedTypes.has(type) && <span className={styles.usedTag}>{tr('in use')}</span>}
              </span>
              <span className={styles.paletteHint}>{tr(def.hint)}</span>
              <span className={styles.paletteHint}>{tr('Tab: {tab}', { tab: tr(def.tab) })}</span>
            </button>
          ))}
        </div>
      </section>

      <section className={styles.card}>
        <h3 className={styles.subtitle}>
          {tr('Blocks')} <span className={styles.hint}>— {tr('order here is the order within each tab and in print')}</span>
        </h3>

        {!form.blocks.length && (
          <p className={styles.empty}>{tr('No blocks yet. Add one above.')}</p>
        )}

        <ol className={styles.list}>
          {form.blocks.map((block, i) => (
            <li key={block.id} className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.itemType}>
                  {BLOCK_TYPES[block.type] ? `${tr(BLOCK_TYPES[block.type].label)} · ${tr(BLOCK_TYPES[block.type].tab)}` : block.type}
                </span>
                <div className={styles.itemActions}>
                  <Button
                    size="small"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={tr('Move up')}
                  >
                    <ArrowUpwardOutlined fontSize="small" />
                  </Button>
                  <Button
                    size="small"
                    disabled={i === form.blocks.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={tr('Move down')}
                  >
                    <ArrowDownwardOutlined fontSize="small" />
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    onClick={() => removeBlock(block.id)}
                    aria-label={tr('Remove block')}
                  >
                    <DeleteOutlined fontSize="small" />
                  </Button>
                </div>
              </div>

              <div className={styles.row}>
                <TextField
                  size="small"
                  label={tr('Title')}
                  value={block.title ?? ''}
                  onChange={(e) => patchBlock(block.id, { title: e.target.value })}
                  className={styles.grow}
                />
                <FormControl size="small" className={styles.width}>
                  <Select
                    value={block.width ?? 'full'}
                    onChange={(e) => patchBlock(block.id, { width: e.target.value })}
                  >
                    {WIDTHS.map((w) => (
                      <MenuItem key={w.value} value={w.value}>
                        {tr(w.label)}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </div>

              <BlockOptions block={block} patchOptions={patchOptions} />
            </li>
          ))}
        </ol>
      </section>

      {templateId && (
        <section className={styles.card}>
          <h3 className={styles.subtitle}>{tr('Danger zone')}</h3>
          <p className={styles.hint}>
            {tr('Deleting a template does not touch any log data — reports are computed live from vision_data every time they are run.')}
          </p>
          <Button
            size="small"
            color="error"
            variant="outlined"
            loading={deleteMutation.isPending}
            onClick={() => {
              if (window.confirm(tr('Delete template "{name}"? This cannot be undone.', { name: form.name }))) {
                deleteMutation.mutate()
              }
            }}
          >
            {tr('Delete template')}
          </Button>
        </section>
      )}
    </div>
  )
}

/** Per-type option form. Only the handful of knobs each block actually reads. */
function BlockOptions({ block, patchOptions }) {
  const tr = useTranslation()
  const o = block.options ?? {}

  if (block.type === 'kpi') {
    return (
      <TextField
        size="small"
        type="number"
        label={tr('Target defect rate %')}
        value={o.targetDefectPct ?? 2}
        onChange={(e) => patchOptions(block.id, { targetDefectPct: Number(e.target.value) })}
        className={styles.num}
      />
    )
  }

  if (block.type === 'pareto') {
    return (
      <div className={styles.row}>
        <TextField
          size="small"
          type="number"
          label={tr('Top N defects')}
          value={o.topN ?? 10}
          onChange={(e) => patchOptions(block.id, { topN: Number(e.target.value) })}
          className={styles.num}
        />
        <FormControl size="small" className={styles.width}>
          <Select
            value={o.rankBy ?? 'count'}
            onChange={(e) => patchOptions(block.id, { rankBy: e.target.value })}
          >
            <MenuItem value="count">{tr('Rank by count')}</MenuItem>
            <MenuItem value="batches">{tr('Rank by batches')}</MenuItem>
          </Select>
        </FormControl>
      </div>
    )
  }

  if (block.type === 'exceptions') {
    return (
      <div className={styles.row}>
        <TextField
          size="small"
          type="number"
          label={tr('Warn ≥ defect rate %')}
          value={o.warnPct ?? 2}
          onChange={(e) => patchOptions(block.id, { warnPct: Number(e.target.value) })}
          className={styles.num}
        />
        <TextField
          size="small"
          type="number"
          label={tr('Critical ≥ defect rate %')}
          value={o.critPct ?? 5}
          onChange={(e) => patchOptions(block.id, { critPct: Number(e.target.value) })}
          className={styles.num}
        />
        <TextField
          size="small"
          type="number"
          label={tr('Top N shown')}
          value={o.topN ?? 10}
          onChange={(e) => patchOptions(block.id, { topN: Number(e.target.value) })}
          className={styles.num}
        />
      </div>
    )
  }

  if (block.type === 'summary_table') {
    const columns = o.columns ?? DEFAULT_SUMMARY_COLUMNS
    return (
      <div className={styles.columns}>
        {SUMMARY_COLUMNS.map((col) => (
          <FormControlLabel
            key={col}
            control={
              <Checkbox
                size="small"
                checked={columns.includes(col)}
                onChange={(e) =>
                  patchOptions(block.id, {
                    columns: e.target.checked
                      ? [...SUMMARY_COLUMNS.filter(
                          (c) => columns.includes(c) || c === col,
                        )]
                      : columns.filter((c) => c !== col),
                  })
                }
              />
            }
            label={tr(SUMMARY_COLUMN_DEFS[col].label)}
          />
        ))}
      </div>
    )
  }

  if (block.type === 'raw_log') {
    return (
      <FormControl size="small" className={styles.width}>
        <Select
          value={o.pageSize ?? 50}
          onChange={(e) => patchOptions(block.id, { pageSize: Number(e.target.value) })}
        >
          {[25, 50, 100, 200].map((n) => (
            <MenuItem key={n} value={n}>
              {tr('{count} rows per page', { count: n })}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    )
  }

  return null
}
