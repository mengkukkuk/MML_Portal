import s from './symbols.module.css'

/**
 * IpCamera — a wall-mounted inspection camera. Drawn as a bracket, a barrel
 * and a lens rather than a schematic block, because on a vision-inspection
 * drawing the question an engineer asks first is "what is this one looking
 * at" — the dashed field-of-view cone answers that at a glance, and only
 * appears while the camera is actually online.
 */
export default function IpCamera({ node, tag }) {
  const { w, h } = node
  const online = tag?.state === 'run' || tag?.state === 'closed'

  const barrelY = h * 0.28
  const barrelH = h * 0.36
  const barrelX = w * 0.14
  const barrelW = w * 0.5
  const lensCx = barrelX + barrelW
  const lensCy = barrelY + barrelH / 2
  const lensR = barrelH * 0.62

  return (
    <g className={online ? '' : s.stopped}>
      {/* field of view — the reason this symbol exists rather than a generic box */}
      {online && (
        <path
          className={s.march}
          d={`M ${lensCx} ${lensCy} L ${w} ${lensCy - h * 0.3} M ${lensCx} ${lensCy} L ${w} ${lensCy + h * 0.3}`}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.5}
          opacity={0.5}
        />
      )}

      {/* wall bracket */}
      <path
        className={s.hair}
        d={`M 0 ${h * 0.06} L 0 ${barrelY + barrelH * 0.2} L ${barrelX} ${barrelY + barrelH * 0.5}`}
        fill="none"
      />

      {/* barrel */}
      <rect className={s.bodyElev} x={barrelX} y={barrelY} width={barrelW} height={barrelH} rx={barrelH * 0.22} />

      {/* lens */}
      <circle className={s.body} cx={lensCx} cy={lensCy} r={lensR} fill="var(--bg-app)" />
      <circle cx={lensCx} cy={lensCy} r={lensR * 0.48} fill="var(--accent)" opacity={online ? 0.55 : 0.2} />

      {/* link LED */}
      <circle
        className={online ? s.beacon : ''}
        cx={barrelX + 8}
        cy={barrelY + 8}
        r={2.6}
        fill={online ? 'var(--ok)' : 'var(--fg-dim)'}
      />

      <text
        className={s.label}
        x={w / 2}
        y={h + 18}
        textAnchor="middle"
        style={{ fontSize: node.options?.labelSize }}
        transform={node.rot ? `rotate(${-node.rot} ${node.w / 2} ${node.h / 2})` : undefined}
      >
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={h + 31} textAnchor="middle"
            transform={node.rot ? `rotate(${-node.rot} ${w / 2} ${h / 2})` : undefined}>
        {online ? 'online' : 'offline'}
      </text>
    </g>
  )
}
