/**
 * Battery test tracking (contract 3.0).
 *
 * The `POST` is ASYNCHRONOUS: the acceptance (`202`) brings the `test_id` and
 * the polling interval, and the execution only starts on the next collector
 * cycle (up to 5 s). That is why the hook never treats the `POST` response as a
 * result — it follows the report at `report_url` until a terminal state.
 *
 * The test type (`duration_10s` or `discharge_20pct`) is decided by the user
 * and restricted to `capabilities.battery_test.test_types`; the hook only
 * forwards it. Nothing is triggered automatically: the test only starts when
 * the user presses the button. The polling only OBSERVES an already requested
 * test.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  abortBatteryTest,
  fetchBatteryTestReport,
  startBatteryTest,
} from "../api/client.js";
import { testPhase, type TestPhase } from "../model/batteryTest.js";
import type { BatteryTestAccept, BatteryTestReport } from "../model/contract.js";

const DEFAULT_POLL_MS = 500;
/** Minimum polling rate: avoids hammering the API with the 25-sample report. */
const MIN_POLL_MS = 400;

export type BatteryTestPhase = "idle" | TestPhase;

export interface BatteryTestState {
  phase: BatteryTestPhase;
  /** Start/cancel request in progress. */
  busy: boolean;
  testId: string | null;
  accept: BatteryTestAccept | null;
  report: BatteryTestReport | null;
  error: { code: string; message: string } | null;
  canAbort: boolean;
  /** `type` is the type published in `capabilities.battery_test.test_types`. */
  start: (type?: string) => void;
  abort: () => void;
}

interface PollRef {
  timer: number | null;
  controller: AbortController | null;
}

export function useBatteryTest(
  deviceId: string | null,
  runningTestId?: string | null,
): BatteryTestState {
  const [testId, setTestId] = useState<string | null>(null);
  const [accept, setAccept] = useState<BatteryTestAccept | null>(null);
  const [report, setReport] = useState<BatteryTestReport | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const pollRef = useRef<PollRef>({ timer: null, controller: null });
  /** Test currently being tracked (avoids duplicate adoption). */
  const trackedRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    const current = pollRef.current;
    if (current.timer !== null) {
      window.clearTimeout(current.timer);
      current.timer = null;
    }
    current.controller?.abort();
    current.controller = null;
  }, []);

  const poll = useCallback(
    (id: string, intervalMs: number) => {
      stopPolling();
      const controller = new AbortController();
      pollRef.current.controller = controller;

      const tick = async (): Promise<void> => {
        const result = await fetchBatteryTestReport(id, deviceId, controller.signal);
        if (controller.signal.aborted) return;

        if (result.data?.report) {
          const next = result.data.report;
          setReport(next);
          setError(null);
          if (next.status !== "running") {
            // Terminal state: the report is complete (or cancelled/failed).
            trackedRef.current = null;
            stopPolling();
            return;
          }
        } else if (result.error) {
          // A transient read failure does not end the tracking.
          setError(result.error);
        }

        pollRef.current.timer = window.setTimeout(() => void tick(), intervalMs);
      };

      void tick();
    },
    [deviceId, stopPolling],
  );

  // The test is per device: switching UPS discards the tracking.
  useEffect(() => {
    stopPolling();
    trackedRef.current = null;
    setTestId(null);
    setAccept(null);
    setReport(null);
    setError(null);
  }, [deviceId, stopPolling]);

  // A test already in progress (started before the page was reloaded) is
  // adopted from the list published by `GET .../tests`, without triggering
  // anything.
  useEffect(() => {
    if (trackedRef.current !== null || !runningTestId) return;
    trackedRef.current = runningTestId;
    setTestId(runningTestId);
    setError(null);
    poll(runningTestId, DEFAULT_POLL_MS);
  }, [runningTestId, poll]);

  useEffect(() => stopPolling, [stopPolling]);

  const start = useCallback((type?: string) => {
    setBusy(true);
    setError(null);
    setReport(null);
    setAccept(null);
    void startBatteryTest(deviceId, type).then((result) => {
      setBusy(false);
      if (!result.ok || !result.data) {
        setError(result.error ?? { code: "unknown", message: "The test request was not accepted." });
        return;
      }
      const accepted = result.data.accept;
      setAccept(accepted);
      setTestId(accepted.test_id);
      trackedRef.current = accepted.test_id;
      const reported = accepted.poll_interval_s;
      const intervalMs =
        typeof reported === "number" && Number.isFinite(reported)
          ? Math.max(MIN_POLL_MS, reported * 1000)
          : DEFAULT_POLL_MS;
      poll(accepted.test_id, intervalMs);
    });
  }, [deviceId, poll]);

  const abort = useCallback(() => {
    const id = trackedRef.current ?? testId;
    if (!id) return;
    setBusy(true);
    void abortBatteryTest(id, deviceId).then((result) => {
      setBusy(false);
      if (!result.ok || !result.data) {
        setError(result.error ?? { code: "unknown", message: "The cancellation was not accepted." });
        return;
      }
      // The report becomes "aborted", preserving the samples already collected.
      poll(id, DEFAULT_POLL_MS);
    });
  }, [deviceId, poll, testId]);

  const phase: BatteryTestPhase = report
    ? testPhase(report.status)
    : accept
      ? "running"
      : "idle";

  return {
    phase,
    busy,
    testId,
    accept,
    report,
    error,
    canAbort: phase === "running" && !busy,
    start,
    abort,
  };
}
