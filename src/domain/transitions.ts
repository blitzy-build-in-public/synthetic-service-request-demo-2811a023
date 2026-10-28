import { DEFAULT_PRIORITY, nextRequestId } from './model';
import type {
  AuditAction,
  CreateFields,
  EditFields,
  Priority,
  RequestType,
  Role,
  ServiceRequest,
  Status,
} from './model';
import { validateFieldsOnSave, validateForSubmission, validateNote } from './validation';
import type { FieldErrors, NoteKind } from './validation';
import { appendAuditEntry, createAuditEntry, describeEdit } from './audit';

/** Identifier of a transition-table action; also the `type` of the command that performs it. */
export type ActionId =
  | 'create'
  | 'edit'
  | 'submit'
  | 'startReview'
  | 'requestInfo'
  | 'supplyInfo'
  | 'complete';

/** One transition-table row: the role that may perform an action, from which status, and what it records. */
export interface TransitionRule {
  /** The action this row permits; equals the `type` of its command. */
  readonly action: ActionId;
  /** Caption of the control that offers the action. */
  readonly label: string;
  /** The only role that may perform the action. */
  readonly role: Role;
  /** Status the request must be in, or `null` for create, which starts from no request. */
  readonly from: Status | null;
  /** Status the request has once the action succeeds. */
  readonly to: Status;
  /** Action text of the audit entry the action appends. */
  readonly auditAction: AuditAction;
  /** The note the action requires, or `null` when it takes none. */
  readonly noteField: NoteKind | null;
}

// Keyed by action so the compiler proves every action has exactly one row and that each row's
// `action` matches its key; `as const` keeps literal types, so a note action's `noteField` is non-null.
const RULES = {
  create: {
    action: 'create',
    label: 'New request',
    role: 'Requester',
    from: null,
    to: 'Draft',
    auditAction: 'Created',
    noteField: null,
  },
  edit: {
    action: 'edit',
    label: 'Edit',
    role: 'Requester',
    from: 'Draft',
    to: 'Draft',
    auditAction: 'Edited',
    noteField: null,
  },
  submit: {
    action: 'submit',
    label: 'Submit',
    role: 'Requester',
    from: 'Draft',
    to: 'Submitted',
    auditAction: 'Submitted',
    noteField: null,
  },
  startReview: {
    action: 'startReview',
    label: 'Start review',
    role: 'Reviewer',
    from: 'Submitted',
    to: 'In Review',
    auditAction: 'Review started',
    noteField: null,
  },
  requestInfo: {
    action: 'requestInfo',
    label: 'Request more information',
    role: 'Reviewer',
    from: 'In Review',
    to: 'Waiting for Information',
    auditAction: 'Information requested',
    noteField: 'reason',
  },
  supplyInfo: {
    action: 'supplyInfo',
    label: 'Supply information',
    role: 'Requester',
    from: 'Waiting for Information',
    to: 'In Review',
    auditAction: 'Information supplied',
    noteField: 'suppliedInformation',
  },
  complete: {
    action: 'complete',
    label: 'Complete',
    role: 'Reviewer',
    from: 'In Review',
    to: 'Completed',
    auditAction: 'Completed',
    noteField: null,
  },
} as const satisfies { readonly [A in ActionId]: TransitionRule & { readonly action: A } };

/** The seven permitted transitions in table order: the single source of truth for who may do what from which status. */
export const TRANSITIONS: readonly TransitionRule[] = Object.freeze(
  [
    RULES.create,
    RULES.edit,
    RULES.submit,
    RULES.startReview,
    RULES.requestInfo,
    RULES.supplyInfo,
    RULES.complete,
  ].map((rule) => Object.freeze(rule)),
);

/** Returns the row letting `role` perform `action` from status `from` (`null` for create), or `undefined` when none does. */
export function findRule(
  action: ActionId,
  role: Role,
  from: Status | null,
): TransitionRule | undefined {
  return TRANSITIONS.find(
    (rule) => rule.action === action && rule.role === role && rule.from === from,
  );
}

/** Returns, in table order, the rows `role` may perform on a request in `status`, or on the list view when `status` is `null`. */
export function availableActions(role: Role, status: Status | null): readonly TransitionRule[] {
  return TRANSITIONS.filter((rule) => rule.role === role && rule.from === status);
}

/** True when no row starts from `status`, so neither role can act on it; Completed is the only such status. */
export function isTerminal(status: Status): boolean {
  return !TRANSITIONS.some((rule) => rule.from === status);
}

/** A request for one transition-table action, discriminated by `type`; form text is passed raw and trimmed here. */
export type Command =
  | { readonly type: 'create'; readonly fields: CreateFields }
  | { readonly type: 'edit'; readonly id: string; readonly fields: EditFields }
  | { readonly type: 'submit'; readonly id: string }
  | { readonly type: 'startReview'; readonly id: string }
  | { readonly type: 'requestInfo'; readonly id: string; readonly note: string }
  | { readonly type: 'supplyInfo'; readonly id: string; readonly note: string }
  | { readonly type: 'complete'; readonly id: string };

/** Why a command was rejected: failing field messages, a permission refusal, or a target ID matching no request. */
export type DomainError =
  | { readonly kind: 'validation'; readonly errors: FieldErrors }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'notFound'; readonly message: string };

/** Outcome of `applyCommand`: the new list with the created or updated request, or the rejection with the input untouched. */
export type CommandResult =
  | {
      readonly ok: true;
      readonly requests: readonly ServiceRequest[];
      readonly request: ServiceRequest;
    }
  | { readonly ok: false; readonly error: DomainError };

type Rejection = Extract<CommandResult, { readonly ok: false }>;

type CreateCommand = Extract<Command, { readonly type: 'create' }>;

type ExistingRequestCommand = Exclude<Command, CreateCommand>;

type Outcome =
  | { readonly ok: true; readonly request: ServiceRequest }
  | Rejection;

interface Transition {
  readonly request: ServiceRequest;
  readonly rule: TransitionRule;
  readonly role: Role;
  readonly now: string;
}

interface RequestFields {
  readonly requesterName: string;
  readonly requestType: RequestType | '';
  readonly description: string;
  readonly priority: Priority;
}

interface Changes {
  /** Overrides the entry's `toStatus`; Edited records `''` rather than the unchanged Draft. */
  readonly toStatus?: Status | '';
  /** Trimmed note for the entry; an absent or empty note leaves the entry without one. */
  readonly note?: string | undefined;
  /** Replacement field values; only Edit supplies them. */
  readonly fields?: RequestFields;
}

function reject(error: DomainError): Rejection {
  return { ok: false, error };
}

function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

// The single way an existing request changes: it takes the row's target status, gains exactly one entry
// at the end of its history, and takes `now` as `lastUpdated` even when that is not later than before,
// because append order, not timestamp order, is the history's chronology.
function advance({ request, rule, role, now }: Transition, changes: Changes = {}): ServiceRequest {
  const fields = changes.fields ?? request;
  const entry = createAuditEntry({
    timestamp: now,
    role,
    action: rule.auditAction,
    fromStatus: request.status,
    toStatus: changes.toStatus ?? rule.to,
    note: changes.note,
  });
  return {
    id: request.id,
    requesterName: fields.requesterName,
    requestType: fields.requestType,
    description: fields.description,
    priority: fields.priority,
    status: rule.to,
    lastUpdated: now,
    auditHistory: appendAuditEntry(request.auditHistory, entry),
  };
}

function changeRequest(transition: Transition, command: ExistingRequestCommand): Outcome {
  switch (command.type) {
    case 'edit': {
      const checked = validateFieldsOnSave(command.fields);
      if (!checked.ok) {
        return reject({ kind: 'validation', errors: checked.errors });
      }
      // Every successful save records an Edited entry, with a note only when the priority changed.
      const request = advance(transition, {
        toStatus: '',
        note: describeEdit(transition.request, checked.values.priority),
        fields: checked.values,
      });
      return { ok: true, request };
    }
    case 'submit': {
      const errors = validateForSubmission(transition.request);
      if (hasErrors(errors)) {
        return reject({ kind: 'validation', errors });
      }
      return { ok: true, request: advance(transition) };
    }
    case 'startReview':
    case 'complete':
      return { ok: true, request: advance(transition) };
    case 'requestInfo':
    case 'supplyInfo': {
      // The permitting row is this action's only row, so RULES gives the same row with its
      // note kind typed non-null.
      const checked = validateNote(command.note, RULES[command.type].noteField);
      if (!checked.ok) {
        return reject({ kind: 'validation', errors: checked.errors });
      }
      return { ok: true, request: advance(transition, { note: checked.value }) };
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
}

function applyCreate(
  requests: readonly ServiceRequest[],
  command: CreateCommand,
  role: Role,
  now: string,
): CommandResult {
  const rule = findRule(command.type, role, null);
  if (rule === undefined) {
    return reject({ kind: 'refused', message: `Create is not available to the ${role}.` });
  }
  // The create form carries no priority, but a fields object may still hold a priority key. Only
  // the three create-form values are projected before validation, so such a key is never validated
  // as an Edit priority and never stored; every new request starts with the default.
  const checked = validateFieldsOnSave({
    requesterName: command.fields.requesterName,
    requestType: command.fields.requestType,
    description: command.fields.description,
  });
  if (!checked.ok) {
    return reject({ kind: 'validation', errors: checked.errors });
  }
  const { requesterName, requestType, description } = checked.values;
  const entry = createAuditEntry({
    timestamp: now,
    role,
    action: rule.auditAction,
    fromStatus: '',
    toStatus: '',
  });
  const request: ServiceRequest = {
    id: nextRequestId(requests),
    requesterName,
    requestType,
    description,
    priority: DEFAULT_PRIORITY,
    status: rule.to,
    lastUpdated: now,
    auditHistory: appendAuditEntry([], entry),
  };
  return { ok: true, requests: [...requests, request], request };
}

/** Applies `command` as `role` at ISO time `now`, checking target, then permission, then input; never changes `requests`. */
export function applyCommand(
  requests: readonly ServiceRequest[],
  command: Command,
  role: Role,
  now: string,
): CommandResult {
  if (command.type === 'create') {
    return applyCreate(requests, command, role, now);
  }
  const index = requests.findIndex((candidate) => candidate.id === command.id);
  const request = index === -1 ? undefined : requests[index];
  if (request === undefined) {
    return reject({ kind: 'notFound', message: `Request ${command.id} was not found.` });
  }
  const rule = findRule(command.type, role, request.status);
  if (rule === undefined) {
    return reject({
      kind: 'refused',
      message: `${RULES[command.type].label} is not available to the ${role} while the request is ${request.status}.`,
    });
  }
  const outcome = changeRequest({ request, rule, role, now }, command);
  if (!outcome.ok) {
    return outcome;
  }
  const updated = outcome.request;
  return {
    ok: true,
    requests: requests.map((existing, position) => (position === index ? updated : existing)),
    request: updated,
  };
}
