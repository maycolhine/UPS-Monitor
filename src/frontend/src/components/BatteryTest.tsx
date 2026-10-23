/**
 * Battery Test quadrant (contract 3.0).
 *
 * Three blocks, per the quadrant doc:
 *  A. control — type selection, start and cancel, with the current state;
 *  B. charts — the timeline (`samples[].normalized`) of the four metrics,
 *     with selectable blocks in the side bar (`BatteryTestCharts`);
 *  C. summary — `deltas`/`estimate` and the reason for termination.
 *
 * The test type comes from `capabilities.battery_test.test_types`: `duration_10s`
 * (window of ~10 s) is offered to every device with a test, while
 * `discharge_20pct` (discharge to 20 % or the 30 min ceiling, whichever comes
 * first) only appears where the API itself declares it — offering it outside
 * the list would only produce `422 unsupported_test_type`.
 *
 * The button only REQUESTS the test: the origin API is the one that runs the
 * command on the UPS, and the report is followed by polling. Nothing is
 * triggered on its own.
 *
 * The presentation follows the golden rule of the integration doc (§11.5): the
 * API delivers the facts; when `estimate.available` is false, we display the
 * `reason`, and the estimate badge is never presented as a measurement.
 */
import { useEffect, useState } from "react";

import type { BatteryTestState } from "../hooks/useBatteryTest.js";
import {
  buildEstimateView,
  buildHistoryRows,
  buildTestChartModels,
  buildTestGuards,
  buildTestProgress,
  buildTestTypeOptions,
  describeFinishReason,
  describeTestError,
  describeTestStatus,
  describeTestTypeParams,
  type BatteryTestSupport,
} from "../model/batteryTest.js";
import { formatLocalDateTime, formatNumber, MISSING_TEXT } from "../model/format.js";
import type { BatteryTestListItem } from "../model/contract.js";
import { BatteryTestCharts } from "./BatteryTestCharts.js";

export interface BatteryTestProps {
  support: BatteryTestSupport;
  /** Displayed device label (brand/model), for the button text. */
  deviceLabel: string;
  state: BatteryTestState;
  /** Recent history of the device (`GET .../tests?limit=N`). */
  history: BatteryTestListItem[];
}

const HISTORY_LIMIT = 3;

export function BatteryTest({ support, deviceLabel, state, history }: BatteryTestProps) {
  const { phase, busy, accept, report, error, canAbort, start, abort } = state;

  // Local clock only for the progress bar while the test is running.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "running") return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [phase]);

  // The type choice is derived from the published list: if the device changes
  // (or the requested type no longer exists), the selector falls back on its own
  // to the first option.
  const [requestedType, setRequestedType] = useState<string>("");
  const typeOptions = buildTestTypeOptions(support);
  const activeType = typeOptions.find((option) => option.type === requestedType) ?? typeOptions[0] ?? null;

  const guards = buildTestGuards(support);
  const estimate = report ? buildEstimateView(report.estimate) : null;
  const charts = report ? buildTestChartModels(report) : [];
  const progress = buildTestProgress(report ?? accept, nowMs);

  const startable = support.supported && support.enabled;
  const durationS = activeType?.params?.duration_s ?? support.durationS;
  const sampleIntervalS = activeType?.params?.sample_interval_s ?? support.sampleIntervalS;
  const sampleLabel =
    durationS !== null && typeof sampleIntervalS === "number" && sampleIntervalS > 0
      ? `${Math.round(durationS / sampleIntervalS)} samples`
      : null;

  const historyRows = buildHistoryRows(history, formatLocalDateTime).filter(
    (row) => row.testId !== report?.test_id,
  );

  const startLabel = activeType?.isTarget ? "Start controlled discharge" : "Test battery (10 s)";

  return (
    <section className="panel battery-test" aria-labelledby="battery-test">
      <div className="battery-test__head">
        <h2 id="battery-test" className="panel__title">
          Battery test
        </h2>
        <div className="battery-test__actions">
          {activeType && typeOptions.length > 1 ? (
            <label className="battery-test__type">
              <span className="visually-hidden">Test type</span>
              <select
                value={activeType.type}
                onChange={(event) => setRequestedType(event.target.value)}
                disabled={phase === "running" || busy}
              >
                {typeOptions.map((option) => (
                  <option key={option.type} value={option.type}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {canAbort && support.abortSupported ? (
            <button type="button" className="btn btn--ghost" onClick={abort} disabled={busy}>
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={() => start(activeType?.type)}
            disabled={!startable || busy || phase === "running" || activeType === null}
          >
            {phase === "running" ? "Testing…" : startLabel}
          </button>
        </div>
      </div>

      <p className="battery-test__meta">
        {describeTestTypeParams(activeType)}
        {sampleLabel ? ` · ${sampleLabel}` : ""} · {deviceLabel}
      </p>

      {!startable ? (
        <p className="panel__empty">
          {support.supported
            ? "The battery test is not enabled on this device (capabilities.battery_test.enabled = false). The API would reject the request with 403."
            : "This device does not declare support for the battery test (capabilities.battery_test)."}
        </p>
      ) : null}

      {guards.length > 0 ? (
        <ul className="battery-test__guards">
          {guards.map((guard) => (
            <li key={guard}>{guard}</li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="panel__warning" role="status">
          {describeTestError(error)}
        </p>
      ) : null}

      {progress ? (
        <div className="battery-test__progress">
          <div
            className="battery-test__bar"
            role="progressbar"
            aria-label="Battery test progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.fraction === null ? undefined : Math.round(progress.fraction * 100)}
          >
            <span
              className={progress.fraction === null ? "battery-test__bar-fill--pending" : undefined}
              style={{ width: progress.fraction === null ? "100%" : `${Math.round(progress.fraction * 100)}%` }}
            />
          </div>
          <span className="battery-test__progress-text">{progress.text}</span>
        </div>
      ) : null}

      {report ? (
        <>
          {charts.length > 0 ? <BatteryTestCharts models={charts} /> : null}

          <div className="battery-test__grid">
            <div className="battery-test__card">
              <span className="battery-test__card-label">Test status</span>
              <strong className={`battery-test__chip battery-test__chip--${phase}`}>
                {describeTestStatus(report.status)}
              </strong>
              <span className="battery-test__card-line">
                {describeFinishReason(report.finish_reason ?? null)}
              </span>
              <span className="battery-test__card-line">
                {report.duration_s == null
                  ? `${formatNumber(report.deltas?.sample_count, 0)} samples`
                  : `${formatNumber(report.duration_s, 1)} s · ${formatNumber(
                      report.deltas?.sample_count,
                      0,
                    )} samples`}
              </span>
            </div>

            <div className="battery-test__card">
              <span className="battery-test__card-label">Battery runtime projection</span>
              <strong className="battery-test__estimate">{estimate?.runtimeText}</strong>
              <span className="battery-test__card-line">
                Discharge rate: {estimate?.dischargeRateText} · Drop: {estimate?.dropText}
              </span>
            </div>
          </div>

          {report.error ? (
            <p className="panel__warning" role="status">
              {describeTestError(report.error)}
            </p>
          ) : null}
        </>
      ) : (
        <div className="battery-test__idle">
          <span className="battery-test__card-label">What the test returns</span>
          <ul>
            <li>
              Timeline charts (output voltage, frequency, internal temperature and battery charge) —
              one block per metric in the side bar.
            </li>
            <li>Battery charge drop and voltage and frequency oscillation within the window.</li>
            <li>
              Estimated runtime for a real drop — first-order linear extrapolation, flagged as an
              estimate.
            </li>
            <li>Confirmation that the device reported the test state (TEST flag).</li>
            <li>
              In the discharge test, the end is the charge reaching the target or the time ceiling —
              whichever comes first.
            </li>
          </ul>
          <p className="battery-test__card-line">
            No test runs automatically: the command is only sent when the button is pressed.
          </p>
        </div>
      )}

      {historyRows.length > 0 ? (
        <>
          <span className="battery-test__section-label">Previous tests</span>
          <table className="battery-test__table">
            <caption className="visually-hidden">
              Latest battery tests recorded on this device
            </caption>
            <thead>
              <tr>
                <th scope="col">Start</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Estimated runtime</th>
                <th scope="col">TEST flag</th>
              </tr>
            </thead>
            <tbody>
              {historyRows.slice(0, HISTORY_LIMIT).map((row) => (
                <tr key={row.testId}>
                  <td>{row.startedText}</td>
                  <td>{row.typeText}</td>
                  <td>{row.statusText}</td>
                  <td>{row.runtimeText}</td>
                  <td>{row.observedTestFlag ? "observed" : MISSING_TEXT}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
