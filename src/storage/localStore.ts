import { LIMITS, isAuditAction, isPriority, isRequestType, isRole, isStatus } from '../domain/model';
import type { AuditEntry, RequestType, ServiceRequest, Status } from '../domain/model';
import { countCharacters } from '../domain/validation';

/** The only browser-storage key the app reads or writes. */
export const STORAGE_KEY = 'service-request-demo.v1';

/** Envelope version this build reads and writes; a stored envelope with any other version is `wrongVersion`. */
export const STORAGE_VERSION = 1;

/** What `load` found under `STORAGE_KEY`; only `ok` carries requests, rebuilt from known keys in stored order. */
export type LoadResult =
  | { readonly kind: 'ok'; readonly requests: ServiceRequest[] }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'wrongVersion' }
  | { readonly kind: 'unavailable' };

/** Outcome of a write: `quota` when storage is full, `unavailable` for any other failure. */
export type SaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'quota' | 'unavailable' };

/** Persistence port used by the store: `load` never writes and `save` never throws. */
export interface StorageAdapter {
  /** Reads and classifies the stored envelope without modifying storage. */
  load(): LoadResult;
  /** Writes the whole request list under `STORAGE_KEY`, reporting failure instead of throwing. */
  save(requests: readonly ServiceRequest[]): SaveResult;
}

/** Serialises `requests` as the compact `{ version, requests }` envelope stored under `STORAGE_KEY`. */
export function serializeEnvelope(requests: readonly ServiceRequest[]): string {
  return JSON.stringify({ version: STORAGE_VERSION, requests });
}

const REQUEST_ID_PATTERN = /^REQ-\d{4,}$/;
const ISO_TIMESTAMP_PATTERN = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const QUOTA_EXCEEDED_NAME = 'QuotaExceededError';
const LEGACY_QUOTA_EXCEEDED_CODE = 22;

// `JSON.parse` yields only plain objects, arrays and primitives, so this is the plain-object test.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Narrows to `unknown` elements rather than the `any[]` that `Array.isArray` alone gives.
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

// Timestamps come from `Date.prototype.toISOString`, which writes years outside 0 to 9999 with a sign and
// six digits, so the shape admits both forms. The round trip rejects what the shape cannot: values that name
// no real instant, such as 30 February, hour 24 or a time past the Date range, which `Date.parse` rolls over
// or refuses, and non-canonical spellings such as `+002026` or `-000000` that `toISOString` never writes.
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function isStatusOrBlank(value: unknown): value is Status | '' {
  return value === '' || isStatus(value);
}

// Counted in code points, matching the domain's save and submission limits.
function isWithinLimit(value: string, limit: number): boolean {
  return countCharacters(value) <= limit;
}

// The domain stores these fields trimmed, so untrimmed or whitespace-only text is data the app never wrote.
function isStoredText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value === value.trim() && isWithinLimit(value, limit);
}

// A blank type is the one stored-shape rule that reads the status: only an incomplete Draft may lack a type.
function isStoredRequestType(value: unknown, status: Status): value is RequestType | '' {
  return isRequestType(value) || (value === '' && status === 'Draft');
}

// Rebuilt from known keys only, so unknown keys are dropped and `note` exists only when it has text.
function parseAuditEntry(value: unknown): AuditEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const { timestamp, role, action, fromStatus, toStatus, note } = value;
  if (
    !isIsoTimestamp(timestamp) ||
    !isRole(role) ||
    !isAuditAction(action) ||
    !isStatusOrBlank(fromStatus) ||
    !isStatusOrBlank(toStatus)
  ) {
    return null;
  }
  const entry: AuditEntry = { timestamp, role, action, fromStatus, toStatus };
  if (note === undefined) {
    return entry;
  }
  if (typeof note !== 'string' || note === '' || !isWithinLimit(note, LIMITS.note)) {
    return null;
  }
  return { ...entry, note };
}

function parseAuditHistory(value: unknown): AuditEntry[] | null {
  if (!isArray(value)) {
    return null;
  }
  const history: AuditEntry[] = [];
  for (const item of value) {
    const entry = parseAuditEntry(item);
    if (entry === null) {
      return null;
    }
    history.push(entry);
  }
  // Every history starts with the Created entry, so an empty one or any other first action is malformed.
  return history[0]?.action === 'Created' ? history : null;
}

// Checks every attribute's type and allowed values and rebuilds the request from its eight known keys.
function parseServiceRequest(value: unknown): ServiceRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, requesterName, requestType, description, priority, status, lastUpdated, auditHistory } =
    value;
  if (
    typeof id !== 'string' ||
    !REQUEST_ID_PATTERN.test(id) ||
    !isStoredText(requesterName, LIMITS.requesterName) ||
    !isStoredText(description, LIMITS.description) ||
    !isPriority(priority) ||
    !isStatus(status) ||
    !isStoredRequestType(requestType, status) ||
    !isIsoTimestamp(lastUpdated)
  ) {
    return null;
  }
  const history = parseAuditHistory(auditHistory);
  if (history === null) {
    return null;
  }
  return {
    id,
    requesterName,
    requestType,
    description,
    priority,
    status,
    lastUpdated,
    auditHistory: history,
  };
}

/** Classifies a stored string: `unreadable` for bad JSON, a non-object or any malformed request or duplicate ID, `wrongVersion` for a version other than 1, otherwise `ok`. */
export function parseEnvelope(raw: string): LoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable' };
  }
  if (!isRecord(parsed)) {
    return { kind: 'unreadable' };
  }
  // Version comes before shape, so a future envelope is reported as unsupported whatever it holds.
  if (parsed['version'] !== STORAGE_VERSION) {
    return { kind: 'wrongVersion' };
  }
  const stored = parsed['requests'];
  if (!isArray(stored)) {
    return { kind: 'unreadable' };
  }
  const requests: ServiceRequest[] = [];
  const ids = new Set<string>();
  for (const item of stored) {
    const request = parseServiceRequest(item);
    // One bad element rejects the whole value, so a partial list is never shown as the stored data.
    if (request === null || ids.has(request.id)) {
      return { kind: 'unreadable' };
    }
    ids.add(request.id);
    requests.push(request);
  }
  return { kind: 'ok', requests };
}

// Duck-typed rather than `instanceof DOMException`: the exception can come from another realm
// (jsdom versus the test runner's global), and browsers agree on the name or the legacy code 22.
function isQuotaExceeded(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return (
    ('name' in error && error.name === QUOTA_EXCEEDED_NAME) ||
    ('code' in error && error.code === LEGACY_QUOTA_EXCEEDED_CODE)
  );
}

/** Builds the adapter over the `Storage` that `getStorage` returns, calling it afresh on every load and save. */
export function createLocalStorageAdapter(getStorage: () => Storage): StorageAdapter {
  // `getStorage` is never cached: reaching the browser's storage can itself throw a SecurityError,
  // and the store retries a failed save on the next change, so each call must try again from scratch.
  return {
    load(): LoadResult {
      let raw: string | null;
      try {
        raw = getStorage().getItem(STORAGE_KEY);
      } catch {
        return { kind: 'unavailable' };
      }
      return raw === null ? { kind: 'empty' } : parseEnvelope(raw);
    },
    save(requests: readonly ServiceRequest[]): SaveResult {
      try {
        getStorage().setItem(STORAGE_KEY, serializeEnvelope(requests));
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: isQuotaExceeded(error) ? 'quota' : 'unavailable' };
      }
    },
  };
}
