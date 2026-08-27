import s from './symbols.module.css'

/**
 * Ats — automatic transfer switch: two incoming sources at the top, one outgoing
 * feeder at the bottom, and a blade that rests on whichever source is carrying.
 *
 * The blade's travel is the information. A switch that snapped between positions
 * would tell an operator where it ended up but not that it moved — and on an ATS
 * the transfer *event* is the thing worth noticing. `.slide` tweens it, the same
 * way Breaker's moving contact swings rather than jumps.
 *
 * Bind with `state.mode: 'map'`: `run` (or `a`) is the normal source, `b` the
 * alternate, and anything else reads as neither — drawn mid-travel, which is
 * where a genuinely stuck switch belongs.
 */
export default function Ats({ node, tag }) {
  const { w, h } = node
  const state = tag?.state ?? 'run'
  const onB = state === 'b' || state === 'stop'
  const onA = state === 'run' || state === 'a'

  const cx = w / 2
  const pivotY = h * 0.62
  const sourceY = h * 0.26
  const ax = w * 0.2
  const bx = w * 0.8

  // Neither source claimed: the blade hangs between them rather than picking one
  // it is not actually on.
  const angle = onA ? -32 : onB ? 32 : 0

  return (
    <g>
      {/* the two incomers, down to their contacts */}
      <line className={onA ? s.accentStroke : s.hair} x1={ax} y1={0} x2={ax} y2={sourceY} />
      <line className={onB ? s.accentStroke : s.hair} x1={bx} y1={0} x2={bx} y2={sourceY} />
      <circle className={onA ? s.accentFill : s.hairFill} cx={ax} cy={sourceY} r={3} />
      <circle className={onB ? s.accentFill : s.hairFill} cx={bx} cy={sourceY} r={3} />

      <text className={s.labelDim} x={ax} y={sourceY - 8} textAnchor="middle">A</text>
      <text className={s.labelDim} x={bx} y={sourceY - 8} textAnchor="middle">B</text>

      {/* The blade, pivoting at the common terminal. `.slide` sets
          `transform-box: fill-box`, and this group holds only the blade — whose
          box therefore ends at the pivot. So `bottom` is the pivot, with no
          invisible spacer rect needed to stretch the box out to it. */}
      <g className={s.slide} style={{ transform: `rotate(${angle}deg)`, transformOrigin: 'bottom' }}>
        <line
          className={onA || onB ? s.accentStroke : s.hair}
          x1={cx}
          y1={pivotY}
          x2={cx}
          y2={sourceY}
          strokeLinecap="round"
          strokeWidth={2.5}
        />
      </g>

      <circle className={s.accentFill} cx={cx} cy={pivotY} r={3} />
      <line className={s.body} x1={cx} y1={pivotY} x2={cx} y2={h} />

      <text
        className={s.label}
        x={cx}
        y={h + 18}
        textAnchor="middle"
        style={{ fontSize: node.options?.labelSize }}
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {node.label}
      </text>
      <text
        className={s.labelDim}
        x={cx}
        y={h + 31}
        textAnchor="middle"
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {onA ? 'source A' : onB ? 'source B' : 'transferring'}
      </text>
    </g>
  )
}
