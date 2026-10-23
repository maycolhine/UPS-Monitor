# Design system and interface guidelines

Base: scope §4 (visual identity), §5 (UX and layout) and §6 (gauge rules), with the **style adjustment
adopted on 2026-10-21** (see [technical-decisions.md](./technical-decisions.md), D16).

> **Recorded divergence.** Scope §4.1 and 30-ui-ux asked for a white overall background (`#FFFFFF`). At
> the user's request, the interface started following the visual language of an internal control-tower
> dashboard used as a visual reference: **dark background, high contrast and the Barlow typeface**, in
> a four-quadrant panel without scrolling. The UX rules (§5 and 30-ui-ux) still fully apply — in
> particular: color is never the only state signal, a missing value never becomes zero and the battery
> percentage is always marked as an estimate.

## 1. Palette

| Token | Color | Use |
|---|---|---|
| `--brand` | `#FF3D03` | Primary actions, focus, highlight border of the context quadrant, "estimate" tag |
| `--ink-strong` | `#FFFFFF` | Titles, numeric values, high hierarchy |
| `--ink-secondary` | `#9EA8B8` | Secondary text, labels, descriptions |
| `--line` | `#1D2335` | Borders, dividers, scale marks |
| `--surface` | `#030408` | Overall background (stage) |
| `--panel` | `#070913` | Quadrant background |
| `--card` | `#0C101F` | Gauge card background |

The primary color does **not** dominate the screen: it appears on the border of the context quadrant,
on the refresh button, on the visible focus and on the estimate tag.

### Semantic colors (exclusive to the operational reading)

| Token | Color | Meaning |
|---|---|---|
| `--sem-critical` | `#EF4444` | Bad, critical or out-of-band condition |
| `--sem-warning` | `#F59E0B` | Attention, approaching a limit |
| `--sem-good` | `#10B981` | Normal condition |
| `--sem-unknown` | `#9EA8B8` | No data |

These colors apply to the gauges, the state indicators and the notices — the exception provided for in
scope §4.2. In the other components the institutional palette applies. The tones were chosen to keep a
contrast ≥ 4.5:1 over `--surface`/`--panel` (dark background).

### Color accessibility

Each state is communicated through **three simultaneous channels**: color, numeric value and textual
label (with a colored dot as visual reinforcement). No information depends on color alone.

## 2. Gauge scale and semantic bands

Defined in [gaugeConfig.ts](../src/backend/src/gaugeConfig.ts) and published in `GET /api/config`. The
bands below were **validated by the requester** on 2026-10-21 and remain overridable via
`VIEWER_GAUGE_THRESHOLDS` (JSON). **No limit is an official manufacturer recommendation.**

| Metric | Origin (`sources[]`) | Scale | Bands | Decimals |
|---|---|---|---|---|
| Input voltage | `data.measurements.input_voltage_v` | 0–250 V | green 80–127 and 200–225 · red otherwise | 0 |
| Output voltage | `data.measurements.output_voltage_v` | 0–250 V | green 80–127 and 200–225 · red otherwise | 0 |
| Frequency | `input_frequency_hz` **or** `output_frequency_hz` (per protocol) | 20–70 Hz | green 47–53 and 57–60 · amber 42–47, 53–57 and 60–63 · red 20–42 and 63–70 | 1 |
| Internal temperature | `data.measurements.temperature_c` | 0–50 °C | green 0–25 · amber 25–35 · red 35–50 | 0 |
| Battery charge | `data.battery_charge.percent` **or** `data.battery.charge_percent` (per protocol) | 0–100 % | red 0–20 · amber 20–40 · green 40–100 | 0 |
| UPS load | `data.measurements.load_percent` | 0–100 % | green 0–50 · amber 50–75 · red 75–100 | 0 |

Each metric can have **more than one origin** (`sources[]`), because different protocols publish the
same data in different fields; the interface uses the first origin present in the payload.

Notes:

- The **voltage** band covers both nominal windows adopted (127 V and 220 V). For an exclusively 220 V
  fleet, adjust via `VIEWER_GAUGE_THRESHOLDS` (example in `.env.example`).
- The manufacturer does **not** document an operating temperature range nor load limits. The adopted
  values come from the requester's validation (D3).
- The bands **no longer** appear as text under each gauge: the card shows only the meter, the value and
  the textual state. The interface only shows the configuration notice when `threshold_problems` is
  not empty.

### How to validate/change

```bash
# example: UPS unit with 220 V output
VIEWER_GAUGE_THRESHOLDS='{"output_voltage_v":{"scale":{"min":0,"max":300,"ticks":[0,75,150,225,300]},
"bands":[{"level":"critical","from":0,"to":198,"label":"Out of range"},
{"level":"warning","from":198,"to":209,"label":"Attention: below ideal"},
{"level":"good","from":209,"to":231,"label":"Expected range (220 V)"},
{"level":"warning","from":231,"to":242,"label":"Attention: above ideal"},
{"level":"critical","from":242,"to":300,"label":"Out of range"}]}}'
```

Invalid JSON, unknown metric, band outside the scale or overlapping bands are **not** accepted
silently: they generate entries in `threshold_problems`, displayed in the interface.

## 3. Gauge anatomy

Semicircle of 220 × 132 viewBox units, center at (110, 110), radius 84, arc thickness 18, needle 66.
Single component: [Gauge.tsx](../src/frontend/src/components/Gauge.tsx).

Layers, from bottom to top:

1. **neutral track** (`#192033`) covering the whole scale;
2. **semantic bands** — one arc per band, colored by level;
3. **band boundaries** — tick marks and labels at the **start and end of each band** (`bands`, via
   `bandBoundaries`), and not at fixed `scale.ticks` marks: this way the user reads where each colored
   stretch begins and ends;
4. **needle** — line from the center to the value, with an axis;
5. **central value** — number at 30 px + unit at 12 px, with a halo in the card color (`--card`) to
   remain legible over the needle;
6. **legend** — metric name, "estimate" tag when applicable and textual state with a colored dot.

Visual states:

| State | Class | Appearance |
|---|---|---|
| Value in a good band | `gauge--good` | Label in green |
| Value in attention | `gauge--warning` | Label in amber |
| Critical value | `gauge--critical` | Label in red |
| No data | `gauge--empty` | Bands and track dimmed, needle absent, value "—", label "No data" |
| Stale | `gauge--stale` | SVG at reduced opacity and label "Stale" |

## 4. Dashboard composition (four quadrants)

The panel occupies exactly the window, in a 2×2 grid, without page scrolling on desktop.

1. **Top left — context and operational state:** product title, the **block selection of the collected
   UPS units** (`GET /api/v1/ups`, with **Brand/Model** in evidence and the `device_id` as description,
   highlighting the one being displayed), the communication indicator, the last valid reading, the data
   age, the contract version, the API address and the automatic refresh interval (there is no manual
   refresh button), the notices (demo mode, API unavailable, telemetry missing/stale, band
   configuration) and, just below, **all** the always-visible Q1 frame states — the **active** ones
   highlighted and the **inactive** ones dimmed — each with the description and, at the bottom, the
   `raw_bits`.
2. **Top right — measurements:** **2×3** grid with the six gauges.
3. **Bottom left — battery test:** the test panel, in three blocks (see §4.1).
4. **Bottom right — details and collection:** identification, battery voltage, collector state, age,
   last error and a table with the result of each HTTP query.
5. **Footer (bottom band):** reinforcement that the application is read-only (the only write is the
   test request, always by user action) and that the bands are configurable via
   `VIEWER_GAUGE_THRESHOLDS`.

### 4.1 Battery Test quadrant (blocks A, B and C)

The panel follows the division of the telemetry service's documentation
(`monitor/docs/battery-test-quadrant.md`):

- **Block A — control:** type selector (only appears when the device declares **more than one** type in
  `capabilities.battery_test.test_types`), start/abort button, pre-click guards (cooldown, minimum
  charge, absence of cancellation) and the current state.
- **Block B — charts:** **left sidebar with four selectable blocks** — output voltage (V), frequency
  (Hz), internal temperature (°C) and battery charge (%) — and, on the right, the chart of the chosen
  series. Each block already summarizes the ripple of its own metric (`deltas.metrics`) so that the
  number is visible without switching charts; the active one is highlighted and the button uses
  `aria-pressed`. When the key was not published in `samples[].normalized`, the block shows "series
  unavailable" and the chart explains — a straight line at zero is **never** drawn.
- **Block C — summary:** test outcome, finish reason (`finish_reason`), sample count, estimated runtime
  (with the `reason` when `estimate.available` is false) and the observation of the `TEST` flag.
  Previous tests appear in a table (with the **Type** column).

**Charts in custom SVG**, without a library: discreet grid track, axis labels in `--ink-secondary`,
series line in `--brand` and dashed target reference line in `--sem-warning`. The Y scale is
**automatic with a 15 % margin** — the voltage and frequency oscillations are small (±2 V, ±0.5 Hz) and
a fixed 0–250 V scale would hide them. The X axis uses `m:ss` when the window is 60 s or more (the
discharge test lasts minutes) and `s.S` in the short test, with the **same** format in all chart
labels. On narrow screens, the sidebar blocks become a horizontal band above the chart.

### Preparation for multiple UPS units

The context quadrant lists the devices returned by the API (`dashboard.devices.devices`), highlighting
the one **being displayed** and those **available**. The entry of new UPS units on the network,
therefore, does not require redesigning the panel: navigating between devices is an evolution of the
same block, with no brand/model hardcoded in the code.

## 5. Rules for displaying absence and staleness

- Value `null`, absent or non-numeric → **"No data"**; never `0`.
- `stale` reading → the number is shown with the **"Stale"** label and a notice at the top with the age
  of the last valid reading.
- Identity unavailable → block with a message explaining that the API did not publish the
  identification.
- No active states → "No active state reported by the device in this reading" (never "mains power
  normal": the absence of `OB` is not evidence of normal mains).
- API unavailable ≠ stale telemetry: these are distinct notices with distinct codes.

## 6. Layout and responsiveness

- **Desktop:** 2×2 stage with `height: 100dvh` and `overflow: hidden` — no page scrolling. Each
  quadrant has its own internal scrolling (`overflow: hidden auto`) for long content.
- **≤ 900 px:** the stage collapses to a single column and the page scrolls again; the gauges use a
  fluid grid (`auto-fit`/`minmax`).
- **≤ 420 px:** a single column.
- There is never horizontal scrolling: no fixed widths in `px` on the containers and `overflow-wrap` on
  the API address and the raw frames.
- Visible focus on all interactive elements (`:focus-visible` with a 3 px `#FF3D03` outline).
- "Skip to content" link for keyboard navigation.
- `prefers-reduced-motion` respected (there is no value animation: the dashboard avoids oscillations).

## 7. Typography

**Barlow** (Google Fonts, weights 400–800 and italic 700) declared in
[index.html](../src/frontend/index.html), with *fallback* to system fonts (`system-ui`, `Segoe UI`,
`Roboto`, `sans-serif`). Numeric values in bold with the unit in a smaller body and tabular alignment
(`font-variant-numeric: tabular-nums`); paths and `raw_bits` in a monospaced font.
