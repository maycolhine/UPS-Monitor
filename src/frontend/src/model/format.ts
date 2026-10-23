/**
 * Display formatting.
 * Missing values never become "0": they render as a dash/absence label.
 */

export const MISSING_TEXT = "—";
export const NO_DATA_TEXT = "No data";

export function formatNumber(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING_TEXT;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Converts an ISO 8601 UTC timestamp into local date/time. */
export function formatLocalDateTime(iso: string | null | undefined): string {
  if (!iso) return MISSING_TEXT;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return MISSING_TEXT;
  return date.toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatLocalTime(iso: string | null | undefined): string {
  if (!iso) return MISSING_TEXT;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return MISSING_TEXT;
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Readable age: "3.2 s", "1 min 4 s", "2 h 5 min". */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return MISSING_TEXT;
  }
  if (seconds < 60) {
    return `${seconds.toLocaleString("en-US", { maximumFractionDigits: 1 })} s`;
  }
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) {
    const rest = Math.floor(seconds % 60);
    return rest === 0 ? `${totalMinutes} min` : `${totalMinutes} min ${rest} s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function formatPercent(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined) return MISSING_TEXT;
  return `${formatNumber(value, decimals)}%`;
}

export function formatBoolean(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return MISSING_TEXT;
  return value ? "Yes" : "No";
}

export function formatText(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return MISSING_TEXT;
  return value;
}
