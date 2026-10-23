/**
 * Geometry of the semicircular gauges and evaluation of the semantic bands.
 * Everything here is a pure function (testable without a browser).
 *
 * Semantics: red = bad/critical, amber = warning, green = normal.
 * Color is never the only signal: every band carries a textual label.
 */
import type { GaugeBand, GaugeDefinition, GaugeSource } from "./contract.js";
import { formatNumber } from "./format.js";

export type MetricLevel = "good" | "warning" | "critical" | "unknown";

export const LEVEL_LABEL: Record<MetricLevel, string> = {
  good: "Normal",
  warning: "Warning",
  critical: "Critical",
  unknown: "No data",
};

export interface BandEvaluation {
  level: MetricLevel;
  /** Textual label of the band (does not rely on color to convey the state). */
  text: string;
  band: GaugeBand | null;
}

/**
 * Locates the band that contains the value.
 *
 * Boundary convention: a value exactly equal to a boundary belongs to the band
 * that ENDS at that boundary — that is how the bands are described to the user
 * ("green between 57 and 60", "green between 0 and 50"). Thus a nominal value
 * such as 60.0 Hz or 127.0 V is classified as normal, not as warning.
 */
export function evaluateBand(value: number | null | undefined, bands: GaugeBand[]): BandEvaluation {
  if (value === null || value === undefined || !Number.isFinite(value) || bands.length === 0) {
    return { level: "unknown", text: "No data", band: null };
  }
  for (const band of bands) {
    if (value >= band.from && value <= band.to) {
      return { level: band.level, text: band.label, band };
    }
  }
  return { level: "unknown", text: "Outside the displayed scale", band: null };
}

/**
 * Band boundaries (start and end of each band), in ascending order and without
 * repetitions. This is what the gauge marks on the scale, instead of fixed
 * marks: it shows where each band starts and ends (scope §4.2 — color is never
 * the only signal; the user must be able to read the boundaries).
 */
export function bandBoundaries(bands: GaugeBand[]): number[] {
  const values = new Set<number>();
  for (const band of bands) {
    values.add(band.from);
    values.add(band.to);
  }
  return [...values].sort((a, b) => a - b);
}

/** Fraction from 0 to 1 of the value within the scale. */
export function valueFraction(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  const fraction = (value - min) / (max - min);
  return Math.min(1, Math.max(0, fraction));
}

/** Angle in degrees: 180° at the left end, 0° at the right. */
export function valueAngle(value: number, min: number, max: number): number {
  return 180 - 180 * valueFraction(value, min, max);
}

export interface Point {
  x: number;
  y: number;
}

export function polarPoint(cx: number, cy: number, radius: number, angleDeg: number): Point {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy - radius * Math.sin(radians),
  };
}

export interface ArcGeometry {
  cx: number;
  cy: number;
  radius: number;
  strokeWidth: number;
}

/** SVG path for an arc between two values of the scale. */
export function arcPath(
  from: number,
  to: number,
  scale: { min: number; max: number },
  geometry: ArcGeometry,
): string {
  const startAngle = valueAngle(from, scale.min, scale.max);
  const endAngle = valueAngle(to, scale.min, scale.max);
  const start = polarPoint(geometry.cx, geometry.cy, geometry.radius, startAngle);
  const end = polarPoint(geometry.cx, geometry.cy, geometry.radius, endAngle);
  const sweep = startAngle > endAngle ? 1 : 0;
  const largeArc = Math.abs(startAngle - endAngle) > 180 ? 1 : 0;
  return `M ${round(start.x)} ${round(start.y)} A ${geometry.radius} ${geometry.radius} 0 ${largeArc} ${sweep} ${round(end.x)} ${round(end.y)}`;
}

/** Geometry of the needle at the value position. */
export function needlePoint(
  value: number,
  scale: { min: number; max: number },
  geometry: ArcGeometry,
  length: number,
): Point {
  return polarPoint(geometry.cx, geometry.cy, length, valueAngle(value, scale.min, scale.max));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface GaugeGeometry {
  width: number;
  height: number;
  center: Point;
  radius: number;
  strokeWidth: number;
  needleLength: number;
}

/** Default geometry of the semicircle (the same for all gauges). */
export const GAUGE_GEOMETRY: GaugeGeometry = {
  width: 220,
  height: 132,
  center: { x: 110, y: 110 },
  radius: 84,
  strokeWidth: 18,
  needleLength: 66,
};

export interface GaugeRenderModel {
  definition: GaugeDefinition;
  /** Source actually used (defines the displayed label and badge). */
  source: GaugeSource | null;
  /** Label of the metric on the used source (default: the one from the definition). */
  label: string;
  value: number | null;
  hasValue: boolean;
  displayValue: string;
  level: MetricLevel;
  statusText: string;
  /** true when the value is displayed but out of date (stale reading). */
  stale: boolean;
  /** Absence text: "No data" or "Stale". */
  emptyText: string | null;
  ariaLabel: string;
}

export interface BuildGaugeModelInput {
  definition: GaugeDefinition;
  /** Value already extracted from the contract (`null` = reported as null, `undefined` = absent). */
  value: number | null | undefined;
  /** Telemetry from the API marked as out of date. */
  stale: boolean;
  /** Source chosen for this payload (see `resolveGaugeSource`). */
  source?: GaugeSource | null;
}

/**
 * Builds the visual model of a gauge.
 *
 * Scope rules §6.2: a missing/invalid value NEVER becomes zero. When there is
 * no usable number, the gauge is neutralized and receives the text "No data".
 * When the reading exists but is out of date, the number is shown with the
 * label "Stale" — never as if it were current.
 */
export function buildGaugeRenderModel(input: BuildGaugeModelInput): GaugeRenderModel {
  const { definition, stale } = input;
  const source = input.source ?? null;
  const label = source?.label ?? definition.label;
  const usable = typeof input.value === "number" && Number.isFinite(input.value);

  if (!usable) {
    const emptyText = stale ? "Stale" : "No data";
    return {
      definition,
      source,
      label,
      value: null,
      hasValue: false,
      displayValue: "—",
      level: "unknown",
      statusText: emptyText,
      stale,
      emptyText,
      ariaLabel: `${label}: ${emptyText}`,
    };
  }

  const value = input.value as number;
  const bandEvaluation = evaluateBand(value, definition.bands);
  const displayValue = formatNumber(value, definition.decimals);
  const statusText = stale ? "Stale" : bandEvaluation.text;

  return {
    definition,
    source,
    label,
    value,
    hasValue: true,
    displayValue,
    level: bandEvaluation.level,
    statusText,
    stale,
    emptyText: stale ? "Stale" : null,
    ariaLabel: `${label}: ${displayValue} ${definition.unit} — ${statusText}`,
  };
}

/**
 * Reads a value by a path of the telemetry payload (exact contract path,
 * without renaming fields).
 *
 * Returns:
 *  - `number`   → usable value;
 *  - `null`     → the contract explicitly reported `null`;
 *  - `undefined`→ absent path or unexpected type (never treated as zero).
 */
export function readMetricPath(payload: unknown, sourcePath: string): number | null | undefined {
  let current: unknown = payload;
  for (const segment of sourcePath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) return undefined;
  if (current === null) return null;
  if (typeof current === "number" && Number.isFinite(current)) return current;
  return undefined;
}

export interface ResolvedGaugeSource {
  /** Source actually chosen (defines the displayed label and badge). */
  source: GaugeSource | null;
  /** Value read on the path of that source (`undefined` = absent, `null` = explicitly null). */
  value: number | null | undefined;
}

/**
 * Chooses the gauge source for the received payload.
 *
 * The same data appears in different fields depending on the equipment PROTOCOL
 * (contract 2.0 is multiprotocol). That is why the definition lists `sources`
 * in order of preference and this function returns the FIRST one whose path is
 * present in the payload — whether a number or an explicit `null`. If no path
 * exists, it returns the first source as a reference (the value stays absent and
 * the gauge shows "No data", never zero).
 */
export function resolveGaugeSource(
  definition: GaugeDefinition,
  payload: unknown,
): ResolvedGaugeSource {
  const sources = definition.sources ?? [];
  for (const source of sources) {
    const value = readMetricPath(payload, source.path);
    if (value !== undefined) {
      return { source, value };
    }
  }
  return { source: sources[0] ?? null, value: undefined };
}
