# Liquid Crystal — reusable surface skill

A design recipe for the SCADA frontend's "liquid crystal" faceplate: a
translucent, frosted glass surface over the dark app background, finished with a
**specular rim-light** that reads like sun catching the top facet of a crystal.
First applied to [`src/components/LivePanel.vue`](src/components/LivePanel.vue).

Use this doc as the source of truth when extending the look to other surfaces
(cards, modals, the sidebar, stat tiles, etc.) so they stay visually coherent.

## When to use it

Apply to **elevated content containers** that sit on `--bg-app` and benefit from
depth: dashboard tiles, cards, popovers, dialogs. Do **not** apply to dense
full-bleed regions (tables-as-pages, the app header) where translucency hurts
legibility — those stay solid.

## Principles

1. **Theme-aware, always.** Every colour derives from the existing tokens in
   [`src/styles/tokens.css`](src/styles/tokens.css) (`--bg-panel`, `--bg-elev`,
   `--accent`, `--accent-soft`, `--fg`, `--border-soft`). Never hard-code a hex.
   This keeps the surface correct across the `cobalt` / `graphite` / `carbon`
   faceplates.
2. **Spend boldness once.** The rim-light is the signature. Everything else
   (chips, headers, text) stays quiet. Don't add a second hero effect per tile.
3. **Frost needs something to blur.** The surface is translucent
   (`color-mix(... 68%, transparent)`) so the dark app bg shows through. Keep the
   page background dark; a faint radial bloom on the page amplifies the glass.
4. **Accessibility floor.** Honour `prefers-reduced-motion`, keep visible focus,
   and keep text contrast ≥ AA — the translucency tints toward the dark base, so
   `--fg` text stays legible.

## The recipe

### 1. Surface + signature rim-light

```css
.surface {
  position: relative;              /* anchors the rim pseudo-element */
  border-radius: var(--radius-lg); /* 14px — softer, more "liquid" than --radius */
  padding: var(--space-4);
  overflow: hidden;
  /* frosted base + top-down glass sheen + iridescent accent bloom (top-right) */
  background:
    radial-gradient(130% 90% at 100% -10%, var(--accent-soft), transparent 55%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0) 32%),
    color-mix(in srgb, var(--bg-panel) 68%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(165%);
  backdrop-filter: blur(16px) saturate(165%);
  border: 1px solid var(--border-soft);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),  /* inner top sheen */
    0 8px 30px rgba(0, 0, 0, 0.45),           /* float */
    0 2px 8px rgba(0, 0, 0, 0.3);
  transition: box-shadow 0.3s ease, transform 0.3s ease;
}

/* SIGNATURE: a masked 1px gradient border, bright at the top facet,
   fading to nothing by the surface midpoint. */
.surface::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.55),
    rgba(255, 255, 255, 0.08) 18%,
    rgba(255, 255, 255, 0) 46%
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}
```

### 2. Hover lift (optional, for interactive surfaces)

```css
.surface:hover {
  transform: translateY(-2px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 14px 44px rgba(0, 0, 0, 0.5),
    0 12px 48px -16px var(--accent-soft); /* accent ambient bloom on lift */
}

@media (prefers-reduced-motion: reduce) {
  .surface { transition: none; }
  .surface:hover { transform: none; }
}
```

### 3. Lit-LCD readout (hero numbers)

Give the primary live value a faint halo so it reads like a lit segment:

```css
.readout {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  text-shadow: 0 0 18px color-mix(in srgb, var(--accent) 35%, transparent);
}
/* When the number is threshold-coloured (ok/warn/crit), tint the halo by its
   own colour instead of the accent: */
.readout--themed {
  text-shadow: 0 0 26px color-mix(in srgb, currentColor 30%, transparent);
}
```

### 4. Glass-pill chips (multi-series legends, tags, badges)

```css
.chip {
  padding: 2px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-elev) 55%, transparent);
  border: 1px solid var(--border-soft);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
```

### 5. Sticky headers over a frosted body

A sticky header inside a translucent surface must be **near-opaque**, or
scrolled content bleeds through it:

```css
.sticky-head {
  background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
```

## Gotchas

- **Stacking order.** Put the glow/sheen in the element's `background` (paints
  behind content). Keep the `::before` for the masked rim only — it paints above
  content, but it's a 1px ring with `pointer-events: none`, so it never covers
  text. Don't try to put the corner bloom in `::after` (it would paint over the
  content).
- **`overflow: hidden` is required** to clip the rim/background to the rounded
  corners. It does **not** clip `box-shadow`, so the float/glow still escapes.
- **`backdrop-filter` fallback.** Browsers without support fall back to the
  `color-mix` base colour — still a readable dark surface, just not frosted.
  Always ship the `-webkit-` prefixed property alongside the standard one.
- **Tune translucency for contrast.** `68%` base is the sweet spot on
  `--bg-app`. If a surface sits on a lighter region, raise toward `80–88%`.

## Applying to a new component

1. Add `position: relative; overflow: hidden` to the container and swap its
   solid `background`/`border` for the recipe in §1.
2. Add the `::before` rim block verbatim.
3. Promote the one primary number to the §3 readout halo; convert legend/badge
   bits to §4 glass pills.
4. If it has a sticky header, apply §5.
5. Verify across all three themes and at mobile width, with reduced-motion on.
