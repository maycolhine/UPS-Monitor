---
description: Visual identity, accessibility and gauge rules
globs: ["src/frontend/**/*.tsx", "src/frontend/**/*.css"]
alwaysApply: true
---

# 30 — UI/UX

Details: [docs/design-system.md](../../docs/design-system.md).

## Palette

| Token | Color | Use |
|---|---|---|
| `--brand` | `#FF3D03` | Primary actions, focus, identity highlight, estimate tag |
| `--ink-strong` | `#000032` | Titles and values |
| `--ink-secondary` | `#424449` | Secondary text, labels |
| `--line` | `#C5CAD2` | Borders, dividers, marks |
| `--surface` | `#FFFFFF` | Overall background (**always white**) |

The primary color does **not** dominate the interface. Do not use a dark overall background.

## Gauge semantics (exception to the palette)

Red (`--sem-critical`) = bad/critical · Amber (`--sem-warning`) = attention · Green (`--sem-good`) =
normal. This exception applies to the gauges and operational indicators.

## Mandatory rules

1. **Color is never the only state signal.** Every gauge and every notice combines color + numeric
   value + textual label.
2. **A missing/invalid value never becomes `0`.** Show "No data"; a reading past its validity shows the
   number with the "Stale" label.
3. **Battery percentage with the origin tag**: "estimate" when the protocol estimates (`megatec-q1`);
   "reported by the device" when the device itself reports (`sms-1phase`). The battery voltage appears
   in a separate field.
4. **Do not infer "normal mains".** With no active states, display "No active state reported by the
   device in this reading".
5. **Loading, error and data-absence states** are mandatory on every screen.
6. **Responsiveness**: no horizontal scrolling; fluid grids (`auto-fit`/`minmax`); breakpoints at
   720 px and 420 px; values and units legible on mobile.
7. **Accessibility**: visible focus (`:focus-visible`), adequate contrast, `aria-label` on the gauges,
   labels in `dt`/`dd`, `caption`/`th scope` in the tables, `role="status"` on the notices.
8. **No value animation** nor color change without a real state change.
9. **Gauge bands are provisional**: each card shows the criterion note and the interface shows a notice
   while `threshold_problems` is not empty. Never present an invented limit as an official manufacturer
   recommendation.
10. **Simulated data** only in demonstration mode (`VITE_ENABLE_DEMO=true`, only in `.env.development`)
    and always with the "DEMO MODE" banner visible.
11. **Battery Test quadrant in three blocks** (control, charts, summary). The charts block uses
    **selectable blocks** in the sidebar (one per metric: output voltage, frequency, internal
    temperature and battery charge) with `aria-pressed`, and each block already summarizes the ripple
    of its own metric (`deltas.metrics`). The chart is **custom SVG** (no library), with `role="img"`
    and `aria-label`, an axis with an **automatic scale with margin** (not the gauge scale) so as not
    to hide small oscillations, and the same time-label format across the whole axis. The target line
    appears **dashed and labeled**. Unpublished series → "series unavailable" and an explanation;
    **never** a straight line at zero.
