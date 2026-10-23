/**
 * Details area: nominal identification of the device, collection state, data
 * age, last communication error, the telemetry service consumed (address and
 * contract) and the result of each query made to the API.
 *
 * The information on "consumed contract", "data age" and "telemetry API" lives
 * here (fourth quadrant), no longer in the header.
 */
import { formatAge, formatLocalDateTime, formatNumber, formatText } from "../model/format.js";
import type {
  DashboardPayload,
  IdentityPayload,
  TelemetryPayload,
  ViewerSection,
} from "../model/contract.js";
import { communicationStateForDetails } from "../model/status.js";

export interface DetailsProps {
  viewer: ViewerSection | null;
  identity: IdentityPayload | null;
  telemetry: TelemetryPayload | null;
}

interface SourceRow {
  key: string;
  label: string;
  state: DashboardPayload["viewer"]["sources"]["health"];
}

function buildSourceRows(viewer: ViewerSection | null): SourceRow[] {
  if (!viewer) return [];
  const { health, devices, telemetry, identity, tests } = viewer.sources;
  return [
    { key: "health", label: "GET /health", state: health },
    { key: "devices", label: "GET /api/v1/ups", state: devices },
    { key: "telemetry", label: "GET .../telemetry", state: telemetry },
    { key: "identity", label: "GET .../identity", state: identity },
    { key: "tests", label: "GET .../tests", state: tests },
  ];
}

export function Details({ viewer, identity, telemetry }: DetailsProps) {
  const device = identity?.data?.device;
  const nominal = identity?.data?.nominal;
  const measurements = telemetry?.data?.measurements ?? null;
  const batteryVoltage = measurements?.["battery_voltage_v"];
  const lastError = telemetry?.communication.last_error ?? null;
  const age = telemetry?.communication.age_seconds ?? telemetry?.data?.age_seconds ?? null;
  const identityAvailable = identity?.identity_available === true;
  const contract = viewer?.upstream_contract ?? null;
  const upstreamBaseUrl = viewer?.upstream.base_url ?? null;

  return (
    <section className="panel" aria-labelledby="details">
      <h2 id="details" className="panel__title">
        Details and collection state
      </h2>

      <div className="details-grid">
        <div className="details-block">
          <h3>Device identification</h3>
          {identityAvailable ? (
            <dl className="kv">
              <div>
                <dt>Manufacturer</dt>
                <dd>{formatText(device?.manufacturer)}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{formatText(device?.model)}</dd>
              </div>
              <div>
                <dt>Firmware</dt>
                <dd>{formatText(device?.firmware)}</dd>
              </div>
              <div>
                <dt>Nominal voltage</dt>
                <dd>{formatText(nominal?.voltage_label)}</dd>
              </div>
              <div>
                <dt>Nominal input current</dt>
                <dd>{nominal?.input_current_a == null ? "—" : `${formatNumber(nominal.input_current_a, 0)} A`}</dd>
              </div>
              <div>
                <dt>Nominal frequency</dt>
                <dd>{nominal?.frequency_hz == null ? "—" : `${formatNumber(nominal.frequency_hz, 0)} Hz`}</dd>
              </div>
            </dl>
          ) : (
            <p className="panel__empty">
              The API did not provide the device identification in this query.
            </p>
          )}
        </div>

        <div className="details-block">
          <h3>Collection and communication</h3>
          <dl className="kv">
            <div>
              <dt>Battery voltage (measurement)</dt>
              <dd>{batteryVoltage == null ? "—" : `${formatNumber(batteryVoltage, 1)} V`}</dd>
            </div>
            <div>
              <dt>Collection state</dt>
              <dd>{communicationStateForDetails(telemetry?.communication)}</dd>
            </div>
            <div>
              <dt>Data age</dt>
              <dd>{formatAge(age)}</dd>
            </div>
            <div>
              <dt>Reading captured at</dt>
              <dd>{formatLocalDateTime(telemetry?.data?.captured_at_utc ?? null)}</dd>
            </div>
            <div>
              <dt>Valid telemetry</dt>
              <dd>
                {telemetry ? (telemetry.telemetry_valid ? "Yes" : "No") : "—"}
                {telemetry?.stale ? " (stale)" : ""}
              </dd>
            </div>
            <div>
              <dt>Frame source</dt>
              <dd>{formatText(telemetry?.data?.source)}</dd>
            </div>
            <div>
              <dt>Raw frame (Q1)</dt>
              <dd className="kv__mono">{formatText(telemetry?.data?.raw_frame)}</dd>
            </div>
          </dl>

          {lastError ? (
            <p className="panel__warning">
              Last communication error: {formatText(lastError.message ?? lastError.code)} (
              {formatLocalDateTime(lastError.at_utc ?? null)})
            </p>
          ) : null}
        </div>

        <div className="details-block">
          <h3>Telemetry service and queries</h3>

          <dl className="kv kv--tight">
            <div>
              <dt>Telemetry API</dt>
              <dd className="kv__mono">{formatText(upstreamBaseUrl)}</dd>
            </div>
            <div>
              <dt>Consumed contract</dt>
              <dd>
                {contract
                  ? `api_version ${contract.api_version} · contract_version ${contract.contract_version}`
                  : "—"}
              </dd>
            </div>
          </dl>

          {viewer ? (
            <table className="sources">
              <caption className="visually-hidden">
                Result of each HTTP query made by the Web Viewer to the API
              </caption>
              <thead>
                <tr>
                  <th scope="col">Query</th>
                  <th scope="col">Result</th>
                  <th scope="col">HTTP</th>
                  <th scope="col">Duration</th>
                </tr>
              </thead>
              <tbody>
                {buildSourceRows(viewer).map((row) => (
                  <tr key={row.key}>
                    <td className="sources__path">{row.label}</td>
                    <td>
                      {row.state.ok ? "ok" : (row.state.error?.code ?? "failure")}
                    </td>
                    <td>{row.state.http_status ?? "—"}</td>
                    <td>{row.state.duration_ms == null ? "—" : `${row.state.duration_ms} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="panel__empty">No query information.</p>
          )}

          {viewer && viewer.warnings.length > 0 ? (
            <ul className="warnings">
              {viewer.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}

