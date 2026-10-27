import { describe, expect, it, vi } from 'vitest';
import {
  STORAGE_KEY,
  STORAGE_VERSION,
  createLocalStorageAdapter,
  parseEnvelope,
  serializeEnvelope,
} from './localStore';
import type { LoadResult } from './localStore';
import { createSampleRequests } from './sampleData';
import { createMemoryStorage, unavailableStorageGetter } from '../test/helpers';
import { nextRequestId } from '../domain/model';
import type { AuditEntry, ServiceRequest } from '../domain/model';

const CREATED_ENTRY: AuditEntry = {
  timestamp: '2026-02-01T09:00:00.000Z',
  role: 'Requester',
  action: 'Created',
  fromStatus: '',
  toStatus: '',
};

/** A valid, fictional Draft; each override replaces one attribute. */
function makeDraft(overrides: Partial<ServiceRequest> = {}): ServiceRequest {
  return {
    id: 'REQ-0001',
    requesterName: 'Riley Test',
    requestType: 'General Question',
    description: 'Fictional test request.',
    priority: 'Normal',
    status: 'Draft',
    lastUpdated: '2026-02-01T09:00:00.000Z',
    auditHistory: [CREATED_ENTRY],
    ...overrides,
  };
}

/** A valid request waiting for information whose last entry carries `note` as its reason. */
function makeWaiting(note: string): ServiceRequest {
  return makeDraft({
    status: 'Waiting for Information',
    lastUpdated: '2026-02-01T09:30:00.000Z',
    auditHistory: [
      CREATED_ENTRY,
      {
        timestamp: '2026-02-01T09:10:00.000Z',
        role: 'Requester',
        action: 'Submitted',
        fromStatus: 'Draft',
        toStatus: 'Submitted',
      },
      {
        timestamp: '2026-02-01T09:20:00.000Z',
        role: 'Reviewer',
        action: 'Review started',
        fromStatus: 'Submitted',
        toStatus: 'In Review',
      },
      {
        timestamp: '2026-02-01T09:30:00.000Z',
        role: 'Reviewer',
        action: 'Information requested',
        fromStatus: 'In Review',
        toStatus: 'Waiting for Information',
        note,
      },
    ],
  });
}

// Malformed shapes are built as plain records, so a wrong type or a missing key needs no type cast.
function draftWithField(key: string, value: unknown): Record<string, unknown> {
  return { ...makeDraft(), [key]: value };
}

function draftWithoutField(key: string): Record<string, unknown> {
  const request: Record<string, unknown> = { ...makeDraft() };
  delete request[key];
  return request;
}

function draftWithEntryField(key: string, value: unknown): Record<string, unknown> {
  return { ...makeDraft(), auditHistory: [{ ...CREATED_ENTRY, [key]: value }] };
}

/** A version 1 envelope string around arbitrary, possibly malformed, request values. */
function envelopeWith(requests: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, requests, ...extra });
}

/** Loads through the adapter from a storage seeded with `raw` under `STORAGE_KEY`. */
function loadRaw(raw: string): LoadResult {
  const storage = createMemoryStorage({ initial: { [STORAGE_KEY]: raw } });
  return createLocalStorageAdapter(() => storage).load();
}

// Built on the memory double, so every member other than the overridden one keeps working.
function throwingGetItemStorage(): Storage {
  return Object.assign(createMemoryStorage(), {
    getItem(): never {
      throw new DOMException('Blocked', 'SecurityError');
    },
  });
}

function throwingSetItemStorage(error: unknown): Storage {
  return Object.assign(createMemoryStorage(), {
    setItem(): never {
      throw error;
    },
  });
}

function readStored(storage: Storage): string {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) {
    throw new Error(`Expected a value stored under ${STORAGE_KEY}.`);
  }
  return raw;
}

/** Every key in `storage` with its raw value, read back through the `Storage` interface itself. */
function storedEntries(storage: Storage): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    const value = key === null ? null : storage.getItem(key);
    if (key === null || value === null) {
      throw new Error(`Expected a stored entry at position ${index}.`);
    }
    entries[key] = value;
  }
  return entries;
}

function loadedRequests(result: LoadResult): ServiceRequest[] {
  if (result.kind !== 'ok') {
    throw new Error(`Expected an ok load, received ${result.kind}.`);
  }
  return result.requests;
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected an item at position ${index}.`);
  }
  return item;
}

describe('storage key and envelope', () => {
  it('uses the one versioned key and envelope version 1', () => {
    expect(STORAGE_KEY).toBe('service-request-demo.v1');
    expect(STORAGE_VERSION).toBe(1);
  });

  it('round-trips samples, a blank-type Draft and a noted Edited entry exactly', () => {
    const requests: ServiceRequest[] = [
      ...createSampleRequests(),
      makeDraft({
        id: 'REQ-0004',
        requestType: '',
        priority: 'Urgent',
        lastUpdated: '2026-02-01T09:05:00.000Z',
        auditHistory: [
          CREATED_ENTRY,
          {
            timestamp: '2026-02-01T09:05:00.000Z',
            role: 'Requester',
            action: 'Edited',
            fromStatus: 'Draft',
            toStatus: '',
            note: 'Priority: Normal to Urgent',
          },
        ],
      }),
    ];
    const storage = createMemoryStorage();
    const adapter = createLocalStorageAdapter(() => storage);

    expect(adapter.save(requests)).toStrictEqual({ ok: true });
    expect(adapter.load()).toStrictEqual({ kind: 'ok', requests });
  });

  // A clock outside the years 0 to 9999 makes `toISOString` write a signed six-digit year; the
  // last two values are the latest and earliest instants a Date can hold.
  it.each([
    '+010000-01-01T00:00:00.000Z',
    '-000001-01-01T00:00:00.000Z',
    '+275760-09-13T00:00:00.000Z',
    '-271821-04-20T00:00:00.000Z',
  ])('round-trips the expanded-year %s in lastUpdated and the audit entry', (timestamp) => {
    const requests = [
      makeDraft({ lastUpdated: timestamp, auditHistory: [{ ...CREATED_ENTRY, timestamp }] }),
    ];
    const storage = createMemoryStorage();
    const adapter = createLocalStorageAdapter(() => storage);

    expect(new Date(timestamp).toISOString()).toBe(timestamp);
    expect(adapter.save(requests)).toStrictEqual({ ok: true });
    expect(adapter.load()).toStrictEqual({ kind: 'ok', requests });
  });

  it('stores the compact envelope under the key and writes no other key', () => {
    const requests = createSampleRequests();
    const storage = createMemoryStorage();

    expect(createLocalStorageAdapter(() => storage).save(requests)).toStrictEqual({ ok: true });

    const raw = readStored(storage);
    expect(raw).toBe(serializeEnvelope(requests));
    expect(raw).not.toContain('\n');
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toStrictEqual({ version: STORAGE_VERSION, requests });
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe(STORAGE_KEY);
  });

  it('loads a saved empty list as ok with no requests', () => {
    const storage = createMemoryStorage();
    const adapter = createLocalStorageAdapter(() => storage);

    expect(adapter.save([])).toStrictEqual({ ok: true });
    expect(adapter.load()).toStrictEqual({ kind: 'ok', requests: [] });
  });
});

describe('load classification', () => {
  it('reports an absent key as empty', () => {
    const storage = createMemoryStorage();

    expect(createLocalStorageAdapter(() => storage).load()).toStrictEqual({ kind: 'empty' });
  });

  it('reports a throwing storage getter as unavailable', () => {
    expect(createLocalStorageAdapter(unavailableStorageGetter).load()).toStrictEqual({
      kind: 'unavailable',
    });
  });

  it('reports a throwing getItem as unavailable', () => {
    const storage = throwingGetItemStorage();

    expect(createLocalStorageAdapter(() => storage).load()).toStrictEqual({ kind: 'unavailable' });
  });

  it('reports text that is not JSON as unreadable', () => {
    expect(loadRaw('not json {')).toStrictEqual({ kind: 'unreadable' });
  });

  it.each(['[]', 'null', '42', '"text"', 'true'])(
    'reports JSON %s, which is not a plain object, as unreadable',
    (raw) => {
      expect(loadRaw(raw)).toStrictEqual({ kind: 'unreadable' });
    },
  );

  it.each([
    { name: 'version 2', raw: '{"version":2,"requests":[]}' },
    { name: 'a missing version', raw: '{"requests":[]}' },
    { name: 'the string "1" as version', raw: '{"version":"1","requests":[]}' },
    { name: 'version 2 with malformed requests', raw: '{"version":2,"requests":"x"}' },
  ])('reports $name as wrongVersion', ({ raw }) => {
    expect(loadRaw(raw)).toStrictEqual({ kind: 'wrongVersion' });
  });

  it.each([
    { name: 'an object', raw: '{"version":1,"requests":{}}' },
    { name: 'missing', raw: '{"version":1}' },
    { name: 'a string', raw: '{"version":1,"requests":"x"}' },
    { name: 'null', raw: '{"version":1,"requests":null}' },
  ])('reports version 1 with requests that are $name as unreadable', ({ raw }) => {
    expect(loadRaw(raw)).toStrictEqual({ kind: 'unreadable' });
  });
});

describe('request and audit entry shape on load', () => {
  it.each([
    { name: 'status Closed', request: draftWithField('status', 'Closed') },
    { name: 'priority High', request: draftWithField('priority', 'High') },
    { name: 'request type Other', request: draftWithField('requestType', 'Other') },
    { name: 'a missing id', request: draftWithoutField('id') },
    { name: 'id REQ-1', request: draftWithField('id', 'REQ-1') },
    { name: 'id ABC-0001', request: draftWithField('id', 'ABC-0001') },
    {
      name: 'an 81-character requester name',
      request: draftWithField('requesterName', 'a'.repeat(81)),
    },
    {
      name: 'a 2001-character description',
      request: draftWithField('description', 'a'.repeat(2001)),
    },
    { name: 'a numeric requester name', request: draftWithField('requesterName', 42) },
    { name: 'lastUpdated "yesterday"', request: draftWithField('lastUpdated', 'yesterday') },
    {
      name: 'lastUpdated on 30 February',
      request: draftWithField('lastUpdated', '2026-02-30T09:00:00.000Z'),
    },
    {
      name: 'a blank type on a Submitted request',
      request: { ...draftWithField('requestType', ''), status: 'Submitted' },
    },
    { name: 'an empty audit history', request: draftWithField('auditHistory', []) },
    {
      name: 'an audit history that is not an array',
      request: draftWithField('auditHistory', CREATED_ENTRY),
    },
    {
      name: 'a first entry Edited, not Created',
      request: draftWithEntryField('action', 'Edited'),
    },
    { name: 'an entry with role Admin', request: draftWithEntryField('role', 'Admin') },
    { name: 'an entry with action Deleted', request: draftWithEntryField('action', 'Deleted') },
    { name: 'an entry from status Closed', request: draftWithEntryField('fromStatus', 'Closed') },
    { name: 'an entry to status Closed', request: draftWithEntryField('toStatus', 'Closed') },
    { name: 'an entry with a numeric timestamp', request: draftWithEntryField('timestamp', 42) },
    { name: 'an entry with an empty note', request: draftWithEntryField('note', '') },
    { name: 'an entry with a null note', request: draftWithEntryField('note', null) },
    { name: 'an entry with a 1001-character note', request: makeWaiting('a'.repeat(1001)) },
    {
      name: 'an entry that is not an object',
      request: { ...makeDraft(), auditHistory: ['Created'] },
    },
    { name: 'a request that is not an object', request: 'REQ-0001' },
    // Each fits a loose ISO shape but is text `toISOString` never writes: a signed four-digit
    // year, a negative zero year, an expanded year missing its sign or sixth digit, and an
    // instant one millisecond past the Date range.
    ...[
      '+002026-02-01T09:00:00.000Z',
      '-000000-01-01T00:00:00.000Z',
      '010000-01-01T00:00:00.000Z',
      '+10000-01-01T00:00:00.000Z',
      '+275760-09-13T00:00:00.001Z',
    ].flatMap((timestamp) => [
      { name: `lastUpdated ${timestamp}`, request: draftWithField('lastUpdated', timestamp) },
      { name: `an entry at ${timestamp}`, request: draftWithEntryField('timestamp', timestamp) },
    ]),
  ])('rejects the whole value for $name as unreadable', ({ request }) => {
    expect(loadRaw(envelopeWith([request]))).toStrictEqual({ kind: 'unreadable' });
  });

  // Code points, not UTF-16 units: each emoji is one character to the limits but two units long.
  it.each([
    { name: 'a blank request type on a Draft', request: makeDraft({ requestType: '' }) },
    {
      name: 'a blank name and description on a Draft',
      request: makeDraft({ requesterName: '', description: '' }),
    },
    {
      name: 'an 80-code-point requester name',
      request: makeDraft({ requesterName: '\u{1F600}'.repeat(80) }),
    },
    {
      name: 'a 2000-code-point description',
      request: makeDraft({ description: '\u{1F600}'.repeat(2000) }),
    },
    { name: 'a 1000-character note', request: makeWaiting('a'.repeat(1000)) },
    { name: 'an id past REQ-9999', request: makeDraft({ id: 'REQ-10000' }) },
  ])('accepts $name', ({ request }) => {
    expect(loadRaw(envelopeWith([request]))).toStrictEqual({ kind: 'ok', requests: [request] });
  });

  it('reports two requests sharing an id as unreadable', () => {
    const raw = envelopeWith([makeDraft(), makeDraft({ requesterName: 'Morgan Test' })]);

    expect(loadRaw(raw)).toStrictEqual({ kind: 'unreadable' });
  });

  it('rejects a valid request stored beside an invalid one', () => {
    const raw = envelopeWith([makeDraft(), draftWithField('id', 'REQ-2')]);

    expect(loadRaw(raw)).toStrictEqual({ kind: 'unreadable' });
  });

  it.each([
    { name: 'non-JSON text', raw: 'not json {', expected: { kind: 'unreadable' } },
    {
      name: 'a version 2 envelope',
      raw: '{"version":2,"requests":[]}',
      expected: { kind: 'wrongVersion' },
    },
    {
      name: 'a valid envelope',
      raw: envelopeWith([makeDraft()]),
      expected: { kind: 'ok', requests: [makeDraft()] },
    },
  ])('parseEnvelope classifies $name as load does', ({ raw, expected }) => {
    expect(parseEnvelope(raw)).toStrictEqual(expected);
    expect(parseEnvelope(raw)).toStrictEqual(loadRaw(raw));
  });
});

describe('load never writes', () => {
  // The valid rows are spaced or carry unknown keys, so any compact or normalising rewrite of an ok
  // load changes their bytes.
  it.each<{ name: string; initial: Record<string, string>; kind: LoadResult['kind'] }>([
    { name: 'empty', initial: {}, kind: 'empty' },
    {
      name: 'spaced-JSON valid',
      initial: { [STORAGE_KEY]: JSON.stringify({ version: 1, requests: [makeDraft()] }, null, 2) },
      kind: 'ok',
    },
    {
      name: 'unknown-key valid',
      initial: {
        [STORAGE_KEY]: envelopeWith([{ ...makeDraft(), colour: 'blue' }], {
          exportedBy: 'Riley Test',
        }),
      },
      kind: 'ok',
    },
    { name: 'unreadable', initial: { [STORAGE_KEY]: 'not json {' }, kind: 'unreadable' },
    {
      name: 'wrong-version',
      initial: { [STORAGE_KEY]: '{"version":2,"requests":[]}' },
      kind: 'wrongVersion',
    },
  ])('leaves $name storage byte-identical across repeated loads', ({ initial, kind }) => {
    const storage = createMemoryStorage({ initial });
    const setItem = vi.spyOn(storage, 'setItem');
    const removeItem = vi.spyOn(storage, 'removeItem');
    const clear = vi.spyOn(storage, 'clear');
    const adapter = createLocalStorageAdapter(() => storage);

    expect(adapter.load().kind).toBe(kind);
    expect(adapter.load().kind).toBe(kind);

    expect(storedEntries(storage)).toStrictEqual(initial);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('unknown keys', () => {
  it('drops unknown envelope, request and entry keys on load', () => {
    const raw = envelopeWith(
      [{ ...makeDraft(), colour: 'blue', auditHistory: [{ ...CREATED_ENTRY, extra: true }] }],
      { exportedBy: 'Riley Test' },
    );

    const requests = loadedRequests(loadRaw(raw));

    expect(requests).toStrictEqual([makeDraft()]);
    const request = itemAt(requests, 0);
    expect('colour' in request).toBe(false);
    expect('extra' in itemAt(request.auditHistory, 0)).toBe(false);
  });
});

describe('save classification', () => {
  it.each([
    {
      name: 'a QuotaExceededError DOMException',
      makeStorage: () => createMemoryStorage({ failOnSet: 'quota' }),
      reason: 'quota',
    },
    {
      name: 'the QuotaExceededError name alone',
      makeStorage: () =>
        throwingSetItemStorage(
          Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' }),
        ),
      reason: 'quota',
    },
    {
      name: 'the legacy quota code 22',
      makeStorage: () =>
        throwingSetItemStorage(Object.assign(new Error('Legacy quota'), { code: 22 })),
      reason: 'quota',
    },
    {
      name: 'a SecurityError',
      makeStorage: () => createMemoryStorage({ failOnSet: 'unavailable' }),
      reason: 'unavailable',
    },
    {
      name: 'any other Error',
      makeStorage: () => throwingSetItemStorage(new Error('Disk error')),
      reason: 'unavailable',
    },
    {
      name: 'a thrown non-object',
      makeStorage: () => throwingSetItemStorage('Storage failed'),
      reason: 'unavailable',
    },
  ])('reports $name from setItem as $reason without throwing', ({ makeStorage, reason }) => {
    const storage = makeStorage();

    expect(createLocalStorageAdapter(() => storage).save([makeDraft()])).toStrictEqual({
      ok: false,
      reason,
    });
  });

  it('reports a throwing storage getter as unavailable without throwing', () => {
    const adapter = createLocalStorageAdapter(unavailableStorageGetter);

    expect(() => adapter.save([])).not.toThrow();
    expect(adapter.save([])).toStrictEqual({ ok: false, reason: 'unavailable' });
  });

  it('keeps the previously stored value when a write fails for quota', () => {
    const stored = serializeEnvelope(createSampleRequests());
    const storage = createMemoryStorage({ initial: { [STORAGE_KEY]: stored }, failOnSet: 'quota' });
    const adapter = createLocalStorageAdapter(() => storage);

    expect(adapter.save([makeDraft()])).toStrictEqual({ ok: false, reason: 'quota' });
    expect(readStored(storage)).toBe(stored);
    expect(adapter.load()).toStrictEqual({ kind: 'ok', requests: createSampleRequests() });
  });
});

describe('storage lookup on every use', () => {
  it('calls getStorage afresh for each load and save', () => {
    const storage = createMemoryStorage();
    let calls = 0;
    const adapter = createLocalStorageAdapter(() => {
      calls += 1;
      return storage;
    });

    adapter.load();
    expect(calls).toBe(1);
    adapter.save([makeDraft()]);
    expect(calls).toBe(2);
    adapter.save([makeDraft()]);
    expect(calls).toBe(3);
  });

  it('succeeds on a retry once storage becomes reachable', () => {
    const storage = createMemoryStorage();
    let attempts = 0;
    const adapter = createLocalStorageAdapter(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new DOMException('Blocked', 'SecurityError');
      }
      return storage;
    });
    const requests = [makeDraft()];

    expect(adapter.save(requests)).toStrictEqual({ ok: false, reason: 'unavailable' });
    expect(adapter.save(requests)).toStrictEqual({ ok: true });
    expect(adapter.load()).toStrictEqual({ kind: 'ok', requests });
  });
});

// Written out independently of sampleData.ts, so a change there cannot change what is expected.
const expectedSamples: readonly ServiceRequest[] = [
  {
    id: 'REQ-0001',
    requesterName: 'Alex Example',
    requestType: 'Equipment Request',
    description: 'Requesting a second monitor for the demo desk.',
    priority: 'Normal',
    status: 'Draft',
    lastUpdated: '2026-01-05T09:00:00.000Z',
    auditHistory: [
      {
        timestamp: '2026-01-05T09:00:00.000Z',
        role: 'Requester',
        action: 'Created',
        fromStatus: '',
        toStatus: '',
      },
    ],
  },
  {
    id: 'REQ-0002',
    requesterName: 'Jordan Sample',
    requestType: 'Access Request',
    description: 'Read access to the sample project folder for evaluation.',
    priority: 'Normal',
    status: 'In Review',
    lastUpdated: '2026-01-07T09:30:00.000Z',
    auditHistory: [
      {
        timestamp: '2026-01-06T10:00:00.000Z',
        role: 'Requester',
        action: 'Created',
        fromStatus: '',
        toStatus: '',
      },
      {
        timestamp: '2026-01-06T10:15:00.000Z',
        role: 'Requester',
        action: 'Submitted',
        fromStatus: 'Draft',
        toStatus: 'Submitted',
      },
      {
        timestamp: '2026-01-07T09:30:00.000Z',
        role: 'Reviewer',
        action: 'Review started',
        fromStatus: 'Submitted',
        toStatus: 'In Review',
      },
    ],
  },
  {
    id: 'REQ-0003',
    requesterName: 'Casey Placeholder',
    requestType: 'General Question',
    description: 'How does this demo store its data?',
    priority: 'Normal',
    status: 'Waiting for Information',
    lastUpdated: '2026-01-09T14:30:00.000Z',
    auditHistory: [
      {
        timestamp: '2026-01-08T11:00:00.000Z',
        role: 'Requester',
        action: 'Created',
        fromStatus: '',
        toStatus: '',
      },
      {
        timestamp: '2026-01-08T11:20:00.000Z',
        role: 'Requester',
        action: 'Submitted',
        fromStatus: 'Draft',
        toStatus: 'Submitted',
      },
      {
        timestamp: '2026-01-09T14:00:00.000Z',
        role: 'Reviewer',
        action: 'Review started',
        fromStatus: 'Submitted',
        toStatus: 'In Review',
      },
      {
        timestamp: '2026-01-09T14:30:00.000Z',
        role: 'Reviewer',
        action: 'Information requested',
        fromStatus: 'In Review',
        toStatus: 'Waiting for Information',
        note: 'Please confirm which browser you are using.',
      },
    ],
  },
];

describe('sample data', () => {
  it('matches the three fixed samples field for field', () => {
    expect(createSampleRequests()).toStrictEqual(expectedSamples);
  });

  it('gives every sample Normal priority and the last entry timestamp as lastUpdated', () => {
    for (const request of createSampleRequests()) {
      expect(request.priority).toBe('Normal');
      expect(request.lastUpdated).toBe(request.auditHistory.at(-1)?.timestamp);
    }
  });

  it('returns fresh objects on every call', () => {
    const first = createSampleRequests();
    const second = createSampleRequests();

    expect(first).toStrictEqual(second);
    expect(first).not.toBe(second);
    first.forEach((request, index) => {
      const other = itemAt(second, index);
      expect(request).not.toBe(other);
      expect(request.auditHistory).not.toBe(other.auditHistory);
      request.auditHistory.forEach((entry, entryIndex) => {
        expect(entry).not.toBe(itemAt(other.auditHistory, entryIndex));
      });
    });
  });

  it('is unaffected by changes a caller makes to an earlier result', () => {
    const first = createSampleRequests();
    const firstRequest = itemAt(first, 0);
    first.push(makeDraft({ id: 'REQ-0099' }));
    // The model's fields are readonly to callers, so the mutation goes through Object.assign.
    Object.assign(firstRequest, { requesterName: 'Changed Name' });
    Object.assign(itemAt(firstRequest.auditHistory, 0), { role: 'Reviewer' });

    expect(first).toHaveLength(4);
    expect(firstRequest.requesterName).toBe('Changed Name');
    expect(createSampleRequests()).toStrictEqual(expectedSamples);
  });

  it('survives serialisation and parsing unchanged', () => {
    expect(parseEnvelope(serializeEnvelope(createSampleRequests()))).toStrictEqual({
      kind: 'ok',
      requests: expectedSamples,
    });
  });

  it('makes REQ-0004 the next ID after a reset', () => {
    expect(nextRequestId(createSampleRequests())).toBe('REQ-0004');
  });
});
