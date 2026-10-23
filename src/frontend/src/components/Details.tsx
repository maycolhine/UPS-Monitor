/**
 * Área de detalhes: identificação nominal do equipamento, estado da coleta,
 * idade dos dados, último erro de comunicação, o serviço de telemetria
 * consumido (endereço e contrato) e o resultado de cada consulta feita à API.
 *
 * As informações de "contrato consumido", "idade dos dados" e "API de
 * telemetria" ficam aqui (quarto quadrante), não mais no cabeçalho.
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
    <section className="panel" aria-labelledby="detalhes">
      <h2 id="detalhes" className="panel__title">
        Detalhes e estado da coleta
      </h2>

      <div className="details-grid">
        <div className="details-block">
          <h3>Identificação do equipamento</h3>
          {identityAvailable ? (
            <dl className="kv">
              <div>
                <dt>Fabricante</dt>
                <dd>{formatText(device?.manufacturer)}</dd>
              </div>
              <div>
                <dt>Modelo</dt>
                <dd>{formatText(device?.model)}</dd>
              </div>
              <div>
                <dt>Firmware</dt>
                <dd>{formatText(device?.firmware)}</dd>
              </div>
              <div>
                <dt>Tensão nominal</dt>
                <dd>{formatText(nominal?.voltage_label)}</dd>
              </div>
              <div>
                <dt>Corrente de entrada nominal</dt>
                <dd>{nominal?.input_current_a == null ? "—" : `${formatNumber(nominal.input_current_a, 0)} A`}</dd>
              </div>
              <div>
                <dt>Frequência nominal</dt>
                <dd>{nominal?.frequency_hz == null ? "—" : `${formatNumber(nominal.frequency_hz, 0)} Hz`}</dd>
              </div>
            </dl>
          ) : (
            <p className="panel__empty">
              A API não disponibilizou a identificação do equipamento nesta consulta.
            </p>
          )}
        </div>

        <div className="details-block">
          <h3>Coleta e comunicação</h3>
          <dl className="kv">
            <div>
              <dt>Tensão da bateria (medição)</dt>
              <dd>{batteryVoltage == null ? "—" : `${formatNumber(batteryVoltage, 1)} V`}</dd>
            </div>
            <div>
              <dt>Estado da coleta</dt>
              <dd>{communicationStateForDetails(telemetry?.communication)}</dd>
            </div>
            <div>
              <dt>Idade dos dados</dt>
              <dd>{formatAge(age)}</dd>
            </div>
            <div>
              <dt>Leitura capturada em</dt>
              <dd>{formatLocalDateTime(telemetry?.data?.captured_at_utc ?? null)}</dd>
            </div>
            <div>
              <dt>Telemetria válida</dt>
              <dd>
                {telemetry ? (telemetry.telemetry_valid ? "Sim" : "Não") : "—"}
                {telemetry?.stale ? " (desatualizada)" : ""}
              </dd>
            </div>
            <div>
              <dt>Fonte do quadro</dt>
              <dd>{formatText(telemetry?.data?.source)}</dd>
            </div>
            <div>
              <dt>Quadro bruto (Q1)</dt>
              <dd className="kv__mono">{formatText(telemetry?.data?.raw_frame)}</dd>
            </div>
          </dl>

          {lastError ? (
            <p className="panel__warning">
              Último erro de comunicação: {formatText(lastError.message ?? lastError.code)} (
              {formatLocalDateTime(lastError.at_utc ?? null)})
            </p>
          ) : null}
        </div>

        <div className="details-block">
          <h3>Serviço de telemetria e consultas</h3>

          <dl className="kv kv--tight">
            <div>
              <dt>API de telemetria</dt>
              <dd className="kv__mono">{formatText(upstreamBaseUrl)}</dd>
            </div>
            <div>
              <dt>Contrato consumido</dt>
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
                Resultado de cada consulta HTTP feita pelo Web Viewer à API
              </caption>
              <thead>
                <tr>
                  <th scope="col">Consulta</th>
                  <th scope="col">Resultado</th>
                  <th scope="col">HTTP</th>
                  <th scope="col">Duração</th>
                </tr>
              </thead>
              <tbody>
                {buildSourceRows(viewer).map((row) => (
                  <tr key={row.key}>
                    <td className="sources__path">{row.label}</td>
                    <td>
                      {row.state.ok ? "ok" : (row.state.error?.code ?? "falha")}
                    </td>
                    <td>{row.state.http_status ?? "—"}</td>
                    <td>{row.state.duration_ms == null ? "—" : `${row.state.duration_ms} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="panel__empty">Sem informação de consulta.</p>
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

