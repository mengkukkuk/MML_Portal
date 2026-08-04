# Plan — `/monitor`: single-asset SCADA mimic page (Boiler House 1)

## Context

`/live` answers "how are all my things doing?" — a grid of independent panels across
many devices. There is no page that answers "what is *this* plant actually doing right
now, and why?" This adds one: a single-asset mimic (P&ID-style process diagram) for one
boiler/steam skid, where the drawing itself is the instrument — live values sit inside
ISA instrument bubbles on the diagram, symbols animate when their value changes, and
clicking any asset opens a detail rail with its full context.

Scope for this pass, per the user's answers:
- Subject: **boiler / steam skid** (matches the repo's existing `Boiler temp (°C)` mock series)
- Symbols: **fluid core + discrete, 12 types**
- Placement: **new `/monitor` route**, added to router and sidebar, alongside `/live`
- **No database, no backend, no `src/api/*` file.** All values come from a local mock
  simulator; the mimic layout persists to `localStorage` only.

Non-goals this pass: real tag binding, backend persistence, pan/zoom, multi-plant switching,
undo/redo.

---

## The one architectural call

**The canvas is free-position SVG, not `react-grid-layout`.** RGL is right for `/live` and
wrong here: a mimic needs arbitrary `{x,y}`, rotation, and edges between symbols, and RGL's
`verticalCompact` (`LivePage.jsx:438`) would reflow a pump under its tank on every drag. Do
not reuse it, and do not add a drag library — `dnd-kit`/`react-dnd` are built for list and
grid reordering, the wrong shape for a canvas. Native pointer events on the SVG are ~40 lines.

**Coordinates are logical, never pixels.** Fixed `viewBox="0 0 1600 900"`, the `<svg>` scales
responsively with `preserveAspectRatio="xMidYMid meet"`. Convert pointer → logical with
`svg.getScreenCTM().inverse()` (handles scale *and* letterboxing; a raw width ratio does not).
Snap to an 8-unit grid. Storing pixels is the one thing that is painful to retrofit.

---

## Design direction

The page lives inside the authenticated shell, so it uses `src/styles/tokens.css` **verbatim**
and must look right in all three faceplates (`cobalt` / `graphite` / `carbon`). No second
palette, no gradients, no glow.

**Signature (spend the boldness here):** the mimic is drawn in real P&ID vernacular —
hairline process lines that are *service-coded* by style, ISA-5.1 instrument bubbles (circle
split by a hairline, `TT` over `202`) tethered to their equipment by a dotted lead line, and
flow direction shown by marching dashes. The live number lives **inside the bubble**, so
reading the diagram is reading the instrument. There is no floating card layer over the drawing.

Service legend, all derived from existing tokens:

| Service | Line |
|---|---|
| Feedwater / condensate | `var(--accent)`, 2u solid |
| Steam | `var(--fg)`, 2.5u solid with a double hairline |
| Fuel gas | `var(--warn)`, 2u dashed |
| Flue gas | `var(--fg-dim)`, 3u solid, low opacity |

**Type:** `--font-display` (IBM Plex Sans Condensed, already loaded in `index.html`) for the
plant title and tag callouts, uppercase with wide tracking. `--font-mono` (IBM Plex Mono) for
**every** numeric readout and tag number — control rooms are monospace, and it makes digits
tabular so a changing value doesn't reflow. `--font-sans` for UI chrome only.

**Second structural idea:** selection → detail. A mimic alone is not "deeper" than `/live`;
what makes it deeper is clicking an asset and getting its full context in a right-hand rail.

**Restraint:** toolbar, symbol palette and detail rail are quiet and token-only. No minimap,
no zoom controls, no second accent.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ BOILER HOUSE 1 · steam skid      ● RUNNING     1s ▾   [Edit layout]  │
├───────────────────────────────────────────────┬──────────────────────┤
│                                    ⌐TT ¬      │  TT-202              │
│   ╔══════╗                         │202│      │  Steam temperature   │
│   ║  T   ║════▶(P-101A)═══▶▉BOILER▉╪══════▶   │                      │
│   ╚══════╝         │           │              │  184.2 °C   ▲ +0.4   │
│    ⌐LT ¬        ⌐FT ¬       ⌐PT ¬             │  ▁▂▄▆█▆▄▂▁▂▄         │
│    │102│        │101│       │201│             │                      │
│                                               │  lo 120 · hi 195     │
│         ░░░ fuel gas ░░░▶ [BURNER]            │  ─────────────       │
│                                               │  10:42:03 → warn     │
│                                               │  10:39:51 → normal   │
├───────────────────────────────────────────────┴──────────────────────┤
│ FT-101 42.1 t/h · PT-201 8.4 bar · O2-402 3.1 % · P-101A RUN · …     │
└──────────────────────────────────────────────────────────────────────┘
```

Rail is ~320px; under 1100px it drops below the canvas. Edit mode swaps the rail for the
symbol palette so the canvas never shrinks twice.

---

## Files

### New — page

| Path | Role |
|---|---|
| `src/pages/monitor/MonitorPage.jsx` | Route component. Owns mock clock, selection, edit mode, layout state, localStorage load/save. |
| `src/pages/monitor/MonitorPage.module.css` | Page shell, header bar, rail, tag strip. |
| `src/pages/monitor/MimicCanvas.jsx` | The `<svg>` stage: viewBox, edge router, node render loop, pointer drag, marquee-free single selection, keyboard nudge. |
| `src/pages/monitor/MimicCanvas.module.css` | Stage, service line classes, selection outline, edit affordances. |
| `src/pages/monitor/SymbolPalette.jsx` | Edit-mode list of the 12 symbol types; click-to-add or drag onto the stage. |
| `src/pages/monitor/DetailRail.jsx` | Selected asset: value, delta, sparkline (`EChart`), thresholds, recent state changes, tag metadata. |
| `src/pages/monitor/DetailRail.module.css` | |
| `src/pages/monitor/defaultLayout.js` | The seeded boiler skid — ~16 nodes + edges in logical coords, so the page is never empty on first load. Must place **all 12 symbol types**: the three discrete ones (`StackLight`, `SensorEye`, `Actuator`) go on the fuel-conveyor branch alongside `Conveyor`, or verification step 6 fails on symbols nothing draws. |
| `src/pages/monitor/layoutStorage.js` | `loadLayout()` / `saveLayout()` against `localStorage`, versioned + validated. |

### New — symbols

| Path | Role |
|---|---|
| `src/components/mimic/symbols/index.js` | Registry barrel: `type → { label, Component, defaultSize, ports, binding }`. Mirrors the existing `src/components/live/options/index.js` barrel pattern. |
| `src/components/mimic/symbols/*.jsx` | 12 files: `Tank`, `Pump`, `Valve`, `Motor`, `HeatExchanger`, `FlowMeter`, `Gauge`, `PipeTee`, `Conveyor`, `StackLight`, `SensorEye`, `Actuator`. |
| `src/components/mimic/symbols/symbols.module.css` | Shared stroke weights, fill rules, and every keyframe animation. |
| `src/components/mimic/InstrumentBubble.jsx` | The ISA tag bubble + lead line + live value. Used by every instrumented symbol. |
| `src/components/mimic/useValueTransition.js` | Previous-vs-current + a change pulse token. |
| `src/components/mimic/useMockPlant.js` | Ticking simulator hook. |
| `src/components/mimic/mockPlant.js` | Boiler tag definitions, ranges, thresholds, and the value generator. |

### Modified

- `src/router/routes.jsx` — lazy import near line 25, route entry with
  `handle: { title: 'Monitor', icon: … }`. Reuse an existing per-path MUI icon import
  (`AccountTreeOutlined`); do **not** add a barrel import — see the comment at line 6.
- `src/components/AppSidebar/AppSidebar.jsx` — the sidebar has its own hardcoded
  `BASE_ITEMS` array (line 19) and does *not* derive from route handles. Add `/monitor`
  after `/live` there too, or the route is unreachable from the nav.

---

## Contracts

### Layout document (also the future DB row shape)

```js
{
  version: 1,
  plant: 'boiler-1',
  viewBox: { w: 1600, h: 900 },
  nodes: [{ id, type, x, y, w, h, rot, tag, label }],
  edges: [{ id, from: { node, port }, to: { node, port }, service: 'feedwater' }],
}
```

Kept deliberately serialisable so a later `mimic_layouts` table is a mechanical swap:
one `src/api/mimic.js` wrapper replaces `layoutStorage.js` and nothing above it changes.
**Not in scope now.**

**Edge paths are derived, never stored.** An edge persists only its two `{node, port}`
endpoints; `MimicCanvas` recomputes the elbow path every render from the endpoints' *current*
`node.x/y` plus the port's local offset. Store the geometry and the first drag desynchronises
the drawing from its pipes.

**Interactive edge creation is out of scope for v1.** Edges are hand-authored in
`defaultLayout.js`; the editor moves and deletes nodes and edges re-route for free. None of
the four requirements asks an operator to draw new pipes, and a port-picking mode is the one
interaction that could eat the whole implementation session. Deleting a node deletes its
edges. (If it's added later: invisible ~16-logical-unit port hit circles, revealed only in
edit mode while a connect mode is armed.)

### Symbol contract

Every symbol is a pure `<g>`-returning component with the same props:

```js
{ node, tag, selected, pulse }   // tag = the single flat entry below
```

`node.tag` resolves to exactly **one** entry in a single flat `tags` map (see mock data) —
one lookup, one shape. Each registry entry declares which fields its symbol reads
(`binding: 'analog' | 'discrete' | 'both'`); a pump binds `both` and gets run/stop from
`state` and amps from `value` off the same entry. `status` is
`'normal' | 'warn' | 'crit' | 'stale'`, derived once in `mockPlant.js` from thresholds —
symbols never compute it. `ports` are local-space in/out anchors the edge router reads.

### Animation — two distinct kinds, do not conflate

1. **Steady-state**, driven by `state`: pump impeller rotates while running, flow dashes
   march along a line while flow > 0, burner flame flickers while firing, conveyor belt
   chevrons travel. CSS animations, paused via `animation-play-state` when stopped.
2. **On value change**, driven by `prevValue !== value` (`useValueTransition`): the tank
   level tweens to its new height rather than jumping, the readout digit rolls, and the
   instrument bubble emits a single hairline ring pulse tinted by direction (rise/fall).
   A threshold *crossing* upgrades that to a stronger, colour-coded pulse.

   `pulse` is a **monotonically incrementing counter**, bumped only when `value !== prevValue`
   — not a boolean. A boolean either never clears or re-fires on unrelated re-renders. The
   ring consumes it either by `key={pulse}` re-mount or by an `animationend`-cleared class,
   so an unchanged tick renders nothing.

This is the requirement most easily satisfied wrongly. Spinning a pump because
`running === true` is steady-state, not "animation when the value changed" — build both.

**Every animation must sit inside `@media (prefers-reduced-motion: reduce)` guards** that
disable it. `tokens.css:96` already sets this precedent.

### Mock data

`useMockPlant({ tickMs })` returns the same *shape* a real poll would, so swapping in
`usePanelPolling`-backed data later is a hook replacement, not a rewrite:

```js
{ tags: {
    'TT-202':  { value: 184.2, prevValue: 183.8, state: null,  status: 'normal', unit: '°C', ts },
    'P-101A':  { value: 12.4,  prevValue: 12.4,  state: 'run', status: 'normal', unit: 'A',  ts },
    'SL-601':  { value: null,  prevValue: null,  state: 'amber', status: 'warn', unit: '',   ts },
  },
  history: { 'TT-202': [[ts, v], …] },   // rolling 120 points, analog tags only
}
```

**One flat map, one shape.** Discrete tags leave `value` null; analog tags leave `state` null;
a pump carries both. Do not split into separate `values`/`states` maps — `node.tag` must
resolve in a single lookup.

Tags: `LT-102` drum level %, `FT-101` feedwater flow t/h, `PT-201` steam pressure bar,
`TT-202` steam temp °C, `TT-203` flue gas temp °C, `O2-402` flue O₂ %, `FCV-301` valve
position %, `BR-401` firing rate %, `P-101A/B` pump run + amps, `HX-701` economiser duty,
`CV-501` fuel conveyor run + speed, `ZS-502` conveyor position sensor (discrete),
`XV-503` fuel damper actuator (discrete + position %), `SL-601` stack light.

Generator: per-tag sine + drift + noise, clamped to range, tick default 1s (selectable
1s/2s/5s from the header). Add a **"Simulate excursion"** control in the header that pushes
one tag past its high threshold for ~15s — without it the alarm-state animations are
untestable by hand.

### Edit mode

Gated on `role === 'admin'`, mirroring `LivePage.jsx:80`. Drag to move, `Delete` to remove
(taking the node's edges with it), arrow keys to nudge the selection by one grid unit, click a
palette entry to drop a symbol at canvas centre. Saves to localStorage on exit, same shape as
`LivePage`'s Edit/Done toggle. No edge drawing — see the contract above.

---

## Build order

1. `mockPlant.js` + `useMockPlant.js` + `useValueTransition.js` — data first, provable in isolation.
2. `MimicCanvas` with two hardcoded symbols and pointer drag — proves the coordinate math.
3. Symbol registry + all 12 symbols + `InstrumentBubble`, with both animation kinds.
4. `defaultLayout.js` — the actual boiler skid drawing.
5. `DetailRail` + selection wiring.
6. `SymbolPalette` + edit mode + `layoutStorage.js`.
7. Route + sidebar registration.

Steps 1–2 are the risk; everything after is additive.

---

## Verification

```bash
cd scada-frontend && npm run dev
```

Then, via the browser preview at `http://localhost:5173/monitor`:

1. **Renders seeded** — page shows the boiler skid on first load with no localStorage entry.
2. **Values move** — instrument bubbles update on the tick; console is clean
   (`read_console_messages`).
3. **Change animation** — a bubble pulses only when its number changes, not on every tick.
   Confirm by setting tick to 5s and watching the gap.
4. **Steady-state animation** — pump impeller and flow dashes run; stopping `P-101B` in the
   simulator freezes only that pump.
5. **Excursion** — "Simulate excursion" drives `TT-202` over its high limit; the bubble, the
   symbol and the rail all go to `crit` together.
6. **Selection** — clicking each of the 12 symbol types opens the rail with the right tag,
   sparkline and thresholds.
7. **Drag** — as admin, enter Edit layout, drag a *connected* symbol; it lands where the cursor
   is at both a wide and a narrow window (this is the `getScreenCTM` check) and its pipes
   re-route to follow it (this is the derived-edges check). Reload → position persists.
8. **Themes** — switch all three faceplates in Settings; no hardcoded colour survives.
9. **Reduced motion** — `resize_window` / OS setting with reduced motion on: all animation stops,
   values still update.
10. **Responsive + keyboard** — 1280px and 768px, rail reflows below the canvas; tab reaches
    every control with a visible focus ring.

Screenshots at steps 1, 5 and 8.

---

## Note for the next session

`.claude/skills/mmlportal-patterns/SKILL.md` still documents the **pre-React** frontend
(Vue 3 SFCs, Element Plus, Pinia, `grid-layout-plus`). On `react_cvt` it is misleading —
follow the actual `.jsx` files (`LivePage.jsx`, `LivePanel.jsx`, `OverviewPage.jsx`) for
component shape. Its backend and token-discipline sections are still accurate. Updating that
skill is worth a separate task.
