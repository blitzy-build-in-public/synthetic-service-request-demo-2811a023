// UI acceptance flows (AC1–AC4, AC6–AC8, AC10), UI edge cases, and accessibility announcements and
// focus, driven through the rendered app.
// Reload persistence (AC5 and the AC10 reload step) lives in reload.test.tsx, and the exhaustive
// transition grids in src/domain/transitions.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import type { CreateFields, Role, ServiceRequest } from '../domain/model';
import type { Command, CommandResult } from '../domain/transitions';
import type { AppStore } from '../state/store';
import { STORAGE_KEY } from '../storage/localStore';
import { createSampleRequests } from '../storage/sampleData';
import {
  clickAction,
  createFixedClock,
  createMemoryStorage,
  createRequest,
  detailsText,
  fillCreateForm,
  getDetailsValue,
  goToHash,
  openCreateForm,
  readTableRows,
  renderApp,
  ROLE_LABEL,
  switchRole,
  unavailableStorageGetter,
} from './helpers';

const BANNER_TEXT =
  'Demo only. Fictional data. Role switch is a simulation, not authentication. Data is stored in this browser only.';
const RESET_PROMPT = 'Replace all requests with the three sample requests? This cannot be undone.';
const STORAGE_WARNING =
  'Browser storage is unavailable or full. Changes will not persist after this session.';
const LOAD_ISSUE_ADVICE =
  'Reset to sample data to start again; any new change will also replace it.';
const COMPLETED_COPY = 'This request is completed. No further actions are available.';
const EM_DASH = '—';
const SAMPLE_IDS = ['REQ-0001', 'REQ-0002', 'REQ-0003'];

const VALID_FIELDS: CreateFields = {
  requesterName: 'Riley Test',
  requestType: 'Equipment Request',
  description: 'Fictional laptop stand for the demo.',
};

// Cell positions, left to right, of the list table and the audit history table.
const LIST_COLUMN = { id: 0, requesterName: 1, requestType: 2, priority: 3, status: 4, lastUpdated: 5 } as const;
const AUDIT_COLUMN = { timestamp: 0, role: 1, action: 2, from: 3, to: 4 } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function viewHeading(): string {
  return screen.getByRole('heading', { level: 1 }).textContent;
}

function actionsRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Actions' });
}

function actionButtons(): string[] {
  return within(actionsRegion())
    .queryAllByRole('button')
    .map((button) => button.textContent);
}

/** Opens the note form of `action`, types `text` into the field labelled `label`, and sends it with `send`. */
function sendNote(action: string, label: string, send: string, text: string): void {
  clickAction(action);
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: send }));
}

function auditTable(): HTMLElement {
  return screen.getByRole('table', { name: 'Audit history' });
}

function listTable(): HTMLElement {
  return screen.getByRole('table', { name: 'Service requests' });
}

function column(rows: readonly string[][], index: number): Array<string | undefined> {
  return rows.map((row) => row[index]);
}

function listRow(id: string): string[] {
  const row = readTableRows(listTable()).find((cells) => cells[LIST_COLUMN.id] === id);
  if (row === undefined) {
    throw new Error(`The request list has no row for ${id}.`);
  }
  return row;
}

/** Text of the element that `element`'s `aria-describedby` names, or null when it names none. */
function describedMessage(element: HTMLElement): string | null {
  const id = element.getAttribute('aria-describedby');
  const message = id === null ? null : document.getElementById(id);
  return message === null ? null : message.textContent;
}

function storedRequest(store: AppStore, id: string): ServiceRequest {
  const request = store.getState().requests.find((candidate) => candidate.id === id);
  if (request === undefined) {
    throw new Error(`The store holds no request ${id}.`);
  }
  return request;
}

// A holder rather than a `let`: TypeScript keeps a `let` narrowed to its initial undefined after a
// closure assigns it, so the result could not be read without a cast.
function dispatchInAct(store: AppStore, command: Command): CommandResult {
  const results: CommandResult[] = [];
  act(() => {
    results.push(store.dispatch(command));
  });
  const [result] = results;
  if (result === undefined) {
    throw new Error(`Dispatching ${command.type} returned no result.`);
  }
  return result;
}

function readEnvelope(storage: Storage): unknown {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) {
    throw new Error(`Nothing is stored under ${STORAGE_KEY}.`);
  }
  return JSON.parse(raw);
}

function confirmReset(scope: HTMLElement, trigger: string): void {
  fireEvent.click(within(scope).getByRole('button', { name: trigger }));
  fireEvent.click(
    within(within(scope).getByRole('group', { name: RESET_PROMPT })).getByRole('button', {
      name: 'Confirm reset',
    }),
  );
}

describe('AC1 missing description blocks submission', () => {
  it('AC1 shows the message beside Description and leaves the draft and its history unchanged', () => {
    const { store } = renderApp();
    createRequest({ requesterName: 'Riley Test', requestType: 'Access Request', description: '' });
    expect(viewHeading()).toBe('REQ-0004');
    const before = store.getState();

    clickAction('Submit');

    const description = getDetailsValue('Description');
    expect(within(description).queryByText('Description is required.')).not.toBeNull();
    expect(detailsText('Requester name')).toBe('Riley Test');
    expect(detailsText('Request type')).toBe('Access Request');
    expect(detailsText('Status')).toBe('Draft');
    expect(column(readTableRows(auditTable()), AUDIT_COLUMN.action)).toEqual(['Created']);
    expect(store.getState()).toBe(before);
    const request = storedRequest(store, 'REQ-0004');
    expect(request.status).toBe('Draft');
    expect(request.auditHistory).toHaveLength(1);
  });
});

describe('Submit feedback beside every required field', () => {
  it('a blank draft shows each required message beside its own row, and they clear after Edit and Submit', () => {
    const { store } = renderApp();
    // A blank draft is valid to save; the required checks run only at Submit.
    createRequest({ requesterName: '', requestType: '', description: '' });
    expect(viewHeading()).toBe('REQ-0004');
    const required = [
      { label: 'Requester name', message: 'Requester name is required.' },
      { label: 'Request type', message: 'Request type is required.' },
      { label: 'Description', message: 'Description is required.' },
    ];
    const messages = required.map(({ message }) => message);
    const before = store.getState();
    const storedBefore = window.localStorage.getItem(STORAGE_KEY);
    expect(storedBefore).not.toBeNull();

    clickAction('Submit');

    for (const { label, message } of required) {
      const row = within(getDetailsValue(label));
      expect(row.queryByText(message)).not.toBeNull();
      const others = messages.filter((other) => other !== message);
      expect(others.map((other) => row.queryByText(other))).toEqual([null, null]);
    }
    expect(detailsText('Status')).toBe('Draft');
    expect(column(readTableRows(auditTable()), AUDIT_COLUMN.action)).toEqual(['Created']);
    expect(store.getState()).toBe(before);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);

    clickAction('Edit');
    fireEvent.change(screen.getByLabelText('Requester name'), { target: { value: VALID_FIELDS.requesterName } });
    fireEvent.change(screen.getByLabelText('Request type'), { target: { value: VALID_FIELDS.requestType } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: VALID_FIELDS.description } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(messages.map((message) => screen.queryByText(message))).toEqual([null, null, null]);
    expect(detailsText('Requester name')).toBe(VALID_FIELDS.requesterName);
    expect(detailsText('Request type')).toBe(VALID_FIELDS.requestType);
    expect(detailsText('Description')).toBe(VALID_FIELDS.description);
    expect(detailsText('Status')).toBe('Draft');

    clickAction('Submit');

    expect(detailsText('Status')).toBe('Submitted');
    expect(messages.map((message) => screen.queryByText(message))).toEqual([null, null, null]);
    expect(column(readTableRows(auditTable()), AUDIT_COLUMN.action)).toEqual([
      'Created',
      'Edited',
      'Submitted',
    ]);
  });
});

describe('AC2 valid request reaches Completed', () => {
  it('AC2 records Created, Submitted, Review started and Completed in order, then offers nothing', () => {
    const { store } = renderApp({ now: createFixedClock('2026-03-02T08:00:00.000Z') });
    createRequest(VALID_FIELDS);
    clickAction('Submit');
    switchRole('Reviewer');
    clickAction('Start review');
    clickAction('Complete');

    expect(detailsText('Status')).toBe('Completed');
    const rows = readTableRows(auditTable());
    expect(column(rows, AUDIT_COLUMN.action)).toEqual([
      'Created',
      'Submitted',
      'Review started',
      'Completed',
    ]);
    expect(column(rows, AUDIT_COLUMN.role)).toEqual(['Requester', 'Requester', 'Reviewer', 'Reviewer']);
    expect(column(rows, AUDIT_COLUMN.from)).toEqual([EM_DASH, 'Draft', 'Submitted', 'In Review']);
    expect(column(rows, AUDIT_COLUMN.to)).toEqual([EM_DASH, 'Submitted', 'In Review', 'Completed']);
    const request = storedRequest(store, 'REQ-0004');
    expect(column(rows, AUDIT_COLUMN.timestamp)).toEqual(
      request.auditHistory.map((entry) => entry.timestamp),
    );
    expect(rows[0]?.[AUDIT_COLUMN.timestamp]).toBe('2026-03-02T08:00:00.000Z');
    expect(getDetailsValue('Last updated').querySelector('time')?.dateTime).toBe(request.lastUpdated);

    for (const role of ['Reviewer', 'Requester'] as const) {
      switchRole(role);
      expect(actionButtons()).toEqual([]);
      expect(actionsRegion().textContent).toBe(COMPLETED_COPY);
    }
  });
});

/** Returns a clock that yields `timestamps` in order, one per call, and throws once they run out. */
function createSequenceClock(timestamps: readonly string[]): () => string {
  let calls = 0;
  return () => {
    const timestamp = timestamps[calls];
    calls += 1;
    // An unplanned dispatch would otherwise take a value meant for a later command and shift every
    // timestamp after it.
    if (timestamp === undefined) {
      throw new Error(
        `createSequenceClock was called ${calls} times but holds only ${timestamps.length} timestamps.`,
      );
    }
    return timestamp;
  };
}

describe('Audit history keeps append order', () => {
  it('shows equal and earlier clock values in append order, and Last updated follows the last entry', () => {
    // Sorting by timestamp in either direction would move Created (08:00) off the first row, and the
    // last value is neither the earliest nor the latest, so neither a sort nor an extreme passes.
    const timestamps = [
      '2026-03-02T08:00:00.000Z',
      '2026-03-02T08:00:00.000Z',
      '2026-03-02T07:00:00.000Z',
      '2026-03-02T09:00:00.000Z',
      '2026-03-02T09:00:00.000Z',
      '2026-03-02T07:30:00.000Z',
    ];
    const reason = 'Please confirm the stand height you need.';
    const information = 'A fictional height of thirty centimetres.';
    const { store } = renderApp({ now: createSequenceClock(timestamps) });

    createRequest(VALID_FIELDS);
    clickAction('Submit');
    switchRole('Reviewer');
    clickAction('Start review');
    sendNote('Request more information', 'Reason', 'Send reason', reason);
    switchRole('Requester');
    sendNote('Supply information', 'Supplied information', 'Send information', information);
    switchRole('Reviewer');
    clickAction('Complete');

    expect(detailsText('Status')).toBe('Completed');
    expect(readTableRows(auditTable())).toEqual([
      ['2026-03-02T08:00:00.000Z', 'Requester', 'Created', EM_DASH, EM_DASH, EM_DASH],
      ['2026-03-02T08:00:00.000Z', 'Requester', 'Submitted', 'Draft', 'Submitted', EM_DASH],
      ['2026-03-02T07:00:00.000Z', 'Reviewer', 'Review started', 'Submitted', 'In Review', EM_DASH],
      [
        '2026-03-02T09:00:00.000Z',
        'Reviewer',
        'Information requested',
        'In Review',
        'Waiting for Information',
        reason,
      ],
      [
        '2026-03-02T09:00:00.000Z',
        'Requester',
        'Information supplied',
        'Waiting for Information',
        'In Review',
        information,
      ],
      ['2026-03-02T07:30:00.000Z', 'Reviewer', 'Completed', 'In Review', 'Completed', EM_DASH],
    ]);
    const request = storedRequest(store, 'REQ-0004');
    expect(request.auditHistory.map((entry) => entry.timestamp)).toEqual(timestamps);
    expect(request.lastUpdated).toBe('2026-03-02T07:30:00.000Z');
    expect(getDetailsValue('Last updated').querySelector('time')?.dateTime).toBe(
      '2026-03-02T07:30:00.000Z',
    );

    goToHash('#/');
    expect(listRow('REQ-0004')).toEqual([
      'REQ-0004',
      'Riley Test',
      'Equipment Request',
      'Normal',
      'Completed',
      '2026-03-02T07:30:00.000Z',
    ]);
  });
});

describe('AC3 requesting information preserves request and reason', () => {
  it('AC3 moves REQ-0002 to Waiting for Information and shows the reason in the details and the history', () => {
    renderApp({ hash: '#/requests/REQ-0002' });
    switchRole('Reviewer');
    const reason = 'Please name the sample folder you need.';

    sendNote('Request more information', 'Reason', 'Send reason', reason);

    expect(detailsText('Status')).toBe('Waiting for Information');
    expect(detailsText('Requester name')).toBe('Jordan Sample');
    expect(detailsText('Request type')).toBe('Access Request');
    expect(detailsText('Description')).toBe('Read access to the sample project folder for evaluation.');
    expect(detailsText('Reason for information request')).toBe(reason);
    const rows = readTableRows(auditTable());
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)?.slice(AUDIT_COLUMN.role)).toEqual([
      'Reviewer',
      'Information requested',
      'In Review',
      'Waiting for Information',
      reason,
    ]);
    expect(screen.queryByLabelText('Reason')).toBeNull();
  });
});

describe('AC4 supplying information returns to review', () => {
  it('AC4 moves REQ-0003 back to In Review, records the text, and lets the Reviewer complete it', () => {
    renderApp({ hash: '#/requests/REQ-0003' });
    expect(detailsText('Reason for information request')).toBe(
      'Please confirm which browser you are using.',
    );
    const information = 'The current stable release of a desktop browser.';

    sendNote('Supply information', 'Supplied information', 'Send information', information);

    expect(detailsText('Status')).toBe('In Review');
    expect(screen.queryByText('Reason for information request')).toBeNull();
    expect(readTableRows(auditTable()).at(-1)?.slice(AUDIT_COLUMN.role)).toEqual([
      'Requester',
      'Information supplied',
      'Waiting for Information',
      'In Review',
      information,
    ]);

    switchRole('Reviewer');
    expect(actionButtons()).toEqual(['Request more information', 'Complete']);
    clickAction('Complete');
    expect(detailsText('Status')).toBe('Completed');
  });
});

describe('AC6 reset restores samples', () => {
  it('AC6 changes nothing on Cancel and replaces every request with the three samples on Confirm', () => {
    const { store } = renderApp();
    createRequest(VALID_FIELDS);
    clickAction('Submit');
    goToHash('#/');
    expect(readTableRows(listTable())).toHaveLength(4);
    const before = store.getState();
    const storedBefore = window.localStorage.getItem(STORAGE_KEY);
    expect(storedBefore).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reset demo data' }));
    const prompt = screen.getByRole('group', { name: RESET_PROMPT });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('group', { name: RESET_PROMPT })).toBeNull();
    expect(store.getState()).toBe(before);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);
    expect(readTableRows(listTable())).toHaveLength(4);

    confirmReset(document.body, 'Reset demo data');

    expect(screen.queryByRole('group', { name: RESET_PROMPT })).toBeNull();
    expect(store.getState().requests).toEqual(createSampleRequests());
    const rows = readTableRows(listTable());
    expect(column(rows, LIST_COLUMN.id)).toEqual(SAMPLE_IDS);
    expect(column(rows, LIST_COLUMN.status)).toEqual(['Draft', 'In Review', 'Waiting for Information']);
    expect(readEnvelope(window.localStorage)).toEqual({ version: 1, requests: createSampleRequests() });
  });
});

describe('AC7 role and demo labelling', () => {
  it.each([
    ['list', '#/', 'Service requests'],
    ['details', '#/requests/REQ-0002', 'REQ-0002'],
    ['unknown request', '#/requests/REQ-9999', 'Request REQ-9999 was not found.'],
    ['unrecognised hash', '#/settings', 'Page not found.'],
  ])('AC7 shows the demo banner and the labelled role switch on the %s view', (_view, hash, heading) => {
    renderApp({ hash });
    expect(viewHeading()).toBe(heading);
    expect(screen.getByRole('complementary', { name: 'Demo notice' }).textContent).toBe(BANNER_TEXT);
    const select = screen.getByLabelText(ROLE_LABEL);
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('The role switch is not a <select>.');
    }
    expect(select.value).toBe('Requester');
    expect(Array.from(select.options, (option) => option.value)).toEqual(['Requester', 'Reviewer']);
  });

  it('AC7 offers REQ-0002 actions only to the Reviewer', () => {
    renderApp({ hash: '#/requests/REQ-0002' });
    expect(actionButtons()).toEqual([]);
    expect(actionsRegion().textContent).toBe(
      'No actions are available to the Requester while the request is In Review.',
    );

    switchRole('Reviewer');
    expect(actionButtons()).toEqual(['Request more information', 'Complete']);
  });
});

describe('AC8 transition rules hold in the UI', () => {
  it('AC8 refused action leaves the request unchanged and shows the refusal until the role switches', () => {
    const storage = createMemoryStorage();
    const { store } = renderApp({ storage, hash: '#/requests/REQ-0001' });
    const requestsBefore = store.getState().requests;
    const message = 'Complete is not available to the Requester while the request is Draft.';

    const result = dispatchInAct(store, { type: 'complete', id: 'REQ-0001' });

    expect(result).toEqual({ ok: false, error: { kind: 'refused', message } });
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(viewHeading()).toBe('REQ-0001');
    expect(detailsText('Status')).toBe('Draft');
    expect(readTableRows(auditTable())).toHaveLength(1);
    expect(store.getState().requests).toBe(requestsBefore);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();

    switchRole('Reviewer');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('AC10 priority in list and details views', () => {
  it('AC10 starts Normal, changes to Urgent through Edit with an Edited note, and is fixed after Submit', () => {
    const { store } = renderApp();
    openCreateForm();
    expect(screen.queryByLabelText('Priority')).toBeNull();
    fillCreateForm(VALID_FIELDS);
    expect(viewHeading()).toBe('REQ-0004');
    expect(detailsText('Priority')).toBe('Normal');
    goToHash('#/');
    expect(listRow('REQ-0004')[LIST_COLUMN.priority]).toBe('Normal');

    goToHash('#/requests/REQ-0004');
    clickAction('Edit');
    const priority = screen.getByLabelText('Priority');
    if (!(priority instanceof HTMLSelectElement)) {
      throw new Error('The Priority control is not a <select>.');
    }
    expect(priority.value).toBe('Normal');
    expect(Array.from(priority.options, (option) => option.value)).toEqual(['Normal', 'Urgent']);
    fireEvent.change(priority, { target: { value: 'Urgent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(detailsText('Priority')).toBe('Urgent');
    expect(readTableRows(auditTable()).at(-1)?.slice(AUDIT_COLUMN.role)).toEqual([
      'Requester',
      'Edited',
      'Draft',
      EM_DASH,
      'Priority: Normal to Urgent',
    ]);
    goToHash('#/');
    expect(listRow('REQ-0004')[LIST_COLUMN.priority]).toBe('Urgent');

    goToHash('#/requests/REQ-0004');
    clickAction('Submit');
    expect(detailsText('Status')).toBe('Submitted');
    expect(actionButtons()).not.toContain('Edit');
    expect(storedRequest(store, 'REQ-0004').priority).toBe('Urgent');
  });
});

/** The create form's three field values, as its controls or the details view show them. */
interface CreateFormValues {
  readonly requesterName: string;
  readonly requestType: string;
  readonly description: string;
}

/** The edit form's four field values, as its controls or the details view show them. */
interface EditFormValues extends CreateFormValues {
  readonly priority: string;
}

const REQ_0001_VALUES: EditFormValues = {
  requesterName: 'Alex Example',
  requestType: 'Equipment Request',
  description: 'Requesting a second monitor for the demo desk.',
  priority: 'Normal',
};

// Every value differs from REQ-0001's, so a save that resends any saved value is caught.
const EDITED_VALUES: EditFormValues = {
  requesterName: 'Quinn Fixture',
  requestType: 'General Question',
  description: 'Which fictional desk lamp suits the demo desk?',
  priority: 'Urgent',
};

/** The control labelled `label`, which must be a `kind` element. */
function labelledControl<T extends HTMLElement>(label: string, kind: new () => T): T {
  const control = screen.getByLabelText(label);
  if (!(control instanceof kind)) {
    throw new Error(`The ${label} control is not an instance of ${kind.name}.`);
  }
  return control;
}

function createFormValues(): CreateFormValues {
  return {
    requesterName: labelledControl('Requester name', HTMLInputElement).value,
    requestType: labelledControl('Request type', HTMLSelectElement).value,
    description: labelledControl('Description', HTMLTextAreaElement).value,
  };
}

function editFormValues(): EditFormValues {
  return { ...createFormValues(), priority: labelledControl('Priority', HTMLSelectElement).value };
}

/** Types `values` into the open create or edit form without saving it. */
function enterCreateFormValues(values: CreateFormValues): void {
  fireEvent.change(labelledControl('Requester name', HTMLInputElement), { target: { value: values.requesterName } });
  fireEvent.change(labelledControl('Request type', HTMLSelectElement), { target: { value: values.requestType } });
  fireEvent.change(labelledControl('Description', HTMLTextAreaElement), { target: { value: values.description } });
}

/** Types `values` into the open edit form, Priority included, without saving it. */
function enterEditFormValues(values: EditFormValues): void {
  enterCreateFormValues(values);
  fireEvent.change(labelledControl('Priority', HTMLSelectElement), { target: { value: values.priority } });
}

function detailsFieldValues(): EditFormValues {
  return {
    requesterName: detailsText('Requester name'),
    requestType: detailsText('Request type'),
    description: detailsText('Description'),
    priority: detailsText('Priority'),
  };
}

/** A create or edit form whose save must run once per accepted submit, and what one save leaves. */
interface SaveOnceCase {
  readonly button: string;
  readonly hash: string;
  /** Opens the form and enters otherwise valid values with `requesterName` as the name. */
  readonly open: (requesterName: string) => void;
  /** The request that one save creates or edits. */
  readonly id: string;
  /** Every request ID the store holds after one save. */
  readonly ids: readonly string[];
  /** The audit actions of `id` after one save. */
  readonly actions: readonly string[];
}

const SAVE_ONCE_CASES: readonly SaveOnceCase[] = [
  {
    button: 'Create draft',
    hash: '#/',
    open: (requesterName) => {
      openCreateForm();
      enterCreateFormValues({ ...VALID_FIELDS, requesterName });
    },
    id: 'REQ-0004',
    ids: [...SAMPLE_IDS, 'REQ-0004'],
    actions: ['Created'],
  },
  {
    button: 'Save changes',
    hash: '#/requests/REQ-0001',
    open: (requesterName) => {
      clickAction('Edit');
      enterEditFormValues({ ...EDITED_VALUES, requesterName });
    },
    id: 'REQ-0001',
    ids: SAMPLE_IDS,
    actions: ['Created', 'Edited'],
  },
];

// Inside one `act` React defers rendering to the end of the callback, so the second click reaches the
// form before the first save has re-rendered or closed it, as two `click()` calls in one browser task do.
function submitTwiceInOneTask(name: string): void {
  const button = screen.getByRole('button', { name });
  act(() => {
    button.click();
    button.click();
  });
}

/** Asserts that exactly one save of `testCase` happened: in the view, the store and the stored envelope. */
function expectSavedOnce(store: AppStore, testCase: SaveOnceCase): void {
  expect(screen.queryByRole('button', { name: testCase.button })).toBeNull();
  expect(window.location.hash).toBe(`#/requests/${testCase.id}`);
  const { requests } = store.getState();
  expect(requests.map((request) => request.id)).toEqual(testCase.ids);
  expect(storedRequest(store, testCase.id).auditHistory.map((entry) => entry.action)).toEqual(testCase.actions);
  expect(column(readTableRows(auditTable()), AUDIT_COLUMN.action)).toEqual(testCase.actions);
  expect(readEnvelope(window.localStorage)).toEqual({ version: 1, requests });
}

describe('Draft edit form and cancellation', () => {
  it('Edit opens with the four saved values and saves a change to every one as one Edited entry', () => {
    const { store } = renderApp({ hash: '#/requests/REQ-0001' });
    const historyBefore = readTableRows(auditTable());
    expect(historyBefore).toHaveLength(1);
    clickAction('Edit');
    expect(editFormValues()).toEqual(REQ_0001_VALUES);

    enterEditFormValues(EDITED_VALUES);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(detailsFieldValues()).toEqual(EDITED_VALUES);
    expect(detailsText('Status')).toBe('Draft');
    const request = storedRequest(store, 'REQ-0001');
    expect(request).toMatchObject({ ...EDITED_VALUES, status: 'Draft' });
    expect(request.auditHistory).toHaveLength(2);
    const rows = readTableRows(auditTable());
    expect(rows).toHaveLength(historyBefore.length + 1);
    expect(rows.slice(0, -1)).toEqual(historyBefore);
    expect(rows.at(-1)?.slice(AUDIT_COLUMN.role)).toEqual([
      'Requester',
      'Edited',
      'Draft',
      EM_DASH,
      'Priority: Normal to Urgent',
    ]);
    expect(rows.at(-1)?.[AUDIT_COLUMN.timestamp]).toBe(request.lastUpdated);

    goToHash('#/');
    expect(listRow('REQ-0001')).toEqual([
      'REQ-0001',
      EDITED_VALUES.requesterName,
      EDITED_VALUES.requestType,
      EDITED_VALUES.priority,
      'Draft',
      request.lastUpdated,
    ]);
  });

  it('an open Edit form closes on a switch to Reviewer, discards its input, and reopens with the saved values', () => {
    const { store } = renderApp({ hash: '#/requests/REQ-0001' });
    const requestsBefore = store.getState().requests;
    clickAction('Edit');
    enterEditFormValues(EDITED_VALUES);

    switchRole('Reviewer');

    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByLabelText('Requester name')).toBeNull();
    expect(screen.queryByLabelText('Priority')).toBeNull();
    expect(detailsFieldValues()).toEqual(REQ_0001_VALUES);
    expect(actionButtons()).toEqual([]);
    expect(store.getState().requests).toBe(requestsBefore);
    expect(readTableRows(auditTable())).toHaveLength(1);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    switchRole('Requester');
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(actionButtons()).toEqual(['Edit', 'Submit']);
    clickAction('Edit');
    expect(editFormValues()).toEqual(REQ_0001_VALUES);
  });

  it('Cancel on the create form discards complete valid input and creates nothing', () => {
    const { store } = renderApp();
    const requestsBefore = store.getState().requests;
    const rowsBefore = readTableRows(listTable());
    openCreateForm();
    enterCreateFormValues(VALID_FIELDS);
    expect(createFormValues()).toEqual(VALID_FIELDS);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Create draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New request' })).not.toBeNull();
    expect(viewHeading()).toBe('Service requests');
    expect(store.getState().requests).toBe(requestsBefore);
    expect(store.getState().requests).toHaveLength(3);
    expect(readTableRows(listTable())).toEqual(rowsBefore);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    openCreateForm();
    expect(createFormValues()).toEqual({ requesterName: '', requestType: '', description: '' });
  });

  it('Cancel on the Edit form discards changed values, saves nothing, and returns focus to the heading', () => {
    const { store } = renderApp({ hash: '#/requests/REQ-0001' });
    const before = store.getState();
    clickAction('Edit');
    enterEditFormValues(EDITED_VALUES);
    expect(editFormValues()).toEqual(EDITED_VALUES);

    press(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(detailsFieldValues()).toEqual(REQ_0001_VALUES);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'REQ-0001' }));
    expect(store.getState()).toBe(before);
    expect(readTableRows(auditTable())).toHaveLength(1);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    clickAction('Edit');
    expect(editFormValues()).toEqual(REQ_0001_VALUES);
  });

  it.each(SAVE_ONCE_CASES)('a second "$button" submit in the same task as the first saves nothing more', (testCase) => {
    const { store } = renderApp({ hash: testCase.hash });
    testCase.open(VALID_FIELDS.requesterName);

    submitTwiceInOneTask(testCase.button);

    expectSavedOnce(store, testCase);
  });

  it.each(SAVE_ONCE_CASES)('"$button" refused for an over-length name saves once after the name is fixed', (testCase) => {
    const { store } = renderApp({ hash: testCase.hash });
    const requestsBefore = store.getState().requests;
    testCase.open('R'.repeat(81));

    fireEvent.click(screen.getByRole('button', { name: testCase.button }));

    const name = labelledControl('Requester name', HTMLInputElement);
    expect(describedMessage(name)).toBe('Requester name must be 80 characters or fewer.');
    expect(store.getState().requests).toBe(requestsBefore);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    fireEvent.change(name, { target: { value: VALID_FIELDS.requesterName } });
    submitTwiceInOneTask(testCase.button);

    expectSavedOnce(store, testCase);
  });
});

/** One blank-note case: which role opens which note form on which request, and what it must report. */
interface BlankNoteCase {
  readonly id: string;
  readonly role: Role;
  readonly action: string;
  readonly label: string;
  readonly send: string;
  readonly message: string;
  readonly status: string;
}

/** One create-form text field typed one character past its limit, with the message it must show. */
interface OverLengthCase {
  readonly label: string;
  readonly key: 'requesterName' | 'description';
  readonly value: string;
  readonly message: string;
  /** Another text field, which must stay valid and carry no maxlength either. */
  readonly other: string;
}

describe('UI edge cases', () => {
  it('the empty list shows "No requests yet" with New request for the Requester and a hint for the Reviewer', () => {
    const initial = { [STORAGE_KEY]: JSON.stringify({ version: 1, requests: [] }) };
    renderApp({ storage: createMemoryStorage({ initial }) });
    expect(screen.queryByText('No requests yet')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: 'New request' })).toHaveLength(1);
    expect(screen.queryByRole('table', { name: 'Service requests' })).toBeNull();
    expect(screen.queryByText('Switch to Requester to create a request.')).toBeNull();

    switchRole('Reviewer');
    expect(screen.queryByText('No requests yet')).not.toBeNull();
    expect(screen.queryByText('Switch to Requester to create a request.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'New request' })).toBeNull();
  });

  // Narrow screens scroll each table sideways, so the table itself must be a keyboard stop.
  it.each([
    ['#/', 'Service requests'],
    ['#/requests/REQ-0001', 'Audit history'],
  ])('at %s the "%s" table is in the tab order and takes keyboard focus', (hash, name) => {
    renderApp({ hash });
    const table = screen.getByRole('table', { name });
    expect(table.tabIndex).toBe(0);

    table.focus();
    expect(document.activeElement).toBe(table);
  });

  it.each([
    ['#/requests/REQ-9999', 'Request REQ-9999 was not found.'],
    ['#/settings', 'Page not found.'],
  ])('%s shows "%s" with a link back to the list', (hash, message) => {
    renderApp({ hash });
    expect(viewHeading()).toBe(message);
    expect(screen.getByRole('link', { name: 'Back to list' }).getAttribute('href')).toBe('#/');
  });

  // " REQ-0001" is not REQ-0001, so the message keeps the ID whole, leading space included, in its own element.
  it('a space-padded unknown ID is reported in a code element that keeps the space', () => {
    renderApp({ hash: '#/requests/%20REQ-0001' });
    expect(viewHeading()).toBe('Request  REQ-0001 was not found.');
    const code = screen.getByRole('heading', { level: 1 }).querySelector('code');
    expect(code?.textContent).toBe(' REQ-0001');
    expect(code?.getAttribute('dir')).toBe('auto');
  });

  it.each<OverLengthCase>([
    {
      label: 'Requester name',
      key: 'requesterName',
      value: 'R'.repeat(81),
      message: 'Requester name must be 80 characters or fewer.',
      other: 'Description',
    },
    {
      label: 'Description',
      key: 'description',
      value: 'D'.repeat(2001),
      message: 'Description must be 2000 characters or fewer.',
      other: 'Requester name',
    },
  ])('an over-length $label is refused with its limit message and kept in full in the field', (testCase) => {
    const { store } = renderApp();

    createRequest({ ...VALID_FIELDS, [testCase.key]: testCase.value });

    const field = screen.getByLabelText(testCase.label);
    if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
      throw new Error(`The ${testCase.label} control is not a text field.`);
    }
    expect(field.value).toBe(testCase.value);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(describedMessage(field)).toBe(testCase.message);
    expect(field.hasAttribute('maxlength')).toBe(false);
    const other = screen.getByLabelText(testCase.other);
    expect(other.hasAttribute('maxlength')).toBe(false);
    expect(other.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Create draft' })).not.toBeNull();
    expect(store.getState().requests).toHaveLength(3);
    expect(readTableRows(listTable())).toHaveLength(3);
  });

  it.each<BlankNoteCase>([
    {
      id: 'REQ-0002',
      role: 'Reviewer',
      action: 'Request more information',
      label: 'Reason',
      send: 'Send reason',
      message: 'Reason is required.',
      status: 'In Review',
    },
    {
      id: 'REQ-0003',
      role: 'Requester',
      action: 'Supply information',
      label: 'Supplied information',
      send: 'Send information',
      message: 'Supplied information is required.',
      status: 'Waiting for Information',
    },
  ])('a whitespace-only $label on $id shows "$message" and changes nothing', (testCase) => {
    const { store } = renderApp({ hash: `#/requests/${testCase.id}` });
    switchRole(testCase.role);
    const before = store.getState();
    const historyBefore = readTableRows(auditTable());

    sendNote(testCase.action, testCase.label, testCase.send, '   ');

    const field = screen.getByLabelText(testCase.label);
    if (!(field instanceof HTMLTextAreaElement)) {
      throw new Error(`The ${testCase.label} control is not a <textarea>.`);
    }
    expect(field.value).toBe('   ');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(describedMessage(field)).toBe(testCase.message);
    expect(screen.queryByRole('button', { name: testCase.send })).not.toBeNull();
    expect(detailsText('Status')).toBe(testCase.status);
    expect(readTableRows(auditTable())).toEqual(historyBefore);
    expect(store.getState()).toBe(before);
  });

  it('an open note form closes when the role switches and stays closed on switching back', () => {
    const { store } = renderApp({ hash: '#/requests/REQ-0002' });
    switchRole('Reviewer');
    clickAction('Request more information');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'An unsent fictional reason.' } });

    switchRole('Requester');
    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send reason' })).toBeNull();

    switchRole('Reviewer');
    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send reason' })).toBeNull();
    expect(actionButtons()).toEqual(['Request more information', 'Complete']);
    expect(readTableRows(auditTable())).toHaveLength(3);
    expect(storedRequest(store, 'REQ-0002')).toEqual(createSampleRequests()[1]);
  });

  it('the open create form closes on a switch to Reviewer and discards its input', () => {
    const { store } = renderApp();
    openCreateForm();
    fireEvent.change(screen.getByLabelText('Requester name'), { target: { value: 'Morgan Fixture' } });

    switchRole('Reviewer');
    expect(screen.queryByRole('button', { name: 'Create draft' })).toBeNull();
    expect(screen.queryByLabelText('Requester name')).toBeNull();
    expect(store.getState().requests).toHaveLength(3);

    switchRole('Requester');
    expect(screen.queryByRole('button', { name: 'Create draft' })).toBeNull();
    expect(screen.queryByLabelText('Requester name')).toBeNull();
    openCreateForm();
    const input = screen.getByLabelText('Requester name');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('The Requester name control is not an <input>.');
    }
    expect(input.value).toBe('');
    expect(store.getState().requests).toHaveLength(3);
  });

  it('a create dispatched as Reviewer shows the refusal on the list view until the route changes', () => {
    const { store } = renderApp();
    switchRole('Reviewer');

    const result = dispatchInAct(store, {
      type: 'create',
      fields: { requesterName: 'Riley Test', requestType: 'Access Request', description: 'Fictional request.' },
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'refused', message: 'Create is not available to the Reviewer.' },
    });
    expect(screen.getByRole('alert').textContent).toBe('Create is not available to the Reviewer.');
    expect(viewHeading()).toBe('Service requests');
    expect(column(readTableRows(listTable()), LIST_COLUMN.id)).toEqual(SAMPLE_IDS);

    goToHash('#/requests/REQ-0001');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['unreadable', '{not json', 'Stored demo data could not be read, so it has been left unchanged.'],
    [
      'wrong-version',
      '{"version":2,"requests":[]}',
      'Stored demo data uses an unsupported version, so it has been left unchanged.',
    ],
  ])('%s stored data starts empty, stays untouched, and is replaced by a confirmed reset', (_kind, raw, sentence) => {
    const storage = createMemoryStorage({ initial: { [STORAGE_KEY]: raw } });
    const { store } = renderApp({ storage });

    const alert = screen.getByRole('alert');
    expect(within(alert).queryByText(`${sentence} ${LOAD_ISSUE_ADVICE}`)).not.toBeNull();
    expect(screen.queryByText('No requests yet')).not.toBeNull();
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);

    confirmReset(alert, 'Reset to sample data');

    expect(screen.queryByRole('alert')).toBeNull();
    expect(column(readTableRows(listTable()), LIST_COLUMN.id)).toEqual(SAMPLE_IDS);
    expect(readEnvelope(storage)).toEqual({ version: 1, requests: createSampleRequests() });
    expect(store.getState().loadIssue).toBeNull();
  });

  it('a full storage keeps a new request in memory and shows the storage warning', () => {
    const storage = createMemoryStorage({ failOnSet: 'quota' });
    const { store } = renderApp({ storage });
    expect(screen.queryByRole('status')).toBeNull();

    createRequest(VALID_FIELDS);

    expect(viewHeading()).toBe('REQ-0004');
    expect(screen.getByRole('status').textContent).toBe(STORAGE_WARNING);
    expect(store.getState().requests).toHaveLength(4);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('blocked storage starts from the samples with the storage warning shown', () => {
    renderApp({ getStorage: unavailableStorageGetter });
    expect(screen.getByRole('status').textContent).toBe(STORAGE_WARNING);
    expect(column(readTableRows(listTable()), LIST_COLUMN.id)).toEqual(SAMPLE_IDS);
  });

  it('a walkthrough of every action and a reset never calls fetch', () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('The demo must make no network request.')));
    const { store } = renderApp();

    createRequest(VALID_FIELDS);
    clickAction('Edit');
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'Urgent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    clickAction('Submit');
    switchRole('Reviewer');
    clickAction('Start review');
    sendNote('Request more information', 'Reason', 'Send reason', 'Please confirm the stand height.');
    switchRole('Requester');
    sendNote('Supply information', 'Supplied information', 'Send information', 'A fictional height of 12 cm.');
    switchRole('Reviewer');
    clickAction('Complete');
    expect(column(readTableRows(auditTable()), AUDIT_COLUMN.action)).toEqual([
      'Created',
      'Edited',
      'Submitted',
      'Review started',
      'Information requested',
      'Information supplied',
      'Completed',
    ]);
    goToHash('#/');
    confirmReset(document.body, 'Reset demo data');

    expect(store.getState().requests).toEqual(createSampleRequests());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('List view contract', () => {
  /** Every link in the list table, in row order: the column index of its cell, its text and its `href`. */
  function listLinks(): Array<{ cellIndex: number | undefined; text: string; href: string | null }> {
    return within(listTable())
      .queryAllByRole('link')
      .map((link) => ({
        cellIndex: link.closest('td')?.cellIndex,
        text: link.textContent,
        href: link.getAttribute('href'),
      }));
  }

  it('the list columns are ID, Requester name, Request type, Priority, Status and Last updated, in order', () => {
    renderApp();
    expect(
      within(listTable())
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['ID', 'Requester name', 'Request type', 'Priority', 'Status', 'Last updated']);
  });

  it('the three samples list their ID, name, type, priority, status and last-updated time', () => {
    renderApp();
    const expected = [
      ['REQ-0001', 'Alex Example', 'Equipment Request', 'Normal', 'Draft', '2026-01-05T09:00:00.000Z'],
      ['REQ-0002', 'Jordan Sample', 'Access Request', 'Normal', 'In Review', '2026-01-07T09:30:00.000Z'],
      [
        'REQ-0003',
        'Casey Placeholder',
        'General Question',
        'Normal',
        'Waiting for Information',
        '2026-01-09T14:30:00.000Z',
      ],
    ];

    // Checked first, so a change to the sample data fails here and a failure below is a list defect.
    expect(
      createSampleRequests().map((request) => [
        request.id,
        request.requesterName,
        request.requestType,
        request.priority,
        request.status,
        request.lastUpdated,
      ]),
    ).toEqual(expected);
    expect(readTableRows(listTable())).toEqual(expected);
  });

  it('each sample ID is a link in the ID column to the details view of that request', () => {
    renderApp();
    expect(listLinks()).toEqual(
      SAMPLE_IDS.map((id) => ({ cellIndex: LIST_COLUMN.id, text: id, href: `#/requests/${id}` })),
    );
  });

  it('a blank draft lists em dashes for its name and type in a new last row linked to its details view', () => {
    const { store } = renderApp();
    createRequest({ requesterName: '', requestType: '', description: '' });
    expect(viewHeading()).toBe('REQ-0004');
    goToHash('#/');

    const request = storedRequest(store, 'REQ-0004');
    expect(request.lastUpdated).toBe(request.auditHistory.at(-1)?.timestamp);
    expect(listRow('REQ-0004')).toEqual(['REQ-0004', EM_DASH, EM_DASH, 'Normal', 'Draft', request.lastUpdated]);
    expect(column(readTableRows(listTable()), LIST_COLUMN.id)).toEqual(
      store.getState().requests.map((candidate) => candidate.id),
    );
    expect(listLinks().at(-1)).toEqual({
      cellIndex: LIST_COLUMN.id,
      text: 'REQ-0004',
      href: '#/requests/REQ-0004',
    });
  });

  it.each([
    [
      'an edit',
      'Edited',
      () => {
        clickAction('Edit');
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      },
    ],
    [
      'a transition',
      'Submitted',
      () => {
        clickAction('Submit');
      },
    ],
  ])('after %s, Last updated in both views is the timestamp of the appended %s entry', (_change, action, change) => {
    const { store } = renderApp({ now: createFixedClock('2026-03-16T13:00:00.000Z') });
    createRequest(VALID_FIELDS);
    const before = storedRequest(store, 'REQ-0004').lastUpdated;

    change();

    const request = storedRequest(store, 'REQ-0004');
    const entry = request.auditHistory.at(-1);
    expect(entry?.action).toBe(action);
    expect(request.lastUpdated).toBe(entry?.timestamp);
    expect(request.lastUpdated).not.toBe(before);
    expect(getDetailsValue('Last updated').querySelector('time')?.dateTime).toBe(request.lastUpdated);
    goToHash('#/');
    expect(listRow('REQ-0004')[LIST_COLUMN.lastUpdated]).toBe(request.lastUpdated);
  });

  it('the details view of a known request links Back to list to #/', () => {
    renderApp({ hash: '#/requests/REQ-0002' });
    expect(viewHeading()).toBe('REQ-0002');
    expect(screen.getByRole('link', { name: 'Back to list' }).getAttribute('href')).toBe('#/');
  });
});

/** A note form: the request and role that offer it, the action that opens it, its field and its send button. */
interface NoteFormCase {
  readonly id: string;
  readonly role: Role;
  readonly action: string;
  readonly label: string;
  readonly send: string;
}

const REASON_FORM: NoteFormCase = {
  id: 'REQ-0002',
  role: 'Reviewer',
  action: 'Request more information',
  label: 'Reason',
  send: 'Send reason',
};

const INFORMATION_FORM: NoteFormCase = {
  id: 'REQ-0003',
  role: 'Requester',
  action: 'Supply information',
  label: 'Supplied information',
  send: 'Send information',
};

/** One accepted transition: where it starts, how it is pressed, and the status it leads to. */
interface TransitionFocusCase {
  readonly name: string;
  readonly id: string;
  readonly role: Role;
  readonly run: () => void;
  readonly status: string;
}

/** Focuses `button` before clicking it, as keyboard and pointer activation both do. */
function press(button: HTMLElement): void {
  button.focus();
  fireEvent.click(button);
}

function actionButton(name: string): HTMLElement {
  return within(actionsRegion()).getByRole('button', { name });
}

function pressSendNote(form: NoteFormCase): void {
  press(actionButton(form.action));
  fireEvent.change(screen.getByLabelText(form.label), { target: { value: 'A fictional note.' } });
  press(screen.getByRole('button', { name: form.send }));
}

/** Renders `form.id` as `form.role` with the note form open, and returns the rendered app's store. */
function renderNoteForm(form: NoteFormCase): AppStore {
  const { store } = renderApp({ hash: `#/requests/${form.id}` });
  switchRole(form.role);
  press(actionButton(form.action));
  return store;
}

/** The element directly after `control`, which must be its polite live message slot. */
function messageSlot(control: HTMLElement): Element {
  const slot = control.nextElementSibling;
  if (slot === null || slot.getAttribute('aria-live') !== 'polite') {
    throw new Error('The control is not directly followed by a polite live message slot.');
  }
  return slot;
}

describe('Accessibility announcements and focus', () => {
  it.each([
    { mode: 'create', hash: '#/', open: 'New request', save: 'Create draft' },
    { mode: 'edit', hash: '#/requests/REQ-0001', open: 'Edit', save: 'Save changes' },
  ])('the $mode form inserts a save error into a live slot that existed before the save', ({ hash, open, save }) => {
    renderApp({ hash });
    fireEvent.click(screen.getByRole('button', { name: open }));
    const input = screen.getByLabelText('Requester name');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('The Requester name control is not an <input>.');
    }
    const slot = messageSlot(input);
    expect(slot.childElementCount).toBe(0);
    const name = 'R'.repeat(81);
    const expected = 'Requester name must be 80 characters or fewer.';

    fireEvent.change(input, { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: save }));

    expect(messageSlot(input)).toBe(slot);
    const message = slot.firstElementChild;
    expect(message?.id).toBe(input.getAttribute('aria-describedby'));
    expect(message?.textContent).toBe(expected);
    expect(input.getAttribute('aria-invalid')).toBe('true');

    // A repeated failure inserts the message afresh, so it is announced again.
    fireEvent.click(screen.getByRole('button', { name: save }));
    const repeated = slot.firstElementChild;
    if (!(repeated instanceof HTMLParagraphElement)) {
      throw new Error('The repeated save left no message paragraph in the live slot.');
    }
    expect(repeated).not.toBe(message);
    expect(slot.childElementCount).toBe(1);
    expect(repeated.textContent).toBe(expected);
    expect(repeated.id).toBe(input.getAttribute('aria-describedby'));
    expect(describedMessage(input)).toBe(expected);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.value).toBe(name);
  });

  it.each([
    { ...REASON_FORM, text: '', message: 'Reason is required.' },
    { ...REASON_FORM, text: 'R'.repeat(1001), message: 'Reason must be 1000 characters or fewer.' },
    {
      ...INFORMATION_FORM,
      text: 'I'.repeat(1001),
      message: 'Supplied information must be 1000 characters or fewer.',
    },
  ])('the $label form inserts "$message" into a live slot that existed before the send', (testCase) => {
    const store = renderNoteForm(testCase);
    const field = screen.getByLabelText(testCase.label);
    if (!(field instanceof HTMLTextAreaElement)) {
      throw new Error(`The ${testCase.label} control is not a <textarea>.`);
    }
    expect(field.hasAttribute('maxlength')).toBe(false);
    const slot = messageSlot(field);
    expect(slot.childElementCount).toBe(0);
    const before = store.getState();
    const statusBefore = detailsText('Status');
    const historyBefore = readTableRows(auditTable());

    fireEvent.change(field, { target: { value: testCase.text } });
    fireEvent.click(screen.getByRole('button', { name: testCase.send }));

    expect(messageSlot(field)).toBe(slot);
    const message = slot.firstElementChild;
    expect(message?.id).toBe(field.getAttribute('aria-describedby'));
    expect(message?.textContent).toBe(testCase.message);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.value).toBe(testCase.text);

    fireEvent.click(screen.getByRole('button', { name: testCase.send }));
    const repeated = slot.firstElementChild;
    if (!(repeated instanceof HTMLParagraphElement)) {
      throw new Error('The repeated send left no message paragraph in the live slot.');
    }
    expect(repeated).not.toBe(message);
    expect(slot.childElementCount).toBe(1);
    expect(repeated.textContent).toBe(testCase.message);
    expect(repeated.id).toBe(field.getAttribute('aria-describedby'));
    expect(describedMessage(field)).toBe(testCase.message);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.value).toBe(testCase.text);
    expect(detailsText('Status')).toBe(statusBefore);
    expect(readTableRows(auditTable())).toEqual(historyBefore);
    expect(store.getState()).toBe(before);
  });

  it('the Status row is one polite, atomic live region that stays mounted across a transition', () => {
    renderApp({ hash: '#/requests/REQ-0002' });
    switchRole('Reviewer');
    const row = getDetailsValue('Status').parentElement;
    expect(row?.getAttribute('aria-live')).toBe('polite');
    expect(row?.getAttribute('aria-atomic')).toBe('true');

    clickAction('Complete');

    expect(getDetailsValue('Status').parentElement).toBe(row);
    expect(detailsText('Status')).toBe('Completed');
  });

  it.each<TransitionFocusCase>([
    {
      name: 'Submit',
      id: 'REQ-0001',
      role: 'Requester',
      run: () => {
        press(actionButton('Submit'));
      },
      status: 'Submitted',
    },
    {
      name: 'Start review',
      id: 'REQ-0001',
      role: 'Requester',
      run: () => {
        press(actionButton('Submit'));
        switchRole('Reviewer');
        press(actionButton('Start review'));
      },
      status: 'In Review',
    },
    {
      name: 'Send reason',
      id: REASON_FORM.id,
      role: REASON_FORM.role,
      run: () => {
        pressSendNote(REASON_FORM);
      },
      status: 'Waiting for Information',
    },
    {
      name: 'Send information',
      id: INFORMATION_FORM.id,
      role: INFORMATION_FORM.role,
      run: () => {
        pressSendNote(INFORMATION_FORM);
      },
      status: 'In Review',
    },
    {
      name: 'Complete',
      id: 'REQ-0002',
      role: 'Reviewer',
      run: () => {
        press(actionButton('Complete'));
      },
      status: 'Completed',
    },
  ])('$name moves focus to the details heading once the panel remounts', ({ id, role, run, status }) => {
    renderApp({ hash: `#/requests/${id}` });
    switchRole(role);

    run();

    expect(detailsText('Status')).toBe(status);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: id }));
  });

  it('a Submit refused by validation keeps focus on Submit', () => {
    renderApp();
    createRequest({ requesterName: 'Riley Test', requestType: 'Access Request', description: '' });
    const submit = actionButton('Submit');

    press(submit);

    expect(within(getDetailsValue('Description')).queryByText('Description is required.')).not.toBeNull();
    expect(document.activeElement).toBe(submit);
  });

  it.each([REASON_FORM, INFORMATION_FORM])(
    'Cancel on a filled $label form sends nothing and returns focus to $action',
    (form) => {
      const store = renderNoteForm(form);
      const before = store.getState();
      const statusBefore = detailsText('Status');
      const historyBefore = readTableRows(auditTable());
      const opener = actionButton(form.action);
      fireEvent.change(screen.getByLabelText(form.label), { target: { value: 'A fictional note never sent.' } });

      press(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByLabelText(form.label)).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(detailsText('Status')).toBe(statusBefore);
      expect(readTableRows(auditTable())).toEqual(historyBefore);
      expect(store.getState()).toBe(before);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

      press(opener);
      expect(labelledControl(form.label, HTMLTextAreaElement).value).toBe('');
    },
  );

  it('a role switch closes an open note form and leaves focus on the role switch', () => {
    renderNoteForm(REASON_FORM);
    const select = screen.getByLabelText(ROLE_LABEL);
    select.focus();

    fireEvent.change(select, { target: { value: 'Requester' } });

    expect(screen.queryByLabelText(REASON_FORM.label)).toBeNull();
    expect(document.activeElement).toBe(select);
  });

  it.each([REASON_FORM, INFORMATION_FORM])(
    'opening the $label form focuses its field, scrolls the form into view and marks only $action expanded',
    (form) => {
      const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
      renderNoteForm(form);
      const opener = actionButton(form.action);
      const field = labelledControl(form.label, HTMLTextAreaElement);
      const noteForm = field.closest('form');
      if (noteForm === null) {
        throw new Error(`The ${form.label} field is not inside a <form>.`);
      }

      expect(document.activeElement).toBe(field);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.contexts[0]).toBe(noteForm);
      expect(noteForm.id).not.toBe('');
      expect(opener.getAttribute('aria-expanded')).toBe('true');
      expect(opener.getAttribute('aria-controls')).toBe(noteForm.id);
      const disclosures = within(actionsRegion())
        .getAllByRole('button')
        .filter((button) => button.hasAttribute('aria-expanded') || button.hasAttribute('aria-controls'));
      expect(disclosures.map((button) => button.textContent)).toEqual([form.action]);

      press(screen.getByRole('button', { name: 'Cancel' }));

      expect(opener.getAttribute('aria-expanded')).toBe('false');
      expect(opener.hasAttribute('aria-controls')).toBe(false);
    },
  );

  it.each([REASON_FORM, INFORMATION_FORM])(
    'a refused send scrolls the $label form into view again and leaves focus on $send',
    (form) => {
      const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
      renderNoteForm(form);
      const field = labelledControl(form.label, HTMLTextAreaElement);
      const noteForm = field.closest('form');
      const send = screen.getByRole('button', { name: form.send });
      // Opening scrolled once already; only the send's own scroll is counted.
      scrollIntoView.mockClear();

      press(send);

      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.contexts[0]).toBe(noteForm);
      expect(document.activeElement).toBe(send);
    },
  );

  it.each([
    { ...REASON_FORM, message: 'Reason is required.' },
    { ...INFORMATION_FORM, message: 'Supplied information is required.' },
  ])('pressing $action again keeps the typed $label text and its message, and focuses the field', (form) => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const store = renderNoteForm(form);
    const field = labelledControl(form.label, HTMLTextAreaElement);
    press(screen.getByRole('button', { name: form.send }));
    expect(describedMessage(field)).toBe(form.message);
    const before = store.getState();
    const text = 'A fictional note still being typed.';
    fireEvent.change(field, { target: { value: text } });
    scrollIntoView.mockClear();

    press(actionButton(form.action));

    expect(labelledControl(form.label, HTMLTextAreaElement)).toBe(field);
    expect(field.value).toBe(text);
    expect(describedMessage(field)).toBe(form.message);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(field.closest('form'));
    expect(actionButton(form.action).getAttribute('aria-expanded')).toBe('true');
    expect(store.getState()).toBe(before);
  });

  it('a double-click on Start review leaves the Request more information that replaces it unpressed', () => {
    renderApp({ hash: '#/requests/REQ-0001' });
    press(actionButton('Submit'));
    switchRole('Reviewer');
    fireEvent.click(actionButton('Start review'), { detail: 1 });
    const replacement = actionButton('Request more information');

    fireEvent.click(replacement, { detail: 2 });

    expect(detailsText('Status')).toBe('In Review');
    expect(column(readTableRows(auditTable()), AUDIT_COLUMN.action)).toEqual([
      'Created',
      'Submitted',
      'Review started',
    ]);
    expect(screen.queryByLabelText(REASON_FORM.label)).toBeNull();
    expect(replacement.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(replacement, { detail: 1 });

    expect(labelledControl(REASON_FORM.label, HTMLTextAreaElement).value).toBe('');
    expect(replacement.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('User text direction', () => {
  it('Arabic-first user text takes its own base direction in the details values and the list name cell', () => {
    const { store } = renderApp();
    const fields: CreateFields = {
      requesterName: 'اختبار ريلي',
      requestType: 'General Question',
      description: 'هذا طلب تجريبي للمكتب.\nالسطر الثاني رقم 2026.',
    };
    createRequest(fields);
    expect(viewHeading()).toBe('REQ-0004');
    const request = storedRequest(store, 'REQ-0004');
    expect([request.requesterName, request.requestType, request.description]).toEqual([
      fields.requesterName,
      fields.requestType,
      fields.description,
    ]);

    // Only the value is marked, so a submit message the row may also hold keeps the page's direction.
    for (const [label, stored] of [
      ['Requester name', request.requesterName],
      ['Request type', request.requestType],
      ['Description', request.description],
    ] as const) {
      const row = getDetailsValue(label);
      expect(row.hasAttribute('dir')).toBe(false);
      expect(row.querySelector('[dir="auto"]')?.textContent).toBe(stored);
    }

    goToHash('#/');
    const listRowElement = within(listTable()).getByRole('link', { name: 'REQ-0004' }).closest('tr');
    const nameCell = listRowElement?.cells[LIST_COLUMN.requesterName];
    expect(nameCell?.textContent).toBe(request.requesterName);
    expect(nameCell?.getAttribute('dir')).toBe('auto');
  });
});
