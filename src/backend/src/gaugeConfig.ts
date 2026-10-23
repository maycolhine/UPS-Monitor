/**
 * Definition of the metrics shown on the semicircular gauges.
 *
 * IMPORTANT (scope §4.2 and §6.1): the red/yellow/green bands below were
 * **validated by the requester** on 2026-10-21. They are not official
 * manufacturer limits, but they become the reference adopted by the interface.
 * They stay in a single place and can be replaced by `VIEWER_GAUGE_THRESHOLDS` (JSON).
 *
 * Each gauge declares one or more `sources`: EXACT paths in the API JSON, relative
 * to the telemetry payload (`/api/v1/ups/{device_id}/telemetry`). No field name
 * is changed. There is more than one path because the same reading appears in
 * different fields depending on the device PROTOCOL — the unified API is
 * multi-device/multi-protocol:
 *   - battery charge: `data.battery_charge.percent` (megatec-q1, estimate) or
 *     `data.battery.charge_percent` (sms-1phase, reported by the device);
 *   - frequency: `data.measurements.input_frequency_hz` (megatec-q1) or
 *     `data.measurements.output_frequency_hz` (sms-1phase).
 * The list order is the preference order (the first path present in the payload wins).
 */

export type BandLevel = "critical" | "warning" | "good";

export interface GaugeBand {
  level: BandLevel;
  from: number;
  to: number;
  label: string;
}

/** Complementary measurement shown alongside the gauge (e.g.: battery voltage). */
export interface GaugeSecondarySource {
  label: string;
  path: string;
  unit: string;
  decimals: number;
}

/** Origin of a value in the telemetry payload (one path per protocol). */
export interface GaugeSource {
  /** Exact path in the telemetry payload (contract names, no renaming). */
  path: string;
  /** Metric label when this path is used (default: the gauge label). */
  label?: string;
  /**
   * Origin badge shown on the card. It should only claim "estimate" when the API
   * actually estimates the value (the SMS reports the battery percentage, so it is
   * not an estimate).
   */
  origin_note?: string;
  secondary?: GaugeSecondarySource;
}

export interface GaugeDefinition {
  /** Stable metric identifier (key used in VIEWER_GAUGE_THRESHOLDS). */
  id: string;
  label: string;
  unit: string;
  /** Paths in the telemetry payload, in preference order. */
  sources: GaugeSource[];
  scale: { min: number; max: number; ticks: number[] };
  bands: GaugeBand[];
  decimals: number;
  order: number;
}

/**
 * AC voltage: green in the two adopted operating windows (127 V and 220 V nominal,
 * with tolerance), red over the rest of the scale.
 */
const VOLTAGE_BANDS = [
  { level: "critical" as BandLevel, from: 0, to: 80, label: "Voltage out of range (low)" },
  { level: "good" as BandLevel, from: 80, to: 127, label: "Within the expected range (127 V)" },
  { level: "critical" as BandLevel, from: 127, to: 200, label: "Voltage out of range (intermediate)" },
  { level: "good" as BandLevel, from: 200, to: 225, label: "Within the expected range (220 V)" },
  { level: "critical" as BandLevel, from: 225, to: 250, label: "Voltage out of range (high)" },
];

const VOLTAGE_SCALE = { min: 0, max: 250, ticks: [0, 50, 100, 150, 200, 250] };

/** Copies the voltage bands so each metric has its own mutable list. */
function voltageBands(): GaugeBand[] {
  return VOLTAGE_BANDS.map((band) => ({ ...band }));
}

export const GAUGE_DEFINITIONS: GaugeDefinition[] = [
  {
    id: "input_voltage_v",
    label: "Input voltage",
    unit: "V",
    sources: [{ path: "data.measurements.input_voltage_v" }],
    scale: { ...VOLTAGE_SCALE, ticks: [...VOLTAGE_SCALE.ticks] },
    bands: voltageBands(),
    decimals: 0,
    order: 1,
  },
  {
    id: "output_voltage_v",
    label: "Output voltage",
    unit: "V",
    sources: [{ path: "data.measurements.output_voltage_v" }],
    scale: { ...VOLTAGE_SCALE, ticks: [...VOLTAGE_SCALE.ticks] },
    bands: voltageBands(),
    decimals: 0,
    order: 2,
  },
  {
    // The id stays "input_frequency_hz" because it is the stable configuration key;
    // the label changes depending on whether the protocol publishes input or output.
    id: "input_frequency_hz",
    label: "Input frequency",
    unit: "Hz",
    sources: [
      { path: "data.measurements.input_frequency_hz" },
      { path: "data.measurements.output_frequency_hz", label: "Output frequency" },
    ],
    scale: { min: 20, max: 70, ticks: [20, 30, 40, 50, 60, 70] },
    bands: [
      { level: "critical", from: 20, to: 42, label: "Frequency out of range (low)" },
      { level: "warning", from: 42, to: 47, label: "Warning: low frequency" },
      { level: "good", from: 47, to: 53, label: "Normal frequency (50 Hz)" },
      { level: "warning", from: 53, to: 57, label: "Warning: frequency outside the ideal" },
      { level: "good", from: 57, to: 60, label: "Normal frequency (60 Hz)" },
      { level: "warning", from: 60, to: 63, label: "Warning: high frequency" },
      { level: "critical", from: 63, to: 70, label: "Frequency out of range (high)" },
    ],
    decimals: 1,
    order: 3,
  },
  {
    id: "temperature_c",
    label: "Internal temperature",
    unit: "°C",
    sources: [{ path: "data.measurements.temperature_c" }],
    scale: { min: 0, max: 50, ticks: [0, 10, 20, 30, 40, 50] },
    bands: [
      { level: "good", from: 0, to: 25, label: "Normal temperature" },
      { level: "warning", from: 25, to: 35, label: "Warning: elevated temperature" },
      { level: "critical", from: 35, to: 50, label: "Critical temperature" },
    ],
    decimals: 0,
    order: 4,
  },
  {
    id: "battery_charge_percent",
    label: "Battery charge",
    unit: "%",
    sources: [
      {
        // megatec-q1: percentage ESTIMATED by linear interpolation of the voltage.
        path: "data.battery_charge.percent",
        origin_note: "estimate",
        secondary: {
          label: "Battery voltage (measurement)",
          path: "data.measurements.battery_voltage_v",
          unit: "V",
          decimals: 1,
        },
      },
      {
        // sms-1phase: percentage REPORTED by the device (not an estimate).
        path: "data.battery.charge_percent",
        origin_note: "reported by the device",
        secondary: {
          label: "Battery voltage (derived by the API)",
          path: "data.battery.voltage_v",
          unit: "V",
          decimals: 1,
        },
      },
    ],
    scale: { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] },
    bands: [
      { level: "critical", from: 0, to: 20, label: "Critical charge" },
      { level: "warning", from: 20, to: 40, label: "Warning: low charge" },
      { level: "good", from: 40, to: 100, label: "Adequate charge" },
    ],
    decimals: 0,
    order: 5,
  },
  {
    id: "load_percent",
    label: "UPS load",
    unit: "%",
    sources: [{ path: "data.measurements.load_percent" }],
    scale: { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] },
    bands: [
      { level: "good", from: 0, to: 50, label: "Adequate load" },
      { level: "warning", from: 50, to: 75, label: "Warning: high load" },
      { level: "critical", from: 75, to: 100, label: "Critical load" },
    ],
    decimals: 0,
    order: 6,
  },
];

const LEVELS: BandLevel[] = ["critical", "warning", "good"];
const METRIC_IDS = GAUGE_DEFINITIONS.map((definition) => definition.id);

export interface GaugeConfigResult {
  gauges: GaugeDefinition[];
  problems: string[];
}

/**
 * Applies a partial override (JSON) over the default bands.
 * Invalid JSON is not silently ignored: it produces problems and keeps the default.
 */
export function applyGaugeOverrides(rawJson: string | undefined): GaugeConfigResult {
  const gauges = GAUGE_DEFINITIONS.map((definition) => ({
    ...definition,
    sources: definition.sources.map((source) => ({
      ...source,
      ...(source.secondary ? { secondary: { ...source.secondary } } : {}),
    })),
    scale: { ...definition.scale, ticks: [...definition.scale.ticks] },
    bands: definition.bands.map((band) => ({ ...band })),
  }));
  const problems: string[] = [];
  if (!rawJson || rawJson.trim() === "") {
    return { gauges, problems };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    problems.push(`VIEWER_GAUGE_THRESHOLDS is not valid JSON: ${(error as Error).message}`);
    return { gauges, problems };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push("VIEWER_GAUGE_THRESHOLDS must be a JSON object");
    return { gauges, problems };
  }

  for (const [metricId, overrideRaw] of Object.entries(parsed as Record<string, unknown>)) {
    const target = gauges.find((definition) => definition.id === metricId);
    if (!target) {
      problems.push(
        `VIEWER_GAUGE_THRESHOLDS: unknown metric '${metricId}' (available: ${METRIC_IDS.join(", ")})`,
      );
      continue;
    }
    if (typeof overrideRaw !== "object" || overrideRaw === null || Array.isArray(overrideRaw)) {
      problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'] must be an object`);
      continue;
    }
    const override = overrideRaw as Record<string, unknown>;

    const scaleRaw = override["scale"];
    if (scaleRaw !== undefined) {
      if (typeof scaleRaw !== "object" || scaleRaw === null) {
        problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].scale must be an object`);
      } else {
        const scale = scaleRaw as Record<string, unknown>;
        const min = typeof scale["min"] === "number" ? scale["min"] : target.scale.min;
        const max = typeof scale["max"] === "number" ? scale["max"] : target.scale.max;
        if (!(min < max)) {
          problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].scale invalid (min >= max)`);
        } else {
          target.scale.min = min;
          target.scale.max = max;
        }
        if (Array.isArray(scale["ticks"]) && scale["ticks"].every((tick) => typeof tick === "number")) {
          target.scale.ticks = scale["ticks"] as number[];
        } else if (scale["ticks"] !== undefined) {
          problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].scale.ticks must be a list of numbers`);
        }
      }
    }

    const bandsRaw = override["bands"];
    if (bandsRaw !== undefined) {
      if (!Array.isArray(bandsRaw) || bandsRaw.length === 0) {
        problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands must be a non-empty list`);
      } else {
        const bands: GaugeBand[] = [];
        let valid = true;
        bandsRaw.forEach((bandRaw, index) => {
          if (typeof bandRaw !== "object" || bandRaw === null) {
            problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands[${index}] must be an object`);
            valid = false;
            return;
          }
          const band = bandRaw as Record<string, unknown>;
          const level = band["level"];
          const from = band["from"];
          const to = band["to"];
          const label = band["label"];
          if (!LEVELS.includes(level as BandLevel)) {
            problems.push(
              `VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands[${index}].level must be critical|warning|good`,
            );
            valid = false;
            return;
          }
          if (typeof from !== "number" || typeof to !== "number" || !(from < to)) {
            problems.push(
              `VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands[${index}] requires numeric from/to with from < to`,
            );
            valid = false;
            return;
          }
          if (from < target.scale.min || to > target.scale.max) {
            problems.push(
              `VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands[${index}] outside the scale (${target.scale.min}–${target.scale.max})`,
            );
            valid = false;
            return;
          }
          bands.push({
            level: level as BandLevel,
            from,
            to,
            label: typeof label === "string" && label !== "" ? label : target.label,
          });
        });
        const ordered = bands.every(
          (band, index) => index === 0 || (bands[index - 1] as GaugeBand).to <= band.from,
        );
        if (!ordered) {
          problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands must be in ascending order and without overlap`);
          valid = false;
        }
        if (valid) target.bands = bands;
      }
    }

    if (typeof override["label"] === "string" && override["label"] !== "") target.label = override["label"];
    if (typeof override["unit"] === "string" && override["unit"] !== "") target.unit = override["unit"];
    if (typeof override["decimals"] === "number" && Number.isInteger(override["decimals"]) && override["decimals"] >= 0) {
      target.decimals = override["decimals"];
    }
  }

  gauges.sort((a, b) => a.order - b.order);
  return { gauges, problems };
}

/** Reads a numeric value by a (`.`-separated) path from the telemetry payload. */
export function readMetricValue(
  telemetryPayload: unknown,
  sourcePath: string,
): number | null | undefined {
  let current: unknown = telemetryPayload;
  for (const segment of sourcePath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) return undefined;
  if (current === null) return null;
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}
