import { useEffect, useRef, useState } from 'react'
import s from './symbols.module.css'

/* Below this the blade is trimming, not travelling. A modulating damper on a
 * one-second tick moves a fraction of a degree every tick, and a symbol that
 * called that "travelling" would never stop saying so. */
const TRAVEL_DEG = 2
/* Just past the blade's own 0.55s sweep, so the drive is still turning when
 * the blade arrives rather than stopping a beat early. */
const TRAVEL_MS = 750

/**
 * Actuator — motor-operated fuel damper. Carries both a discrete state
 * (open / closed) and an analog position, and the blade angle is driven by
 * the position: fully horizontal is wide open, vertical is shut.
 *
 * On-change animation: the blade sweeps to its new angle instead of
 * snapping (CSS transition on `.needle`), and the drive collar on the stem
 * turns while it sweeps.
 *
 * The turning collar is the point of the symbol. A damper spends nearly all
 * its life parked at a limit, so the moment worth drawing is the one in
 * between — "in transit" is a state of its own, it is when a seized actuator
 * shows itself, and without motion an operator can only infer it by watching a
 * number change. A travelling damper is therefore never drawn as stopped, even
 * on its way to shut.
 */
export default function Actuator({ node, tag }) {
  const { w, h } = node
  const closed = tag?.state === 'closed'
  const pct = tag?.value == null ? 0 : Math.min(1, Math.max(0, tag.value / 100))
  const angle = 90 * (1 - pct)

  const [travelling, setTravelling] = useState(false)
  const restAngle = useRef(angle)
  useEffect(() => {
    if (Math.abs(angle - restAngle.current) < TRAVEL_DEG) return undefined
    restAngle.current = angle
    setTravelling(true)
    const settle = setTimeout(() => setTravelling(false), TRAVEL_MS)
    return () => clearTimeout(settle)
  }, [angle])

  const ductTop = h * 0.36
  const ductH = h - ductTop
  const cx = w / 2
  const cy = ductTop + ductH / 2
  const bladeR = Math.min(w, ductH) * 0.42
  const stemTop = h * 0.22
  const collarY = (stemTop + cy) / 2

  return (
    <g className={closed && !travelling ? s.stopped : ''}>
      {/* actuator head + stem */}
      <rect className={s.bodyElev} x={cx - w * 0.26} y={0} width={w * 0.52} height={h * 0.22} rx={2} />
      <line className={s.hair} x1={cx} y1={stemTop} x2={cx} y2={cy} />
      <text className={s.labelDim} x={cx} y={h * 0.15} textAnchor="middle">
        M
      </text>

      {/* The drive collar. Always drawn, so nothing appears or disappears —
          only its motion and its tint change when the motor is stroking. */}
      <g className={travelling ? s.spin : ''}>
        <line
          className={travelling ? s.accentStroke : s.hair}
          x1={cx - w * 0.15}
          y1={collarY}
          x2={cx + w * 0.15}
          y2={collarY}
        />
      </g>

      {/* duct walls — the blade sits between them */}
      <line className={s.body} x1={0} y1={ductTop} x2={w} y2={ductTop} />
      <line className={s.body} x1={0} y1={h} x2={w} y2={h} />

      <g className={s.needle} style={{ transform: `rotate(${angle}deg)` }}>
        <circle cx={cx} cy={cy} r={bladeR} fill="none" stroke="none" />
        <line x1={cx - bladeR} y1={cy} x2={cx + bladeR} y2={cy} />
      </g>
      <circle className={s.hairFill} cx={cx} cy={cy} r={3} />

      <text className={s.label} x={cx} y={h + 18} textAnchor="middle">
        {node.label}
      </text>
    </g>
  )
}
