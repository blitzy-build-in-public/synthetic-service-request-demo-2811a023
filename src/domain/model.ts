/** Request statuses in workflow order; Completed is the only terminal one. */
export const STATUSES = [
  'Draft',
  'Submitted',
  'In Review',
  'Waiting for Information',
  'Completed',
] as const;

/** One of the five request statuses. */
export type Status = (typeof STATUSES)[number];

/** Simulated roles offered by the header switch, in display order. */
export const ROLES = ['Requester', 'Reviewer'] as const;

/** The simulated role a command runs as; never an identity. */
export type Role = (typeof ROLES)[number];

/** The three request types, in the order the type select lists them. */
export const REQUEST_TYPES = [
  'Access Request',
  'Equipment Request',
  'General Question',
] as const;

/** One of the three request types. */
export type RequestType = (typeof REQUEST_TYPES)[number];

/** Request priorities, in the order the priority select lists them. */
export const PRIORITIES = ['Normal', 'Urgent'] as const;

/** One of the two request priorities. */
export type Priority = (typeof PRIORITIES)[number];

/** Audit action texts, one per transition-table action. */
export const AUDIT_ACTIONS = [
  'Created',
  'Edited',
  'Submitted',
  'Review started',
  'Information requested',
  'Information supplied',
  'Completed',
] as const;

/** The action text recorded in an audit entry. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Priority every new request starts with; Edit on a Draft is the only way to change it. */
export const DEFAULT_PRIORITY: Priority = 'Normal';

/** Maximum lengths in Unicode code points, applied after trimming. */
export const LIMITS = {
  requesterName: 80,
  description: 2000,
  note: 1000,
} as const;

function isOneOf<T extends string>(members: readonly T[], value: unknown): value is T {
  return members.some((member) => member === value);
}

/** True when `value` is exactly one of `STATUSES`. */
export function isStatus(value: unknown): value is Status {
  return isOneOf(STATUSES, value);
}

/** True when `value` is exactly one of `ROLES`. */
export function isRole(value: unknown): value is Role {
  return isOneOf(ROLES, value);
}

/** True when `value` is exactly one of `REQUEST_TYPES`. */
export function isRequestType(value: unknown): value is RequestType {
  return isOneOf(REQUEST_TYPES, value);
}

/** True when `value` is exactly one of `PRIORITIES`. */
export function isPriority(value: unknown): value is Priority {
  return isOneOf(PRIORITIES, value);
}

/** True when `value` is exactly one of `AUDIT_ACTIONS`. */
export function isAuditAction(value: unknown): value is AuditAction {
  return isOneOf(AUDIT_ACTIONS, value);
}

/** One immutable audit history record; `''` marks an empty status (both for Created, `toStatus` for Edited). */
export interface AuditEntry {
  /** ISO 8601 UTC timestamp taken from the injected clock when the entry was appended. */
  readonly timestamp: string;
  /** Role selected when the command ran. */
  readonly role: Role;
  /** What happened. */
  readonly action: AuditAction;
  /** Status before the command, or `''` for Created. */
  readonly fromStatus: Status | '';
  /** Status after the command, or `''` for Created and Edited. */
  readonly toStatus: Status | '';
  /** Reason, supplied information or priority-change text; present only when non-empty. */
  readonly note?: string;
}

/** A fictional service request together with its append-only audit history. */
export interface ServiceRequest {
  /** `REQ-` followed by an integer zero-padded to at least four digits; never changes. */
  readonly id: string;
  /** Trimmed, at most `LIMITS.requesterName` code points; `''` only while Draft. */
  readonly requesterName: string;
  /** One of `REQUEST_TYPES`, or `''` only while Draft. */
  readonly requestType: RequestType | '';
  /** Trimmed, at most `LIMITS.description` code points; `''` only while Draft. */
  readonly description: string;
  /** Fixed once the request leaves Draft. */
  readonly priority: Priority;
  /** Current workflow status. */
  readonly status: Status;
  /** ISO 8601 timestamp of the latest appended audit entry. */
  readonly lastUpdated: string;
  /** Non-empty and in append order; the first entry is always Created. */
  readonly auditHistory: readonly AuditEntry[];
}

/** Raw, untrimmed create-form values; the create form carries no priority. */
export interface CreateFields {
  /** Requester name as typed. */
  readonly requesterName: string;
  /** Selected request type, or `''` when none is chosen. */
  readonly requestType: string;
  /** Description as typed. */
  readonly description: string;
}

/** Raw edit-form values: the create fields plus the selected priority. */
export interface EditFields extends CreateFields {
  /** Selected priority value. */
  readonly priority: string;
}

const REQUEST_ID_PATTERN = /^REQ-(\d+)$/;

/** Formats a positive integer as a request ID: 1 gives `REQ-0001`, 10000 gives `REQ-10000`; throws `RangeError` otherwise. */
export function formatRequestId(n: number | bigint): string {
  const valid = typeof n === 'bigint' ? n >= 1n : Number.isSafeInteger(n) && n >= 1;
  if (!valid) {
    throw new RangeError(`Request number must be a positive integer, received ${String(n)}.`);
  }
  return `REQ-${String(n).padStart(4, '0')}`;
}

/** Returns the ID after the highest `REQ-<digits>` ID in `requests`, or `REQ-0001` when there is none; other IDs are ignored. */
export function nextRequestId(requests: readonly Pick<ServiceRequest, 'id'>[]): string {
  // Stored IDs are user-editable, so the suffix can exceed Number's exact-integer range;
  // BigInt keeps the successor exact there instead of rounding onto an existing ID.
  let highest = 0n;
  for (const { id } of requests) {
    const digits = REQUEST_ID_PATTERN.exec(id)?.[1];
    if (digits === undefined) {
      continue;
    }
    const value = BigInt(digits);
    if (value > highest) {
      highest = value;
    }
  }
  return formatRequestId(highest + 1n);
}
