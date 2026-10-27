import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from './store';
import type { AppState } from './store';
import { STORAGE_KEY, createLocalStorageAdapter, serializeEnvelope } from '../storage/localStore';
import type { StorageAdapter } from '../storage/localStore';
import { createSampleRequests } from '../storage/sampleData';
import { createFixedClock, createMemoryStorage, unavailableStorageGetter } from '../test/helpers';
import type { MemoryStorageOptions } from '../test/helpers';
import type { Command, CommandResult, DomainError } from '../domain/transitions';
import type { CreateFields, Role, ServiceRequest } from '../domain/model';

const RILEY_FIELDS: CreateFields = {
  requesterName: 'Riley Test',
  requestType: 'Equipment Request',
  description: 'Fictional request used by the store suite.',
};

const CREATE_RILEY: Command = { type: 'create', fields: RILEY_FIELDS };

const UNREADABLE_VALUE = '{not json';
const VERSION_2_VALUE = '{"version":2,"requests":[]}';
const MISSING_VERSION_VALUE = '{"requests":[]}';

// Wraps the real adapter so saves can be counted and inspected; the adapter itself is never spied on,
// because its object may be frozen.
function countingAdapter(getStorage: () => Storage) {
  const inner = createLocalStorageAdapter(getStorage);
  const save = vi.fn((requests: readonly ServiceRequest[]) => inner.save(requests));
  const adapter: StorageAdapter = { load: () => inner.load(), save };
  return { adapter, save };
}

interface SetupOptions extends MemoryStorageOptions {
  /** Replaces the memory storage lookup, for example with `unavailableStorageGetter`. */
  getStorage?: () => Storage;
}

// One store per test over its own memory storage, with a fresh clock and a subscribed listener.
function setup(options: SetupOptions = {}) {
  const { getStorage, ...memoryOptions } = options;
  const memory = createMemoryStorage(memoryOptions);
  const { adapter, save } = countingAdapter(getStorage ?? (() => memory));
  const store = createAppStore({ storage: adapter, now: createFixedClock() });
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  return { memory, save, store, listener, unsubscribe };
}

function accepted(result: CommandResult): Extract<CommandResult, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(`Expected an accepted command, got a ${result.error.kind} rejection.`);
  }
  return result;
}

function rejected(result: CommandResult): DomainError {
  if (result.ok) {
    throw new Error(`Expected a rejected command, but ${result.request.id} was accepted.`);
  }
  return result.error;
}

// Every publish replaces the snapshot with a new frozen object; returns `current` for the next comparison.
function expectNewFrozenSnapshot(previous: AppState, current: AppState): AppState {
  expect(current).not.toBe(previous);
  expect(Object.isFrozen(current)).toBe(true);
  return current;
}

describe('startup modes', () => {
  const samples = createSampleRequests();
  const oneSample = samples.slice(0, 1);
  const modes: readonly {
    mode: string;
    options: SetupOptions;
    requests: readonly ServiceRequest[];
    storageWarning: boolean;
    loadIssue: AppState['loadIssue'];
    stored: string | null;
  }[] = [
    {
      mode: 'empty key shows the samples in memory only',
      options: {},
      requests: samples,
      storageWarning: false,
      loadIssue: null,
      stored: null,
    },
    {
      mode: 'valid data loads the stored requests',
      options: { initial: { [STORAGE_KEY]: serializeEnvelope(oneSample) } },
      requests: oneSample,
      storageWarning: false,
      loadIssue: null,
      stored: serializeEnvelope(oneSample),
    },
    {
      mode: 'unavailable storage shows the samples with a warning',
      options: { getStorage: unavailableStorageGetter },
      requests: samples,
      storageWarning: true,
      loadIssue: null,
      stored: null,
    },
    {
      mode: 'unreadable data starts empty and is left unchanged',
      options: { initial: { [STORAGE_KEY]: UNREADABLE_VALUE } },
      requests: [],
      storageWarning: false,
      loadIssue: 'unreadable',
      stored: UNREADABLE_VALUE,
    },
    {
      mode: 'version 2 data starts empty and is left unchanged',
      options: { initial: { [STORAGE_KEY]: VERSION_2_VALUE } },
      requests: [],
      storageWarning: false,
      loadIssue: 'wrongVersion',
      stored: VERSION_2_VALUE,
    },
    {
      mode: 'data without a version starts empty and is left unchanged',
      options: { initial: { [STORAGE_KEY]: MISSING_VERSION_VALUE } },
      requests: [],
      storageWarning: false,
      loadIssue: 'wrongVersion',
      stored: MISSING_VERSION_VALUE,
    },
  ];

  it.each(modes)('$mode, without writing', ({ options, requests, storageWarning, loadIssue, stored }) => {
    const { memory, save, store } = setup(options);

    expect(store.getState()).toEqual({
      requests,
      role: 'Requester',
      storageWarning,
      loadIssue,
      refusal: null,
    });
    expect(save).not.toHaveBeenCalled();
    expect(memory.getItem(STORAGE_KEY)).toBe(stored);
  });

  it('continues request IDs from the loaded list', () => {
    const { store } = setup({ initial: { [STORAGE_KEY]: serializeEnvelope(oneSample) } });

    expect(accepted(store.dispatch(CREATE_RILEY)).request.id).toBe('REQ-0002');
  });

  it('leaves unreadable data byte-identical through a validation failure, refusals and a role switch', () => {
    const { memory, save, store } = setup({ initial: { [STORAGE_KEY]: UNREADABLE_VALUE } });

    expect(
      rejected(
        store.dispatch({ type: 'create', fields: { ...RILEY_FIELDS, requesterName: 'x'.repeat(81) } }),
      ).kind,
    ).toBe('validation');
    expect(memory.getItem(STORAGE_KEY)).toBe(UNREADABLE_VALUE);

    expect(rejected(store.dispatch({ type: 'submit', id: 'REQ-0001' })).kind).toBe('notFound');
    expect(memory.getItem(STORAGE_KEY)).toBe(UNREADABLE_VALUE);

    store.setRole('Reviewer');
    expect(memory.getItem(STORAGE_KEY)).toBe(UNREADABLE_VALUE);

    expect(rejected(store.dispatch(CREATE_RILEY)).kind).toBe('refused');
    expect(memory.getItem(STORAGE_KEY)).toBe(UNREADABLE_VALUE);

    expect(save).not.toHaveBeenCalled();
    expect(store.getState().loadIssue).toBe('unreadable');
  });
});

describe.each([
  { loadIssue: 'unreadable', stored: UNREADABLE_VALUE },
  { loadIssue: 'wrongVersion', stored: VERSION_2_VALUE },
])('overwriting $loadIssue stored data', ({ loadIssue, stored }) => {
  it('is replaced by the first successful change', () => {
    const { memory, save, store } = setup({ initial: { [STORAGE_KEY]: stored } });

    const result = accepted(store.dispatch(CREATE_RILEY));

    expect(result.request.id).toBe('REQ-0001');
    expect(save).toHaveBeenCalledTimes(1);
    expect(memory.getItem(STORAGE_KEY)).toBe(serializeEnvelope(store.getState().requests));
    expect(store.getState().loadIssue).toBeNull();
    expect(store.getState().storageWarning).toBe(false);
  });

  it('is replaced by a confirmed reset', () => {
    const { memory, save, store } = setup({ initial: { [STORAGE_KEY]: stored } });

    store.resetToSamples();

    expect(memory.getItem(STORAGE_KEY)).toBe(serializeEnvelope(createSampleRequests()));
    expect(store.getState().requests).toEqual(createSampleRequests());
    expect(store.getState().loadIssue).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps its notice and its value when the save fails', () => {
    const { memory, store } = setup({ initial: { [STORAGE_KEY]: stored }, failOnSet: 'quota' });

    const result = accepted(store.dispatch(CREATE_RILEY));

    expect(store.getState().requests).toContain(result.request);
    expect(store.getState().storageWarning).toBe(true);
    // Only a successful save clears the load issue, because only then has the stored value been replaced.
    expect(store.getState().loadIssue).toBe(loadIssue);
    expect(memory.getItem(STORAGE_KEY)).toBe(stored);
  });
});

describe('persistence timing', () => {
  it('saves exactly once per accepted command and never on a role switch', () => {
    const { memory, save, store } = setup();
    let saves = 0;

    function dispatchAccepted(command: Command): ServiceRequest {
      const { request } = accepted(store.dispatch(command));
      saves += 1;
      expect(save).toHaveBeenCalledTimes(saves);
      expect(save.mock.lastCall?.[0]).toBe(store.getState().requests);
      return request;
    }

    function switchRole(role: Role): void {
      store.setRole(role);
      expect(save).toHaveBeenCalledTimes(saves);
    }

    const { id } = dispatchAccepted(CREATE_RILEY);
    dispatchAccepted({ type: 'edit', id, fields: { ...RILEY_FIELDS, priority: 'Urgent' } });
    dispatchAccepted({ type: 'submit', id });
    switchRole('Reviewer');
    dispatchAccepted({ type: 'startReview', id });
    dispatchAccepted({ type: 'requestInfo', id, note: 'Please add the desk number.' });
    switchRole('Requester');
    dispatchAccepted({ type: 'supplyInfo', id, note: 'Desk 4, fictional floor.' });
    switchRole('Reviewer');
    const completed = dispatchAccepted({ type: 'complete', id });

    expect(save).toHaveBeenCalledTimes(7);
    expect(completed.status).toBe('Completed');
    expect(completed.auditHistory.map((entry) => entry.action)).toEqual([
      'Created',
      'Edited',
      'Submitted',
      'Review started',
      'Information requested',
      'Information supplied',
      'Completed',
    ]);
    expect(memory.getItem(STORAGE_KEY)).toBe(serializeEnvelope(store.getState().requests));
  });

  it('has saved before subscribers are notified', () => {
    const { memory, save, store } = setup();
    const seen: { stored: string | null; saves: number }[] = [];
    store.subscribe(() => {
      seen.push({ stored: memory.getItem(STORAGE_KEY), saves: save.mock.calls.length });
    });

    accepted(store.dispatch(CREATE_RILEY));

    expect(seen).toEqual([{ stored: serializeEnvelope(store.getState().requests), saves: 1 }]);
  });

  it('saves once per confirmed reset, clearing the refusal and keeping the role', () => {
    const { save, store, listener } = setup();
    accepted(store.dispatch(CREATE_RILEY));
    store.setRole('Reviewer');
    rejected(store.dispatch(CREATE_RILEY));
    expect(store.getState().refusal).not.toBeNull();
    save.mockClear();
    listener.mockClear();

    store.resetToSamples();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(createSampleRequests());
    expect(store.getState()).toEqual({
      requests: createSampleRequests(),
      role: 'Reviewer',
      storageWarning: false,
      loadIssue: null,
      refusal: null,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('runs each dispatch as the current role at the injected clock time', () => {
    const { store } = setup();

    const created = accepted(store.dispatch(CREATE_RILEY));

    expect(created.request.id).toBe('REQ-0004');
    expect(created.request.auditHistory.at(-1)).toEqual({
      timestamp: '2026-02-01T09:00:00.000Z',
      role: 'Requester',
      action: 'Created',
      fromStatus: '',
      toStatus: '',
    });
    expect(created.request.lastUpdated).toBe('2026-02-01T09:00:00.000Z');
    expect(created.requests).toHaveLength(4);
    expect(created.requests).toBe(store.getState().requests);

    store.setRole('Reviewer');
    const completed = accepted(store.dispatch({ type: 'complete', id: 'REQ-0002' }));

    expect(completed.request.auditHistory.at(-1)).toEqual({
      timestamp: '2026-02-01T09:01:00.000Z',
      role: 'Reviewer',
      action: 'Completed',
      fromStatus: 'In Review',
      toStatus: 'Completed',
    });
    expect(completed.request.lastUpdated).toBe('2026-02-01T09:01:00.000Z');
  });
});

describe('rejected commands', () => {
  const validationCases: readonly {
    name: string;
    role: Role;
    command: Command;
    error: DomainError;
  }[] = [
    {
      name: 'an over-length requester name on create',
      role: 'Requester',
      command: { type: 'create', fields: { ...RILEY_FIELDS, requesterName: 'x'.repeat(81) } },
      error: {
        kind: 'validation',
        errors: { requesterName: 'Requester name must be 80 characters or fewer.' },
      },
    },
    {
      name: 'a blank reason on request more information',
      role: 'Reviewer',
      command: { type: 'requestInfo', id: 'REQ-0002', note: '   ' },
      error: { kind: 'validation', errors: { note: 'Reason is required.' } },
    },
  ];

  it.each(validationCases)(
    'publishes nothing and saves nothing for $name',
    ({ role, command, error }) => {
      const { save, store, listener } = setup();
      store.setRole(role);
      listener.mockClear();
      const before = store.getState();

      expect(rejected(store.dispatch(command))).toEqual(error);
      expect(save).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(store.getState()).toBe(before);
    },
  );

  const refusalCases: readonly {
    name: string;
    role: Role;
    command: Command;
    kind: 'refused' | 'notFound';
    message: string;
  }[] = [
    {
      name: 'AC8: Complete on a Draft as Requester',
      role: 'Requester',
      command: { type: 'complete', id: 'REQ-0001' },
      kind: 'refused',
      message: 'Complete is not available to the Requester while the request is Draft.',
    },
    {
      name: 'Create as Reviewer',
      role: 'Reviewer',
      command: CREATE_RILEY,
      kind: 'refused',
      message: 'Create is not available to the Reviewer.',
    },
    {
      name: 'a command for an unknown ID',
      role: 'Requester',
      command: { type: 'submit', id: 'REQ-9999' },
      kind: 'notFound',
      message: 'Request REQ-9999 was not found.',
    },
  ];

  it.each(refusalCases)(
    'publishes only the refusal message, without saving, for $name',
    ({ role, command, kind, message }) => {
      const { save, store, listener } = setup();
      store.setRole(role);
      listener.mockClear();
      const before = store.getState();

      expect(rejected(store.dispatch(command))).toEqual({ kind, message });

      const after = store.getState();
      expect(after).toEqual({ ...before, refusal: message });
      expect(after.requests).toBe(before.requests);
      expect(after.requests).toEqual(createSampleRequests());
      expectNewFrozenSnapshot(before, after);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
    },
  );
});


describe('refusal lifecycle and snapshot identity', () => {
  const REFUSED_COMPLETE: Command = { type: 'complete', id: 'REQ-0001' };

  it('clears the refusal on the next accepted command', () => {
    const { store } = setup();
    rejected(store.dispatch(REFUSED_COMPLETE));
    expect(store.getState().refusal).not.toBeNull();

    accepted(store.dispatch(CREATE_RILEY));

    expect(store.getState().refusal).toBeNull();
  });

  it('clears the refusal on a role switch, without saving', () => {
    const { save, store } = setup();
    rejected(store.dispatch(REFUSED_COMPLETE));
    expect(store.getState().refusal).not.toBeNull();

    store.setRole('Reviewer');

    expect(store.getState().refusal).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('publishes once from clearRefusal, then nothing while no refusal is left', () => {
    const { store, listener } = setup();
    rejected(store.dispatch(REFUSED_COMPLETE));
    listener.mockClear();

    store.clearRefusal();
    const cleared = store.getState();

    expect(cleared.refusal).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    store.clearRefusal();

    expect(store.getState()).toBe(cleared);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns the same snapshot until something changes, including after a no-op role switch', () => {
    const { store, listener } = setup();
    const first = store.getState();

    expect(store.getState()).toBe(first);

    store.setRole('Requester');

    expect(store.getState()).toBe(first);
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishes a new frozen snapshot for every kind of change', () => {
    const { store, listener } = setup();
    let snapshot = store.getState();
    expect(Object.isFrozen(snapshot)).toBe(true);

    accepted(store.dispatch(CREATE_RILEY));
    snapshot = expectNewFrozenSnapshot(snapshot, store.getState());

    rejected(store.dispatch(REFUSED_COMPLETE));
    snapshot = expectNewFrozenSnapshot(snapshot, store.getState());

    store.setRole('Reviewer');
    snapshot = expectNewFrozenSnapshot(snapshot, store.getState());

    store.resetToSamples();
    snapshot = expectNewFrozenSnapshot(snapshot, store.getState());

    rejected(store.dispatch(CREATE_RILEY));
    snapshot = expectNewFrozenSnapshot(snapshot, store.getState());

    store.clearRefusal();
    expectNewFrozenSnapshot(snapshot, store.getState());

    expect(listener).toHaveBeenCalledTimes(6);
  });

  it('stops notifying a listener once unsubscribed, and a second unsubscribe is harmless', () => {
    const { store, listener, unsubscribe } = setup();
    const remaining = vi.fn();
    store.subscribe(remaining);

    unsubscribe();
    store.setRole('Reviewer');

    expect(listener).not.toHaveBeenCalled();
    expect(remaining).toHaveBeenCalledTimes(1);

    expect(() => unsubscribe()).not.toThrow();
    store.setRole('Requester');

    expect(listener).not.toHaveBeenCalled();
    expect(remaining).toHaveBeenCalledTimes(2);
  });
});

describe('storage warnings and recovery', () => {
  it('keeps a change in memory and warns when the save hits the quota', () => {
    const { memory, save, store } = setup({ failOnSet: 'quota' });

    const { request } = accepted(store.dispatch(CREATE_RILEY));

    expect(store.getState().requests).toContain(request);
    expect(store.getState().storageWarning).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(memory.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clears the warning once a later save succeeds, writing the change made while saves failed', () => {
    const quotaStorage = createMemoryStorage({ failOnSet: 'quota' });
    const workingStorage = createMemoryStorage();
    let target: Storage = quotaStorage;
    const { store } = setup({ getStorage: () => target });
    const { id } = accepted(store.dispatch(CREATE_RILEY)).request;
    expect(store.getState().storageWarning).toBe(true);

    target = workingStorage;
    accepted(store.dispatch({ type: 'submit', id }));

    expect(store.getState().storageWarning).toBe(false);
    expect(store.getState().requests.map((request) => request.id)).toContain(id);
    expect(workingStorage.getItem(STORAGE_KEY)).toBe(serializeEnvelope(store.getState().requests));
    expect(quotaStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('keeps retrying saves after unavailable storage and clears the warning once one succeeds', () => {
    const recovered = createMemoryStorage();
    let blocked = true;
    const { save, store } = setup({
      getStorage: () => (blocked ? unavailableStorageGetter() : recovered),
    });
    expect(store.getState().storageWarning).toBe(true);

    const { request } = accepted(store.dispatch(CREATE_RILEY));

    expect(save).toHaveBeenCalledTimes(1);
    expect(store.getState().requests).toContain(request);
    expect(store.getState().storageWarning).toBe(true);
    expect(recovered.getItem(STORAGE_KEY)).toBeNull();

    blocked = false;
    accepted(
      store.dispatch({
        type: 'edit',
        id: request.id,
        fields: { ...RILEY_FIELDS, priority: 'Urgent' },
      }),
    );

    expect(save).toHaveBeenCalledTimes(2);
    expect(store.getState().storageWarning).toBe(false);
    expect(recovered.getItem(STORAGE_KEY)).toBe(serializeEnvelope(store.getState().requests));
  });

  it('resets in memory but leaves the stored value when the reset cannot be written', () => {
    const seed = serializeEnvelope(createSampleRequests().slice(0, 1));
    const { memory, store } = setup({ initial: { [STORAGE_KEY]: seed }, failOnSet: 'quota' });
    accepted(store.dispatch(CREATE_RILEY));
    expect(store.getState().requests).toHaveLength(2);

    store.resetToSamples();

    expect(store.getState().requests).toEqual(createSampleRequests());
    expect(store.getState().storageWarning).toBe(true);
    expect(memory.getItem(STORAGE_KEY)).toBe(seed);
  });

  it('resets in memory with one save attempt while storage is unavailable', () => {
    const { save, store } = setup({ getStorage: unavailableStorageGetter });
    accepted(store.dispatch(CREATE_RILEY));
    save.mockClear();

    store.resetToSamples();

    expect(store.getState().requests).toEqual(createSampleRequests());
    expect(store.getState().storageWarning).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('role (R12, A8)', () => {
  it('starts as Requester and switches role without saving', () => {
    const { memory, save, store, listener } = setup();
    expect(store.getState().role).toBe('Requester');

    store.setRole('Reviewer');

    expect(store.getState().role).toBe('Reviewer');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(memory.getItem(STORAGE_KEY)).toBeNull();
  });

  it('is not persisted, so a new store over the same storage opens as Requester', () => {
    const { memory, store } = setup();
    store.setRole('Reviewer');
    accepted(store.dispatch({ type: 'complete', id: 'REQ-0002' }));

    const reloaded = createAppStore({
      storage: createLocalStorageAdapter(() => memory),
      now: createFixedClock(),
    });

    expect(reloaded.getState().role).toBe('Requester');
    expect(reloaded.getState().requests).toEqual(store.getState().requests);
  });
});

