/**
 * UPS telemetry reading panel.
 *
 * Four-quadrant composition, filling exactly the window (no page scrolling on
 * the desktop):
 *   top left     → device context (identification, UPS selection and
 *                  operational state right below the reading);
 *   top right    → measurements (gauges) in a 2×3 grid;
 *   bottom left  → ~10 s battery test (runtime prediction);
 *   bottom right → details, consulted service and collection state.
 *
 * The top-left quadrant also lists the devices discovered in
 * `GET /api/v1/ups`: the list is the navigation of the panel and allows choosing,
 * one at a time, which UPS is displayed (`GET /api/dashboard?device_id=...`). Each
 * item carries an on/off dot with the communication state of that device.
 *
 * The reading uses `GET /api/config` and `GET /api/dashboard`; the only write is
 * the battery test request (`POST /api/tests`), always by user action — the Web
 * Viewer never triggers a test on its own.
 */
import { useMemo, useState } from "react";

import { BatteryTest } from "./components/BatteryTest.js";
import { Details } from "./components/Details.js";
import { GaugeCard, type GaugeCardSecondary } from "./components/GaugeCard.js";
import { Header } from "./components/Header.js";
import { Notices, buildNotices } from "./components/Notices.js";
import { StatusFlags } from "./components/StatusFlags.js";
import { useBatteryTest } from "./hooks/useBatteryTest.js";
import { useViewerData } from "./hooks/useViewerData.js";
import { readTestSupport } from "./model/batteryTest.js";
import { formatNumber } from "./model/format.js";
import {
  buildGaugeRenderModel,
  readMetricPath,
  resolveGaugeSource,
  type GaugeRenderModel,
} from "./model/metrics.js";
import {
  buildFlagViews,
  buildUnknownFlagViews,
  deviceStatusView,
  type DeviceStatusView,
} from "./model/status.js";

const DEMO_ENABLED = import.meta.env["VITE_ENABLE_DEMO"] === "true";

/**
 * Metrics whose critical state paints the dot red — the requester specifically
 * asked for output voltage, frequency and UPS load (and the battery charge at a
 * critical level, which is the measured "low battery").
 */
const CRITICAL_GAUGE_IDS = new Set([
  "output_voltage_v",
  "input_frequency_hz",
  "load_percent",
  "battery_charge_percent",
]);

interface DiscoveredDevice {
  id: string;
  label: string;
  status: DeviceStatusView;
}

function describeDevice(brand?: string | null, model?: string | null): string {
  return [brand, model]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
}

export function App() {
  // Without a selection, the backend chooses the device (environment variable,
  // first valid or first in the list). The user's choice overrides this decision
  // and is sent as `?device_id=` — one UPS at a time, never both at once.
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const { demo, loading, config, dashboard, fetchError, refreshIntervalMs } = useViewerData(
    DEMO_ENABLED,
    selectedDeviceId,
  );

  const viewer = dashboard?.viewer ?? null;
  const telemetry = dashboard?.telemetry ?? null;
  const identity = dashboard?.identity ?? null;

  // The displayed `device_id` is the one the backend confirmed it served (not the request).
  const deviceId = viewer?.device_id ?? config?.device_id ?? null;

  const deviceEntries = dashboard?.devices?.devices ?? [];

  // Contract 3.0 publishes `capabilities.battery_test` per device: this is what
  // decides whether the test button can be triggered.
  const selectedDevice = useMemo(
    () => deviceEntries.find((item) => item.device_id === deviceId) ?? null,
    [deviceEntries, deviceId],
  );
  const testSupport = readTestSupport(selectedDevice?.capabilities);
  const deviceLabel =
    describeDevice(selectedDevice?.brand, selectedDevice?.model) || deviceId || "device";

  const testHistory = dashboard?.tests?.tests ?? [];
  // A test already in progress (started in another tab or before reloading) is
  // only OBSERVED; the hook never triggers a test by itself.
  const runningTestId = testHistory.find((item) => item.status === "running")?.test_id ?? null;
  const batteryTest = useBatteryTest(deviceId, runningTestId);

  const gauges = config?.gauges ?? [];
  const stale = telemetry?.stale === true;

  const gaugeModels = useMemo(
    () =>
      gauges.map((definition) => {
        // The source is resolved per payload: each protocol publishes the same
        // data in a different field (e.g., input × output frequency).
        const resolved = resolveGaugeSource(definition, telemetry);
        return buildGaugeRenderModel({
          definition,
          value: resolved.value,
          stale,
          source: resolved.source,
        });
      }),
    [gauges, telemetry, stale],
  );

  // Complementary measurement (e.g., battery voltage) comes from the chosen
  // source itself, with the label and units declared on that source.
  const secondaryFor = (model: GaugeRenderModel): GaugeCardSecondary | undefined => {
    const secondary = model.source?.secondary;
    if (!secondary) return undefined;
    const raw = readMetricPath(telemetry, secondary.path);
    return {
      label: secondary.label,
      value: raw === null || raw === undefined ? "—" : `${formatNumber(raw, secondary.decimals)} ${secondary.unit}`,
    };
  };

  const status = telemetry?.data?.status;
  // The frame bits mean different things per protocol: the translation table is
  // chosen by the `data.source` reported by the API.
  const protocol = telemetry?.data?.source ?? null;
  const flagsAvailable = Boolean(status);
  const flags = buildFlagViews(status?.flags, status?.active, protocol);
  const unknownFlags = buildUnknownFlagViews(status?.flags, status?.active, protocol);

  // Readings that summarize the dot of the device CURRENTLY DISPLAYED (the API
  // only publishes telemetry for the selected one). For the others, the dot keeps
  // only the communication state — nothing is inferred without data.
  const statusSignals = useMemo(() => {
    const activeSet = new Set(status?.active ?? []);
    const flagActive = (id: string): boolean => {
      const declared = status?.flags?.[id];
      return typeof declared === "boolean" ? declared : activeSet.has(id);
    };
    return {
      testRunning: batteryTest.phase === "running" || flagActive("TEST"),
      onBattery: flagActive("OB"),
      batteryLow: flagActive("LB") || flagActive("FAULT"),
      criticalMetric: gaugeModels.some(
        (model) => CRITICAL_GAUGE_IDS.has(model.definition.id) && model.level === "critical",
      ),
      warningSignal: gaugeModels.some((model) => model.level === "warning"),
    };
  }, [status, gaugeModels, batteryTest.phase]);

  const hasTelemetry = telemetry !== null && telemetry.data_available !== false;

  const discovered = useMemo<DiscoveredDevice[]>(
    () =>
      deviceEntries.map((item) => {
        const selected = item.device_id === deviceId;
        const deviceStatus = deviceStatusView(
          selected ? { ...item, hasTelemetry, ...statusSignals } : { ...item },
        );
        return {
          id: item.device_id,
          label: describeDevice(item.brand, item.model) || item.device_id,
          status: deviceStatus,
        };
      }),
    [deviceEntries, deviceId, hasTelemetry, statusSignals],
  );

  const notices = buildNotices({
    demo,
    fetchError,
    dashboard,
    thresholdProblems: config?.threshold_problems ?? [],
  });

  const waitingFirstResponse = loading && dashboard === null && fetchError === null;

  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      <main id="content" className="stage">
        {/* Quadrant 1 — device context and operational state */}
        <section className="q q--context" aria-label="Device context">
          <Header
            productName={config?.viewer.name ?? "UPS Monitor — Web Viewer"}
            lastTelemetryAtUtc={telemetry?.data?.captured_at_utc ?? null}
            refreshIntervalMs={refreshIntervalMs}
          >
            {discovered.length > 0 ? (
              <div className="devices">
                <p className="devices__label">Collected UPS units ({discovered.length})</p>
                <ul className="devices__list">
                  {discovered.map((item) => {
                    const active = item.id === deviceId;
                    return (
                      <li key={item.id} className={active ? "device device--on" : "device"}>
                        <button
                          type="button"
                          className="device__button"
                          aria-current={active ? "true" : undefined}
                          onClick={() => setSelectedDeviceId(item.id)}
                        >
                          <span className="device__name">{item.label}</span>
                          <span className="device__id">{item.id}</span>
                          <span className={`device__tag device__tag--${item.status.level}`}>
                            {active ? "Displayed" : item.status.label}
                          </span>
                        </button>
                        <span
                          className={`device__conn device__conn--${item.status.level}`}
                          role="img"
                          aria-label={`${item.label}: ${item.status.label} — ${item.status.description}`}
                          title={`${item.status.label}: ${item.status.description}`}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </Header>

          <Notices notices={notices} />

          {waitingFirstResponse ? (
            <p className="loading" role="status">
              Querying the local Web Viewer service…
            </p>
          ) : null}

          {/* Operational state, right below the reading information. */}
          <StatusFlags
            available={flagsAvailable}
            stale={stale}
            flags={flags}
            unknownFlags={unknownFlags}
            rawBits={status?.raw_bits ?? null}
          />
        </section>

        {/* Quadrant 2 — measurements */}
        <section className="q q--gauges" aria-labelledby="gauges">
          <h2 id="gauges" className="q__title">
            Measurements
          </h2>
          {gaugeModels.length === 0 ? (
            <p className="panel__empty">
              No metrics configured. Check `GET /api/config` on the Web Viewer service.
            </p>
          ) : (
            <div className="gauge-grid">
              {gaugeModels.map((model) => (
                <GaugeCard
                  key={model.definition.id}
                  model={model}
                  secondary={secondaryFor(model)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Quadrant 3 — ~10 s battery test */}
        <div className="q">
          <BatteryTest
            support={testSupport}
            deviceLabel={deviceLabel}
            state={batteryTest}
            history={testHistory}
          />
        </div>

        {/* Quadrant 4 — details, consulted service and collection */}
        <div className="q">
          <Details viewer={viewer} identity={identity} telemetry={telemetry} />
        </div>

        <footer className="stage__foot">
          Read-only over HTTP GET; the only write is the battery test request (POST /api/tests),
          always triggered by you. The telemetry API executes the command on the UPS. Gauge ranges
          are configurable via VIEWER_GAUGE_THRESHOLDS.
        </footer>
      </main>
    </>
  );
}
