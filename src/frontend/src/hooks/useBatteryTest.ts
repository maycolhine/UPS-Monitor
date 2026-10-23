/**
 * Acompanhamento do teste de bateria (contrato 3.0).
 *
 * O `POST` é ASSÍNCRONO: o aceite (`202`) traz o `test_id` e o intervalo de
 * consulta, e a execução só começa no próximo ciclo do coletor (até 5 s). Por
 * isso o hook nunca trata a resposta do `POST` como resultado — ele acompanha o
 * relatório em `report_url` até um estado terminal.
 *
 * O tipo do teste (`duration_10s` ou `discharge_20pct`) é decidido pelo usuário
 * e restrito a `capabilities.battery_test.test_types`; o hook apenas o repassa.
 * Nada é disparado automaticamente: o teste só começa quando o usuário aciona o
 * botão. O polling apenas OBSERVA um teste já pedido.
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
/** Ritmo mínimo de consulta: evita martelar a API com o relatório de 25 amostras. */
const MIN_POLL_MS = 400;

export type BatteryTestPhase = "idle" | TestPhase;

export interface BatteryTestState {
  phase: BatteryTestPhase;
  /** Requisição de disparo/cancelamento em curso. */
  busy: boolean;
  testId: string | null;
  accept: BatteryTestAccept | null;
  report: BatteryTestReport | null;
  error: { code: string; message: string } | null;
  canAbort: boolean;
  /** `type` é o tipo publicado em `capabilities.battery_test.test_types`. */
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
  /** Teste que está sendo acompanhado agora (evita adoção duplicada). */
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
            // Estado terminal: o relatório está completo (ou cancelado/falhou).
            trackedRef.current = null;
            stopPolling();
            return;
          }
        } else if (result.error) {
          // Falha transitória de leitura não encerra o acompanhamento.
          setError(result.error);
        }

        pollRef.current.timer = window.setTimeout(() => void tick(), intervalMs);
      };

      void tick();
    },
    [deviceId, stopPolling],
  );

  // O teste é por equipamento: trocar de nobreak descarta o acompanhamento.
  useEffect(() => {
    stopPolling();
    trackedRef.current = null;
    setTestId(null);
    setAccept(null);
    setReport(null);
    setError(null);
  }, [deviceId, stopPolling]);

  // Um teste já em andamento (iniciado antes de recarregar a página) é adotado
  // pela lista publicada em `GET .../tests`, sem disparar nada.
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
        setError(result.error ?? { code: "unknown", message: "O pedido de teste não foi aceito." });
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
        setError(result.error ?? { code: "unknown", message: "O cancelamento não foi aceito." });
        return;
      }
      // O relatório passa a "aborted" preservando as amostras já coletadas.
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
