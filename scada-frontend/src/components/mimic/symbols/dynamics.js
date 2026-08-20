import s from './symbols.module.css'

/**
 * dynamics — the motion catalogue for admin-authored symbols.
 *
 * This is the app's third pluggable-renderer registry, shaped like SYMBOLS and
 * WIRE_TYPES on purpose: a `kind -> descriptor` map, a lookup that tolerates an
 * id it has never heard of, and one renderer (CustomSymbol) that draws whatever
 * the map returns.
 *
 * The idea it implements is the one GraphWorX64 gets right: **the motion is the
 * dynamic, not the file**. An admin uploads a still picture and attaches
 * behaviour to it, so a pump image spins because the pump is running — not
 * because someone found an animated GIF of a pump. That is what makes the motion
 * mean something, and it is also why every dynamic below is a thin wrapper over
 * a class that already exists in symbols.module.css: pause-on-stop and
 * prefers-reduced-motion come with those classes, and a bespoke animation would
 * have to re-earn both.
 *
 * Descriptor fields:
 *   label    caption in the authoring dialog
 *   hint     one line on what an operator will see, in operator language
 *   reads    which part of the tag drives it — shown in the dialog so an admin
 *            can tell why a dynamic is doing nothing ('state' needs a binding
 *            with a state rule; 'value' needs a range)
 *   role     how CustomSymbol applies it:
 *              'motion'  a wrapper <g> under the freeze group — stops with the drive
 *              'signal'  a wrapper <g> above it — keeps going when the drive stops
 *              'asset'   chooses which picture is drawn
 *              'overlay' drawn on top of the picture
 *   fields   the parameters the dialog collects, with defaults
 *   layer    (dyn, tag) -> { className, style } | null   [motion/signal]
 *   pick     (dyn, tag) -> assetId | null                [asset]
 *   level    (dyn, tag) -> 0..1 | null                   [overlay]
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Where `tag.value` sits between two bounds, 0..1, or null when that cannot be
 * answered. Falls back to the binding's own range so an admin who already told
 * the binding dialog "0 to 100" does not have to say it again here.
 */
function fraction(dyn, tag) {
  if (tag?.value == null) return null
  const from = dyn.from ?? tag.range?.[0] ?? 0
  const to = dyn.to ?? tag.range?.[1] ?? 100
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return null
  return clamp01((tag.value - from) / (to - from))
}

/** True when the reading is off-normal. Stale does not count — see below. */
const inAlarm = (tag) => tag?.status === 'warn' || tag?.status === 'crit'

export const DYNAMICS = {
  spin: {
    label: 'Rotate while running',
    hint: 'The picture turns steadily, and freezes where it stopped.',
    reads: 'state',
    role: 'motion',
    fields: [
      { name: 'speed', label: 'Speed', type: 'select', options: ['fast', 'slow'], default: 'fast' },
    ],
    layer: (dyn) => ({ className: dyn.speed === 'slow' ? s.spinSlow : s.spin }),
  },

  recip: {
    label: 'Stroke while running',
    hint: 'The picture strokes back and forth — a dosing head or a ram, which '
      + 'does not rotate.',
    reads: 'state',
    role: 'motion',
    fields: [],
    layer: () => ({ className: s.recip }),
  },

  turn: {
    label: 'Turn by value',
    hint: 'The picture rotates to an angle set by the reading — a damper blade '
      + 'or a valve stem at 40% open.',
    reads: 'value',
    role: 'motion',
    fields: [
      { name: 'from', label: 'Value at start angle', type: 'number', default: 0 },
      { name: 'to', label: 'Value at end angle', type: 'number', default: 100 },
      { name: 'minDeg', label: 'Start angle (°)', type: 'number', default: 0 },
      { name: 'maxDeg', label: 'End angle (°)', type: 'number', default: 90 },
    ],
    // A transition, not an animation, so this keeps working while the drive is
    // stopped — a closed damper is still at a position worth reading.
    layer: (dyn, tag) => {
      const f = fraction(dyn, tag)
      if (f == null) return null
      const lo = dyn.minDeg ?? 0
      const hi = dyn.maxDeg ?? 90
      return {
        className: s.turn,
        style: { transform: `rotate(${(lo + f * (hi - lo)).toFixed(2)}deg)` },
      }
    },
  },

  blink: {
    label: 'Blink on alarm',
    hint: 'The picture flashes while the reading is off normal.',
    reads: 'status',
    role: 'signal',
    fields: [],
    // 'signal' rather than 'motion': a stopped machine in alarm still has to
    // attract attention, and anything under the freeze group would sit still.
    layer: (dyn, tag) => (inAlarm(tag) ? { className: s.beacon } : null),
  },

  hide: {
    label: 'Show only when running',
    hint: 'The picture fades out when the drive stops — for a flame, a spray, or '
      + 'a jet that is either there or not.',
    reads: 'state',
    role: 'signal',
    fields: [
      {
        name: 'mode',
        label: 'When stopped',
        type: 'select',
        options: ['hide', 'dim'],
        default: 'hide',
      },
    ],
    // Also 'signal': this decides whether the picture is visible at all, which
    // has to hold whether or not the freeze group is pausing motion beneath it.
    layer: (dyn, tag) => {
      if (tag?.state !== 'stop' && tag?.state !== 'closed') return null
      return { className: s.faded, style: { opacity: dyn.mode === 'dim' ? 0.28 : 0 } }
    },
  },

  swap: {
    label: 'Change picture by state',
    hint: 'A different image per state — the multi-state symbol, e.g. a valve '
      + 'drawn open, shut and travelling.',
    reads: 'state',
    role: 'asset',
    fields: [
      { name: 'map', label: 'State to image', type: 'assetMap', default: {} },
    ],
    // Drive this from a binding with `state.mode: 'map'`, which the binding
    // dialog already offers — a coded register (0/1/2) becomes a named state,
    // and that name picks the picture.
    pick: (dyn, tag) => (tag?.state ? dyn.map?.[tag.state] ?? null : null),
  },

  fill: {
    label: 'Fill by value',
    hint: 'A gauge bar beside the picture rises with the reading — a tank, a '
      + 'battery, a vessel. Drawn next to the artwork rather than over it, so '
      + 'a photo never gets a translucent wash across part of it.',
    reads: 'value',
    role: 'overlay',
    fields: [
      { name: 'from', label: 'Value at empty', type: 'number', default: 0 },
      { name: 'to', label: 'Value at full', type: 'number', default: 100 },
      {
        name: 'direction',
        label: 'Bar orientation',
        type: 'select',
        // 'vertical': a side bar to the right, rising bottom to top — the
        // tank-gauge reading. 'horizontal': a bar underneath, filling left to
        // right — the battery/progress reading. Named for what they show
        // rather than which way they grow, since that is what the option
        // actually has to communicate in a plain <select>.
        options: ['vertical', 'horizontal'],
        default: 'vertical',
      },
    ],
    level: fraction,
  },
}

export const DYNAMIC_KINDS = Object.keys(DYNAMICS)

/**
 * A descriptor by kind, or null.
 *
 * Null rather than a fallback, which is the opposite of `wireType()` — and for
 * the same reason. An unknown *line* still has to be drawn, because the pipe is
 * part of the plant either way. An unknown *dynamic* has no sensible stand-in:
 * guessing at motion would show an operator a machine doing something it may not
 * be doing. So CustomSymbol skips it, and the symbol renders still.
 *
 * This matters because the library is authored, not deployed: an admin on a new
 * bundle can save a symbol using a dynamic that an operator's cached bundle has
 * never heard of, and that operator must still see the plant.
 */
export function dynamic(kind) {
  return Object.prototype.hasOwnProperty.call(DYNAMICS, kind) ? DYNAMICS[kind] : null
}

/** Every dynamic on this symbol that this bundle can actually apply. */
export function knownDynamics(list) {
  return (list ?? [])
    .map((dyn) => ({ dyn, def: dynamic(dyn?.kind) }))
    .filter((e) => e.def !== null)
}

/** A new dynamic of `kind`, with its fields at their defaults. */
export function newDynamic(kind) {
  const def = dynamic(kind)
  if (!def) return null
  const out = { kind }
  def.fields.forEach((f) => { out[f.name] = f.default })
  return out
}
