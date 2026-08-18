/**
 * wireTypes — the line catalogue for the mimic, and the one renderer that
 * draws it.
 *
 * Style is the legend. An operator reads what a line carries from how it is
 * drawn, not from a colour key sitting off to one side — so a wire type is
 * defined here as stroke geometry, and every surface that shows one (the
 * canvas, the pen picker, the edge inspector, the drawing's own legend) draws
 * it through <WirePath> below. A swatch cannot drift from the line it stands
 * for, because it is the same code at a shorter length.
 *
 * Geometry does the identifying, not colour. The app ships three faceplates
 * over seven semantic colour tokens, so nineteen types cannot be told apart by
 * hue — weight, dash rhythm, double-stroke and halo carry the difference. That
 * is also how IEC 60617 and ISA-5.1 sheets work: they have to survive being
 * printed in black and white.
 *
 * Descriptor fields:
 *   id       stored on the edge as `service` — see the note on NORMAL below
 *   label    caption in the picker, the inspector and the legend
 *   group    which discipline's sheet this line belongs to; buckets the picker
 *   stroke   any CSS colour, applied inline so tokens resolve per faceplate
 *   width    stroke width in logical (viewBox) units
 *   dash     stroke-dasharray, or null for a solid line
 *   cap      stroke-linecap; 'round' softens a dotted line into true dots
 *   opacity  for lines that sit behind the process, e.g. flue gas
 *   halo     wide translucent stroke drawn *under* the line — a cable screen
 *   inner    hairline in the panel colour drawn *over* it — a double line
 *   flow     colour of the marching dashes, or null where flow is meaningless
 *            (an earth conductor does not carry product)
 *
 * Ids are frozen: they are persisted inside saved layouts. `feedwater`,
 * `steam`, `fuelgas` and `fluegas` predate this catalogue and keep both their
 * ids and their exact appearance, so drawings made before it look unchanged.
 */

/** What an edge falls back to: an unstyled line, and the default pen. */
export const NORMAL_WIRE = 'normal'

export const WIRE_GROUPS = [
  { id: 'general', label: 'General' },
  { id: 'electrical', label: 'Electrical' },
  { id: 'process', label: 'Process' },
  { id: 'signal', label: 'Signal & data' },
]

export const WIRE_TYPES = {
  // --- general -----------------------------------------------------------
  [NORMAL_WIRE]: {
    label: 'Normal wire',
    group: 'general',
    stroke: 'var(--fg-muted)',
    width: 2,
    dash: null,
    flow: 'var(--accent)',
  },

  // --- electrical (IEC 60617 single-line) ---------------------------------
  // Weight is voltage class: an operator scanning a single line should be able
  // to trace the incomer without reading a single label.
  power_lv: {
    label: 'LV power',
    group: 'electrical',
    stroke: 'var(--fg)',
    width: 3,
    dash: null,
    flow: 'var(--fg)',
  },
  power_mv: {
    label: 'MV feeder',
    group: 'electrical',
    stroke: 'var(--fg)',
    width: 5,
    dash: null,
    flow: 'var(--fg)',
  },
  power_hv: {
    label: 'HV line',
    group: 'electrical',
    stroke: 'var(--fg)',
    width: 7,
    dash: null,
    // Split down the middle by the panel colour: the classic double line for
    // the highest voltage class, and unmistakable next to a solid MV feeder.
    inner: { stroke: 'var(--bg-panel)', width: 3 },
    flow: 'var(--fg)',
  },
  bustie: {
    label: 'Bus tie',
    group: 'electrical',
    stroke: 'var(--accent)',
    width: 6,
    dash: null,
    cap: 'butt',
    flow: 'var(--accent)',
  },
  control: {
    label: 'Control wiring',
    group: 'electrical',
    stroke: 'var(--fg-muted)',
    width: 1.5,
    dash: '8 5',
    flow: null,
  },
  dc: {
    label: 'DC supply',
    group: 'electrical',
    stroke: 'var(--warn)',
    width: 2,
    dash: '18 5 3 5',
    flow: 'var(--warn)',
  },
  earth: {
    label: 'Earth / bonding',
    group: 'electrical',
    // The one place a fixed colour beats a theme token: earth is green on
    // every standard, in every country, and --ok is green in all three
    // faceplates. Nothing marches along it — a bond carries fault current, not
    // product.
    stroke: 'var(--ok)',
    width: 1.8,
    dash: '3 4',
    cap: 'round',
    flow: null,
  },
  shielded: {
    label: 'Shielded cable',
    group: 'electrical',
    stroke: 'var(--fg-muted)',
    width: 1.8,
    dash: null,
    // The screen, drawn as what it is: a sleeve around the conductor.
    halo: { stroke: 'var(--fg-dim)', width: 7, opacity: 0.28 },
    flow: null,
  },

  // --- process ------------------------------------------------------------
  feedwater: {
    label: 'Feedwater',
    group: 'process',
    stroke: 'var(--accent)',
    width: 2,
    dash: null,
    flow: 'var(--accent)',
  },
  steam: {
    label: 'Steam',
    group: 'process',
    stroke: 'var(--fg)',
    width: 2.5,
    dash: null,
    inner: { stroke: 'var(--bg-panel)', width: 0.75 },
    flow: 'var(--fg)',
  },
  fuelgas: {
    label: 'Fuel gas',
    group: 'process',
    stroke: 'var(--warn)',
    width: 2,
    dash: '12 5',
    flow: 'var(--warn)',
  },
  fluegas: {
    label: 'Flue gas',
    group: 'process',
    stroke: 'var(--fg-dim)',
    width: 3.5,
    dash: null,
    opacity: 0.45,
    flow: 'var(--fg-muted)',
    flowOpacity: 0.5,
  },
  drain: {
    label: 'Drain / vent',
    group: 'process',
    stroke: 'var(--fg-dim)',
    width: 1.6,
    dash: '2 5',
    cap: 'round',
    flow: 'var(--fg-dim)',
  },
  chemical: {
    label: 'Chemical dosing',
    group: 'process',
    stroke: 'var(--crit)',
    width: 2,
    dash: '10 4 2 4',
    flow: 'var(--crit)',
  },

  // --- signal & data (ISA-5.1) --------------------------------------------
  signal_elec: {
    label: 'Electric signal',
    group: 'signal',
    stroke: 'var(--accent)',
    width: 1.4,
    dash: '6 4',
    flow: null,
  },
  signal_pneu: {
    label: 'Pneumatic',
    group: 'signal',
    stroke: 'var(--fg-muted)',
    width: 1.8,
    dash: '14 4',
    flow: null,
  },
  signal_data: {
    label: 'Data link',
    group: 'signal',
    stroke: 'var(--fg)',
    width: 1.4,
    dash: '0.1 5',
    cap: 'round',
    flow: null,
  },
  fieldbus: {
    label: 'Fieldbus',
    group: 'signal',
    stroke: 'var(--accent)',
    width: 2.4,
    dash: null,
    inner: { stroke: 'var(--bg-panel)', width: 0.8 },
    flow: 'var(--accent)',
  },
}

export const WIRE_TYPE_IDS = Object.keys(WIRE_TYPES)

/**
 * A wire type by id, always. A layout saved by a newer build — or by hand —
 * can name a type this bundle has never heard of, and a pipe drawn as nothing
 * is worse than a pipe drawn plainly.
 */
export function wireType(id) {
  return WIRE_TYPES[id] ?? WIRE_TYPES[NORMAL_WIRE]
}

/** True when `id` is a type this build can actually draw. */
export function isKnownWire(id) {
  return Object.prototype.hasOwnProperty.call(WIRE_TYPES, id)
}

/**
 * WIRE_TYPE_IDS bucketed into WIRE_GROUPS order, for the picker.
 * A type filed under a group that does not exist lands in a trailing "Other"
 * rather than vanishing — a half-registered line should be visibly wrong.
 */
export const WIRE_GROUPED = (() => {
  const groups = WIRE_GROUPS.map((g) => ({ ...g, ids: [] }))
  const byId = new Map(groups.map((g) => [g.id, g]))
  const other = { id: 'other', label: 'Other', ids: [] }

  WIRE_TYPE_IDS.forEach((id) => {
    (byId.get(WIRE_TYPES[id].group) ?? other).ids.push(id)
  })

  return [...groups, other].filter((g) => g.ids.length > 0)
})()

/**
 * One line, drawn to its type's spec, as a bare fragment of SVG.
 *
 * Layer order is load-bearing: the screen sits under the conductor, the
 * hairline that splits a double line sits over it, and the marching dashes ride
 * on top of both so a dashed service keeps its own rhythm underneath. The
 * caller supplies `flowClass` because the animation is a CSS concern and the
 * two callers want different things from it — the canvas pauses it when the
 * drive behind the line is stopped, the picker never runs it at all.
 */
export function WirePath({
  d, wire, flowClass = null, flowStopped = false,
}) {
  return (
    <>
      {wire.halo && (
        <path
          d={d}
          fill="none"
          style={{
            stroke: wire.halo.stroke,
            strokeWidth: wire.halo.width,
            opacity: wire.halo.opacity,
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
          }}
        />
      )}
      <path
        d={d}
        fill="none"
        style={{
          stroke: wire.stroke,
          strokeWidth: wire.width,
          strokeDasharray: wire.dash ?? 'none',
          strokeLinecap: wire.cap ?? 'butt',
          strokeLinejoin: 'round',
          opacity: wire.opacity ?? 1,
        }}
      />
      {wire.inner && (
        <path
          d={d}
          fill="none"
          style={{
            stroke: wire.inner.stroke,
            strokeWidth: wire.inner.width,
            strokeDasharray: wire.inner.dash ?? 'none',
            strokeLinejoin: 'round',
          }}
        />
      )}
      {flowClass && wire.flow && (
        <path
          className={flowClass}
          d={d}
          fill="none"
          style={{
            stroke: wire.flow,
            opacity: flowStopped ? undefined : wire.flowOpacity,
          }}
        />
      )}
    </>
  )
}

/**
 * A short sample of one wire type, at the same stroke weights the canvas uses.
 *
 * Not scaled to fit: a 7-unit HV line has to look seven units heavy next to a
 * 1.4-unit data link, or the picker is showing something the drawing will not
 * do. The viewBox is therefore in canvas units and only the box around it
 * changes size.
 */
export function WireSample({ id, width = 44, height = 12 }) {
  const wire = wireType(id)
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <WirePath d={`M 0 ${height / 2} H ${width}`} wire={wire} />
    </svg>
  )
}
