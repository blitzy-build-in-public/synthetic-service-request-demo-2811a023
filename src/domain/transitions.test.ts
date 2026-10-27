// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  TRANSITIONS,
  applyCommand,
  availableActions,
  findRule,
  isTerminal,
} from './transitions';
import type { ActionId, Command, CommandResult, DomainError } from './transitions';
import {
  AUDIT_ACTIONS,
  DEFAULT_PRIORITY,
  ROLES,
  STATUSES,
  formatRequestId,
  nextRequestId,
} from './model';
import type {
  AuditAction,
  AuditEntry,
  CreateFields,
  EditFields,
  Priority,
  Role,
  ServiceRequest,
  Status,
} from './model';
import {
  appendAuditEntry,
  createAuditEntry,
  describeEdit,
  latestInformationRequest,
} from './audit';

// A local copy rather than the one in src/test/helpers.tsx: that module pulls in React Testing
// Library and the App, and this node-environment suite must depend on src/domain only.
/** Recursively freezes `value`, so a mutation inside the domain throws in ES-module strict mode. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

type Accepted = Extract<CommandResult, { readonly ok: true }>;

function expectAccepted(result: CommandResult): Accepted {
  if (!result.ok) {
    throw new Error(`Expected the command to succeed, received ${JSON.stringify(result.error)}`);
  }
  return result;
}

function expectRejected(result: CommandResult): DomainError {
  if (result.ok) {
    throw new Error(
      `Expected a rejection, but ${result.request.id} reached ${result.request.status}`,
    );
  }
  return result.error;
}

function lastEntryOf(history: readonly AuditEntry[]): AuditEntry {
  const last = history.at(-1);
  if (last === undefined) {
    throw new Error('Expected a non-empty audit history.');
  }
  return last;
}

function requestAt(requests: readonly ServiceRequest[], index: number): ServiceRequest {
  const request = requests[index];
  if (request === undefined) {
    throw new Error(`Expected a request at position ${index}.`);
  }
  return request;
}

// The expected rows are written out here, independent of TRANSITIONS, so a changed table fails.
interface ExpectedRow {
  readonly action: ActionId;
  readonly role: Role;
  readonly from: Status | null;
  readonly to: Status;
}

const EXPECTED: readonly ExpectedRow[] = [
  { action: 'create', role: 'Requester', from: null, to: 'Draft' },
  { action: 'edit', role: 'Requester', from: 'Draft', to: 'Draft' },
  { action: 'submit', role: 'Requester', from: 'Draft', to: 'Submitted' },
  { action: 'startReview', role: 'Reviewer', from: 'Submitted', to: 'In Review' },
  { action: 'requestInfo', role: 'Reviewer', from: 'In Review', to: 'Waiting for Information' },
  { action: 'supplyInfo', role: 'Requester', from: 'Waiting for Information', to: 'In Review' },
  { action: 'complete', role: 'Reviewer', from: 'In Review', to: 'Completed' },
];

interface ExpectedPresentation {
  readonly label: string;
  readonly auditAction: AuditAction;
  readonly noteField: 'reason' | 'suppliedInformation' | null;
}

const EXPECTED_PRESENTATION: { readonly [A in ActionId]: ExpectedPresentation } = {
  create: { label: 'New request', auditAction: 'Created', noteField: null },
  edit: { label: 'Edit', auditAction: 'Edited', noteField: null },
  submit: { label: 'Submit', auditAction: 'Submitted', noteField: null },
  startReview: { label: 'Start review', auditAction: 'Review started', noteField: null },
  requestInfo: {
    label: 'Request more information',
    auditAction: 'Information requested',
    noteField: 'reason',
  },
  supplyInfo: {
    label: 'Supply information',
    auditAction: 'Information supplied',
    noteField: 'suppliedInformation',
  },
  complete: { label: 'Complete', auditAction: 'Completed', noteField: null },
};

const ACTIONS: readonly ActionId[] = [
  'create',
  'edit',
  'submit',
  'startReview',
  'requestInfo',
  'supplyInfo',
  'complete',
];

const EXISTING_REQUEST_ACTIONS: readonly Exclude<ActionId, 'create'>[] = [
  'edit',
  'submit',
  'startReview',
  'requestInfo',
  'supplyInfo',
  'complete',
];

const FROM_STATES: readonly (Status | null)[] = [null, ...STATUSES];

function expectedRow(action: ActionId, role: Role, from: Status | null): ExpectedRow | undefined {
  return EXPECTED.find((row) => row.action === action && row.role === role && row.from === from);
}

const NOW = '2026-03-01T10:00:00.000Z';
const LATER = '2026-03-01T10:05:00.000Z';
const TYPE_INVALID =
  'Request type must be one of Access Request, Equipment Request, General Question.';
const REASON = 'Please confirm the fictional desk number.';
const SUPPLIED = 'The fictional desk number is D-12.';

// Matches makeRequest's defaults, so an edit with these fields changes nothing but adds an entry.
const VALID_EDIT_FIELDS: EditFields = {
  requesterName: 'Riley Test',
  requestType: 'Equipment Request',
  description: 'A fictional second monitor for the test desk.',
  priority: 'Normal',
};

const VALID_CREATE_FIELDS: CreateFields = {
  requesterName: 'Morgan Trial',
  requestType: 'Access Request',
  description: 'Read access to a fictional evaluation folder.',
};

const CREATED: AuditEntry = {
  timestamp: '2026-03-01T08:00:00.000Z',
  role: 'Requester',
  action: 'Created',
  fromStatus: '',
  toStatus: '',
};
const SUBMITTED: AuditEntry = {
  timestamp: '2026-03-01T08:10:00.000Z',
  role: 'Requester',
  action: 'Submitted',
  fromStatus: 'Draft',
  toStatus: 'Submitted',
};
const REVIEW_STARTED: AuditEntry = {
  timestamp: '2026-03-01T08:20:00.000Z',
  role: 'Reviewer',
  action: 'Review started',
  fromStatus: 'Submitted',
  toStatus: 'In Review',
};
const INFORMATION_REQUESTED: AuditEntry = {
  timestamp: '2026-03-01T08:30:00.000Z',
  role: 'Reviewer',
  action: 'Information requested',
  fromStatus: 'In Review',
  toStatus: 'Waiting for Information',
  note: 'Which fictional floor is the desk on?',
};
const COMPLETED: AuditEntry = {
  timestamp: '2026-03-01T08:40:00.000Z',
  role: 'Reviewer',
  action: 'Completed',
  fromStatus: 'In Review',
  toStatus: 'Completed',
};

// A history consistent with each status, as the workflow would have produced it.
const HISTORIES: { readonly [S in Status]: readonly AuditEntry[] } = {
  Draft: [CREATED],
  Submitted: [CREATED, SUBMITTED],
  'In Review': [CREATED, SUBMITTED, REVIEW_STARTED],
  'Waiting for Information': [CREATED, SUBMITTED, REVIEW_STARTED, INFORMATION_REQUESTED],
  Completed: [CREATED, SUBMITTED, REVIEW_STARTED, COMPLETED],
};

/** A fully valid request in `status` from fresh objects; `lastUpdated` is its last timestamp. */
function makeRequest(status: Status, overrides: Partial<ServiceRequest> = {}): ServiceRequest {
  const auditHistory = overrides.auditHistory ?? HISTORIES[status].map((entry) => ({ ...entry }));
  return {
    id: 'REQ-0001',
    requesterName: VALID_EDIT_FIELDS.requesterName,
    requestType: 'Equipment Request',
    description: VALID_EDIT_FIELDS.description,
    priority: 'Normal',
    status,
    lastUpdated: lastEntryOf(auditHistory).timestamp,
    ...overrides,
    auditHistory,
  };
}

/** A command for `action` on `id` whose input passes validation: valid fields, or a valid note. */
function validCommandFor(action: ActionId, id: string): Command {
  switch (action) {
    case 'create':
      return { type: 'create', fields: VALID_CREATE_FIELDS };
    case 'edit':
      return { type: 'edit', id, fields: VALID_EDIT_FIELDS };
    case 'submit':
      return { type: 'submit', id };
    case 'startReview':
      return { type: 'startReview', id };
    case 'requestInfo':
      return { type: 'requestInfo', id, note: REASON };
    case 'supplyInfo':
      return { type: 'supplyInfo', id, note: SUPPLIED };
    case 'complete':
      return { type: 'complete', id };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

// Built independently of the domain: Created stores two empty statuses, Edited an empty `toStatus`.
/** The entry a permitted row appends when run at `now` with `validCommandFor`'s input. */
function expectedEntry(row: ExpectedRow, now: string): AuditEntry {
  const fromStatus = row.from ?? '';
  const toStatus = row.action === 'create' || row.action === 'edit' ? '' : row.to;
  const note =
    row.action === 'requestInfo' ? REASON : row.action === 'supplyInfo' ? SUPPLIED : undefined;
  const entry: AuditEntry = {
    timestamp: now,
    role: row.role,
    action: EXPECTED_PRESENTATION[row.action].auditAction,
    fromStatus,
    toStatus,
  };
  return note === undefined ? entry : { ...entry, note };
}

function refusalMessage(action: ActionId, role: Role, status: Status | null): string {
  if (status === null) {
    return `Create is not available to the ${role}.`;
  }
  const { label } = EXPECTED_PRESENTATION[action];
  return `${label} is not available to the ${role} while the request is ${status}.`;
}

interface GridCase {
  readonly action: ActionId;
  readonly role: Role;
  readonly status: Status | null;
  readonly expected: ExpectedRow | undefined;
}

function gridCase(action: ActionId, role: Role, status: Status | null): GridCase {
  return { action, role, status, expected: expectedRow(action, role, status) };
}

// Every (action, role, from-state) combination, including the pseudo-state `null` before creation.
const PERMISSION_GRID: readonly GridCase[] = ACTIONS.flatMap((action) =>
  ROLES.flatMap((role) => FROM_STATES.map((status) => gridCase(action, role, status))),
);

// The combinations applyCommand can be asked to run: create from no request, and every other
// action against a request in each of the five statuses.
const EXECUTION_GRID: readonly GridCase[] = [
  ...ROLES.map((role) => gridCase('create', role, null)),
  ...EXISTING_REQUEST_ACTIONS.flatMap((action) =>
    ROLES.flatMap((role) => STATUSES.map((status) => gridCase(action, role, status))),
  ),
];

const PERMITTED_EXECUTIONS = EXECUTION_GRID.flatMap((entry) =>
  entry.expected === undefined ? [] : [{ ...entry, row: entry.expected }],
);

const REFUSED_EXECUTIONS = EXECUTION_GRID.filter((entry) => entry.expected === undefined);

describe('TRANSITIONS', () => {
  it('holds exactly the seven rows of the transition table, in table order', () => {
    expect(TRANSITIONS.map(({ action, role, from, to }) => ({ action, role, from, to }))).toEqual(
      EXPECTED,
    );
  });

  it('labels each row and names its audit action and required note', () => {
    expect(
      TRANSITIONS.map(({ action, label, auditAction, noteField }) => ({
        action,
        label,
        auditAction,
        noteField,
      })),
    ).toEqual(EXPECTED.map(({ action }) => ({ action, ...EXPECTED_PRESENTATION[action] })));
  });

  it('records one distinct audit action per row, in the order of AUDIT_ACTIONS', () => {
    expect(TRANSITIONS.map((rule) => rule.auditAction)).toEqual([...AUDIT_ACTIONS]);
  });
});

describe('findRule permission grid', () => {
  it('covers all 84 combinations, of which exactly 7 are permitted', () => {
    expect(PERMISSION_GRID).toHaveLength(84);
    expect(PERMISSION_GRID.filter((entry) => entry.expected !== undefined)).toHaveLength(7);
    const found = PERMISSION_GRID.filter(({ action, role, status }) =>
      findRule(action, role, status),
    );
    expect(found).toHaveLength(7);
  });

  it.each(PERMISSION_GRID)(
    'decides $action as $role from $status',
    ({ action, role, status, expected }) => {
      const rule = findRule(action, role, status);
      if (expected === undefined) {
        expect(rule).toBeUndefined();
        return;
      }
      expect(rule).toMatchObject({ action, role, from: status, to: expected.to });
    },
  );
});

describe('applyCommand execution grid', () => {
  it('covers all 62 executable combinations: 7 succeed and 55 are refused', () => {
    expect(EXECUTION_GRID).toHaveLength(62);
    expect(PERMITTED_EXECUTIONS).toHaveLength(7);
    expect(REFUSED_EXECUTIONS).toHaveLength(55);
  });

  it.each(PERMITTED_EXECUTIONS)(
    'applies $action as $role from $status',
    ({ action, role, status, row }) => {
      // Create runs beside an existing request, so the new ID and the untouched neighbour count.
      const requests = deepFreeze([makeRequest(status ?? 'Draft')]);
      const snapshot = structuredClone(requests);
      const existing = requestAt(requests, 0);

      const accepted = expectAccepted(
        applyCommand(requests, validCommandFor(action, 'REQ-0001'), role, NOW),
      );

      const previousHistory = status === null ? [] : existing.auditHistory;
      const history = accepted.request.auditHistory;
      expect(accepted.request.status).toBe(row.to);
      expect(history).toHaveLength(previousHistory.length + 1);
      expect(history.slice(0, -1)).toEqual(structuredClone(previousHistory));
      expect(lastEntryOf(history)).toStrictEqual(expectedEntry(row, NOW));
      expect(accepted.request.lastUpdated).toBe(NOW);
      expect(lastEntryOf(history).timestamp).toBe(accepted.request.lastUpdated);
      expect(requests).toEqual(snapshot);
      if (status === null) {
        expect(accepted.request.id).toBe('REQ-0002');
        expect(accepted.requests).toHaveLength(2);
        expect(accepted.requests[0]).toBe(existing);
        expect(accepted.requests[1]).toBe(accepted.request);
      } else {
        expect(accepted.request.id).toBe('REQ-0001');
        expect(accepted.requests).toHaveLength(1);
        expect(accepted.requests[0]).toBe(accepted.request);
      }
    },
  );

  it.each(REFUSED_EXECUTIONS)(
    'refuses $action as $role from $status',
    ({ action, role, status }) => {
      const requests = deepFreeze([makeRequest(status ?? 'Draft')]);
      const snapshot = structuredClone(requests);
      const existing = requestAt(requests, 0);

      const error = expectRejected(
        applyCommand(requests, validCommandFor(action, 'REQ-0001'), role, NOW),
      );

      expect(error).toEqual({ kind: 'refused', message: refusalMessage(action, role, status) });
      expect(requests).toEqual(snapshot);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toBe(existing);
    },
  );

  it('words a refusal with the action label, the role and the current status', () => {
    const requests = deepFreeze([makeRequest('Draft')]);
    expect(
      expectRejected(
        applyCommand(requests, { type: 'complete', id: 'REQ-0001' }, 'Requester', NOW),
      ),
    ).toEqual({
      kind: 'refused',
      message: 'Complete is not available to the Requester while the request is Draft.',
    });
    expect(
      expectRejected(applyCommand(requests, validCommandFor('create', ''), 'Reviewer', NOW)),
    ).toEqual({ kind: 'refused', message: 'Create is not available to the Reviewer.' });
  });

  const PERMISSION_BEFORE_INPUT: readonly {
    readonly label: string;
    readonly status: Status;
    readonly role: Role;
    readonly command: Command;
    readonly message: string;
  }[] = [
    {
      label: 'create with invalid fields as the Reviewer',
      status: 'Draft',
      role: 'Reviewer',
      command: {
        type: 'create',
        fields: { requesterName: 'R'.repeat(81), requestType: 'Other', description: '' },
      },
      message: 'Create is not available to the Reviewer.',
    },
    {
      label: 'a blank reason as the Requester',
      status: 'In Review',
      role: 'Requester',
      command: { type: 'requestInfo', id: 'REQ-0001', note: '   ' },
      message:
        'Request more information is not available to the Requester while the request is In Review.',
    },
    {
      label: 'an invalid priority on a submitted request',
      status: 'Submitted',
      role: 'Requester',
      command: { type: 'edit', id: 'REQ-0001', fields: { ...VALID_EDIT_FIELDS, priority: 'High' } },
      message: 'Edit is not available to the Requester while the request is Submitted.',
    },
  ];

  it.each(PERMISSION_BEFORE_INPUT)(
    'checks permission before input: $label is refused, not invalid',
    ({ status, role, command, message }) => {
      const requests = deepFreeze([makeRequest(status)]);
      expect(expectRejected(applyCommand(requests, command, role, NOW))).toEqual({
        kind: 'refused',
        message,
      });
    },
  );
});

describe('availableActions and isTerminal', () => {
  const OFFER_CASES = ROLES.flatMap((role) =>
    FROM_STATES.map((status) => ({
      role,
      status,
      actions: EXPECTED.filter((row) => row.role === role && row.from === status).map(
        (row) => row.action,
      ),
    })),
  );

  it('covers both roles at the list view and in each of the five statuses', () => {
    expect(OFFER_CASES).toHaveLength(12);
  });

  it.each(OFFER_CASES)(
    'offers the $role at $status exactly the permitted rows',
    ({ role, status, actions }) => {
      const offered = availableActions(role, status);
      expect(offered.map((rule) => rule.action)).toEqual(actions);
      for (const rule of offered) {
        expect(findRule(rule.action, role, status)).toBe(rule);
      }
    },
  );

  const OFFERED_TABLE: readonly {
    readonly role: Role;
    readonly status: Status | null;
    readonly actions: readonly ActionId[];
  }[] = [
    { role: 'Requester', status: null, actions: ['create'] },
    { role: 'Reviewer', status: null, actions: [] },
    { role: 'Requester', status: 'Draft', actions: ['edit', 'submit'] },
    { role: 'Reviewer', status: 'Draft', actions: [] },
    { role: 'Requester', status: 'Submitted', actions: [] },
    { role: 'Reviewer', status: 'Submitted', actions: ['startReview'] },
    { role: 'Requester', status: 'In Review', actions: [] },
    { role: 'Reviewer', status: 'In Review', actions: ['requestInfo', 'complete'] },
    { role: 'Requester', status: 'Waiting for Information', actions: ['supplyInfo'] },
    { role: 'Reviewer', status: 'Waiting for Information', actions: [] },
    { role: 'Requester', status: 'Completed', actions: [] },
    { role: 'Reviewer', status: 'Completed', actions: [] },
  ];

  it.each(OFFERED_TABLE)(
    'matches the offered-actions table for the $role at $status',
    ({ role, status, actions }) => {
      expect(availableActions(role, status).map((rule) => rule.action)).toEqual(actions);
    },
  );

  it.each(STATUSES)('derives whether %s is terminal from the table', (status) => {
    expect(isTerminal(status)).toBe(status === 'Completed');
  });
});


describe('create', () => {
  it('starts REQ-0001 in Draft with Normal priority, trimmed fields and one Created entry', () => {
    const requests: readonly ServiceRequest[] = deepFreeze([]);
    const accepted = expectAccepted(
      applyCommand(
        requests,
        {
          type: 'create',
          fields: {
            requesterName: '  Riley Test  ',
            requestType: ' Access Request ',
            description: '\tA fictional visitor badge.\n',
          },
        },
        'Requester',
        NOW,
      ),
    );

    expect(accepted.request).toStrictEqual({
      id: 'REQ-0001',
      requesterName: 'Riley Test',
      requestType: 'Access Request',
      description: 'A fictional visitor badge.',
      priority: DEFAULT_PRIORITY,
      status: 'Draft',
      lastUpdated: NOW,
      auditHistory: [
        { timestamp: NOW, role: 'Requester', action: 'Created', fromStatus: '', toStatus: '' },
      ],
    });
    expect(accepted.request.priority).toBe('Normal');
    expect(lastEntryOf(accepted.request.auditHistory)).not.toHaveProperty('note');
    expect(accepted.requests).toEqual([accepted.request]);
  });

  it('accepts a blank draft, since required fields are checked only at Submit', () => {
    const accepted = expectAccepted(
      applyCommand(
        deepFreeze([]),
        { type: 'create', fields: { requesterName: '   ', requestType: '', description: '' } },
        'Requester',
        NOW,
      ),
    );
    expect(accepted.request).toMatchObject({
      requesterName: '',
      requestType: '',
      description: '',
      priority: 'Normal',
      status: 'Draft',
    });
    expect(accepted.request.auditHistory).toHaveLength(1);
  });

  it('starts every new request as Normal even when the fields object carries a priority', () => {
    const fields: EditFields = { ...VALID_CREATE_FIELDS, priority: 'Urgent' };
    const accepted = expectAccepted(
      applyCommand(deepFreeze([]), { type: 'create', fields }, 'Requester', NOW),
    );
    expect(accepted.request.priority).toBe('Normal');
  });

  it('rejects a request type outside the three without creating a request', () => {
    const requests = deepFreeze([makeRequest('Draft')]);
    const snapshot = structuredClone(requests);
    const error = expectRejected(
      applyCommand(
        requests,
        { type: 'create', fields: { ...VALID_CREATE_FIELDS, requestType: 'Other' } },
        'Requester',
        NOW,
      ),
    );
    expect(error).toEqual({ kind: 'validation', errors: { requestType: TYPE_INVALID } });
    expect(requests).toEqual(snapshot);
  });

  it('gives the next sequential ID, appends the request last and keeps the others', () => {
    const requests = deepFreeze([
      makeRequest('Draft'),
      makeRequest('In Review', { id: 'REQ-0002' }),
      makeRequest('Waiting for Information', { id: 'REQ-0003' }),
    ]);
    const accepted = expectAccepted(
      applyCommand(requests, validCommandFor('create', ''), 'Requester', NOW),
    );
    expect(accepted.request.id).toBe('REQ-0004');
    expect(accepted.requests.map((request) => request.id)).toEqual([
      'REQ-0001',
      'REQ-0002',
      'REQ-0003',
      'REQ-0004',
    ]);
    requests.forEach((request, index) => {
      expect(accepted.requests[index]).toBe(request);
    });
    expect(accepted.requests[3]).toBe(accepted.request);
  });
});

describe('edit', () => {
  it('appends an Edited entry without a note on every save, even when nothing changed', () => {
    const original = deepFreeze([makeRequest('Draft')]);
    const first = expectAccepted(
      applyCommand(original, validCommandFor('edit', 'REQ-0001'), 'Requester', NOW),
    );
    const second = expectAccepted(
      applyCommand(
        deepFreeze(first.requests),
        validCommandFor('edit', 'REQ-0001'),
        'Requester',
        LATER,
      ),
    );

    const edited: AuditEntry = {
      timestamp: NOW,
      role: 'Requester',
      action: 'Edited',
      fromStatus: 'Draft',
      toStatus: '',
    };
    expect(second.request.auditHistory).toStrictEqual([
      CREATED,
      edited,
      { ...edited, timestamp: LATER },
    ]);
    expect(lastEntryOf(first.request.auditHistory)).not.toHaveProperty('note');
    expect(lastEntryOf(second.request.auditHistory)).not.toHaveProperty('note');
    expect(second.request).toMatchObject({
      requesterName: VALID_EDIT_FIELDS.requesterName,
      requestType: VALID_EDIT_FIELDS.requestType,
      description: VALID_EDIT_FIELDS.description,
      priority: 'Normal',
      status: 'Draft',
      lastUpdated: LATER,
    });
  });

  const PRIORITY_CHANGES: readonly {
    readonly before: Priority;
    readonly after: Priority;
    readonly note: string;
  }[] = [
    { before: 'Normal', after: 'Urgent', note: 'Priority: Normal to Urgent' },
    { before: 'Urgent', after: 'Normal', note: 'Priority: Urgent to Normal' },
  ];

  it.each(PRIORITY_CHANGES)(
    'records "$note" when the priority changes from $before to $after',
    ({ before, after, note }) => {
      const requests = deepFreeze([makeRequest('Draft', { priority: before })]);
      const accepted = expectAccepted(
        applyCommand(
          requests,
          { type: 'edit', id: 'REQ-0001', fields: { ...VALID_EDIT_FIELDS, priority: after } },
          'Requester',
          NOW,
        ),
      );
      expect(accepted.request.priority).toBe(after);
      expect(lastEntryOf(accepted.request.auditHistory)).toStrictEqual({
        timestamp: NOW,
        role: 'Requester',
        action: 'Edited',
        fromStatus: 'Draft',
        toStatus: '',
        note,
      });
    },
  );

  it('replaces all four fields with their trimmed values and keeps the request in Draft', () => {
    const requests = deepFreeze([makeRequest('Draft')]);
    const accepted = expectAccepted(
      applyCommand(
        requests,
        {
          type: 'edit',
          id: 'REQ-0001',
          fields: {
            requesterName: '  Morgan Trial ',
            requestType: ' General Question',
            description: ' How does this fictional desk get booked? ',
            priority: 'Urgent',
          },
        },
        'Requester',
        NOW,
      ),
    );
    expect(accepted.request).toStrictEqual({
      id: 'REQ-0001',
      requesterName: 'Morgan Trial',
      requestType: 'General Question',
      description: 'How does this fictional desk get booked?',
      priority: 'Urgent',
      status: 'Draft',
      lastUpdated: NOW,
      auditHistory: [
        CREATED,
        {
          timestamp: NOW,
          role: 'Requester',
          action: 'Edited',
          fromStatus: 'Draft',
          toStatus: '',
          note: 'Priority: Normal to Urgent',
        },
      ],
    });
  });

  it('accepts only Normal and Urgent as the priority', () => {
    const requests = deepFreeze([makeRequest('Draft')]);
    const snapshot = structuredClone(requests);
    const error = expectRejected(
      applyCommand(
        requests,
        { type: 'edit', id: 'REQ-0001', fields: { ...VALID_EDIT_FIELDS, priority: 'High' } },
        'Requester',
        NOW,
      ),
    );
    expect(error).toEqual({
      kind: 'validation',
      errors: { priority: 'Priority must be Normal or Urgent.' },
    });
    expect(requests).toEqual(snapshot);
  });
});

describe('submit', () => {
  const INCOMPLETE_DRAFTS: readonly {
    readonly label: string;
    readonly overrides: Partial<ServiceRequest>;
    readonly errors: Readonly<Record<string, string>>;
  }[] = [
    {
      label: 'a blank requester name',
      overrides: { requesterName: '' },
      errors: { requesterName: 'Requester name is required.' },
    },
    {
      label: 'no request type',
      overrides: { requestType: '' },
      errors: { requestType: 'Request type is required.' },
    },
    {
      label: 'a blank description',
      overrides: { description: '' },
      errors: { description: 'Description is required.' },
    },
    {
      label: 'a whitespace-only description',
      overrides: { description: ' \t ' },
      errors: { description: 'Description is required.' },
    },
    {
      label: 'all three fields blank',
      overrides: { requesterName: '', requestType: '', description: '' },
      errors: {
        requesterName: 'Requester name is required.',
        requestType: 'Request type is required.',
        description: 'Description is required.',
      },
    },
  ];

  it.each(INCOMPLETE_DRAFTS)(
    'blocks a Draft with $label and changes neither status, history nor lastUpdated',
    ({ overrides, errors }) => {
      const requests = deepFreeze([makeRequest('Draft', overrides)]);
      const snapshot = structuredClone(requests);
      const error = expectRejected(
        applyCommand(requests, { type: 'submit', id: 'REQ-0001' }, 'Requester', NOW),
      );
      expect(error).toEqual({ kind: 'validation', errors });
      expect(requests).toEqual(snapshot);
      expect(requestAt(requests, 0)).toMatchObject({
        status: 'Draft',
        lastUpdated: CREATED.timestamp,
        auditHistory: [CREATED],
      });
    },
  );
});


describe('full lifecycle history', () => {
  const LIFECYCLE_ID = 'REQ-0001';
  const FIRST_REASON = 'Please confirm the fictional desk number.';
  const FIRST_ANSWER = 'The fictional desk number is D-12.';
  const SECOND_REASON = 'Please also confirm the fictional floor.';
  const SECOND_ANSWER = 'The fictional floor is the third.';

  interface Step {
    readonly role: Role;
    readonly now: string;
    readonly command: Command;
    readonly action: AuditAction;
    readonly status: Status;
  }

  // Notes carry surrounding whitespace to prove they are stored trimmed; the edit keeps the created
  // values, so every field is expected to stay as created throughout.
  const STEPS: readonly Step[] = [
    {
      role: 'Requester',
      now: '2026-03-02T09:00:00.000Z',
      command: validCommandFor('create', LIFECYCLE_ID),
      action: 'Created',
      status: 'Draft',
    },
    {
      role: 'Requester',
      now: '2026-03-02T09:01:00.000Z',
      command: {
        type: 'edit',
        id: LIFECYCLE_ID,
        fields: { ...VALID_CREATE_FIELDS, priority: 'Normal' },
      },
      action: 'Edited',
      status: 'Draft',
    },
    {
      role: 'Requester',
      now: '2026-03-02T09:02:00.000Z',
      command: { type: 'submit', id: LIFECYCLE_ID },
      action: 'Submitted',
      status: 'Submitted',
    },
    {
      role: 'Reviewer',
      now: '2026-03-02T09:03:00.000Z',
      command: { type: 'startReview', id: LIFECYCLE_ID },
      action: 'Review started',
      status: 'In Review',
    },
    {
      role: 'Reviewer',
      now: '2026-03-02T09:04:00.000Z',
      command: { type: 'requestInfo', id: LIFECYCLE_ID, note: `  ${FIRST_REASON}  ` },
      action: 'Information requested',
      status: 'Waiting for Information',
    },
    {
      role: 'Requester',
      now: '2026-03-02T09:05:00.000Z',
      command: { type: 'supplyInfo', id: LIFECYCLE_ID, note: `\n${FIRST_ANSWER}\t` },
      action: 'Information supplied',
      status: 'In Review',
    },
    {
      role: 'Reviewer',
      now: '2026-03-02T09:06:00.000Z',
      command: { type: 'requestInfo', id: LIFECYCLE_ID, note: ` ${SECOND_REASON}` },
      action: 'Information requested',
      status: 'Waiting for Information',
    },
    {
      role: 'Requester',
      now: '2026-03-02T09:07:00.000Z',
      command: { type: 'supplyInfo', id: LIFECYCLE_ID, note: `${SECOND_ANSWER} ` },
      action: 'Information supplied',
      status: 'In Review',
    },
    {
      role: 'Reviewer',
      now: '2026-03-02T09:08:00.000Z',
      command: { type: 'complete', id: LIFECYCLE_ID },
      action: 'Completed',
      status: 'Completed',
    },
  ];

  interface StepOutcome {
    readonly step: Step;
    /** The history before the step, as the step's frozen input held it. */
    readonly before: readonly AuditEntry[];
    /** A deep copy of `before` taken ahead of the step. */
    readonly beforeSnapshot: readonly AuditEntry[];
    readonly request: ServiceRequest;
  }

  function runLifecycle(): readonly StepOutcome[] {
    let requests: readonly ServiceRequest[] = deepFreeze([]);
    return STEPS.map((step) => {
      const before = requests.find((request) => request.id === LIFECYCLE_ID)?.auditHistory ?? [];
      const beforeSnapshot = structuredClone(before);
      const accepted = expectAccepted(applyCommand(requests, step.command, step.role, step.now));
      requests = deepFreeze(accepted.requests);
      return { step, before, beforeSnapshot, request: accepted.request };
    });
  }

  it('appends exactly one entry per step and keeps every earlier entry as it was', () => {
    const outcomes = runLifecycle();
    expect(outcomes).toHaveLength(9);
    for (const { step, before, beforeSnapshot, request } of outcomes) {
      const history = request.auditHistory;
      expect(history).toHaveLength(beforeSnapshot.length + 1);
      expect(history.slice(0, -1)).toEqual(beforeSnapshot);
      before.forEach((entry, index) => {
        expect(history[index]).toBe(entry);
      });
      expect(lastEntryOf(history)).toMatchObject({
        timestamp: step.now,
        role: step.role,
        action: step.action,
      });
      expect(request.status).toBe(step.status);
      expect(request.lastUpdated).toBe(step.now);
    }
  });

  it('ends Completed with the full history in append order and no action for either role', () => {
    const final = lastOutcome(runLifecycle()).request;
    expect(final.status).toBe('Completed');
    expect(
      final.auditHistory.map(({ role, action, fromStatus, toStatus }) => ({
        role,
        action,
        fromStatus,
        toStatus,
      })),
    ).toEqual([
      { role: 'Requester', action: 'Created', fromStatus: '', toStatus: '' },
      { role: 'Requester', action: 'Edited', fromStatus: 'Draft', toStatus: '' },
      { role: 'Requester', action: 'Submitted', fromStatus: 'Draft', toStatus: 'Submitted' },
      {
        role: 'Reviewer',
        action: 'Review started',
        fromStatus: 'Submitted',
        toStatus: 'In Review',
      },
      {
        role: 'Reviewer',
        action: 'Information requested',
        fromStatus: 'In Review',
        toStatus: 'Waiting for Information',
      },
      {
        role: 'Requester',
        action: 'Information supplied',
        fromStatus: 'Waiting for Information',
        toStatus: 'In Review',
      },
      {
        role: 'Reviewer',
        action: 'Information requested',
        fromStatus: 'In Review',
        toStatus: 'Waiting for Information',
      },
      {
        role: 'Requester',
        action: 'Information supplied',
        fromStatus: 'Waiting for Information',
        toStatus: 'In Review',
      },
      { role: 'Reviewer', action: 'Completed', fromStatus: 'In Review', toStatus: 'Completed' },
    ]);
    expect(final.auditHistory.map((entry) => entry.timestamp)).toEqual(
      STEPS.map((step) => step.now),
    );
    for (const role of ROLES) {
      expect(availableActions(role, final.status)).toEqual([]);
    }
    expect(isTerminal(final.status)).toBe(true);
  });

  it('stores notes trimmed and reports the most recent reason', () => {
    const outcomes = runLifecycle();
    expect(lastOutcome(outcomes).request.auditHistory.map((entry) => entry.note)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      FIRST_REASON,
      FIRST_ANSWER,
      SECOND_REASON,
      SECOND_ANSWER,
      undefined,
    ]);
    expect(latestInformationRequest(outcomeAt(outcomes, 3).request)).toBeUndefined();
    expect(latestInformationRequest(outcomeAt(outcomes, 4).request)).toBe(FIRST_REASON);
    expect(latestInformationRequest(outcomeAt(outcomes, 6).request)).toBe(SECOND_REASON);
    expect(latestInformationRequest(lastOutcome(outcomes).request)).toBe(SECOND_REASON);
  });

  it('keeps the priority Normal and changes no field outside Edit', () => {
    for (const { request } of runLifecycle()) {
      expect({
        requesterName: request.requesterName,
        requestType: request.requestType,
        description: request.description,
        priority: request.priority,
      }).toEqual({ ...VALID_CREATE_FIELDS, priority: 'Normal' });
    }
  });

  it('refuses Edit in every status after submission', () => {
    const submitted = runLifecycle().slice(2);
    expect(submitted.map(({ request }) => request.status)).toEqual([
      'Submitted',
      'In Review',
      'Waiting for Information',
      'In Review',
      'Waiting for Information',
      'In Review',
      'Completed',
    ]);
    for (const { request } of submitted) {
      const requests = deepFreeze([request]);
      const error = expectRejected(
        applyCommand(
          requests,
          {
            type: 'edit',
            id: LIFECYCLE_ID,
            fields: { ...VALID_CREATE_FIELDS, priority: 'Urgent' },
          },
          'Requester',
          LATER,
        ),
      );
      expect(error).toEqual({
        kind: 'refused',
        message: `Edit is not available to the Requester while the request is ${request.status}.`,
      });
      expect(request.priority).toBe('Normal');
    }
  });

  function outcomeAt(outcomes: readonly StepOutcome[], index: number): StepOutcome {
    const outcome = outcomes[index];
    if (outcome === undefined) {
      throw new Error(`Expected an outcome for step ${index}.`);
    }
    return outcome;
  }

  function lastOutcome(outcomes: readonly StepOutcome[]): StepOutcome {
    return outcomeAt(outcomes, outcomes.length - 1);
  }
});

describe('history ordering', () => {
  it('keeps append order and the given timestamps when the clock repeats or goes back', () => {
    const times = [
      '2026-03-01T10:00:00.000Z',
      '2026-03-01T10:00:00.000Z',
      '2026-03-01T09:00:00.000Z',
    ];
    let requests: readonly ServiceRequest[] = deepFreeze([makeRequest('Draft')]);
    for (const now of times) {
      const accepted = expectAccepted(
        applyCommand(requests, validCommandFor('edit', 'REQ-0001'), 'Requester', now),
      );
      expect(accepted.request.lastUpdated).toBe(now);
      requests = deepFreeze(accepted.requests);
    }

    const request = requestAt(requests, 0);
    expect(request.auditHistory.map(({ action, timestamp }) => ({ action, timestamp }))).toEqual([
      { action: 'Created', timestamp: CREATED.timestamp },
      { action: 'Edited', timestamp: '2026-03-01T10:00:00.000Z' },
      { action: 'Edited', timestamp: '2026-03-01T10:00:00.000Z' },
      { action: 'Edited', timestamp: '2026-03-01T09:00:00.000Z' },
    ]);
    // The latest appended entry decides lastUpdated, not the latest timestamp.
    expect(request.lastUpdated).toBe('2026-03-01T09:00:00.000Z');
  });
});

describe('independent requests', () => {
  it('changes only the targeted request when several are waiting for information', () => {
    const requests = deepFreeze([
      makeRequest('Waiting for Information'),
      makeRequest('Waiting for Information', { id: 'REQ-0002', requesterName: 'Morgan Trial' }),
    ]);
    const snapshot = structuredClone(requests);
    const first = requestAt(requests, 0);

    const accepted = expectAccepted(
      applyCommand(requests, validCommandFor('supplyInfo', 'REQ-0002'), 'Requester', NOW),
    );

    expect(requests).toEqual(snapshot);
    expect(accepted.request).toMatchObject({ id: 'REQ-0002', status: 'In Review' });
    expect(accepted.requests).toHaveLength(2);
    expect(accepted.requests[0]).toBe(first);
    expect(accepted.requests[1]).toBe(accepted.request);
    expect(availableActions('Requester', first.status).map((rule) => rule.action)).toEqual([
      'supplyInfo',
    ]);

    const second = expectAccepted(
      applyCommand(
        deepFreeze(accepted.requests),
        validCommandFor('supplyInfo', 'REQ-0001'),
        'Requester',
        LATER,
      ),
    );
    expect(second.requests.map((request) => request.status)).toEqual(['In Review', 'In Review']);
    expect(second.requests[1]).toBe(accepted.request);
  });
});

describe('unknown request IDs', () => {
  const NOT_FOUND_CASES = EXISTING_REQUEST_ACTIONS.flatMap((action) =>
    ROLES.map((role) => ({ action, role })),
  );

  it.each(NOT_FOUND_CASES)(
    'reports $action as the $role on REQ-0999 as not found',
    ({ action, role }) => {
      const requests = deepFreeze(
        STATUSES.map((status, index) => makeRequest(status, { id: formatRequestId(index + 1) })),
      );
      const snapshot = structuredClone(requests);
      const error = expectRejected(
        applyCommand(requests, validCommandFor(action, 'REQ-0999'), role, NOW),
      );
      expect(error).toEqual({ kind: 'notFound', message: 'Request REQ-0999 was not found.' });
      expect(requests).toEqual(snapshot);
    },
  );
});

describe('request IDs', () => {
  const NEXT_ID_CASES: readonly {
    readonly label: string;
    readonly ids: readonly string[];
    readonly next: string;
  }[] = [
    { label: 'an empty list', ids: [], next: 'REQ-0001' },
    { label: 'the three samples', ids: ['REQ-0001', 'REQ-0002', 'REQ-0003'], next: 'REQ-0004' },
    { label: 'a gap', ids: ['REQ-0001', 'REQ-0003'], next: 'REQ-0004' },
    { label: 'unordered IDs', ids: ['REQ-0007', 'REQ-0002'], next: 'REQ-0008' },
    { label: 'REQ-9999', ids: ['REQ-9999'], next: 'REQ-10000' },
    {
      label: 'non-matching IDs',
      ids: ['TICKET-0050', 'req-0040', 'REQ-12a', 'REQ-', 'REQ-0002'],
      next: 'REQ-0003',
    },
  ];

  it.each(NEXT_ID_CASES)('nextRequestId after $label is $next', ({ ids, next }) => {
    expect(nextRequestId(ids.map((id) => ({ id })))).toBe(next);
  });

  it.each([
    { n: 1, id: 'REQ-0001' },
    { n: 42, id: 'REQ-0042' },
    { n: 9999, id: 'REQ-9999' },
    { n: 10000, id: 'REQ-10000' },
  ])('formatRequestId($n) is $id', ({ n, id }) => {
    expect(formatRequestId(n)).toBe(id);
  });

  it.each([0, -1, 1.5])('formatRequestId(%s) throws a RangeError', (n) => {
    expect(() => formatRequestId(n)).toThrow(RangeError);
  });

  it('continues the sequence past REQ-9999 when creating', () => {
    const requests = deepFreeze([makeRequest('Completed', { id: 'REQ-9999' })]);
    const accepted = expectAccepted(
      applyCommand(requests, validCommandFor('create', ''), 'Requester', NOW),
    );
    expect(accepted.request.id).toBe('REQ-10000');
  });
});

describe('audit helpers', () => {
  const BASE_ENTRY: AuditEntry = {
    timestamp: NOW,
    role: 'Reviewer',
    action: 'Completed',
    fromStatus: 'In Review',
    toStatus: 'Completed',
  };

  it.each([
    { label: 'no note', note: undefined },
    { label: 'an empty note', note: '' },
  ])('createAuditEntry leaves out the note key for $label', ({ note }) => {
    const entry = createAuditEntry({ ...BASE_ENTRY, note });
    expect(entry).toStrictEqual(BASE_ENTRY);
    expect(entry).not.toHaveProperty('note');
  });

  it('createAuditEntry keeps a non-empty note', () => {
    expect(createAuditEntry({ ...BASE_ENTRY, note: 'A fictional note.' })).toStrictEqual({
      ...BASE_ENTRY,
      note: 'A fictional note.',
    });
  });

  it('appendAuditEntry returns a new array with the entry last and the original untouched', () => {
    const history = deepFreeze([{ ...CREATED }, { ...SUBMITTED }]);
    const snapshot = structuredClone(history);
    const entry = createAuditEntry(BASE_ENTRY);

    const appended = appendAuditEntry(history, entry);

    expect(appended).not.toBe(history);
    expect(history).toEqual(snapshot);
    expect(appended).toEqual([...snapshot, entry]);
    expect(appended[0]).toBe(history[0]);
    expect(appended[1]).toBe(history[1]);
    expect(appended.at(-1)).toBe(entry);
  });

  const EDIT_NOTES: readonly {
    readonly before: Priority;
    readonly after: Priority;
    readonly note: string | undefined;
  }[] = [
    { before: 'Normal', after: 'Normal', note: undefined },
    { before: 'Urgent', after: 'Urgent', note: undefined },
    { before: 'Normal', after: 'Urgent', note: 'Priority: Normal to Urgent' },
    { before: 'Urgent', after: 'Normal', note: 'Priority: Urgent to Normal' },
  ];

  it.each(EDIT_NOTES)(
    'describeEdit from $before to $after gives $note',
    ({ before, after, note }) => {
      expect(describeEdit({ priority: before }, after)).toBe(note);
    },
  );

  it('latestInformationRequest is undefined until a reason has been requested', () => {
    expect(latestInformationRequest(makeRequest('In Review'))).toBeUndefined();
    expect(latestInformationRequest(makeRequest('Waiting for Information'))).toBe(
      INFORMATION_REQUESTED.note,
    );
  });
});

