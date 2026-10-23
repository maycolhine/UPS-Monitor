import { describe, expect, it } from "vitest";

import {
  parseBatteryTestAbort,
  parseBatteryTestAccept,
  parseBatteryTestReport,
  parseDevices,
  parseErrorPayload,
  parseHealth,
  parseIdentity,
  parseTelemetry,
  parseTestsList,
} from "../src/contract.js";
import {
  deviceId,
  deviceNotFound,
  devicesEmpty,
  devicesOk,
  healthOk,
  identityOk,
  telemetryNoData,
  telemetryOk,
  telemetrySms,
  testAbort,
  testAccept,
  testAcceptDischarge,
  testId,
  testReportCompleted,
  testReportDischarge,
  testReportEstimateUnavailable,
  testReportRunning,
  testsListOk,
} from "./helpers/fixtures.js";

describe("parseTelemetry", () => {
  it("accepts the valid response preserving the contract field names", () => {
    const parsed = parseTelemetry(telemetryOk);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.problems).toEqual([]);
    const measurements = parsed.value.data?.measurements;
    expect(measurements).toMatchObject({
      input_voltage_v: 219,
      input_voltage_fault_v: 219,
      output_voltage_v: 111,
      load_percent: 11,
      input_frequency_hz: 60,
      battery_voltage_v: 27.4,
      temperature_c: 26,
    });
    expect(parsed.value.data?.battery_charge?.percent).toBe(100);
    expect(parsed.value.data?.battery_charge?.estimated).toBe(true);
    expect(parsed.value.data?.status?.flags?.STANDBY).toBe(true);
    expect(parsed.value.data?.status?.active).toEqual(["STANDBY", "BEEP"]);
    expect(parsed.value.communication.state).toBe("ok");
    expect(parsed.value.telemetry_valid).toBe(true);
    expect(parsed.value.stale).toBe(false);
  });

  it("preserves null as null (never converts it to zero)", () => {
    const payload = {
      ...telemetryOk,
      data: {
        ...telemetryOk.data,
        measurements: { ...telemetryOk.data.measurements, temperature_c: null },
        battery_charge: { percent: null, estimated: true },
      },
    };
    const parsed = parseTelemetry(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.data?.measurements["temperature_c"]).toBeNull();
    expect(parsed.value.data?.battery_charge?.percent).toBeNull();
  });

  it("keeps unknown fields (other brands/models) without renaming", () => {
    const payload = {
      ...telemetryOk,
      data: {
        ...telemetryOk.data,
        measurements: { ...telemetryOk.data.measurements, battery_temperature_c: 31.5 },
      },
    };
    const parsed = parseTelemetry(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.data?.measurements["battery_temperature_c"]).toBe(31.5);
  });

  it("reads the SMS battery block and the status byte (contract 2.0)", () => {
    const parsed = parseTelemetry(telemetrySms);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.problems).toEqual([]);
    expect(parsed.value.data?.source).toBe("sms-1phase");
    expect(parsed.value.data?.battery?.charge_percent).toBe(100);
    expect(parsed.value.data?.battery?.charge_source).toBe("reported_by_device");
    expect(parsed.value.data?.battery?.voltage_derived).toBe(true);
    expect(parsed.value.data?.status?.raw_byte).toBe(41);
    expect(parsed.value.data?.status?.flags?.["BYPASS"]).toBe(true);
    expect(parsed.value.data?.measurements["output_frequency_hz"]).toBe(59.9);
  });

  it("accepts telemetry without data (data = null) without inventing measurements", () => {
    const parsed = parseTelemetry(telemetryNoData);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.data).toBeNull();
    expect(parsed.value.data_available).toBe(false);
    expect(parsed.value.communication.state).toBe("starting");
  });

  it("rejects a response without the contract envelope", () => {
    const parsed = parseTelemetry({ device_id: "x", data: null });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(" ")).toContain("api_version");
  });

  it("rejects a response without communication metadata", () => {
    const { communication, ...rest } = telemetryOk;
    expect(communication).toBeDefined();
    const parsed = parseTelemetry(rest);
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(" ")).toContain("communication");
  });

  it("reports a divergence when the type of a measurement is unexpected, without breaking", () => {
    const payload = {
      ...telemetryOk,
      data: {
        ...telemetryOk.data,
        measurements: { ...telemetryOk.data.measurements, load_percent: "11" },
      },
    };
    const parsed = parseTelemetry(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.data?.measurements["load_percent"]).toBeUndefined();
    expect(parsed.problems.join(" ")).toContain("load_percent");
  });
});

describe("parseIdentity", () => {
  it("reads identity and nominal values, preserving voltage_v as null", () => {
    const parsed = parseIdentity(identityOk);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.identity_available).toBe(true);
    expect(parsed.value.data?.device?.firmware).toBe("V01020805A");
    expect(parsed.value.data?.nominal?.voltage_label).toBe("Univ.");
    expect(parsed.value.data?.nominal?.voltage_v).toBeNull();
    expect(parsed.value.configured?.["serial_baud"]).toBe(2400);
  });
});

describe("parseDevices / parseHealth / parseErrorPayload", () => {
  it("reads the device list with both protocols", () => {
    const parsed = parseDevices(devicesOk);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.count).toBe(2);
    expect(parsed.value.devices[0]?.device_id).toBe("tsshara-3200va-01");
    expect(parsed.value.devices[0]?.model).toBe("Universal UPS Senoidal 3200VA");
    expect(parsed.value.devices[0]?.protocol).toBe("megatec-q1");
    expect(parsed.value.devices[1]?.protocol).toBe("sms-1phase");
  });

  it("reads the battery test capability of each device (contract 3.0)", () => {
    const parsed = parseDevices(devicesOk);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // TS Shara declares the test, but disabled and without cancellation.
    expect(parsed.value.devices[0]?.capabilities?.battery_test?.enabled).toBe(false);
    expect(parsed.value.devices[0]?.capabilities?.battery_test?.abort_supported).toBe(false);
    // The SMS exposes the test enabled and cancellable.
    expect(parsed.value.devices[1]?.capabilities?.battery_test?.enabled).toBe(true);
    expect(parsed.value.devices[1]?.capabilities?.battery_test?.abort_supported).toBe(true);
    expect(parsed.value.devices[0]?.capabilities?.battery_test?.duration_s).toBe(10);
    // Only the SMS declares the controlled discharge; TS Shara is restricted to the window.
    expect(parsed.value.devices[0]?.capabilities?.battery_test?.test_types).toEqual(["duration_10s"]);
    expect(parsed.value.devices[1]?.capabilities?.battery_test?.test_types).toEqual([
      "duration_10s",
      "discharge_20pct",
    ]);
    // The parameters of each type are preserved (window × target/cap).
    expect(parsed.value.devices[1]?.capabilities?.battery_test?.types?.["duration_10s"]?.duration_s).toBe(10);
    expect(
      parsed.value.devices[1]?.capabilities?.battery_test?.types?.["discharge_20pct"]?.target_percent,
    ).toBe(20);
    expect(parsed.value.devices[1]?.capabilities?.battery_test?.types?.["discharge_20pct"]?.timeout_s).toBe(1800);
  });

  it("accepts an empty list without a contract error", () => {
    const parsed = parseDevices(devicesEmpty);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.devices).toEqual([]);
  });

  it("reads /health aggregated by device (contract 2.0)", () => {
    const parsed = parseHealth(healthOk);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.status).toBe("degraded");
    expect(parsed.value.devices_total).toBe(2);
    expect(parsed.value.devices_ok).toBe(1);
    expect(parsed.value.devices?.[deviceId]?.telemetry_freshness).toBe("ok");
    expect(parsed.value.devices?.[deviceId]?.state).toBe("ok");
  });

  it("reads the contract error payload", () => {
    const parsed = parseErrorPayload(deviceNotFound);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.error.code).toBe("device_not_found");
  });
});

describe("battery test parsers (contract 3.0)", () => {
  it("reads the request acceptance without confusing it with the test result", () => {
    const parsed = parseBatteryTestAccept(testAccept);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.problems).toEqual([]);
    expect(parsed.value.test_id).toBe(testId);
    expect(parsed.value.status).toBe("running");
    expect(parsed.value.type).toBe("duration_10s");
    expect(parsed.value.poll_interval_s).toBe(0.5);
    expect(parsed.value.report_url).toBe(`/api/v1/ups/${deviceId}/tests/${testId}`);
  });

  it("rejects an acceptance without 'test_id'/'status'", () => {
    const parsed = parseBatteryTestAccept({ device_id: deviceId });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(" ")).toContain("test_id");
  });

  it("reads the partial report (running) without inventing aggregations or an estimate", () => {
    const parsed = parseBatteryTestReport(testReportRunning);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.status).toBe("running");
    expect(parsed.value.test_flag_observed).toBe(true);
    expect(parsed.value.estimate).toBeNull();
    expect(parsed.value.deltas?.metrics).toBeUndefined();
    expect(parsed.value.samples?.[0]?.battery?.charge_percent).toBe(99.5);
    expect(parsed.value.samples?.[0]?.status?.flags?.["TEST"]).toBe(true);
  });

  it("reads the complete report: charge drop, ripple and estimated runtime", () => {
    const parsed = parseBatteryTestReport(testReportCompleted);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.problems).toEqual([]);
    expect(parsed.value.status).toBe("completed");
    expect(parsed.value.finish_reason).toBe("duration_elapsed");
    expect(parsed.value.test_flag_observed).toBe(true);
    expect(parsed.value.flags_seen).toContain("TEST");
    expect(parsed.value.deltas?.sample_count).toBe(25);
    expect(parsed.value.deltas?.metrics?.["battery_charge_percent"]?.delta).toBe(-7.5);
    expect(parsed.value.deltas?.metrics?.["battery_charge_percent"]?.ripple).toBe(7.5);
    expect(parsed.value.deltas?.metrics?.["load_percent"]?.delta).toBe(7);
    expect(parsed.value.estimate?.available).toBe(true);
    expect(parsed.value.estimate?.estimated_runtime_min).toBe(2.2);
    expect(parsed.value.estimate?.capped_at_min).toBe(600);
    expect(parsed.value.estimate?.confidence).toBe("low");
    // The normalized series (basis of the charts) is preserved without renaming anything.
    expect(parsed.value.samples?.[0]?.normalized?.["output_voltage_v"]).toBe(218);
    expect(parsed.value.samples?.[2]?.normalized?.["frequency_hz"]).toBe(59.7);
    expect(parsed.value.samples?.[2]?.offset_s).toBe(10.031);
  });

  it("reads the controlled discharge: 20 % target, 30 min cap and end at the target", () => {
    const parsed = parseBatteryTestReport(testReportDischarge);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.problems).toEqual([]);
    expect(parsed.value.type).toBe("discharge_20pct");
    expect(parsed.value.target_percent).toBe(20);
    expect(parsed.value.timeout_s).toBe(1800);
    expect(parsed.value.finish_reason).toBe("target_percent_reached");
    expect(parsed.value.deltas?.metrics?.["battery_charge_percent"]?.delta).toBe(-80);
    expect(parsed.value.deltas?.metrics?.["frequency_hz"]?.ripple).toBe(0.5);
    // The series covers the long window: X in seconds, not in ms.
    expect(parsed.value.samples?.[1]?.offset_s).toBe(246);
    expect(parsed.value.samples?.[1]?.normalized?.["battery_charge_percent"]).toBe(58);
  });

  it("reads the discharge acceptance preserving target and cap (without a fixed window)", () => {
    const parsed = parseBatteryTestAccept(testAcceptDischarge);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.type).toBe("discharge_20pct");
    expect(parsed.value.target_percent).toBe(20);
    expect(parsed.value.timeout_s).toBe(1800);
    expect(parsed.value.requested_duration_s).toBeUndefined();
  });

  it("preserves 'available: false' with the reason — never converts it to a number", () => {
    const parsed = parseBatteryTestReport(testReportEstimateUnavailable);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.estimate?.available).toBe(false);
    expect(parsed.value.estimate?.estimated_runtime_min).toBeUndefined();
    expect(parsed.value.estimate?.reason).toBe("charge drop below the measurable resolution");
    expect(parsed.value.test_flag_observed).toBe(false);
    expect(parsed.value.deltas?.metrics?.["battery_charge_percent"]?.delta).toBe(0);
  });

  it("rejects a report without the 'test' block", () => {
    const parsed = parseBatteryTestReport({ test_id: testId, status: "completed" });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(" ")).toContain("test");
  });

  it("reads the cancellation (202) preserving the 'aborting' state", () => {
    const parsed = parseBatteryTestAbort(testAbort);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.test_id).toBe(testId);
    expect(parsed.value.status).toBe("aborting");
  });

  it("reads the test history (without the sample series)", () => {
    const parsed = parseTestsList(testsListOk);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.problems).toEqual([]);
    expect(parsed.value.device_id).toBe(deviceId);
    expect(parsed.value.count).toBe(1);
    expect(parsed.value.tests[0]?.test_id).toBe(testId);
    expect(parsed.value.tests[0]?.status).toBe("completed");
    expect(parsed.value.tests[0]?.estimate?.estimated_runtime_min).toBe(2.2);
    expect(parsed.value.tests[0]).not.toHaveProperty("samples");
  });

  it("rejects a history without 'device_id'", () => {
    const parsed = parseTestsList({ api_version: "v1", contract_version: "3.0", tests: [] });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(" ")).toContain("device_id");
  });
});
