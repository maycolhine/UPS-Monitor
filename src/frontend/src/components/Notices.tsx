/**
 * Avisos do topo do painel: modo demonstração, falha de transporte,
 * telemetria ausente/desatualizada e faixas provisórias.
 *
 * Cada aviso distingue explicitamente "API indisponível" de "telemetria
 * desatualizada" (critério de aceite do escopo §10).
 */
import type { DashboardPayload, TelemetryPayload } from "../model/contract.js";
import { formatAge } from "../model/format.js";

export type NoticeLevel = "critical" | "warning" | "info";

export interface Notice {
  id: string;
  level: NoticeLevel;
  title: string;
  message: string;
}

export interface NoticesInput {
  demo: boolean;
  fetchError: { code: string; message: string } | null;
  dashboard: DashboardPayload | null;
  thresholdProblems: string[];
}

/** Monta a lista de avisos a partir do estado atual (função pura, testável). */
export function buildNotices(input: NoticesInput): Notice[] {
  const notices: Notice[] = [];
  const viewer = input.dashboard?.viewer ?? null;
  const telemetry: TelemetryPayload | null = input.dashboard?.telemetry ?? null;

  if (input.demo) {
    notices.push({
      id: "demo",
      level: "warning",
      title: "MODO DEMONSTRAÇÃO",
      message:
        "Os valores exibidos são simulados para validar o layout. Não são telemetria do nobreak.",
    });
  }

  if (input.fetchError) {
    notices.push({
      id: "viewer_fetch",
      level: "critical",
      title: "Serviço do Web Viewer inacessível",
      message: `${input.fetchError.message} (código: ${input.fetchError.code})`,
    });
  }

  const upstreamError = viewer?.upstream.error ?? null;
  if (upstreamError) {
    notices.push({
      id: "upstream_unreachable",
      level: "critical",
      title: "API de telemetria indisponível",
      message: `${upstreamError.message} (código: ${upstreamError.code}) — endereço consultado: ${viewer?.upstream.base_url ?? "—"}.`,
    });
  }

  // Erro devolvido pelo backend do Web Viewer sobre a API de origem (502/404).
  const apiError = upstreamError ? null : (input.dashboard?.error ?? null);
  if (apiError) {
    const deviceMissing = apiError.code === "device_not_found";
    notices.push({
      id: deviceMissing ? "device_not_found" : "api_error",
      level: "critical",
      title: deviceMissing ? "Equipamento não encontrado na API" : "API de telemetria indisponível",
      message: `${apiError.message} (código: ${apiError.code}).`,
    });
  }

  if (!telemetry && !upstreamError && !apiError && !input.fetchError) {
    notices.push({
      id: "no_telemetry",
      level: "warning",
      title: "Sem telemetria utilizável",
      message:
        viewer?.device_id === null
          ? "Nenhum equipamento foi identificado em /api/v1/ups."
          : "A API respondeu, mas não publicou uma leitura válida neste momento.",
    });
  }

  if (telemetry?.stale) {
    notices.push({
      id: "stale",
      level: "warning",
      title: "Leitura desatualizada",
      message: `A última leitura válida tem ${formatAge(
        telemetry.communication.age_seconds ?? telemetry.data?.age_seconds ?? null,
      )}. Os valores são exibidos apenas como referência histórica.`,
    });
  } else if (telemetry && telemetry.data === null) {
    notices.push({
      id: "no_data",
      level: "warning",
      title: "Sem amostra de telemetria",
      message: "A API está ativa, mas ainda não há amostra válida publicada.",
    });
  }

  if (input.thresholdProblems.length > 0) {
    notices.push({
      id: "thresholds",
      level: "info",
      title: "Configuração das faixas dos medidores",
      message: input.thresholdProblems.join(" "),
    });
  }

  return notices;
}

export function Notices({ notices }: { notices: Notice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice notice--${notice.level}`}>
          <strong className="notice__title">{notice.title}</strong>
          <span className="notice__message">{notice.message}</span>
        </div>
      ))}
    </div>
  );
}
