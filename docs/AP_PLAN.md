# A&P UI Prototype — Implementation Plan

## Summary

Replace the authenticated `/` Overview with a high-fidelity “Analysis & Prediction” prototype for production managers and reliability engineers. The prototype uses deterministic packaging-line fixtures, makes no backend requests, and labels every analytic as simulated historian data.

## Experience

- Rename the sidebar and route title to **A&P**, with **Analysis & Prediction** as the page heading.
- Lead with business outcomes: availability, unplanned loss, estimated lost units, reject rate, and units at risk.
- Filter the whole page by period (`8h`, `24h`, `7d`), line, machine, and prediction horizon (`30m`, `60m`, `120m`).
- Centre the page on a Time Lens: observed incidents and signal changes sit to the left of **Now**, while forecast risk windows sit to the right.
- Open an evidence drawer from incidents and predictions. Historical findings use “likely contributors,” never claim proven root cause, and pair every model statement with human-readable historian evidence.

## Prototype Architecture

- Keep the existing React, MUI, ECharts, AppShell, authentication, and theme system.
- Build the feature under `scada-frontend/src/pages/ap/`, with a fixture adapter shaped like the future API: `fetchAPDashboard({ range, line, machine, horizon })`.
- Return `outcomes`, `timeline`, `incidents`, `predictions`, `dataCoverage`, and `model` from the adapter.
- Include stable Packaging Line 1, high-risk Packaging Line 2, detailed Packer 02 evidence, and an insufficient-history machine.
- Use prototype risk bands: stable `<35%`, watch `35–64%`, and high `>=65%`.
- Keep future historian mappings configurable per datasource; mapping administration, training, inference, persistence, and live predictions remain out of scope.

## Design and Accessibility

- Preserve current theme and typography tokens, adding local observed cyan `#58C7FA`, analysis amber `#F5A524`, prediction violet `#9B8CFF`, and critical red `#F05A5A`.
- Use a desktop 7/5 analysis-prediction split, stacked tablet layout, and single-column mobile layout with a full-screen evidence drawer.
- Use one restrained Time Lens reveal animation and disable it for reduced motion.
- Provide keyboard-operable controls, visible focus, textual chart summaries, and status labels that do not rely on color.

## Acceptance

- `npm run build` completes without new warnings or dependencies.
- Navigation and authentication remain intact, and `/` displays A&P.
- All filters update internally consistent deterministic content.
- Incident and prediction selections show the matching evidence.
- Stable, high-risk, insufficient-history, and partial-data states are available.
- All existing themes and responsive layouts remain usable.
- No analytics API requests are made, and simulated results are never presented as live predictions.

