import { useMemo } from 'react'
import { useTranslation } from '@/i18n'
import { paceGeometry, fmtPieces } from '../kpiView'
import styles from './Blocks.module.css'

const W = 600
const H = 220
const PAD = { l: 8, r: 92, t: 10, b: 22 }

/**
 * PlanPace — "are we making the plan": cumulative good pieces against the plan
 * line, with stopped time as grey bands and missing data hatched behind them.
 *
 * The faint upper line is what the line could have made (good + every counted
 * loss): the gap between it and the plan is a plan problem, the gap between it
 * and the actual line is a running problem. Without a plan the block still
 * draws actual against could-have-made. x spans the whole period, so the rest
 * of the day is visible as ground still to cover.
 */
export default function PlanPace({ summary }) {
  const tr = useTranslation()
  const g = useMemo(() => paceGeometry(summary), [summary])
  if (!g) return null
  const X = (x) => PAD.l + x * (W - PAD.l - PAD.r)
  const Y = (y) => H - PAD.b - y * (H - PAD.t - PAD.b)
  const path = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ')
  const last = g.last
  const end = g.good[g.good.length - 1]
  const p = summary.period
  const t0 = new Date(p.start)
  const t1 = new Date(p.full_end || p.end)
  const tick = (d) => (p.name === 'today'
    ? `${String(d.getHours()).padStart(2, '0')}:00` : `${d.getDate()}/${d.getMonth() + 1}`)
  const behind = summary.plan && last.plan_cum != null ? last.good_cum - last.plan_cum : null

  return (
    <>
      <svg className={styles.pace} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${tr('Good')} ${fmtPieces(last.good_cum)}${summary.plan ? ` · ${tr('Plan')} ${fmtPieces(last.plan_cum)}` : ''}`}>
        <defs>
          <pattern id="pace-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className={styles.pace__hatch} />
          </pattern>
        </defs>
        {g.bands.map((b, i) => (
          <rect key={i} x={X(b.x)} y={PAD.t} width={Math.max(1, X(b.x + b.w) - X(b.x))} height={H - PAD.t - PAD.b}
            className={b.state === 'stop' ? styles.pace__stop : undefined}
            fill={b.state === 'nodata' ? 'url(#pace-hatch)' : undefined} />
        ))}
        <line x1={X(0)} x2={X(1)} y1={Y(0)} y2={Y(0)} className={styles.pace__axis} />
        <path d={path(g.potential)} className={styles.pace__potential} />
        {g.plan && <path d={path(g.plan)} className={styles.pace__plan} />}
        <path d={path(g.good)} className={styles.pace__good} />
        <circle cx={X(end[0])} cy={Y(end[1])} r="4" className={styles.pace__dot} />
        {g.plan && (
          <text x={W - PAD.r + 6} y={Y(g.plan[1][1])} dy="0.35em" className={styles.pace__lbl}>
            {tr('Plan')} {fmtPieces(summary.plan.total)}
          </text>
        )}
        <text x={X(end[0]) + 8} y={Y(end[1])} dy="0.35em" className={`${styles.pace__lbl} ${styles['pace__lbl--good']}`}>
          {fmtPieces(last.good_cum)}
        </text>
        <text x={X(0)} y={H - 6} className={styles.pace__lbl}>{tick(t0)}</text>
        <text x={X(1)} y={H - 6} textAnchor="end" className={styles.pace__lbl}>{tick(t1)}</text>
      </svg>
      <p className={styles.foot}>
        {behind != null && (
          <span className={behind < 0 ? styles['tone--bad'] : styles['tone--good']}>
            {behind < 0 ? tr('{n} behind plan', { n: fmtPieces(-behind) }) : tr('{n} ahead of plan', { n: fmtPieces(behind) })}
            {' · '}
          </span>
        )}
        {tr('grey = stopped · hatched = no data · faint line = could have made')}
      </p>
    </>
  )
}
