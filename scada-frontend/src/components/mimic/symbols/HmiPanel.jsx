import s from './symbols.module.css'

/**
 * HmiPanel — the operator terminal at the machine. A bezel with a screen and
 * a hard-wired e-stop below it: the e-stop is drawn because it is the one
 * control on the panel that is not software, and a drawing that omits it
 * misrepresents what the operator can actually reach.
 */
export default function HmiPanel({ node, tag }) {
  const { w, h } = node
  const live = tag?.state === 'run' || tag?.state === 'closed'

  const bezelH = h * 0.68
  const inset = w * 0.1

  return (
    <g className={live ? '' : s.stopped}>
      <rect className={s.bodyElev} x={0} y={0} width={w} height={bezelH} rx={4} />
      <rect
        className={s.body}
        x={inset}
        y={h * 0.1}
        width={w - inset * 2}
        height={bezelH - h * 0.2}
        rx={2}
        fill={live ? 'var(--bg-app)' : 'var(--bg-panel)'}
      />

      {/* screen content, abstracted to two trend lines — enough to read as a
          display without pretending to show a real page */}
      {live && (
        <>
          <path
            className={s.accentStroke}
            d={`M ${inset + 6} ${bezelH * 0.62} l ${(w - inset * 2 - 12) * 0.3} ${-h * 0.12} l ${(w - inset * 2 - 12) * 0.35} ${h * 0.07} l ${(w - inset * 2 - 12) * 0.35} ${-h * 0.1}`}
            strokeWidth={1.5}
          />
          <line
            className={s.hair}
            x1={inset + 6}
            y1={bezelH * 0.74}
            x2={w - inset - 6}
            y2={bezelH * 0.74}
          />
        </>
      )}

      {/* e-stop mushroom */}
      <circle className={s.body} cx={w / 2} cy={bezelH + h * 0.13} r={h * 0.09} fill="var(--crit)" />

      <text className={s.label} x={w / 2} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
