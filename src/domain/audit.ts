import type { AuditAction, AuditEntry, Priority, Role, ServiceRequest, Status } from './model';

/** Values for one audit entry; `note` is kept only when it is a non-empty string. */
export interface AuditEntryInput {
  /** ISO 8601 timestamp from the caller's injected clock. */
  readonly timestamp: string;
  /** Role selected when the command ran. */
  readonly role: Role;
  readonly action: AuditAction;
  /** Status before the command, or `''` for Created. */
  readonly fromStatus: Status | '';
  /** Status after the command, or `''` for Created and Edited. */
  readonly toStatus: Status | '';
  /** Already-trimmed reason, supplied information or priority-change text. */
  readonly note?: string | undefined;
}

const INFORMATION_REQUESTED: AuditAction = 'Information requested';

/** Builds a new audit entry, leaving out the `note` key when the note is absent or empty. */
export function createAuditEntry(input: AuditEntryInput): AuditEntry {
  const { timestamp, role, action, fromStatus, toStatus, note } = input;
  // An absent key, not `note: undefined`, keeps entries deep-equal across a JSON round trip.
  if (note === undefined || note.length === 0) {
    return { timestamp, role, action, fromStatus, toStatus };
  }
  return { timestamp, role, action, fromStatus, toStatus, note };
}

/** Returns a new history with `entry` last; `history` itself is never changed or reordered. */
export function appendAuditEntry(
  history: readonly AuditEntry[],
  entry: AuditEntry,
): readonly AuditEntry[] {
  // Append order is the chronological order: timestamps are never compared or sorted,
  // so an entry with an equal or earlier clock value still goes last.
  return [...history, entry];
}

/** Returns the Edited note for a priority change, such as `Priority: Normal to Urgent`, or `undefined` when unchanged. */
export function describeEdit(
  before: Pick<ServiceRequest, 'priority'>,
  afterPriority: Priority,
): string | undefined {
  if (before.priority === afterPriority) {
    return undefined;
  }
  return `Priority: ${before.priority} to ${afterPriority}`;
}

/** Returns the note of the most recent Information requested entry, or `undefined` when there is none. */
export function latestInformationRequest(
  request: Pick<ServiceRequest, 'auditHistory'>,
): string | undefined {
  const history = request.auditHistory;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.action === INFORMATION_REQUESTED) {
      return entry.note;
    }
  }
  return undefined;
}
