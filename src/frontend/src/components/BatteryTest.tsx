/**
 * Quadrante de Teste de Bateria (contrato 3.0).
 *
 * Três blocos, conforme a doc do quadrante:
 *  A. controle — seleção do tipo, iniciar e cancelar, com o estado corrente;
 *  B. gráficos — a linha do tempo (`samples[].normalized`) das quatro métricas,
 *     com blocos selecionáveis na barra lateral (`BatteryTestCharts`);
 *  C. resumo — `deltas`/`estimate` e o motivo do encerramento.
 *
 * O tipo do teste vem de `capabilities.battery_test.test_types`: `duration_10s`
 * (janela de ~10 s) é oferecido a todos os equipamentos com teste, enquanto
 * `discharge_20pct` (descarga até 20 % ou o teto de 30 min, o que vier primeiro)
 * só aparece onde a própria API o declara — oferecer fora da lista só geraria
 * `422 unsupported_test_type`.
 *
 * O botão apenas PEDE o teste: quem executa o comando no nobreak é a API de
 * origem, e o relatório é acompanhado por polling. Nada é disparado sozinho.
 *
 * A apresentação segue a regra de ouro da doc de integração (§11.5): a API
 * entrega os fatos; quando `estimate.available` é falso, exibimos o `reason`, e
 * o selo de estimativa nunca é apresentado como medição.
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
  /** Rótulo do equipamento exibido (marca/modelo), para o texto do botão. */
  deviceLabel: string;
  state: BatteryTestState;
  /** Histórico recente do equipamento (`GET .../tests?limit=N`). */
  history: BatteryTestListItem[];
}

const HISTORY_LIMIT = 3;

export function BatteryTest({ support, deviceLabel, state, history }: BatteryTestProps) {
  const { phase, busy, accept, report, error, canAbort, start, abort } = state;

  // Relógio local apenas para a barra de progresso enquanto o teste corre.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "running") return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [phase]);

  // A escolha do tipo é derivada da lista publicada: se o equipamento mudar (ou
  // o tipo pedido deixar de existir), o seletor volta sozinho à primeira opção.
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
      ? `${Math.round(durationS / sampleIntervalS)} amostras`
      : null;

  const historyRows = buildHistoryRows(history, formatLocalDateTime).filter(
    (row) => row.testId !== report?.test_id,
  );

  const startLabel = activeType?.isTarget ? "Iniciar descarga controlada" : "Testar bateria (10 s)";

  return (
    <section className="panel battery-test" aria-labelledby="teste-bateria">
      <div className="battery-test__head">
        <h2 id="teste-bateria" className="panel__title">
          Teste de bateria
        </h2>
        <div className="battery-test__actions">
          {activeType && typeOptions.length > 1 ? (
            <label className="battery-test__type">
              <span className="visually-hidden">Tipo de teste</span>
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
              Cancelar
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={() => start(activeType?.type)}
            disabled={!startable || busy || phase === "running" || activeType === null}
          >
            {phase === "running" ? "Testando…" : startLabel}
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
            ? "O teste de bateria não está habilitado neste equipamento (capabilities.battery_test.enabled = false). A API recusaria o pedido com 403."
            : "Este equipamento não declara suporte ao teste de bateria (capabilities.battery_test)."}
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
            aria-label="Andamento do teste de bateria"
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
              <span className="battery-test__card-label">Situação do teste</span>
              <strong className={`battery-test__chip battery-test__chip--${phase}`}>
                {describeTestStatus(report.status)}
              </strong>
              <span className="battery-test__card-line">
                {describeFinishReason(report.finish_reason ?? null)}
              </span>
              <span className="battery-test__card-line">
                {report.duration_s == null
                  ? `${formatNumber(report.deltas?.sample_count, 0)} amostras`
                  : `${formatNumber(report.duration_s, 1)} s · ${formatNumber(
                      report.deltas?.sample_count,
                      0,
                    )} amostras`}
              </span>
            </div>

            <div className="battery-test__card">
              <span className="battery-test__card-label">Previsão de autonomia da bateria</span>
              <strong className="battery-test__estimate">{estimate?.runtimeText}</strong>
              <span className="battery-test__card-line">
                Taxa de descarga: {estimate?.dischargeRateText} · Queda: {estimate?.dropText}
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
          <span className="battery-test__card-label">O que o teste devolve</span>
          <ul>
            <li>
              Gráficos da linha do tempo (tensão de saída, frequência, temperatura interna e carga da
              bateria) — um bloco por métrica na barra lateral.
            </li>
            <li>Queda de carga da bateria e oscilação de tensão e frequência na janela.</li>
            <li>
              Autonomia estimada para uma queda real — extrapolação linear de 1ª ordem, marcada como
              estimativa.
            </li>
            <li>Confirmação de que o equipamento reportou o estado de teste (flag TEST).</li>
            <li>
              No teste de descarga, o fim é a carga chegar ao alvo ou o teto de tempo — o que vier
              primeiro.
            </li>
          </ul>
          <p className="battery-test__card-line">
            Nenhum teste é executado automaticamente: o comando só é enviado ao acionar o botão.
          </p>
        </div>
      )}

      {historyRows.length > 0 ? (
        <>
          <span className="battery-test__section-label">Testes anteriores</span>
          <table className="battery-test__table">
            <caption className="visually-hidden">
              Últimos testes de bateria registrados neste equipamento
            </caption>
            <thead>
              <tr>
                <th scope="col">Início</th>
                <th scope="col">Tipo</th>
                <th scope="col">Situação</th>
                <th scope="col">Autonomia estimada</th>
                <th scope="col">Flag TEST</th>
              </tr>
            </thead>
            <tbody>
              {historyRows.slice(0, HISTORY_LIMIT).map((row) => (
                <tr key={row.testId}>
                  <td>{row.startedText}</td>
                  <td>{row.typeText}</td>
                  <td>{row.statusText}</td>
                  <td>{row.runtimeText}</td>
                  <td>{row.observedTestFlag ? "observada" : MISSING_TEXT}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
