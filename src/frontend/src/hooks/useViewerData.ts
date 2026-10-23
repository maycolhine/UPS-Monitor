/**
 * Hook de atualização periódica.
 *
 * Dois efeitos independentes:
 *  1. `GET /api/config` — lido uma vez (definição dos gauges e intervalo).
 *  2. `GET /api/dashboard` — lido em ciclo, sempre DEPOIS de terminar o
 *     anterior (sem sobreposição de requisições). O ciclo reinicia quando o
 *     intervalo muda OU quando o usuário troca de nobreak (`deviceId`).
 *
 * Nada é inferido aqui: o hook só transporta o que o backend informou.
 */
import { useEffect, useMemo, useState } from "react";

import { fetchConfig, fetchDashboard, isViewerLevelFailure } from "../api/client.js";
import { DEMO_CONFIG, DEMO_DASHBOARD } from "../demo/fixture.js";
import type { DashboardPayload, ViewerConfigPayload } from "../model/contract.js";

const DEFAULT_REFRESH_INTERVAL_MS = 5000;

export interface ViewerDataState {
  demo: boolean;
  loading: boolean;
  config: ViewerConfigPayload | null;
  dashboard: DashboardPayload | null;
  /** Instante (ms) em que o dashboard foi recebido pela última vez. */
  lastFetchAtMs: number | null;
  /** Falha do próprio Web Viewer (não da API de telemetria). */
  fetchError: { code: string; message: string } | null;
  refreshIntervalMs: number;
}

export function useViewerData(demoEnabled: boolean, deviceId?: string | null): ViewerDataState {
  const [config, setConfig] = useState<ViewerConfigPayload | null>(demoEnabled ? DEMO_CONFIG : null);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(
    demoEnabled ? DEMO_DASHBOARD : null,
  );
  const [loading, setLoading] = useState(!demoEnabled);
  const [lastFetchAtMs, setLastFetchAtMs] = useState<number | null>(
    demoEnabled ? Date.now() : null,
  );
  const [fetchError, setFetchError] = useState<{ code: string; message: string } | null>(null);

  const intervalMs = useMemo(() => {
    if (demoEnabled) return DEMO_CONFIG.viewer.refresh_interval_ms;
    const configured = config?.viewer.refresh_interval_ms ?? DEFAULT_REFRESH_INTERVAL_MS;
    return Number.isFinite(configured) && configured >= 1000 ? configured : DEFAULT_REFRESH_INTERVAL_MS;
  }, [config, demoEnabled]);

  // 1. Configuração (gauges, intervalo).
  useEffect(() => {
    if (demoEnabled) return;
    const controller = new AbortController();
    void fetchConfig(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.data) setConfig(result.data);
    });
    return () => controller.abort();
  }, [demoEnabled]);

  // 2. Telemetria (ciclo sem sobreposição).
  useEffect(() => {
    if (demoEnabled) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: number | null = null;

    async function tick(): Promise<void> {
      setLoading(true);
      const result = await fetchDashboard(deviceId, controller.signal);
      if (cancelled || controller.signal.aborted) return;

      if (result.data) setDashboard(result.data);
      // Um envelope de erro do backend (502/404) descreve a API de origem, não o
      // serviço do Web Viewer: nesse caso o payload é a fonte do aviso exibido.
      setFetchError(isViewerLevelFailure(result) ? result.error : null);
      setLastFetchAtMs(Date.now());
      setLoading(false);

      if (!cancelled) timer = window.setTimeout(() => void tick(), intervalMs);
    }

    void tick();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [demoEnabled, intervalMs, deviceId]);

  return {
    demo: demoEnabled,
    loading,
    config,
    dashboard,
    lastFetchAtMs,
    fetchError,
    refreshIntervalMs: intervalMs,
  };
}
