/**
 * Periodic refresh hook.
 *
 * Two independent effects:
 *  1. `GET /api/config` — read once (gauge definitions and interval).
 *  2. `GET /api/dashboard` — read in a cycle, always AFTER the previous one
 *     finishes (no overlapping requests). The cycle restarts when the interval
 *     changes OR when the user switches UPS (`deviceId`).
 *
 * Nothing is inferred here: the hook only carries what the backend reported.
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
  /** Instant (ms) at which the dashboard was last received. */
  lastFetchAtMs: number | null;
  /** Failure of the Web Viewer itself (not of the telemetry API). */
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

  // 1. Configuration (gauges, interval).
  useEffect(() => {
    if (demoEnabled) return;
    const controller = new AbortController();
    void fetchConfig(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.data) setConfig(result.data);
    });
    return () => controller.abort();
  }, [demoEnabled]);

  // 2. Telemetry (cycle without overlap).
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
      // A backend error envelope (502/404) describes the origin API, not the
      // Web Viewer service: in that case the payload is the source of the
      // displayed notice.
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
