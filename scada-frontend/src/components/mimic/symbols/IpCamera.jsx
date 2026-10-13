import s from './symbols.module.css'
import IpCameraClassic from './IpCameraClassic'
import {
  PLATE_MIN_W, cameraLayout, plateWidth, squeezedCodeWidth,
} from './cameraLayout'
import { cameraStyle, platePlacement } from './cameraStyle'

/**
 * A word in `state` that means this camera is up. `closed` counts because a made
 * contact is a connected camera — the reading the earlier drawing already used.
 */
const ONLINE_STATES = new Set(['run', 'closed'])

/** The words (see STATE_TOKENS in tagStatus.js) that colour a tag as an alarm. */
const FAULT_STATES = new Set(['fault', 'alarm', 'trip', 'crit', 'red'])

/**
 * IpCamera — an inspection camera on a profile bracket: a box body, a C-mount
 * lens, a status LED row and a serial label, with the dashed field of view
 * fanning out of the front glass while it is online.
 *
 * It replaced a bracket, a pill and a circle. On a real sheet that drawing is
 * turned on its side, scaled to about 0.4 and printed a few pixels tall, and at
 * that size nothing about it said "camera": the details were fixed-size units
 * that vanished, and what was left was a tube with a blue dot on it. This one
 * is drawn from parts a plant person already knows — a lens barrel with its
 * rings, the glass at the end of it, the LEDs — and every part scales with the
 * node, so it still holds together when the sheet is small.
 *
 * ## One drawing, scaled uniformly
 *
 * The geometry is a 110 x 80 reference drawing fitted into the node box (see
 * cameraLayout.js). Other symbols stretch to w x h; a lens stretched to a
 * different ratio is an oval, so this one letterboxes instead.
 *
 * ## Identity
 *
 * The plate says which camera this is: an IP cell and its code, resolved the way
 * CameraRail resolves it — the explicit link (`options.cameraId`) first, the loop
 * id second. With neither, the plate is drawn empty and dashed, so a symbol that
 * still has to be linked looks like one. The plate is not drawn with the camera:
 * it is counter-rotated into the node's own frame so its text is never upside
 * down — flat beside a camera lying down, reading upward beside one standing up —
 * which keeps it against the body instead of swinging out across the sheet.
 * (`options.platePlacement: 'upright'` keeps it flat at every angle instead.)
 *
 * ## Styles
 *
 * This is the "Smart camera" style, the default. `options.cameraStyle: 'classic'`
 * hands the node to IpCameraClassic — the drawing this one replaced — which has
 * nothing in common with it beyond the registry entry: no plate, no letterboxing.
 * See cameraStyle.js for the two choices and their defaults.
 *
 * ## States
 *
 * Online: green LED, lit glass, the field of view. Offline: grey LED, dim glass,
 * no field of view, the plate faded. Fault (a critical status, or a word like
 * `fault` in the reading): the whole drawing red. A fault outranks online — a
 * presentation colour must never hide an alarm.
 */
export default function IpCamera({ node, tag }) {
  // No hooks below, so choosing the drawing first is safe.
  if (cameraStyle(node.options) === 'classic') return <IpCameraClassic node={node} tag={tag} />

  const { w, h } = node
  const rot = node.rot || 0

  const state = typeof tag?.state === 'string' ? tag.state.toLowerCase() : null
  const faulted = tag?.status === 'crit' || FAULT_STATES.has(state)
  const online = !faulted && ONLINE_STATES.has(state)

  const code = node.options?.cameraId?.trim() || node.tagId?.trim() || ''
  const linked = code !== ''
  const plateW = linked ? plateWidth(code) : PLATE_MIN_W
  const squeeze = linked ? squeezedCodeWidth(code) : null

  const labelSize = node.options?.labelSize
  const L = cameraLayout({
    w, h, rot, plateW, labelSize, plateUpright: platePlacement(node.options) === 'upright',
  })

  // How strongly the lens glows. Offline is dim rather than off: a dark lens would read as a
  // part that is missing from the drawing.
  const iris = faulted ? 0.5 : online ? 0.9 : 0.22
  const glint = faulted ? 0.4 : online ? 0.85 : 0.3
  const led = faulted ? 'var(--crit)' : online ? 'var(--ok)' : 'var(--fg-dim)'

  // Net effect of the node's own rotate() and this one is none: the plate and the title keep
  // their place in the node frame and stay upright.
  const upright = rot ? `rotate(${-rot} ${w / 2} ${h / 2})` : undefined
  const half = plateW / 2

  return (
    <g className={`${online ? '' : s.stopped} ${faulted ? s.cameraFault : ''}`}>
      {/* The net port is the middle of the node's left edge. When the node is wider than the
          drawing the box is letterboxed, so the wire gets a stub across the gap. */}
      {L.ox > 0.5 && <path className={s.hair} d={`M 0 ${h / 2} H ${L.ox + 0.8 * L.k}`} />}

      <g transform={`translate(${L.ox} ${L.oy}) scale(${L.k})`}>
        {/* field of view — what this camera is looking at, drawn only while it is looking */}
        {online && (
          <>
            <path
              className={s.accentFill}
              opacity={0.1}
              d="M 88.4 40 L 105.59 26.91 A 21.6 21.6 0 0 1 105.59 53.09 Z"
            />
            <path
              className={`${s.fovEdge} ${s.fovDash}`}
              d="M 88.4 40 L 105.59 26.91 M 88.4 40 L 105.59 53.09"
            />
            <path className={s.fovEdge} d="M 105.59 26.91 A 21.6 21.6 0 0 1 105.59 53.09" />
          </>
        )}

        {/* profile bracket: the bar with its slot, the arm under the body, the tripod screw */}
        <rect className={s.bodyElev} x={0.8} y={16} width={5.5} height={48} rx={1.5} />
        <rect className={s.hairFill} x={2.75} y={22} width={1.6} height={36} rx={0.8} />
        <rect className={s.bodyElev} x={6.3} y={57.2} width={34} height={4.6} rx={1.2} />
        <rect className={s.bodyElev} x={24} y={54.6} width={8} height={3} rx={0.8} />

        {/* network tail: the cable from the port to the RJ45 housing on the back of the body */}
        <path className={s.hair} d="M 6.3 40 H 11" />
        <rect className={s.bodyElev} x={11} y={34.5} width={6} height={11} rx={1.6} />

        {/* body, its serial label and its three status LEDs: power, link, spare */}
        <rect className={s.body} x={17} y={23} width={36} height={32} rx={5} />
        <rect className={s.hair} x={22} y={39.5} width={16} height={10} rx={1.2} />
        <path
          className={s.hair}
          d="M 24.5 42 V 47.5 M 27 42 V 47.5 M 29 42 V 47.5 M 32.5 42 V 47.5 M 35 42 V 47.5"
        />
        <circle className={online ? s.beacon : ''} cx={25} cy={29} r={1.7} fill={led} />
        <circle className={s.accentFill} cx={31} cy={29} r={1.7} opacity={iris} />
        <circle className={s.hairFill} cx={37} cy={29} r={1.7} />

        {/* C-mount lens: mount ring, knurled focus barrel, hood ring, then the glass */}
        <rect className={s.bodyElev} x={53} y={27.5} width={6} height={25} rx={1.4} />
        <rect className={s.body} x={59} y={30} width={22} height={20} />
        <path
          className={s.hair}
          d="M 62.5 30.6 V 49.4 M 66 30.6 V 49.4 M 69.5 30.6 V 49.4 M 73 30.6 V 49.4 M 76.5 30.6 V 49.4"
        />
        <rect className={s.bodyElev} x={81} y={28} width={5} height={24} rx={1.4} />
        <ellipse className={s.bodyElev} cx={86} cy={40} rx={2.7} ry={10.6} />
        <ellipse className={s.cameraGlass} cx={86.4} cy={40} rx={1.7} ry={8} />
        <ellipse className={s.accentFill} cx={86.8} cy={40} rx={0.9} ry={3.2} opacity={iris} />
        <ellipse cx={85.6} cy={36} rx={0.55} ry={1.7} fill="#ffffff" opacity={glint} />
      </g>

      {/* identity plate */}
      <g
        transform={`${upright ? `${upright} ` : ''}translate(${L.plate.x} ${L.plate.y})${L.plate.turn ? ` rotate(${L.plate.turn})` : ''} scale(${L.k})`}
      >
        {linked ? (
          <g opacity={online || faulted ? 1 : 0.6}>
            <rect className={s.body} x={-half} y={-6.3} width={plateW} height={12.6} rx={3.2} />
            <path
              className={s.accentFill}
              opacity={0.3}
              d={`M ${-half + 3.2} -6.3 H ${-half + 13} V 6.3 H ${-half + 3.2} A 3.2 3.2 0 0 1 ${-half} 3.1 V -3.1 A 3.2 3.2 0 0 1 ${-half + 3.2} -6.3 Z`}
            />
            <path className={s.hair} d={`M ${-half + 13} -5.7 V 5.7`} />
            <text className={s.cameraChip} x={-half + 6.5} y={2.2} textAnchor="middle">IP</text>
            <text
              className={s.cameraCode}
              x={-half + 16}
              y={2.4}
              textLength={squeeze ?? undefined}
              lengthAdjust={squeeze ? 'spacingAndGlyphs' : undefined}
            >
              {code}
            </text>
          </g>
        ) : (
          <g opacity={0.75}>
            <rect className={s.cameraNoLinkBox} x={-PLATE_MIN_W / 2} y={-6.3} width={PLATE_MIN_W} height={12.6} rx={3.2} />
            <text className={s.cameraNoLink} x={0} y={2} textAnchor="middle">NOT LINKED</text>
          </g>
        )}
      </g>

      <text
        className={s.label}
        x={w / 2}
        y={L.labelY}
        textAnchor="middle"
        style={{ fontSize: labelSize }}
        transform={upright}
      >
        {node.label}
      </text>
      <text className={s.labelDim} x={w / 2} y={L.labelY + 13} textAnchor="middle" transform={upright}>
        {faulted ? 'fault' : online ? 'online' : 'offline'}
      </text>
    </g>
  )
}
