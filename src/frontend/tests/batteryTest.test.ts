import { describe, expect, it } from "vitest";

import type { BatteryTestReport } from "../src/model/contract.js";
import {
  buildChartPoints,
  buildEstimateView,
  buildHistoryRows,
  buildLineChart,
  buildObservationView,
  buildTestChartModels,
  buildTestGuards,
  buildTestProgress,
  buildTestTypeOptions,
  describeFinishReason,
  describeTestError,
  describeTestStatus,
  describeTestType,
  describeTestTypeParams,
  formatOffsetSeconds,
  readTestSupport,
  testPhase,
} from "../src/model/batteryTest.js";

/**
 * The battery test model is pure and does not talk to the network. The cases
 * below cover the project golden rule: the API delivers FACTS and the viewer
 * PRESENTS — `estimate.available: false` never becomes a number.
 */

describe("readTestSupport", () => {
  it("reads the capabilities declared by the API (contract 3.0)", () => {
    const support = readTestSupport({
      battery_test: {
        supported: true,
        enabled: true,
        abort_supported: true,
        duration_s: 10,
        sample_interval_s: 0.4,
        cooldown_s: 300,
        min_battery_percent: 50,
        test_types: ["duration_10s", "discharge_20pct"],
        types: {
          duration_10s: { duration_s: 10, sample_interval_s: 0.4 },
          discharge_20pct: { target_percent: 20, timeout_s: 1800, sample_interval_s: 1 },
        },
      },
    });
    expect(support).toMatchObject({
      supported: true,
      enabled: true,
      abortSupported: true,
      durationS: 10,
      sampleIntervalS: 0.4,
      cooldownS: 300,
      minBatteryPercent: 50,
      testTypes: ["duration_10s", "discharge_20pct"],
    });
    // The detail of each type (window × target/ceiling) comes from `types.<type>`.
    expect(support.types["discharge_20pct"]?.target_percent).toBe(20);
    expect(support.types["discharge_20pct"]?.timeout_s).toBe(1800);
  });

  it("treats missing capabilities as unsupported (without inventing defaults)", () => {
    const support = readTestSupport(undefined);
    expect(support.supported).toBe(false);
    expect(support.enabled).toBe(false);
    expect(support.abortSupported).toBe(false);
    expect(support.durationS).toBeNull();
  });

  it("does not promise cancellation when the device does not support it", () => {
    const support = readTestSupport({
      battery_test: { supported: true, enabled: false, abort_supported: false, cooldown_s: 300 },
    });
    const guards = buildTestGuards(support);
    expect(guards.join(" ")).toContain("does not cancel");
    expect(guards.join(" ")).toContain("Wait of 5 min");
  });
});

describe("buildEstimateView", () => {
  it("presents the runtime as an extrapolation, with the API confidence", () => {
    const view = buildEstimateView({
      available: true,
      method: "linear_charge_extrapolation",
      window_s: 10.03,
      drop_percent_in_window: 7.5,
      discharge_rate_pp_per_min: 44.86,
      estimated_runtime_min: 2.2,
      capped_at_min: 600,
      confidence: "low",
    });
    expect(view.available).toBe(true);
    expect(view.runtimeText).toBe("2 min 12 s");
    expect(view.note).toContain("First-order linear extrapolation");
    expect(view.note).toContain("confidence low");
    expect(view.note).toContain("Estimate, not a measurement");
    expect(view.dischargeRateText).toBe("44.9 p.p./min");
    expect(view.dropText).toBe("7.5 p.p. in 10.0 s");
  });

  it("treats the sanity ceiling as a floor, not as precision", () => {
    const view = buildEstimateView({
      available: true,
      estimated_runtime_min: 600,
      capped_at_min: 600,
      confidence: "low",
    });
    expect(view.runtimeText).toBe("≥ 10 h (extrapolation)");
  });

  it("never invents a number when the API marks the estimate as unavailable", () => {
    const view = buildEstimateView({
      available: false,
      reason: "charge drop below the measurable resolution",
      confidence: "low",
    });
    expect(view.available).toBe(false);
    expect(view.runtimeText).toBe("—");
    expect(view.note).toBe("No estimated runtime: charge drop below the measurable resolution");
  });

  it("warns when the API marks it available but omits the runtime", () => {
    const view = buildEstimateView({ available: true, confidence: "low" });
    expect(view.available).toBe(false);
    expect(view.runtimeText).toBe("—");
    expect(view.note).toContain("did not publish the runtime");
  });
});

describe("buildObservationView", () => {
  const base: Pick<BatteryTestReport, "status" | "test_flag_observed" | "flags_seen"> = {
    status: "completed",
    test_flag_observed: true,
    flags_seen: ["BEEP", "OB", "TEST"],
  };

  it("confirms when the device reported the TEST flag", () => {
    const view = buildObservationView(base);
    expect(view.observed).toBe(true);
    expect(view.level).toBe("good");
    expect(view.text).toContain("reported the TEST flag");
  });

  it("warns when the TEST appeared in the samples but the API did not confirm it", () => {
    const view = buildObservationView({ ...base, test_flag_observed: false });
    expect(view.observed).toBe(false);
    expect(view.level).toBe("warning");
    expect(view.text).toContain("did not confirm it");
  });

  it("warns when the test state was not observed in the window", () => {
    const view = buildObservationView({ status: "completed", test_flag_observed: false, flags_seen: ["OB"] });
    expect(view.observed).toBe(false);
    expect(view.text).toContain("did NOT report the test state");
  });

  it("keeps the state undefined while the test runs", () => {
    const view = buildObservationView({ status: "running", test_flag_observed: true, flags_seen: [] });
    expect(view.observed).toBeNull();
    expect(view.level).toBe("unknown");
  });
});

describe("test types", () => {
  it("offers ONLY the types declared in test_types", () => {
    const support = readTestSupport({
      battery_test: {
        supported: true,
        enabled: true,
        test_types: ["duration_10s", "discharge_20pct"],
        types: {
          duration_10s: { duration_s: 10, sample_interval_s: 0.4 },
          discharge_20pct: { target_percent: 20, timeout_s: 1800, sample_interval_s: 1 },
        },
      },
    });
    const options = buildTestTypeOptions(support);
    expect(options.map((option) => option.type)).toEqual(["duration_10s", "discharge_20pct"]);
    expect(options[0]?.label).toBe("Quick test (~10 s)");
    expect(options[0]?.isTarget).toBe(false);
    expect(options[1]?.label).toBe("Controlled discharge (up to 20 %)");
    expect(options[1]?.isTarget).toBe(true);
    expect(options[1]?.params?.target_percent).toBe(20);
  });

  it("offers no type at all when the API does not publish test_types", () => {
    // The `megatec-q1` only lists `duration_10s`; without a list, the selector
    // stays empty instead of inventing a type the API would reject with 422.
    expect(buildTestTypeOptions(readTestSupport({ battery_test: { enabled: true } }))).toEqual([]);
  });

  it("describes the chosen type by window × target", () => {
    const support = readTestSupport({
      battery_test: {
        enabled: true,
        test_types: ["duration_10s", "discharge_20pct"],
        types: {
          duration_10s: { duration_s: 10 },
          discharge_20pct: { target_percent: 20, timeout_s: 1800 },
        },
      },
    });
    const [windowOption, targetOption] = buildTestTypeOptions(support);
    expect(describeTestTypeParams(windowOption ?? null)).toBe("Window of 10.0 s");
    expect(describeTestTypeParams(targetOption ?? null)).toBe("Discharge to 20%");
    expect(describeTestTypeParams(null)).toBe("—");
    expect(describeTestType("discharge_20pct")).toBe("Controlled discharge (up to 20 %)");
    // A new type keeps the API's own name.
    expect(describeTestType("new_type")).toBe("new_type");
  });
});

describe("chart series", () => {
  it("ignores the absent key — the unavailable series never becomes zero", () => {
    const points = buildChartPoints(
      [
        { offset_s: 0, normalized: { output_voltage_v: 218 } },
        { offset_s: 1, normalized: {} },
        { offset_s: 2, normalized: { output_voltage_v: null } },
        { offset_s: 3 },
      ],
      "output_voltage_v",
    );
    expect(points).toEqual([{ x: 0, y: 218 }]);
    expect(buildChartPoints(null, "output_voltage_v")).toEqual([]);
  });

  it("builds the four metrics in the order of the side bar", () => {
    const models = buildTestChartModels({
      samples: [
        {
          offset_s: 0,
          normalized: {
            output_voltage_v: 218,
            frequency_hz: 60,
            temperature_c: 26,
            battery_charge_percent: 100,
          },
        },
        {
          offset_s: 5,
          normalized: {
            output_voltage_v: 217,
            frequency_hz: 60.2,
            temperature_c: 27,
            battery_charge_percent: 90,
          },
        },
      ],
      deltas: {
        metrics: {
          output_voltage_v: { ripple: 1 },
          frequency_hz: { ripple: 0.2 },
          temperature_c: { delta: 1 },
          battery_charge_percent: { delta: -10 },
        },
      },
      target_percent: 20,
    });

    expect(models.map((model) => model.key)).toEqual([
      "output_voltage_v",
      "frequency_hz",
      "temperature_c",
      "battery_charge_percent",
    ]);
    expect(models[0]?.available).toBe(true);
    expect(models[0]?.variationText).toBe("Oscillation 1.0 V");
    expect(models[1]?.variationText).toBe("Oscillation 0.2 Hz");
    expect(models[2]?.variationText).toBe("Variation +1.0 °C");
    expect(models[3]?.variationText).toBe("Drop -10.0 p.p.");
    // The target line only exists on the battery charge.
    expect(models[0]?.reference).toBeNull();
    expect(models[3]?.reference).toBe(20);
    expect(models[3]?.referenceLabel).toBe("target 20%");
  });

  it("marks as unavailable the metric the device did not publish", () => {
    const models = buildTestChartModels({
      samples: [{ offset_s: 0, normalized: { output_voltage_v: 218 } }],
      target_percent: null,
    });
    expect(models[0]?.available).toBe(true);
    expect(models[1]?.available).toBe(false);
    expect(models[1]?.points).toEqual([]);
    expect(models[1]?.variationText).toBe("—");
    expect(models[3]?.reference).toBeNull();
  });
});

describe("chart geometry", () => {
  it("formats the X axis in short seconds and in m:ss for long tests", () => {
    expect(formatOffsetSeconds(0)).toBe("0.0 s");
    expect(formatOffsetSeconds(9.6)).toBe("9.6 s");
    expect(formatOffsetSeconds(12)).toBe("12.0 s");
    expect(formatOffsetSeconds(125)).toBe("125.0 s");
    expect(formatOffsetSeconds(125, true)).toBe("2:05");
  });

  it("projects the series into the SVG with a padded Y axis and time X axis", () => {
    const geometry = buildLineChart(
      [
        { x: 0, y: 218 },
        { x: 5, y: 217 },
        { x: 10, y: 218 },
      ],
      { width: 200, height: 100, decimals: 1 },
    );
    expect(geometry).not.toBeNull();
    expect(geometry?.path.startsWith("M")).toBe(true);
    expect(geometry?.yTicks).toHaveLength(4);
    expect(geometry?.xTicks.map((tick) => tick.text)).toEqual(["0.0 s", "5.0 s", "10.0 s"]);
    expect(geometry?.plotLeft).toBe(42);
    expect(geometry?.plotRight).toBe(188);
    expect(geometry?.referencePos).toBeNull();
  });

  it("uses m:ss in all labels when the window exceeds one minute", () => {
    const geometry = buildLineChart(
      [
        { x: 0, y: 100 },
        { x: 246, y: 60 },
        { x: 492, y: 20 },
      ],
      { width: 200, height: 100, decimals: 0 },
    );
    expect(geometry?.xTicks.map((tick) => tick.text)).toEqual(["0:00", "4:06", "8:12"]);
  });

  it("positions the target line inside the plot area", () => {
    const geometry = buildLineChart(
      [
        { x: 0, y: 100 },
        { x: 10, y: 20 },
      ],
      { width: 200, height: 100, decimals: 0, reference: 20 },
    );
    expect(geometry?.referencePos).not.toBeNull();
    const pos = geometry?.referencePos ?? -1;
    expect(pos).toBeGreaterThan(0);
    expect(pos).toBeLessThan(100);
  });

  it("draws nothing when the series is empty", () => {
    expect(buildLineChart([], { width: 200, height: 100, decimals: 1 })).toBeNull();
  });
});

describe("buildTestProgress", () => {
  it("in the window test, uses the elapsed time over the requested window", () => {
    const view = buildTestProgress(
      {
        status: "running",
        started_at_utc: "2026-10-22T15:04:11.400Z",
        expected_end_at_utc: "2026-10-22T15:04:21.400Z",
      },
      Date.parse("2026-10-22T15:04:16.400Z"),
    );
    expect(view?.mode).toBe("window");
    expect(view?.fraction).toBeCloseTo(0.5, 5);
    expect(view?.text).toBe("5.0 s of 10.0 s");
  });

  it("in the target test, progresses by the charge and ignores the 30 min ceiling", () => {
    const view = buildTestProgress(
      {
        status: "running",
        type: "discharge_20pct",
        target_percent: 20,
        // The 30 min ceiling is only a safety net: if it were used as the
        // window, the bar would be almost empty even with half the discharge
        // completed.
        started_at_utc: "2026-10-22T15:20:00.000Z",
        expected_end_at_utc: "2026-10-22T15:50:00.000Z",
        baseline: { battery_charge_percent: 100 },
        samples: [{ offset_s: 1, normalized: { battery_charge_percent: 70 } }],
      },
      Date.parse("2026-10-22T15:24:00.000Z"),
    );
    expect(view?.mode).toBe("target");
    expect(view?.fraction).toBeCloseTo(0.375, 5);
    expect(view?.text).toBe("Discharging to 20% · current: 70%");
  });

  it("in the target test, leaves the bar indeterminate while there is no charge", () => {
    const view = buildTestProgress(
      {
        status: "running",
        target_percent: 20,
        started_at_utc: "2026-10-22T15:20:00.000Z",
        baseline: null,
        samples: [],
      },
      Date.parse("2026-10-22T15:20:01.000Z"),
    );
    expect(view?.mode).toBe("target");
    expect(view?.fraction).toBeNull();
    expect(view?.text).toContain("waiting for the first sample");
  });

  it("does not project progress outside the execution", () => {
    expect(
      buildTestProgress(
        { status: "completed", started_at_utc: null, expected_end_at_utc: null },
        Date.now(),
      ),
    ).toBeNull();
  });
});

describe("descriptions and history", () => {
  it("translates status, finish reason and contract errors", () => {
    expect(describeTestStatus("running")).toBe("Running");
    expect(describeTestStatus("aborting")).toBe("Aborting");
    expect(describeTestStatus("new_status")).toBe("new_status");
    expect(describeFinishReason("duration_elapsed")).toBe("Full test window");
    expect(describeFinishReason("target_percent_reached")).toContain("reached the test target");
    expect(describeFinishReason("watchdog")).toContain("time ceiling");
    expect(describeFinishReason(null)).toBe("—");
    expect(describeTestError({ code: "test_cooldown", message: "" })).toContain("cooldown");
    expect(describeTestError({ code: "battery_at_target", message: "" })).toContain("target");
    expect(describeTestError({ code: "test_requires_battery_percent", message: "" })).toContain(
      "battery percentage",
    );
    expect(describeTestError({ code: "new_code", message: "API detail" })).toBe("API detail");
    expect(describeTestError(null)).toBe("—");
  });

  it("maps the status to the visual phase, without inventing a phase", () => {
    expect(testPhase("completed")).toBe("completed");
    expect(testPhase("aborting")).toBe("unknown");
    expect(testPhase(null)).toBe("unknown");
  });

  it("builds the history from the facts published by the API", () => {
    const rows = buildHistoryRows(
      [
        {
          test_id: "abc",
          type: "duration_10s",
          status: "completed",
          started_at_utc: "2026-10-22T15:04:11.400Z",
          finish_reason: "duration_elapsed",
          flags_seen: ["TEST"],
          estimate: { available: true, estimated_runtime_min: 2.2, confidence: "low" },
        },
        {
          test_id: "def",
          type: "discharge_20pct",
          status: "completed",
          finish_reason: "target_percent_reached",
          flags_seen: [],
          estimate: { available: false, reason: "small drop", confidence: "low" },
        },
      ],
      () => "10/22/2026, 12:04:11 PM",
    );
    expect(rows[0]?.runtimeText).toBe("2 min 12 s");
    expect(rows[0]?.typeText).toBe("Quick test (~10 s)");
    expect(rows[1]?.typeText).toBe("Controlled discharge (up to 20 %)");
    expect(rows[1]?.finishText).toContain("reached the test target");
    expect(rows[0]?.observedTestFlag).toBe(true);
    expect(rows[1]?.runtimeText).toBe("no estimate (small drop)");
    expect(rows[1]?.observedTestFlag).toBe(false);
    expect(buildHistoryRows(null, () => "")).toEqual([]);
  });
});
