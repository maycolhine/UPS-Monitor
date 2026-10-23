import { describe, expect, it } from "vitest";

import { applyGaugeOverrides, GAUGE_DEFINITIONS, readMetricValue } from "../src/gaugeConfig.js";

describe("applyGaugeOverrides", () => {
  it("without an override, keeps the default provisional bands and the defined order", () => {
    const { gauges, problems } = applyGaugeOverrides(undefined);
    expect(problems).toEqual([]);
    expect(gauges.map((gauge) => gauge.id)).toEqual([
      "input_voltage_v",
      "output_voltage_v",
      "input_frequency_hz",
      "temperature_c",
      "battery_charge_percent",
      "load_percent",
    ]);
  });

  it("the default bands cover the whole scale without overlap", () => {
    for (const gauge of GAUGE_DEFINITIONS) {
      expect(gauge.bands[0]?.from).toBe(gauge.scale.min);
      expect(gauge.bands[gauge.bands.length - 1]?.to).toBe(gauge.scale.max);
      gauge.bands.forEach((band, index) => {
        expect(band.from).toBeLessThan(band.to);
        if (index > 0) {
          expect(gauge.bands[index - 1]!.to).toBe(band.from);
        }
      });
    }
  });

  it("the nominal 60 Hz frequency falls in a 'good' band", () => {
    const frequency = GAUGE_DEFINITIONS.find((gauge) => gauge.id === "input_frequency_hz");
    // The value at the limit belongs to the band that ends at it (see metrics.evaluateBand).
    const band = frequency?.bands.find((item) => 60 >= item.from && 60 <= item.to);
    expect(band?.level).toBe("good");
    expect(band?.label).toContain("Normal");
  });

  it("declares the battery charge origins per protocol, with the origin badge", () => {
    const battery = GAUGE_DEFINITIONS.find((gauge) => gauge.id === "battery_charge_percent");
    // megatec-q1: estimated percentage + measured voltage as a secondary measurement.
    expect(battery?.sources[0]?.path).toBe("data.battery_charge.percent");
    expect(battery?.sources[0]?.origin_note).toBe("estimate");
    expect(battery?.sources[0]?.secondary?.path).toBe("data.measurements.battery_voltage_v");
    // sms-1phase: percentage reported by the device (not an estimate).
    expect(battery?.sources[1]?.path).toBe("data.battery.charge_percent");
    expect(battery?.sources[1]?.origin_note).toBe("reported by the device");
    expect(battery?.sources[1]?.secondary?.path).toBe("data.battery.voltage_v");
  });

  it("declares the frequency origins (input on Q1, output on SMS)", () => {
    const frequency = GAUGE_DEFINITIONS.find((gauge) => gauge.id === "input_frequency_hz");
    expect(frequency?.sources[0]?.path).toBe("data.measurements.input_frequency_hz");
    expect(frequency?.sources[1]?.path).toBe("data.measurements.output_frequency_hz");
    expect(frequency?.sources[1]?.label).toBe("Output frequency");
  });

  it("applies a valid override of scale and bands", () => {
    const override = JSON.stringify({
      output_voltage_v: {
        scale: { min: 0, max: 300, ticks: [0, 150, 300] },
        bands: [
          { level: "critical", from: 0, to: 198, label: "Out of range" },
          { level: "good", from: 198, to: 242, label: "Expected range (220 V)" },
          { level: "critical", from: 242, to: 300, label: "Out of range" },
        ],
      },
    });

    const { gauges, problems } = applyGaugeOverrides(override);
    expect(problems).toEqual([]);
    const output = gauges.find((gauge) => gauge.id === "output_voltage_v");
    expect(output?.scale.max).toBe(300);
    expect(output?.bands).toHaveLength(3);
    expect(output?.bands[1]?.label).toBe("Expected range (220 V)");
  });

  it("invalid JSON produces a problem and keeps the default", () => {
    const { gauges, problems } = applyGaugeOverrides("{this is not json}");
    expect(problems.length).toBeGreaterThan(0);
    expect(gauges.find((gauge) => gauge.id === "output_voltage_v")?.bands).toHaveLength(5);
  });

  it("an unknown metric is reported and changes nothing", () => {
    const { problems } = applyGaugeOverrides(JSON.stringify({ magic_voltage_v: { scale: { min: 0, max: 1 } } }));
    expect(problems.join(" ")).toContain("magic_voltage_v");
  });

  it("a band out of scale or out of order is rejected", () => {
    const outOfScale = applyGaugeOverrides(
      JSON.stringify({ load_percent: { bands: [{ level: "good", from: 0, to: 150, label: "x" }] } }),
    );
    expect(outOfScale.problems.join(" ")).toContain("outside the scale");
    expect(outOfScale.gauges.find((gauge) => gauge.id === "load_percent")?.bands).toHaveLength(3);

    const unordered = applyGaugeOverrides(
      JSON.stringify({
        load_percent: {
          bands: [
            { level: "good", from: 50, to: 100, label: "b" },
            { level: "critical", from: 0, to: 50, label: "a" },
          ],
        },
      }),
    );
    expect(unordered.problems.join(" ")).toContain("in ascending order");
  });
});

describe("readMetricValue", () => {
  const payload = {
    data: {
      measurements: { input_voltage_v: 219, temperature_c: null },
      battery_charge: { percent: 100 },
    },
  };

  it("reads the value by the exact contract path", () => {
    expect(readMetricValue(payload, "data.measurements.input_voltage_v")).toBe(219);
    expect(readMetricValue(payload, "data.battery_charge.percent")).toBe(100);
  });

  it("distinguishes null (no data) from absent", () => {
    expect(readMetricValue(payload, "data.measurements.temperature_c")).toBeNull();
    expect(readMetricValue(payload, "data.measurements.output_voltage_v")).toBeUndefined();
  });

  it("returns undefined when there is no payload (no data)", () => {
    expect(readMetricValue(null, "data.measurements.input_voltage_v")).toBeUndefined();
  });
});
