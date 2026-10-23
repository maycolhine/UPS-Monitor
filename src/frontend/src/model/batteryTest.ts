/**
 * (Pure) model of the battery test of contract 3.0.
 *
 * The contract publishes TWO test types: `duration_10s` (fixed window, in all
 * protocols with test) and `discharge_20pct` (no window: it runs until the
 * charge drops to the target of 20 % or until the safety ceiling of 30 min, only
 * where the device knows how to cancel). The interface selector is restricted to
 * `test_types`.
 *
 * Golden rule: the API delivers the FACTS (series, aggregations and the
 * first-order linear extrapolation marked `confidence: "low"`); the Web Viewer
 * only PRESENTS them. No number is invented here — when `estimate.available` is
 * false, the panel shows the `reason` reported by the API, never a runtime.
 *
 * The charts are drawn from `samples[].normalized` (the standardized mirror
 * across protocols): an ABSENT key means "series unavailable" and NEVER becomes
 * zero.
 *
 * All functions are pure so they can be tested without a DOM, per the project's
 * 40-testing-and-docker rule.
 */
import { formatAge, formatNumber, MISSING_TEXT } from "./format.js";
import type {
  BatteryTestCapabilities,
  BatteryTestEstimate,
  BatteryTestListItem,
  BatteryTestMetricDelta,
  BatteryTestReport,
  BatteryTestSample,
  BatteryTestTypeParams,
  DeviceCapabilities,
} from "./contract.js";

export type TestPhase = "running" | "completed" | "aborted" | "failed" | "unknown";

export function testPhase(status: string | null | undefined): TestPhase {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "aborted") return "aborted";
  if (status === "failed") return "failed";
  return "unknown";
}

const STATUS_TEXT: Record<string, string> = {
  running: "Running",
  aborting: "Aborting",
  completed: "Completed",
  aborted: "Aborted",
  failed: "Failed",
  accepted: "Accepted (in the collector queue)",
};

export function describeTestStatus(status: string | null | undefined): string {
  if (!status) return MISSING_TEXT;
  return STATUS_TEXT[status] ?? status;
}

/**
 * Reason for the termination. Unlike `duration_elapsed`, the window was atypical
 * (cancelled, low battery, watchdog) and the report should not be treated as a
 * normal test.
 */
const FINISH_REASON_TEXT: Record<string, string> = {
  duration_elapsed: "Full test window",
  target_percent_reached: "Battery charge reached the test target",
  test_flag_cleared: "The device cleared the test flag before the time",
  aborted: "Cancelled during execution",
  battery_low: "Interrupted: low battery (LB flag)",
  watchdog: "Interrupted by the collector time ceiling",
  stopping: "Interrupted: the service was shut down",
  serial_error: "Interrupted by a serial port error",
};

export function describeFinishReason(reason: string | null | undefined): string {
  if (!reason) return MISSING_TEXT;
  return FINISH_REASON_TEXT[reason] ?? reason;
}

/**
 * Supporting messages for the test error codes (§11.4 of the integration doc).
 * The API already returns `message` ready to display; this map is only the
 * fallback when the envelope comes without a message.
 */
const TEST_ERROR_TEXT: Record<string, string> = {
  test_disabled: "Battery test is not enabled on this device.",
  test_cooldown: "Wait a few minutes between tests (cooldown).",
  battery_too_low: "Battery charge below the minimum safe for testing.",
  battery_at_target: "The battery charge is already at the target of this test.",
  on_battery: "The UPS is already on battery — test not allowed.",
  battery_low: "Low battery (LB flag) — test not allowed.",
  test_in_progress: "There is already a test in progress on this device.",
  test_unavailable: "No fresh telemetry — check the device communication.",
  test_not_running: "This test has already ended.",
  unsupported_test_type: "Test type unavailable on this device.",
  test_not_supported: "This device does not support the battery test.",
  test_requires_battery_percent:
    "This test type requires the device to report the battery percentage.",
  device_not_found: "Device not found in the telemetry API.",
  test_not_found: "Test not found in the telemetry API.",
  invalid_request: "Malformed test request.",
};

export function describeTestError(
  error: { code: string; message: string } | null | undefined,
): string {
  if (!error) return MISSING_TEXT;
  const known = TEST_ERROR_TEXT[error.code];
  const message = error.message?.trim() ?? "";
  if (known) return message === "" || message === known ? known : message;
  return message === "" ? `Test failure (${error.code}).` : message;
}

// --------------------------------------------------------------- capabilities ---

export interface BatteryTestSupport {
  /** The API declared the test as supported. */
  supported: boolean;
  /** `enabled` decides whether the button can be triggered (contract §11.1). */
  enabled: boolean;
  abortSupported: boolean;
  durationS: number | null;
  sampleIntervalS: number | null;
  cooldownS: number | null;
  minBatteryPercent: number | null;
  /** Types accepted by THIS device — the selector never offers another. */
  testTypes: string[];
  /** Parameters per type (`types.<type>`): window × target. */
  types: Record<string, BatteryTestTypeParams>;
}

/** Reads `capabilities.battery_test` of the device discovered in `GET /api/v1/ups`. */
export function readTestSupport(
  capabilities: DeviceCapabilities | undefined | null,
): BatteryTestSupport {
  const raw: BatteryTestCapabilities = capabilities?.battery_test ?? {};
  return {
    supported: raw.supported === true,
    enabled: raw.enabled === true,
    abortSupported: raw.abort_supported === true,
    durationS: raw.duration_s ?? null,
    sampleIntervalS: raw.sample_interval_s ?? null,
    cooldownS: raw.cooldown_s ?? null,
    minBatteryPercent: raw.min_battery_percent ?? null,
    testTypes: raw.test_types ?? [],
    types: raw.types ?? {},
  };
}

/** Warnings shown BEFORE the click, to avoid the guard 409s. */
export function buildTestGuards(support: BatteryTestSupport): string[] {
  const guards: string[] = [];
  if (support.cooldownS !== null && support.cooldownS > 0) {
    guards.push(`Wait of ${formatAge(support.cooldownS)} between two tests.`);
  }
  if (support.minBatteryPercent !== null) {
    guards.push(
      `Requires battery charge of at least ${formatNumber(support.minBatteryPercent, 0)}%.`,
    );
  }
  if (!support.abortSupported) {
    guards.push("This device does not cancel the test: cancellation only stops the sampling.");
  }
  return guards;
}

// ---------------------------------------------------------- test types ---

/** Labels suggested by the quadrant doc (§3.1), per contract `type`. */
const TEST_TYPE_LABEL: Record<string, string> = {
  duration_10s: "Quick test (~10 s)",
  discharge_20pct: "Controlled discharge (up to 20 %)",
};

export interface TestTypeOption {
  type: string;
  label: string;
  /** Parameters published in `types.<type>`; `null` when the API does not send them. */
  params: BatteryTestTypeParams | null;
  /** `true` in the target discharge test (no window). */
  isTarget: boolean;
}

export function describeTestType(type: string | null | undefined): string {
  if (!type) return MISSING_TEXT;
  return TEST_TYPE_LABEL[type] ?? type;
}

/**
 * A test is "by target" when it declares `target_percent` without a window.
 * Without the detail in `types`, the type name itself decides — we never invent
 * parameters the API did not publish.
 */
function isTargetType(type: string, params: BatteryTestTypeParams | null): boolean {
  if (params?.target_percent != null) return true;
  if (params?.duration_s != null) return false;
  return type === "discharge_20pct";
}

/**
 * Selector options: ONLY the types declared in `test_types` — offering a type
 * outside the list would only produce `422 unsupported_test_type` (e.g., the
 * `discharge_20pct` on `megatec-q1`).
 */
export function buildTestTypeOptions(support: BatteryTestSupport): TestTypeOption[] {
  return support.testTypes.map((type) => {
    const params = support.types[type] ?? null;
    return {
      type,
      label: TEST_TYPE_LABEL[type] ?? type,
      params,
      isTarget: isTargetType(type, params),
    };
  });
}

/**
 * Short label of the chosen test: "Window of 10.0 s" (window test) or
 * "Discharge to 20 %" (target test). Without `types`, it falls back to the type
 * name.
 */
export function describeTestTypeParams(option: TestTypeOption | null): string {
  if (!option) return MISSING_TEXT;
  if (option.isTarget) {
    const target = option.params?.target_percent;
    return target == null ? "Discharge to the target" : `Discharge to ${formatNumber(target, 0)}%`;
  }
  const duration = option.params?.duration_s;
  return duration == null ? "Fixed window" : `Window of ${formatNumber(duration, 1)} s`;
}

// ----------------------------------------------------------------- estimate ---

export interface EstimateView {
  available: boolean;
  /** "2 min 12 s", "≥ 10 h (extrapolation)" or the dash when unavailable. */
  runtimeText: string;
  /** Short note about how the number was obtained. */
  note: string;
  dischargeRateText: string;
  dropText: string;
}

/**
 * Translates `estimate`. When `available` is false, only the `reason` is
 * displayed — the interface never converts the absence into a number.
 */
export function buildEstimateView(estimate: BatteryTestEstimate | null | undefined): EstimateView {
  if (!estimate) {
    return {
      available: false,
      runtimeText: MISSING_TEXT,
      note: "No estimate in this reading.",
      dischargeRateText: MISSING_TEXT,
      dropText: MISSING_TEXT,
    };
  }

  const rate = estimate.discharge_rate_pp_per_min;
  const drop = estimate.drop_percent_in_window;
  const windowS = estimate.window_s;

  const dischargeRateText =
    rate == null ? MISSING_TEXT : `${formatNumber(rate, 1)} p.p./min`;
  const dropText =
    drop == null
      ? MISSING_TEXT
      : `${formatNumber(drop, 1)} p.p.${windowS == null ? "" : ` in ${formatNumber(windowS, 1)} s`}`;

  if (!estimate.available) {
    return {
      available: false,
      runtimeText: MISSING_TEXT,
      note: estimate.reason ? `No estimated runtime: ${estimate.reason}` : "Runtime not estimated.",
      dischargeRateText,
      dropText,
    };
  }

  const runtime = estimate.estimated_runtime_min ?? null;
  if (runtime === null) {
    return {
      available: false,
      runtimeText: MISSING_TEXT,
      note: "The API marked the estimate as available, but did not publish the runtime.",
      dischargeRateText,
      dropText,
    };
  }

  // `estimated_runtime_min` is limited to `capped_at_min` (sanity ceiling):
  // when it ties with the ceiling, the value is a floor, not a precise figure.
  const capped = estimate.capped_at_min ?? null;
  const reachedCap = capped !== null && runtime >= capped;
  const runtimeText = reachedCap
    ? `≥ ${formatAge(capped * 60)} (extrapolation)`
    : formatAge(runtime * 60);

  const confidence = estimate.confidence ?? "low";
  const parts = ["First-order linear extrapolation"];
  if (estimate.method) parts.push(estimate.method);
  parts.push(`confidence ${confidence}`);

  return {
    available: true,
    runtimeText,
    note: `${parts.join(" · ")}. Estimate, not a measurement.`,
    dischargeRateText,
    dropText,
  };
}

// ------------------------------------------------------------------- charts ---

export interface ChartPoint {
  /** `offset_s` — X axis, in seconds since the start of the window. */
  x: number;
  /** Normalized metric value — Y axis. */
  y: number;
}

/** How to summarize the metric oscillation in the side block. */
type ChartSummaryKind = "oscillation" | "variation" | "drop";

interface ChartDefinition {
  /** Key in `samples[].normalized` (also the id of the selectable block). */
  key: string;
  label: string;
  unit: string;
  decimals: number;
  summary: ChartSummaryKind;
}

/**
 * The FOUR charts of the quadrant: output voltage, frequency, internal
 * temperature and battery charge. The order is the one of the selection side bar.
 */
const CHART_DEFINITIONS: ChartDefinition[] = [
  { key: "output_voltage_v", label: "Output voltage", unit: "V", decimals: 1, summary: "oscillation" },
  { key: "frequency_hz", label: "Frequency", unit: "Hz", decimals: 1, summary: "oscillation" },
  { key: "temperature_c", label: "Internal temperature", unit: "°C", decimals: 1, summary: "variation" },
  { key: "battery_charge_percent", label: "Battery charge", unit: "%", decimals: 1, summary: "drop" },
];

export interface TestChartModel {
  key: string;
  label: string;
  unit: string;
  decimals: number;
  points: ChartPoint[];
  /** `false` when the key never appeared: series unavailable, NEVER zero. */
  available: boolean;
  /** Oscillation summarized in the side bar (comes from `deltas.metrics`). */
  variationText: string;
  /** Dashed reference line (the charge target in the discharge test). */
  reference: number | null;
  referenceLabel: string | null;
}

/** Points of ONE metric: an absent/null key is IGNORED (never becomes 0). */
export function buildChartPoints(
  samples: BatteryTestSample[] | null | undefined,
  key: string,
): ChartPoint[] {
  const points: ChartPoint[] = [];
  for (const sample of samples ?? []) {
    const x = sample.offset_s;
    const y = sample.normalized?.[key];
    if (typeof x !== "number" || !Number.isFinite(x)) continue;
    if (typeof y !== "number" || !Number.isFinite(y)) continue;
    points.push({ x, y });
  }
  return points;
}

function buildVariationText(
  definition: ChartDefinition,
  metric: BatteryTestMetricDelta | null,
): string {
  if (!metric) return MISSING_TEXT;
  if (definition.summary === "oscillation") {
    const ripple = metric.ripple;
    if (ripple == null) return MISSING_TEXT;
    return `Oscillation ${formatNumber(ripple, definition.decimals)} ${definition.unit}`;
  }
  const delta = metric.delta;
  if (delta == null) return MISSING_TEXT;
  const signed = `${delta > 0 ? "+" : ""}${formatNumber(delta, definition.decimals)}`;
  return definition.summary === "drop"
    ? `Drop ${signed} p.p.`
    : `Variation ${signed} ${definition.unit}`;
}

/**
 * Models of the side bar and the chart, built from `samples[].normalized`
 * (contract §5) and the summary in `deltas.metrics`.
 */
export function buildTestChartModels(
  report: Pick<BatteryTestReport, "samples" | "deltas" | "target_percent"> | null | undefined,
): TestChartModel[] {
  const samples = report?.samples ?? [];
  const metrics = report?.deltas?.metrics ?? {};
  const target = report?.target_percent ?? null;

  return CHART_DEFINITIONS.map((definition) => {
    const points = buildChartPoints(samples, definition.key);
    const reference = definition.key === "battery_charge_percent" ? target : null;
    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      decimals: definition.decimals,
      points,
      available: points.length > 0,
      variationText: buildVariationText(definition, metrics[definition.key] ?? null),
      reference,
      referenceLabel: reference == null ? null : `target ${formatNumber(reference, 0)}%`,
    };
  });
}

// ------------------------- chart geometry (own SVG, no library) ---

export interface ChartTick {
  /** Position in the SVG coordinate system (px). */
  pos: number;
  text: string;
}

export interface LineChartGeometry {
  width: number;
  height: number;
  /** `M`/`L` trace of the series, already projected into the SVG. */
  path: string;
  yTicks: ChartTick[];
  xTicks: ChartTick[];
  /** Y position of the reference line, when present. */
  referencePos: number | null;
  /** Horizontal limits of the plot area (for the grid and the reference line). */
  plotLeft: number;
  plotRight: number;
}

const CHART_PADDING = { top: 10, right: 12, bottom: 20, left: 42 };

/**
 * X axis: `offset_s` in seconds. The format applies to the whole axis — mixing
 * "0.0 s" with "4:06" in the same chart is confusing — so `clock` decides the
 * mode: `m:ss` when the window is 60 s or more (the `discharge_20pct` lasts
 * minutes) and `s.S` in the short 10 s test (contract doc §4.3).
 */
export function formatOffsetSeconds(seconds: number, clock = false): string {
  if (!Number.isFinite(seconds)) return MISSING_TEXT;
  if (!clock) return `${formatNumber(seconds, 1)} s`;
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Projects the series into the SVG. The Y axis uses PROPORTIONAL padding: the
 * voltage and frequency oscillations are small (±2 V, ±0.5 Hz) and a fixed scale
 * of 0–250 V would hide them (contract doc §6). Returns `null` when there are no
 * points.
 */
export function buildLineChart(
  points: ChartPoint[],
  options: { width: number; height: number; decimals: number; reference?: number | null },
): LineChartGeometry | null {
  if (points.length === 0) return null;

  const { width, height, decimals } = options;
  const innerW = width - CHART_PADDING.left - CHART_PADDING.right;
  const innerH = height - CHART_PADDING.top - CHART_PADDING.bottom;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const reference = options.reference;
  if (reference != null && Number.isFinite(reference)) ys.push(reference);

  const minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  if (maxX - minX < 1e-9) maxX = minX + 1;

  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  const span = maxY - minY;
  const padY = span > 0 ? span * 0.15 : Math.max(Math.abs(maxY) * 0.05, 1);
  minY -= padY;
  maxY += padY;

  const projectX = (x: number): number =>
    CHART_PADDING.left + ((x - minX) / (maxX - minX)) * innerW;
  const projectY = (y: number): number =>
    CHART_PADDING.top + innerH - ((y - minY) / (maxY - minY)) * innerH;

  const path = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${projectX(point.x).toFixed(1)} ${projectY(point.y).toFixed(1)}`,
    )
    .join(" ");

  const yTicks: ChartTick[] = [0, 1, 2, 3].map((step) => {
    const value = minY + ((maxY - minY) * step) / 3;
    return { pos: projectY(value), text: formatNumber(value, decimals) };
  });

  const xTicks: ChartTick[] = [0, 0.5, 1].map((ratio) => {
    const value = minX + (maxX - minX) * ratio;
    return { pos: projectX(value), text: formatOffsetSeconds(value, maxX - minX >= 60) };
  });

  return {
    width,
    height,
    path,
    yTicks,
    xTicks,
    referencePos: reference != null && Number.isFinite(reference) ? projectY(reference) : null,
    plotLeft: CHART_PADDING.left,
    plotRight: width - CHART_PADDING.right,
  };
}

// ------------------------------------------------ test state confirmation ---

export interface TestObservationView {
  /** `true`/`false` when the API has concluded; `null` while the test runs. */
  observed: boolean | null;
  level: "good" | "warning" | "unknown";
  text: string;
}

/**
 * Confirms whether the UPS REALLY reported the "Test in progress" state
 * (`TEST` in `flags_seen`) during the window. It is the proof that the test
 * occurred.
 */
export function buildObservationView(
  report: Pick<BatteryTestReport, "status" | "test_flag_observed" | "flags_seen"> | null,
): TestObservationView {
  if (!report || report.status === "running") {
    return {
      observed: null,
      level: "unknown",
      text: "Checking whether the device reported the test state…",
    };
  }
  const seen = report.flags_seen ?? [];
  const sawTestFlag = seen.includes("TEST");
  const observed = report.test_flag_observed === true;

  if (observed) {
    return {
      observed: true,
      level: "good",
      text: "The device reported the TEST flag during the test.",
    };
  }
  if (sawTestFlag) {
    return {
      observed: false,
      level: "warning",
      text: "The TEST flag appeared in the samples, but the API did not confirm it in this window.",
    };
  }
  return {
    observed: false,
    level: "warning",
    text: "The device did NOT report the test state in this window — confirm the result.",
  };
}

// ------------------------------------------------------------------- progress ---

/** Input common to the acceptance (`202`) and to the report — only what is published. */
export interface TestProgressInput {
  status: string;
  type?: string | null;
  started_at_utc?: string | null;
  expected_end_at_utc?: string | null;
  requested_duration_s?: number | null;
  target_percent?: number | null;
  baseline?: Record<string, number | null> | null;
  final?: Record<string, number | null> | null;
  samples?: BatteryTestSample[] | null;
}

export interface TestProgressView {
  /** `window` = fixed window; `target` = discharge down to the target. */
  mode: "window" | "target";
  /** Fraction 0..1; `null` when there is not enough data (indeterminate bar). */
  fraction: number | null;
  text: string;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Current charge: the report's `final` or the last sample with the key. */
function currentChargePercent(report: TestProgressInput): number | null {
  const finalValue = report.final?.["battery_charge_percent"];
  if (typeof finalValue === "number" && Number.isFinite(finalValue)) return finalValue;
  const samples = report.samples ?? [];
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const value = samples[index]?.normalized?.["battery_charge_percent"];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function windowSecondsFromExpected(report: TestProgressInput): number | null {
  if (!report.started_at_utc || !report.expected_end_at_utc) return null;
  const start = Date.parse(report.started_at_utc);
  const end = Date.parse(report.expected_end_at_utc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return (end - start) / 1000;
}

/**
 * Progress of the running test.
 *
 * In the WINDOW test the fraction is the elapsed time over the requested window.
 * In the by-TARGET test (`discharge_20pct`) the progress is the CHARGE that has
 * dropped towards the target — never the 30 min of `expected_end_at_utc`, which
 * are only the safety ceiling.
 */
export function buildTestProgress(
  report: TestProgressInput | null,
  nowMs: number,
): TestProgressView | null {
  if (!report || report.status !== "running") return null;

  const target = report.target_percent;
  if (target != null) {
    const label = `Discharging to ${formatNumber(target, 0)}%`;
    const startCharge = report.baseline?.["battery_charge_percent"] ?? null;
    const currentCharge = currentChargePercent(report);
    if (startCharge == null || currentCharge == null || startCharge <= target) {
      return {
        mode: "target",
        fraction: null,
        text:
          currentCharge == null
            ? `${label} (waiting for the first sample)`
            : `${label} · current: ${formatNumber(currentCharge, 0)}%`,
      };
    }
    return {
      mode: "target",
      fraction: clamp01((startCharge - currentCharge) / (startCharge - target)),
      text: `${label} · current: ${formatNumber(currentCharge, 0)}%`,
    };
  }

  const windowSeconds = report.requested_duration_s ?? windowSecondsFromExpected(report);
  if (windowSeconds == null || windowSeconds <= 0 || !report.started_at_utc) return null;
  const start = Date.parse(report.started_at_utc);
  if (!Number.isFinite(start)) return null;

  const elapsed = Math.max(0, (nowMs - start) / 1000);
  return {
    mode: "window",
    fraction: clamp01(elapsed / windowSeconds),
    text: `${formatNumber(elapsed, 1)} s of ${formatNumber(windowSeconds, 1)} s`,
  };
}

// -------------------------------------------------------------------- history ---

export interface HistoryRowView {
  testId: string;
  startedText: string;
  /** Label of the test type (window × discharge by target). */
  typeText: string;
  statusText: string;
  finishText: string;
  runtimeText: string;
  confidence: string;
  observedTestFlag: boolean;
}

/**
 * Recent history (`GET .../tests`) — only the facts published by the API. The
 * history is in memory and is lost when the service restarts.
 */
export function buildHistoryRows(
  tests: BatteryTestListItem[] | null | undefined,
  formatDate: (iso: string | null | undefined) => string,
): HistoryRowView[] {
  if (!tests) return [];
  return tests.map((item) => {
    const estimate = item.estimate ?? null;
    const runtime =
      estimate && estimate.available && estimate.estimated_runtime_min != null
        ? formatAge(estimate.estimated_runtime_min * 60)
        : estimate?.reason
          ? `no estimate (${estimate.reason})`
          : MISSING_TEXT;
    return {
      testId: item.test_id,
      startedText: formatDate(item.started_at_utc ?? null),
      typeText: describeTestType(item.type ?? null),
      statusText: describeTestStatus(item.status),
      finishText: describeFinishReason(item.finish_reason ?? null),
      runtimeText: runtime,
      confidence: estimate?.confidence ?? MISSING_TEXT,
      observedTestFlag: (item.flags_seen ?? []).includes("TEST"),
    };
  });
}
