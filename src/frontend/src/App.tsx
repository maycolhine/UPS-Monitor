/**
 * Painel de leitura da telemetria de nobreaks.
 *
 * Composição em quatro quadrantes, ocupando exatamente a janela (sem rolagem de
 * página no desktop):
 *   superior esquerdo → contexto do equipamento (identificação, seleção dos
 *                       nobreaks e estado operacional logo abaixo da leitura);
 *   superior direito  → medições (gauges) em grade 2×3;
 *   inferior esquerdo → teste de bateria de ~10 s (previsão de autonomia);
 *   inferior direito  → detalhes, serviço consultado e estado da coleta.
 *
 * O quadrante superior esquerdo também lista os equipamentos descobertos em
 * `GET /api/v1/ups`: a lista é a navegação do painel e permite escolher, um de
 * cada vez, qual nobreak é exibido (`GET /api/dashboard?device_id=...`). Cada
 * item traz uma bolinha on/off com o estado de comunicação daquele equipamento.
 *
 * A leitura usa `GET /api/config` e `GET /api/dashboard`; a única escrita é o
 * pedido de teste de bateria (`POST /api/tests`), sempre por ação do usuário —
 * o Web Viewer nunca dispara um teste por conta própria.
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
 * Métricas cujo estado crítico pinta a bolinha de vermelho — o solicitante
 * pediu especificamente tensão de saída, frequência e carga do nobreak (e a
 * carga da bateria em nível crítico, que é a "bateria baixa" medida).
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
  // Sem seleção, o backend escolhe o equipamento (variável de ambiente, primeiro
  // válido ou primeiro da lista). A escolha do usuário sobrepõe essa decisão e é
  // enviada como `?device_id=` — um nobreak por vez, nunca os dois ao mesmo tempo.
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const { demo, loading, config, dashboard, fetchError, refreshIntervalMs } = useViewerData(
    DEMO_ENABLED,
    selectedDeviceId,
  );

  const viewer = dashboard?.viewer ?? null;
  const telemetry = dashboard?.telemetry ?? null;
  const identity = dashboard?.identity ?? null;

  // O `device_id` exibido é o que o backend confirmou ter servido (não o pedido).
  const deviceId = viewer?.device_id ?? config?.device_id ?? null;

  const deviceEntries = dashboard?.devices?.devices ?? [];

  // O contrato 3.0 publica `capabilities.battery_test` por equipamento: é isso
  // que decide se o botão do teste pode ser acionado.
  const selectedDevice = useMemo(
    () => deviceEntries.find((item) => item.device_id === deviceId) ?? null,
    [deviceEntries, deviceId],
  );
  const testSupport = readTestSupport(selectedDevice?.capabilities);
  const deviceLabel =
    describeDevice(selectedDevice?.brand, selectedDevice?.model) || deviceId || "equipamento";

  const testHistory = dashboard?.tests?.tests ?? [];
  // Um teste já em andamento (iniciado em outra aba ou antes de recarregar) é
  // apenas OBSERVADO; o hook nunca dispara um teste sozinho.
  const runningTestId = testHistory.find((item) => item.status === "running")?.test_id ?? null;
  const batteryTest = useBatteryTest(deviceId, runningTestId);

  const gauges = config?.gauges ?? [];
  const stale = telemetry?.stale === true;

  const gaugeModels = useMemo(
    () =>
      gauges.map((definition) => {
        // A origem é resolvida por payload: cada protocolo publica o mesmo dado em
        // um campo diferente (ex.: frequência de entrada × de saída).
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

  // Medição complementar (ex.: tensão da bateria) vem da própria origem escolhida,
  // com o rótulo e as unidades declarados nessa origem.
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
  // Os bits do quadro têm significado diferente por protocolo: a tabela de
  // tradução é escolhida pelo `data.source` informado pela API.
  const protocol = telemetry?.data?.source ?? null;
  const flagsAvailable = Boolean(status);
  const flags = buildFlagViews(status?.flags, status?.active, protocol);
  const unknownFlags = buildUnknownFlagViews(status?.flags, status?.active, protocol);

  // Leituras que resumem a bolinha do equipamento EM EXIBIÇÃO (a API só publica
  // telemetria do selecionado). Para os demais, a bolinha fica só com o estado
  // de comunicação — nada é inferido sem dado.
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
      <a className="skip-link" href="#conteudo">
        Ir para o conteúdo
      </a>

      <main id="conteudo" className="stage">
        {/* Quadrante 1 — contexto do equipamento e estado operacional */}
        <section className="q q--context" aria-label="Contexto do equipamento">
          <Header
            productName={config?.viewer.name ?? "UPS Monitor — Web Viewer"}
            lastTelemetryAtUtc={telemetry?.data?.captured_at_utc ?? null}
            refreshIntervalMs={refreshIntervalMs}
          >
            {discovered.length > 0 ? (
              <div className="devices">
                <p className="devices__label">Nobreaks coletados ({discovered.length})</p>
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
                            {active ? "Em exibição" : item.status.label}
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
              Consultando o serviço local do Web Viewer…
            </p>
          ) : null}

          {/* Estado operacional, logo abaixo das informações de leitura. */}
          <StatusFlags
            available={flagsAvailable}
            stale={stale}
            flags={flags}
            unknownFlags={unknownFlags}
            rawBits={status?.raw_bits ?? null}
          />
        </section>

        {/* Quadrante 2 — medições */}
        <section className="q q--gauges" aria-labelledby="medidores">
          <h2 id="medidores" className="q__title">
            Medições
          </h2>
          {gaugeModels.length === 0 ? (
            <p className="panel__empty">
              Nenhuma métrica configurada. Verifique `GET /api/config` no serviço do Web Viewer.
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

        {/* Quadrante 3 — teste de bateria de ~10 s */}
        <div className="q">
          <BatteryTest
            support={testSupport}
            deviceLabel={deviceLabel}
            state={batteryTest}
            history={testHistory}
          />
        </div>

        {/* Quadrante 4 — detalhes, serviço consultado e coleta */}
        <div className="q">
          <Details viewer={viewer} identity={identity} telemetry={telemetry} />
        </div>

        <footer className="stage__foot">
          Leitura por HTTP GET; a única escrita é o pedido de teste de bateria (POST /api/tests),
          sempre acionado por você. Quem executa o comando no nobreak é a API de telemetria. Faixas
          dos medidores configuráveis por VIEWER_GAUGE_THRESHOLDS.
        </footer>
      </main>
    </>
  );
}
