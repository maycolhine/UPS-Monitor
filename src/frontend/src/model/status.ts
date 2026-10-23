/**
 * Translation of the states reported by the API (status frame flags and
 * communication state) into display text, with severity for visual reading.
 *
 * No condition is inferred: only what the API reports is displayed.
 * In particular, the absence of `OB` is NOT presented as "normal mains power",
 * because that would require evaluating the quality and freshness of the reading.
 *
 * NOTE (contract 2.0 — multiprotocol): the frame bits have a DIFFERENT meaning
 * depending on the protocol. b5/b4/b3 are `BOOST`/`FAULT`/`STANDBY` in
 * `megatec-q1` and `BYPASS`/`BOOST`/`UPSOK` in `sms-1phase`. That is why there
 * are two tables and the table is chosen by the protocol that produced the frame
 * (`data.source`), never by assumption.
 */
import { formatAge } from "./format.js";
import type { CommunicationState, DashboardPayload, TelemetryPayload } from "./contract.js";

export type Severity = "critical" | "warning" | "info";

export interface FlagMeta {
  id: string;
  label: string;
  description: string;
  severity: Severity;
}

/**
 * Order and meaning of the `megatec-q1` (TS Shara) flags, per
 * monitor/docs/unified-api.md §6.3.
 *
 * The order of the list is FIXED and goes from the calmest state to the most
 * critical. The interface grid does not reorder based on active/inactive: the
 * cards must not "move up and down" on every reading, otherwise the user cannot
 * follow the change.
 */
export const FLAG_META: FlagMeta[] = [
  {
    id: "BEEP",
    label: "Audible alarm",
    description: "Audible alarm in operation.",
    severity: "warning",
  },
  {
    id: "BOOST",
    label: "Voltage boost",
    description: "Low input voltage, with active boost.",
    severity: "warning",
  },
  {
    id: "STANDBY",
    label: "Standby",
    description: "Standby mode reported by the device.",
    severity: "info",
  },
  {
    id: "OB",
    label: "Operating on battery",
    description: "The device is feeding the load from the battery.",
    severity: "warning",
  },
  {
    id: "LB",
    label: "Low battery",
    description: "Battery below the limit indicated by the device.",
    severity: "critical",
  },
  {
    id: "FAULT",
    label: "Fault",
    description: "The device reports a fault condition.",
    severity: "critical",
  },
  {
    id: "TEST",
    label: "Test in progress",
    description: "The device reports that it is running a battery test.",
    severity: "info",
  },
  {
    id: "FSD",
    label: "Scheduled shutdown",
    description: "Scheduled shutdown (fail-safe shutdown) reported by the device.",
    severity: "warning",
  },
];

/**
 * Flags of `sms-1phase`. b5/b4/b3 mean `BYPASS`/`BOOST`/`UPSOK`, and not the Q1
 * states — reusing the Q1 table would state, for example, that the SMS is in
 * "Fault" (bit b4) when it reports "Boost/Buck active".
 *
 * The order of the list is also FIXED: it goes from the calmest state (green) to
 * the most critical (red), passing through the test in progress (blue) and the
 * shutdown (yellow) — the grid does not reorder based on active/inactive.
 */
export const SMS_FLAG_META: FlagMeta[] = [
  {
    id: "BYPASS",
    label: "Bypass active",
    description: "The load is connected directly to the input (bypass).",
    severity: "warning",
  },
  {
    id: "BEEP",
    label: "Audible alarm",
    description: "Audible alarm in operation.",
    severity: "warning",
  },
  {
    id: "UPSOK",
    label: "Inverter/mains OK",
    description: "Inverter and mains operating with no reported fault.",
    severity: "info",
  },
  {
    id: "BOOST",
    label: "Boost/Buck active",
    description: "Active correction of the output voltage.",
    severity: "info",
  },
  {
    id: "OB",
    label: "Mains absent (on battery)",
    description: "Input mains absent; the load is fed from the battery.",
    severity: "warning",
  },
  {
    id: "LB",
    label: "Low battery",
    description: "Battery below the limit indicated by the device.",
    severity: "critical",
  },
  {
    id: "TEST",
    label: "Test in progress",
    description: "The device reports that it is running a battery test.",
    severity: "info",
  },
  {
    id: "FSD",
    label: "Shutdown active",
    description: "Shutdown (fail-safe) reported by the device.",
    severity: "warning",
  },
];

/**
 * Flag table applicable to the protocol reported by the API (`data.source`).
 * An unknown protocol keeps the Q1 table — the previous behavior — and flags
 * outside the table remain listed as undocumented.
 */
export function flagMetaForProtocol(protocol?: string | null): FlagMeta[] {
  return protocol === "sms-1phase" ? SMS_FLAG_META : FLAG_META;
}

export interface FlagView extends FlagMeta {
  active: boolean;
}

export function buildFlagViews(
  flags: Record<string, boolean> | undefined,
  active: string[] | undefined,
  protocol?: string | null,
): FlagView[] {
  const activeSet = new Set(active ?? []);
  return flagMetaForProtocol(protocol).map((meta) => {
    const declared = flags?.[meta.id];
    const activeValue = typeof declared === "boolean" ? declared : activeSet.has(meta.id);
    return { ...meta, active: activeValue };
  });
}

/** Unknown flags (other models/brands) are displayed as informational. */
export function buildUnknownFlagViews(
  flags: Record<string, boolean> | undefined,
  active: string[] | undefined,
  protocol?: string | null,
): FlagView[] {
  const known = new Set(flagMetaForProtocol(protocol).map((meta) => meta.id));
  const ids = new Set([...Object.keys(flags ?? {}), ...(active ?? [])]);
  return [...ids]
    .filter((id) => !known.has(id))
    .sort()
    .map((id) => ({
      id,
      label: id,
      description: "State not documented in the current contract.",
      severity: "info" as Severity,
      active: flags?.[id] ?? (active ?? []).includes(id),
    }));
}

/**
 * Visual tone of a flag in the status frame.
 *
 * Unlike the generic `severity` (critical/warning/informational), the tone is
 * what the interface paints on the side bar of each card and follows the
 * agreement with the requester: green = normal operation, orange = mains absent,
 * red = low battery / fault, blue = test in progress, yellow = shutdown,
 * gray = inactive state (no signal).
 */
export type FlagTone = "good" | "warning" | "on_battery" | "critical" | "test" | "neutral";

/**
 * Tone of a flag considering whether it is ACTIVE.
 *
 * Two rules depart from "inactive = gray": `UPSOK` (inverter/mains) and `BOOST`
 * (boost/buck) — for them, INACTIVITY is the alert condition, so the bar turns
 * red. For the others, the inactive card is gray.
 */
export function flagTone(flag: FlagView): FlagTone {
  if (!flag.active) {
    if (flag.id === "UPSOK" || flag.id === "BOOST") return "critical";
    return "neutral";
  }
  switch (flag.id) {
    case "BYPASS":
    case "BEEP":
    case "UPSOK":
    case "BOOST":
      return "good";
    case "OB":
      return "on_battery";
    case "LB":
    case "FAULT":
      return "critical";
    case "TEST":
      return "test";
    case "FSD":
      return "warning";
    default:
      // Active flags outside the known table inherit the declared severity.
      return flag.severity === "critical" ? "critical" : flag.severity === "warning" ? "warning" : "good";
  }
}

export type CommunicationLevel = "ok" | "warning" | "stale" | "down" | "unknown";

export interface CommunicationView {
  level: CommunicationLevel;
  label: string;
  description: string;
}

const STATE_TEXT: Record<string, { label: string; description: string }> = {
  starting: { label: "Waiting for reading", description: "The collector has not yet completed the first attempt." },
  ok: { label: "Connected", description: "Last collection attempt succeeded." },
  stale: {
    label: "Stale",
    description: "Last valid reading older than the limit configured in the collector.",
  },
  port_unavailable: {
    label: "Port unavailable",
    description: "Serial port not found or in use by another process.",
  },
  permission_denied: { label: "Permission denied", description: "Collector user without access to the serial port." },
  disconnected: { label: "Disconnected", description: "The device was disconnected during operation." },
  timeout: { label: "Timeout", description: "No response from the device within the expected time." },
  invalid_response: { label: "Invalid response", description: "Response received does not contain a Q1 frame." },
  incomplete_response: { label: "Incomplete response", description: "Truncated/incomplete frame." },
  checksum_error: {
    label: "Corrupted frame",
    description: "Frame checksum does not match (SMS protocol); reading discarded.",
  },
  parse_error: { label: "Read error", description: "Non-numeric field or malformed frame." },
  out_of_range: { label: "Out of range", description: "Value outside the plausible range (sanity)." },
  serial_error: { label: "Serial error", description: "Another I/O failure on the serial port." },
};

export function describeCommunicationState(state: string): { label: string; description: string } {
  return STATE_TEXT[state] ?? { label: state, description: "State not documented in the current contract." };
}

export function communicationLevel(state: string): CommunicationLevel {
  if (state === "ok") return "ok";
  if (state === "stale") return "stale";
  if (state === "starting") return "warning";
  return "down";
}

/**
 * Level of the on/off dot of each UPS in the device list.
 *
 * The item of `GET /api/v1/ups` reports `communication_state` and
 * `telemetry_valid` — both together tell whether that device is delivering a
 * reading right now. Nothing else is inferred.
 */
export function deviceConnectionLevel(device: {
  communication_state?: string | null;
  telemetry_valid?: boolean;
}): CommunicationLevel {
  const level = communicationLevel(device.communication_state ?? "unknown");
  if (level === "ok" && device.telemetry_valid === false) return "warning";
  return level;
}

/** Accessible label of the dot (`aria-label`), since color is not the only signal. */
export function deviceConnectionLabel(device: {
  communication_state?: string | null;
  telemetry_valid?: boolean;
}): string {
  const level = deviceConnectionLevel(device);
  const stateText = describeCommunicationState(device.communication_state ?? "unknown");
  const value = level === "ok" ? "Connected" : level === "warning" ? "Warning" : "No communication";
  return `${value}: ${stateText.label}`;
}

/**
 * Visual levels of the status dot of ONE UPS in the device list.
 *
 * There are six, from the calmest to the most critical: gray (no data), blue
 * (test in progress), green (all OK), yellow (some indicator in alert), orange
 * (mains absent / on battery) and red (low battery or critical indicator).
 */
export type DeviceStatusLevel = "unknown" | "ok" | "warning" | "on_battery" | "critical" | "test";

interface DeviceStatusText {
  label: string;
  description: string;
}

/**
 * Short text (used in the item description) and long text (`aria-label`) per
 * level. Color is never the only signal: the `label` accompanies the dot.
 */
const DEVICE_STATUS_TEXT: Record<DeviceStatusLevel, DeviceStatusText> = {
  unknown: {
    label: "No communication",
    description: "Not connected, not responding, or no telemetry published by the API.",
  },
  ok: {
    label: "Connected",
    description: "Connected with all indicators normal.",
  },
  warning: {
    label: "Warning",
    description: "Some indicator is in alert.",
  },
  on_battery: {
    label: "On battery",
    description: "Input mains absent; the load is fed from the battery.",
  },
  critical: {
    label: "Critical alert",
    description: "Low battery or output voltage, frequency, or load indicator in a critical state.",
  },
  test: {
    label: "Test in progress",
    description: "The device is running a battery test.",
  },
};

export interface DeviceStatusSignals {
  communication_state?: string | null;
  telemetry_valid?: boolean;
  /** `false` when the API did not publish usable telemetry for this device. */
  hasTelemetry?: boolean;
  testRunning?: boolean;
  onBattery?: boolean;
  batteryLow?: boolean;
  /** Output voltage, frequency, or load indicator in a critical state. */
  criticalMetric?: boolean;
  /** Any indicator in warning (not critical). */
  warningSignal?: boolean;
}

/**
 * Level of the dot from the observed signals. The priority order goes from the
 * most specific to the most generic: no communication wins over everything; then
 * test in progress, critical alert, mains absent, warning and, finally, all OK.
 */
export function deviceStatusLevel(input: DeviceStatusSignals): DeviceStatusLevel {
  const connected = deviceConnectionLevel(input) === "ok" && (input.hasTelemetry ?? true);
  if (!connected) return "unknown";
  if (input.testRunning) return "test";
  if (input.batteryLow || input.criticalMetric) return "critical";
  if (input.onBattery) return "on_battery";
  if (input.warningSignal) return "warning";
  return "ok";
}

export interface DeviceStatusView extends DeviceStatusText {
  level: DeviceStatusLevel;
}

export function deviceStatusView(input: DeviceStatusSignals): DeviceStatusView {
  const level = deviceStatusLevel(input);
  return { level, ...DEVICE_STATUS_TEXT[level] };
}

/**
 * Communication state shown in the header, combining:
 *  - the telemetry response from the API (with `stale`/`communication`);
 *  - the backend transport failure (`viewer.upstream`).
 */
export function describeCommunication(
  telemetry: TelemetryPayload | null,
  payload: Pick<DashboardPayload, "viewer"> | null,
): CommunicationView {
  const upstreamError = payload?.viewer.upstream.error ?? null;
  if (!telemetry) {
    if (upstreamError) {
      return {
        level: "down",
        label: "No communication with the API",
        description: upstreamError.message,
      };
    }
    return {
      level: "down",
      label: "No data from the device",
      description: "The API responded, but there is no usable telemetry right now.",
    };
  }

  const state = telemetry.communication.state;
  const stateText = describeCommunicationState(state);
  const age = telemetry.communication.age_seconds ?? telemetry.data?.age_seconds ?? null;

  if (telemetry.stale) {
    return {
      level: "stale",
      label: "Stale",
      description: `Last valid reading ${formatAge(age)} ago. Displayed as stale.`,
    };
  }
  if (state !== "ok") {
    const level = communicationLevel(state);
    return {
      level: level === "ok" ? "warning" : level,
      label: stateText.label,
      description: stateText.description,
    };
  }
  if (!telemetry.data_available) {
    return {
      level: "warning",
      label: "No data",
      description: "Collection active, but no valid reading published by the API.",
    };
  }
  return {
    level: "ok",
    label: "Connected",
    description: `Valid reading ${formatAge(age)} ago.`,
  };
}

export function communicationStateForDetails(state: CommunicationState | undefined): string {
  if (!state) return "unknown";
  return describeCommunicationState(state.state).label;
}
