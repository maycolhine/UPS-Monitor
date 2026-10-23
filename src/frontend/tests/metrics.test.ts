import { describe, expect, it } from "vitest";

import type { GaugeBand, GaugeDefinition } from "../src/model/contract.js";
import {
  GAUGE_GEOMETRY,
  arcPath,
  bandBoundaries,
  buildGaugeRenderModel,
  evaluateBand,
  readMetricPath,
  resolveGaugeSource,
  valueAngle,
  valueFraction,
} from "../src/model/metrics.js";

const definition: GaugeDefinition = {
  id: "input_voltage_v",
  label: "Input voltage",
  unit: "V",
  sources: [{ path: "data.measurements.input_voltage_v" }],
  scale: { min: 0, max: 300, ticks: [0, 150, 300] },
  bands: [
    { level: "critical", from: 0, to: 100, label: "Out of range" },
    { level: "good", from: 100, to: 200, label: "Normal" },
    { level: "critical", from: 200, to: 300, label: "Out of range" },
  ],
  decimals: 0,
  order: 1,
};

describe("evaluateBand", () => {
  it("finds the band that contains the value", () => {
    expect(evaluateBand(150, definition.bands).level).toBe("good");
    expect(evaluateBand(150, definition.bands).text).toBe("Normal");
  });

  it("flips to critical above the limit", () => {
    expect(evaluateBand(250, definition.bands).level).toBe("critical");
  });

  it("includes the upper limit in the last band", () => {
    expect(evaluateBand(300, definition.bands).level).toBe("critical");
  });

  it("returns 'no data' for null/undefined/NaN", () => {
    expect(evaluateBand(null, definition.bands).level).toBe("unknown");
    expect(evaluateBand(undefined, definition.bands).level).toBe("unknown");
    expect(evaluateBand(Number.NaN, definition.bands).level).toBe("unknown");
  });
});

describe("band limits", () => {
  // Same bands as the input frequency (60 Hz nominal must be normal).
  const bands: GaugeBand[] = [
    { level: "critical", from: 20, to: 42, label: "Frequency out of range (low)" },
    { level: "warning", from: 42, to: 47, label: "Warning: low frequency" },
    { level: "good", from: 47, to: 53, label: "Normal frequency (50 Hz)" },
    { level: "warning", from: 53, to: 57, label: "Warning: frequency out of the ideal" },
    { level: "good", from: 57, to: 60, label: "Normal frequency (60 Hz)" },
    { level: "warning", from: 60, to: 63, label: "Warning: high frequency" },
    { level: "critical", from: 63, to: 70, label: "Frequency out of range (high)" },
  ];

  it("classifies 60.0 Hz as normal, not as high frequency", () => {
    expect(evaluateBand(60, bands).level).toBe("good");
    expect(evaluateBand(60, bands).text).toBe("Normal frequency (60 Hz)");
  });

  it("a value exactly at the boundary belongs to the band that ends there", () => {
    expect(evaluateBand(42, bands).level).toBe("critical");
    expect(evaluateBand(47, bands).level).toBe("warning");
    expect(evaluateBand(53, bands).level).toBe("good");
    expect(evaluateBand(57, bands).level).toBe("warning");
    expect(evaluateBand(63, bands).level).toBe("warning");
    expect(evaluateBand(70, bands).level).toBe("critical");
  });

  it("bandBoundaries returns the start/end of each band, in order and without repetition", () => {
    expect(bandBoundaries(bands)).toEqual([20, 42, 47, 53, 57, 60, 63, 70]);
  });
});

describe("scale", () => {
  it("valueFraction clamps the fraction between 0 and 1", () => {
    expect(valueFraction(-10, 0, 100)).toBe(0);
    expect(valueFraction(50, 0, 100)).toBe(0.5);
    expect(valueFraction(500, 0, 100)).toBe(1);
  });

  it("valueAngle goes from 180° (minimum) to 0° (maximum)", () => {
    expect(valueAngle(0, 0, 100)).toBe(180);
    expect(valueAngle(50, 0, 100)).toBe(90);
    expect(valueAngle(100, 0, 100)).toBe(0);
  });

  it("arcPath generates a valid SVG path, with the same radius as the geometry", () => {
    const path = arcPath(0, 300, definition.scale, {
      cx: GAUGE_GEOMETRY.center.x,
      cy: GAUGE_GEOMETRY.center.y,
      radius: GAUGE_GEOMETRY.radius,
      strokeWidth: GAUGE_GEOMETRY.strokeWidth,
    });
    expect(path.startsWith("M ")).toBe(true);
    expect(path).toContain(`A ${GAUGE_GEOMETRY.radius} ${GAUGE_GEOMETRY.radius}`);
  });

  it("arcPath of a subinterval does not cross the center", () => {
    const [start] = arcPath(0, 300, definition.scale, {
      cx: 110,
      cy: 110,
      radius: 84,
      strokeWidth: 18,
    })
      .replace("M ", "")
      .split(" A ");
    expect(start).toBe("26 110");
  });
});

describe("buildGaugeRenderModel", () => {
  it("builds the model with a valid value", () => {
    const model = buildGaugeRenderModel({ definition, value: 150, stale: false });
    expect(model.hasValue).toBe(true);
    expect(model.displayValue).toBe("150");
    expect(model.level).toBe("good");
    expect(model.statusText).toBe("Normal");
    expect(model.ariaLabel).toContain("Input voltage");
  });

  it("does NOT convert a missing value into zero", () => {
    const missing = buildGaugeRenderModel({ definition, value: undefined, stale: false });
    expect(missing.hasValue).toBe(false);
    expect(missing.displayValue).toBe("—");
    expect(missing.emptyText).toBe("No data");
    expect(missing.level).toBe("unknown");
  });

  it("treats an explicit null as absence, not as zero", () => {
    const nullValue = buildGaugeRenderModel({ definition, value: null, stale: false });
    expect(nullValue.hasValue).toBe(false);
    expect(nullValue.displayValue).toBe("—");
    expect(nullValue.statusText).toBe("No data");
  });

  it("rejects NaN as a usable value", () => {
    const invalid = buildGaugeRenderModel({ definition, value: Number.NaN, stale: false });
    expect(invalid.hasValue).toBe(false);
  });

  it("shows the number, but labels it as stale, when stale", () => {
    const model = buildGaugeRenderModel({ definition, value: 150, stale: true });
    expect(model.hasValue).toBe(true);
    expect(model.displayValue).toBe("150");
    expect(model.statusText).toBe("Stale");
    expect(model.stale).toBe(true);
  });

  it("respects the number of decimals of the definition", () => {
    const model = buildGaugeRenderModel({
      definition: { ...definition, decimals: 1 },
      value: 60.25,
      stale: false,
    });
    expect(model.displayValue).toBe("60.3");
  });
});

describe("readMetricPath", () => {
  const payload = {
    data: {
      measurements: { input_voltage_v: 219, output_voltage_v: null },
      battery_charge: { percent: 100 },
    },
  };

  it("reads by the exact contract path", () => {
    expect(readMetricPath(payload, "data.measurements.input_voltage_v")).toBe(219);
    expect(readMetricPath(payload, "data.battery_charge.percent")).toBe(100);
  });

  it("distinguishes a reported null from an absent path", () => {
    expect(readMetricPath(payload, "data.measurements.output_voltage_v")).toBeNull();
    expect(readMetricPath(payload, "data.measurements.temperature_c")).toBeUndefined();
  });

  it("does not convert numeric strings into numbers", () => {
    expect(readMetricPath({ a: "10" }, "a")).toBeUndefined();
  });

  it("returns undefined when traversing a non-object node", () => {
    expect(readMetricPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(readMetricPath(null, "a")).toBeUndefined();
  });
});

describe("resolveGaugeSource", () => {
  const frequency: GaugeDefinition = {
    id: "input_frequency_hz",
    label: "Input frequency",
    unit: "Hz",
    sources: [
      { path: "data.measurements.input_frequency_hz" },
      { path: "data.measurements.output_frequency_hz", label: "Output frequency" },
    ],
    scale: { min: 20, max: 70, ticks: [20, 70] },
    bands: [{ level: "good", from: 20, to: 70, label: "Normal" }],
    decimals: 1,
    order: 3,
  };

  it("chooses the first source present in the payload (megatec-q1 → input)", () => {
    const payload = { data: { measurements: { input_frequency_hz: 60 } } };
    const resolved = resolveGaugeSource(frequency, payload);
    expect(resolved.source?.path).toBe("data.measurements.input_frequency_hz");
    expect(resolved.value).toBe(60);
  });

  it("falls back to the next source when the protocol publishes the other path (sms-1phase → output)", () => {
    const payload = { data: { measurements: { output_frequency_hz: 59.9 } } };
    const resolved = resolveGaugeSource(frequency, payload);
    expect(resolved.source?.path).toBe("data.measurements.output_frequency_hz");
    expect(resolved.value).toBe(59.9);
  });

  it("treats an explicit null as a present source (never falls back to another protocol)", () => {
    const payload = { data: { measurements: { input_frequency_hz: null, output_frequency_hz: 59.9 } } };
    const resolved = resolveGaugeSource(frequency, payload);
    expect(resolved.source?.path).toBe("data.measurements.input_frequency_hz");
    expect(resolved.value).toBeNull();
  });

  it("with no path present, returns the first source and a missing value", () => {
    const resolved = resolveGaugeSource(frequency, { data: { measurements: {} } });
    expect(resolved.source?.path).toBe("data.measurements.input_frequency_hz");
    expect(resolved.value).toBeUndefined();
  });

  it("uses the label of the chosen source in the gauge model", () => {
    const payload = { data: { measurements: { output_frequency_hz: 59.9 } } };
    const resolved = resolveGaugeSource(frequency, payload);
    const model = buildGaugeRenderModel({
      definition: frequency,
      value: resolved.value,
      stale: false,
      source: resolved.source,
    });
    expect(model.label).toBe("Output frequency");
    expect(model.ariaLabel).toContain("Output frequency");
  });
});
