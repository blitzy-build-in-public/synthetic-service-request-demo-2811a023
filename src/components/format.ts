import type { Status } from '../domain/model';

/** The em dash (U+2014) shown in place of a blank value or an empty audit status. */
export const EM_DASH = '—';

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

// One decision shared by the text and its class, so a timestamp shown as stored always gets the class that
// lets it wrap, and a formatted one never does.
function localTimestampText(iso: string): string | undefined {
  // Stored timestamps are untrusted, so an unparseable value is shown as stored rather than throwing.
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  // Built from date parts rather than locale-aware formatting, whose output varies by locale.
  // A local year outside 0 to 9999 has no four-digit YYYY form, so it falls back to the stored text too.
  const year = date.getFullYear();
  if (year < 0 || year > 9999) {
    return undefined;
  }
  const day = `${pad(year, 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
  return `${day} ${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}`;
}

/** Formats an ISO 8601 timestamp as local `YYYY-MM-DD HH:mm`; returns `iso` unchanged when it cannot be shown that way. */
export function formatTimestamp(iso: string): string {
  return localTimestampText(iso) ?? iso;
}

/** Returns `'raw-timestamp'` exactly when `formatTimestamp(iso)` shows `iso` unchanged, otherwise `undefined`. */
export function timestampClassName(iso: string): string | undefined {
  return localTimestampText(iso) === undefined ? 'raw-timestamp' : undefined;
}

/** Returns `EM_DASH` for an undefined or empty value, otherwise `value` unchanged. */
export function formatBlank(value: string | undefined): string {
  return value === undefined || value === '' ? EM_DASH : value;
}

/** Renders an audit From or To status, showing the empty status `''` as `EM_DASH`. */
export function formatStatusCell(value: Status | ''): string {
  return formatBlank(value);
}
