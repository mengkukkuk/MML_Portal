import { useMemo } from 'react'
import Button from '@mui/material/Button'
import LinkOutlined from '@mui/icons-material/LinkOutlined'
import EChart from '@/components/charts/EChart'
import { symbolDef } from '@/components/mimic/symbols'
import { formatValue } from '@/components/mimic/tagStatus'
import { useSettingsStore } from '@/stores/settings'
import styles from './DetailRail.module.css'

const STATUS_CLASS = {
  normal: styles.toNormal, warn: styles.toWarn, crit: styles.toCrit, stale: styles.toStale,
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}

/**
 * DetailRail — what makes /monitor deeper than /live: a mimic alone shows
 * values, but clicking an asset should give the whole story behind one.
 *
 * Works with or without a node: selecting a symbol passes both, clicking a
 * tag in the strip passes the tag alone.
 */
export default function DetailRail({
  tag, node, history, events, canBind = false, onConnect,
}) {
  const theme = useSettingsStore((s) => s.theme)

  const sparkOption = useMemo(() => {
    if (!history?.length) return null
    // Read the live faceplate rather than hardcoding a hex — the three themes
    // change --accent, and a fixed colour would survive a theme switch.
    const accent = cssVar('--accent')
    return {
      animation: false,
      grid: {
        left: 2, right: 2, top: 6, bottom: 2, containLabel: false,
      },
      xAxis: { type: 'time', show: false },
      yAxis: { type: 'value', show: false, scale: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: cssVar('--bg-elev'),
        borderColor: cssVar('--border'),
        textStyle: { color: cssVar('--fg'), fontSize: 11 },
        formatter: (p) => `${clockTime(p[0].value[0])}  ${Number(p[0].value[1]).toFixed(2)}`,
      },
      series: [{
        type: 'line',
        showSymbol: false,
        smooth: 0.2,
        lineStyle: { width: 1.5, color: accent },
        areaStyle: { color: accent, opacity: 0.12 },
        data: history,
      }],
    }
    // `theme` is not read directly — it invalidates the cssVar() reads above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, theme])

  // A selected symbol with no reading behind it is a different state from
  // nothing being selected: it has a name and an obvious next step.
  if (!tag && node) {
    return (
      <aside className={styles.rail}>
        <div className={styles.head}>
          <span className={styles.eyebrow}>{symbolDef(node)?.label}</span>
          <span className={styles.tagId}>{node.tagId || 'No loop id'}</span>
          <span className={styles.tagLabel}>{node.label}</span>
        </div>
        <p className={styles.quiet}>
          Not connected. This symbol is drawn on the plant but has no reading behind it.
        </p>
        {canBind && (
          <div className={styles.connectRow}>
            <Button
              fullWidth
              variant="contained"
              startIcon={<LinkOutlined />}
              onClick={() => onConnect(node)}
            >
              Connect data source
            </Button>
          </div>
        )}
      </aside>
    )
  }

  if (!tag) {
    return (
      <aside className={styles.rail}>
        <div className={styles.empty}>
          <span className={styles.emptyTitle}>No asset selected</span>
          <p>
            Click any symbol on the mimic, or any tag in the strip below it, to see its
            reading, trend, limits and recent state changes.
          </p>
        </div>
      </aside>
    )
  }

  const symbolLabel = node ? symbolDef(node)?.label : 'Unplaced tag'
  const statusClass = tag.status === 'crit' ? styles.valueCrit
    : tag.status === 'warn' ? styles.valueWarn : ''

  const delta = tag.display != null && tag.prevDisplay != null
    ? tag.display - tag.prevDisplay
    : null

  const lim = tag.limits || {}
  const range = tag.range
  const pos = (v) => (range ? ((v - range[0]) / (range[1] - range[0])) * 100 : 0)
  // Scoped to the selected *node*, not the loop id: two symbols may print the
  // same loop, and one's transitions must never appear under the other.
  const tagEvents = node
    ? events.filter((e) => e.nodeId === node.id)
    : events.filter((e) => e.tag === tag.id)

  return (
    <aside className={styles.rail} aria-live="polite">
      <div className={styles.head}>
        <span className={styles.eyebrow}>{symbolLabel}</span>
        <span className={styles.tagId}>{tag.id}</span>
        <span className={styles.tagLabel}>{tag.label}</span>
      </div>

      <div className={styles.reading}>
        {tag.display != null ? (
          <>
            <span className={`${styles.value} ${statusClass}`}>{formatValue(tag)}</span>
            {tag.unit && <span className={styles.unit}>{tag.unit}</span>}
          </>
        ) : (
          <span className={styles.state}>{tag.state ?? '—'}</span>
        )}
        {delta != null && (
          <span className={styles.delta}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '·'}
            {' '}
            {delta === 0 ? 'steady' : `${delta > 0 ? '+' : ''}${delta.toFixed(tag.decimals)}`}
          </span>
        )}
      </div>

      {tag.state && tag.display != null && (
        <span className={styles.state}>{tag.state}</span>
      )}

      {sparkOption && (
        <div className={styles.spark}>
          <EChart option={sparkOption} />
        </div>
      )}

      {range && (
        <div className={styles.ladder}>
          <div className={styles.track}>
            {lim.critLo != null && (
              <span className={`${styles.band} ${styles.bandCrit}`} style={{ left: 0, width: `${pos(lim.critLo)}%` }} />
            )}
            {lim.warnLo != null && lim.critLo != null && (
              <span className={`${styles.band} ${styles.bandWarn}`} style={{ left: `${pos(lim.critLo)}%`, width: `${pos(lim.warnLo) - pos(lim.critLo)}%` }} />
            )}
            {lim.warnHi != null && lim.critHi != null && (
              <span className={`${styles.band} ${styles.bandWarn}`} style={{ left: `${pos(lim.warnHi)}%`, width: `${pos(lim.critHi) - pos(lim.warnHi)}%` }} />
            )}
            {lim.critHi != null && (
              <span className={`${styles.band} ${styles.bandCrit}`} style={{ left: `${pos(lim.critHi)}%`, right: 0 }} />
            )}
            {tag.value != null && (
              <span className={styles.marker} style={{ left: `${Math.min(99.5, Math.max(0, pos(tag.value)))}%` }} />
            )}
          </div>
          <div className={styles.limits}>
            <span>{range[0]}</span>
            <span>
              lo
              {' '}
              {lim.warnLo ?? '—'}
              {' · hi '}
              {lim.warnHi ?? '—'}
            </span>
            <span>{range[1]}</span>
          </div>
        </div>
      )}

      <div>
        <div className={styles.sectionTitle}>Recent state changes</div>
        {tagEvents.length ? (
          <ul className={styles.events}>
            {tagEvents.map((e) => (
              <li className={styles.event} key={`${e.ts}-${e.to}`}>
                <span className={styles.eventTime}>{clockTime(e.ts)}</span>
                <span className={styles.eventText}>
                  {e.from}
                  {' → '}
                </span>
                <span className={`${styles.eventTo} ${STATUS_CLASS[e.to] || ''}`}>{e.to}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.quiet}>Steady since this page opened.</p>
        )}
      </div>

      <div>
        <div className={styles.sectionTitle}>Tag</div>
        <div className={styles.meta}>
          <span className={styles.metaKey}>Signal</span>
          <span className={styles.metaVal}>{tag.kind}</span>
          <span className={styles.metaKey}>Status</span>
          <span className={`${styles.metaVal} ${STATUS_CLASS[tag.status] || ''}`}>{tag.status}</span>
          {node && (
            <>
              <span className={styles.metaKey}>Asset</span>
              <span className={styles.metaVal}>{node.label}</span>
            </>
          )}
          <span className={styles.metaKey}>Updated</span>
          <span className={styles.metaVal}>{clockTime(tag.ts)}</span>
        </div>
      </div>

      {/* An admin shouldn't have to enter edit mode just to retune a limit or
          repoint a symbol at a different column. */}
      {canBind && node && (
        <div className={styles.connectRow}>
          <Button
            fullWidth
            variant="outlined"
            color="inherit"
            startIcon={<LinkOutlined />}
            onClick={() => onConnect(node)}
          >
            {node.binding ? 'Edit connection' : 'Connect data source'}
          </Button>
        </div>
      )}
    </aside>
  )
}
