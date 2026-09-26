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
import { PRESETS } from '@/components/report/reportRange'
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

const BLOCK_TYPES = {
  kpi: {
    label: 'KPI Strip',
    hint: 'Inspected, defects, defect rate, cameras reporting',
    defaults: { width: 'full', options: { targetDefectPct: 2 } },
  },
  timeline: {
    label: 'Camera Throughput Timeline',
    hint: 'Hourly defect-rate heatmap, one row per camera',
    defaults: { width: 'full', options: {} },
  },
  pareto: {
    label: 'Defect Pareto',
    hint: 'Ranked defect types with cumulative %',
    defaults: { width: 'half', options: { topN: 10, rankBy: 'count' } },
  },
  exceptions: {
    label: 'Quality Exceptions',
    hint: 'Cameras over the warn/critical defect-rate threshold',
    defaults: { width: 'half', options: { warnPct: 2, critPct: 5, topN: 10 } },
  },
  summary_table: {
    label: 'Camera Summary',
    hint: 'One row per camera with a totals footer',
    defaults: { width: 'full', options: {} },
  },
  raw_log: {
    label: 'Defect Batch Log',
    hint: 'Raw, unclassified camera_defect_logs rows',
    defaults: { width: 'full', options: { pageSize: 50 } },
  },
}

const WIDTHS = [
  { value: 'full', label: 'Full width' },
  { value: 'half', label: 'Half' },
  { value: 'third', label: 'Third' },
]

const SUMMARY_COLUMNS = ['camera', 'inspected', 'defects', 'rate', 'worstDefect', 'lastSeen', 'status']

const DEFAULT_SUMMARY_COLUMNS = SUMMARY_COLUMNS

let idCounter = 0
const newBlockId = () => `b${Date.now().toString(36)}${(idCounter += 1)}`

function errorText(error) {
  if (!error) return ''
  return error?.response?.data?.detail || error?.message || String(error)
}

export default function ReportBuilderPage() {
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
      setForm({ name: '', description: '', blocks: [], preset: 'last7d', is_default: false })
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
          {templateQuery.error ? errorText(templateQuery.error) : 'Loading template…'}
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
          title: def.label,
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
      setSaveError('A template needs a name.')
      return
    }
    saveMutation.mutate({
      name: form.name.trim(),
      description: form.description,
      blocks: form.blocks,
      default_filters: { preset: form.preset },
      is_default: form.is_default,
    })
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h2 className={styles.title}>{templateId ? 'Edit report template' : 'New report template'}</h2>
        <div className={styles.actions}>
          <Button size="small" onClick={() => navigate(templateId ? `/reports/${templateId}` : '/reports')}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            loading={saveMutation.isPending}
            onClick={save}
          >
            Save
          </Button>
        </div>
      </header>

      {saveError && <p className={styles.error}>{saveError}</p>}

      <section className={styles.card}>
        <div className={styles.row}>
          <TextField
            size="small"
            label="Name"
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
                  Default range: {p.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </div>
        <TextField
          size="small"
          label="Description"
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
          label="Open this template when /reports is visited"
        />
      </section>

      <section className={styles.card}>
        <h3 className={styles.subtitle}>Add a block</h3>
        <div className={styles.palette}>
          {Object.entries(BLOCK_TYPES).map(([type, def]) => (
            <button
              key={type}
              type="button"
              className={styles.paletteItem}
              onClick={() => addBlock(type)}
            >
              <span className={styles.paletteLabel}>
                {def.label}
                {usedTypes.has(type) && <span className={styles.usedTag}>in use</span>}
              </span>
              <span className={styles.paletteHint}>{def.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section className={styles.card}>
        <h3 className={styles.subtitle}>
          Blocks <span className={styles.hint}>— order here is the order on the page and in print</span>
        </h3>

        {!form.blocks.length && (
          <p className={styles.empty}>No blocks yet. Add one above.</p>
        )}

        <ol className={styles.list}>
          {form.blocks.map((block, i) => (
            <li key={block.id} className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.itemType}>
                  {BLOCK_TYPES[block.type]?.label ?? block.type}
                </span>
                <div className={styles.itemActions}>
                  <Button
                    size="small"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label="Move up"
                  >
                    <ArrowUpwardOutlined fontSize="small" />
                  </Button>
                  <Button
                    size="small"
                    disabled={i === form.blocks.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label="Move down"
                  >
                    <ArrowDownwardOutlined fontSize="small" />
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    onClick={() => removeBlock(block.id)}
                    aria-label="Remove block"
                  >
                    <DeleteOutlined fontSize="small" />
                  </Button>
                </div>
              </div>

              <div className={styles.row}>
                <TextField
                  size="small"
                  label="Title"
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
                        {w.label}
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
          <h3 className={styles.subtitle}>Danger zone</h3>
          <p className={styles.hint}>
            Deleting a template does not touch any log data — reports are computed
            live from vision_data every time they are run.
          </p>
          <Button
            size="small"
            color="error"
            variant="outlined"
            loading={deleteMutation.isPending}
            onClick={() => {
              if (window.confirm(`Delete template "${form.name}"? This cannot be undone.`)) {
                deleteMutation.mutate()
              }
            }}
          >
            Delete template
          </Button>
        </section>
      )}
    </div>
  )
}

/** Per-type option form. Only the handful of knobs each block actually reads. */
function BlockOptions({ block, patchOptions }) {
  const o = block.options ?? {}

  if (block.type === 'kpi') {
    return (
      <TextField
        size="small"
        type="number"
        label="Target defect rate %"
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
          label="Top N defects"
          value={o.topN ?? 10}
          onChange={(e) => patchOptions(block.id, { topN: Number(e.target.value) })}
          className={styles.num}
        />
        <FormControl size="small" className={styles.width}>
          <Select
            value={o.rankBy ?? 'count'}
            onChange={(e) => patchOptions(block.id, { rankBy: e.target.value })}
          >
            <MenuItem value="count">Rank by count</MenuItem>
            <MenuItem value="batches">Rank by batches</MenuItem>
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
          label="Warn ≥ defect rate %"
          value={o.warnPct ?? 2}
          onChange={(e) => patchOptions(block.id, { warnPct: Number(e.target.value) })}
          className={styles.num}
        />
        <TextField
          size="small"
          type="number"
          label="Critical ≥ defect rate %"
          value={o.critPct ?? 5}
          onChange={(e) => patchOptions(block.id, { critPct: Number(e.target.value) })}
          className={styles.num}
        />
        <TextField
          size="small"
          type="number"
          label="Top N shown"
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
            label={col}
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
              {n} rows per page
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    )
  }

  return null
}
