import { Controller } from 'react-hook-form'
import Switch from '@mui/material/Switch'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import styles from './PanelEditorDialog.module.css'

/**
 * ParamFields — renders the PARAM_SCHEMA-driven per-viz-type option fields
 * (switch/number/enum) inside PanelEditorDialog's "Options" sub-menu. Pure
 * presentational: all state lives in the parent's react-hook-form `control`,
 * bound here via dotted paths `options.<key>` so a whole-object reset
 * (onVizTypeChange swapping form.options wholesale) and a single-field edit
 * both flow through the same RHF subscription. Ported from LivePage.vue's
 * `<el-form-item v-for="f in currentSchema">` block (submenu__grid, lines
 * 1152-1171).
 *
 * Numeric fields never coerce a cleared input to 0 (the "empty numeric field
 * -> 0" risk from MUI's TextField type="number"): blank resolves to `null`
 * when the field is `nullable` (warn/crit/colorMin/colorMax), else back to
 * the field's own schema default — never a bare `Number('')`.
 */
export default function ParamFields({ schema, control }) {
  if (!schema?.length) return null
  return (
    <div className={styles.submenuGrid}>
      {schema.map((f) => (
        <div key={f.key} className={styles.submenuField}>
          <label className={styles.submenuLabel}>{f.label}</label>
          <Controller
            name={`options.${f.key}`}
            control={control}
            render={({ field }) => {
              if (f.type === 'switch') {
                return (
                  <Switch
                    size="small"
                    checked={!!field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                  />
                )
              }
              if (f.type === 'enum') {
                return (
                  <Select
                    size="small"
                    fullWidth
                    value={field.value ?? f.default}
                    onChange={(e) => field.onChange(e.target.value)}
                  >
                    {(f.options || []).map((o) => (
                      <MenuItem key={o} value={o}>{o}</MenuItem>
                    ))}
                  </Select>
                )
              }
              return (
                <TextField
                  size="small"
                  type="number"
                  fullWidth
                  placeholder={f.nullable ? 'none' : ''}
                  slotProps={{ htmlInput: { min: f.min, max: f.max } }}
                  value={field.value ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value
                    if (raw === '') {
                      field.onChange(f.nullable ? null : (f.default ?? 0))
                      return
                    }
                    const n = Number(raw)
                    field.onChange(Number.isFinite(n) ? n : null)
                  }}
                />
              )
            }}
          />
        </div>
      ))}
    </div>
  )
}
