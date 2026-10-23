/**
 * Notices at the top of the panel: demo mode, transport failure, missing/stale
 * telemetry and provisional bands.
 *
 * Each notice explicitly distinguishes "API unavailable" from "stale telemetry"
 * (acceptance criterion of scope §10).
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

/** Builds the list of notices from the current state (pure, testable function). */
export function buildNotices(input: NoticesInput): Notice[] {
  const notices: Notice[] = [];
  const viewer = input.dashboard?.viewer ?? null;
  const telemetry: TelemetryPayload | null = input.dashboard?.telemetry ?? null;

  if (input.demo) {
    notices.push({
      id: "demo",
      level: "warning",
      title: "DEMO MODE",
      message:
        "The values displayed are simulated to validate the layout. They are not telemetry from the UPS.",
    });
  }

  if (input.fetchError) {
    notices.push({
      id: "viewer_fetch",
      level: "critical",
      title: "Web Viewer service unreachable",
      message: `${input.fetchError.message} (code: ${input.fetchError.code})`,
    });
  }

  const upstreamError = viewer?.upstream.error ?? null;
  if (upstreamError) {
    notices.push({
      id: "upstream_unreachable",
      level: "critical",
      title: "Telemetry API unavailable",
      message: `${upstreamError.message} (code: ${upstreamError.code}) — address consulted: ${viewer?.upstream.base_url ?? "—"}.`,
    });
  }

  // Error returned by the Web Viewer backend about the origin API (502/404).
  const apiError = upstreamError ? null : (input.dashboard?.error ?? null);
  if (apiError) {
    const deviceMissing = apiError.code === "device_not_found";
    notices.push({
      id: deviceMissing ? "device_not_found" : "api_error",
      level: "critical",
      title: deviceMissing ? "Device not found in the API" : "Telemetry API unavailable",
      message: `${apiError.message} (code: ${apiError.code}).`,
    });
  }

  if (!telemetry && !upstreamError && !apiError && !input.fetchError) {
    notices.push({
      id: "no_telemetry",
      level: "warning",
      title: "No usable telemetry",
      message:
        viewer?.device_id === null
          ? "No device was identified in /api/v1/ups."
          : "The API responded, but has not published a valid reading at this time.",
    });
  }

  if (telemetry?.stale) {
    notices.push({
      id: "stale",
      level: "warning",
      title: "Stale reading",
      message: `The last valid reading is ${formatAge(
        telemetry.communication.age_seconds ?? telemetry.data?.age_seconds ?? null,
      )} old. The values are shown only as a historical reference.`,
    });
  } else if (telemetry && telemetry.data === null) {
    notices.push({
      id: "no_data",
      level: "warning",
      title: "No telemetry sample",
      message: "The API is active, but no valid sample has been published yet.",
    });
  }

  if (input.thresholdProblems.length > 0) {
    notices.push({
      id: "thresholds",
      level: "info",
      title: "Gauge band configuration",
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
