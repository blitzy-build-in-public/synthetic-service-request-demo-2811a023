import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import {
  clickAction,
  createFixedClock,
  createRequest,
  detailsText,
  goToHash,
  readTableRows,
  renderApp,
  ROLE_LABEL,
  switchRole,
} from './helpers';
import { STORAGE_KEY } from '../storage/localStore';

// Every render here leaves `storage` and `getStorage` unset, so both sides of a reload share jsdom's real
// `window.localStorage`, which src/test/setup.ts clears after each test: every test starts from the
// first-run samples, and the first request created is REQ-0004. A reload is `unmount()` followed by a new
// `renderApp()`, which builds a fresh adapter, store and clock that load from that same storage.

const REQUEST_IDS = ['REQ-0001', 'REQ-0002', 'REQ-0003', 'REQ-0004'];

const LIST_ID = 0;
const LIST_PRIORITY = 3;
const LIST_STATUS = 4;
const AUDIT_ACTION = 2;
const AUDIT_NOTE = 5;

function getRoleSelect(): HTMLSelectElement {
  const select = screen.getByLabelText(ROLE_LABEL);
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`The control labelled "${ROLE_LABEL}" is not a <select>.`);
  }
  return select;
}

function changeField(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function readListRows(): string[][] {
  goToHash('#/');
  return readTableRows(screen.getByRole('table', { name: 'Service requests' }));
}

function readAuditRows(id: string): string[][] {
  goToHash(`#/requests/${id}`);
  return readTableRows(screen.getByRole('table', { name: 'Audit history' }));
}

function readStoredValue(): string {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === null) {
    throw new Error(`Nothing is stored under ${STORAGE_KEY}.`);
  }
  return stored;
}

describe('reload persistence', () => {
  it('AC5 reload preserves state', () => {
    const first = renderApp({ now: createFixedClock('2026-02-01T09:00:00.000Z') });

    goToHash('#/');
    createRequest({
      requesterName: 'Riley Test',
      requestType: 'Equipment Request',
      description: 'Fictional desk lamp for the reload check.',
    });
    expect(window.location.hash).toBe('#/requests/REQ-0004');
    clickAction('Edit');
    changeField('Description', 'Fictional desk lamp and stand for the reload check.');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(detailsText('Description')).toBe('Fictional desk lamp and stand for the reload check.');
    clickAction('Submit');
    expect(detailsText('Status')).toBe('Submitted');

    switchRole('Reviewer');
    clickAction('Start review');
    expect(detailsText('Status')).toBe('In Review');

    goToHash('#/requests/REQ-0002');
    clickAction('Request more information');
    changeField('Reason', 'Please name the fictional folder you need.');
    fireEvent.click(screen.getByRole('button', { name: 'Send reason' }));
    expect(detailsText('Status')).toBe('Waiting for Information');

    // Snapshots are frozen and replaced on every change, so this reference keeps the pre-reload state.
    const requestsBefore = first.store.getState().requests;
    const listBefore = readListRows();
    const auditBefore = REQUEST_IDS.map((id) => readAuditRows(id));

    // The captured views reflect every change, so equality after the reload cannot pass on the samples alone.
    expect(listBefore.map((row) => [row[LIST_ID], row[LIST_STATUS]])).toEqual([
      ['REQ-0001', 'Draft'],
      ['REQ-0002', 'Waiting for Information'],
      ['REQ-0003', 'Waiting for Information'],
      ['REQ-0004', 'In Review'],
    ]);
    expect(auditBefore[1]?.map((row) => row[AUDIT_ACTION])).toEqual([
      'Created',
      'Submitted',
      'Review started',
      'Information requested',
    ]);
    expect(auditBefore[3]?.map((row) => row[AUDIT_ACTION])).toEqual([
      'Created',
      'Edited',
      'Submitted',
      'Review started',
    ]);
    expect(first.store.getState().role).toBe('Reviewer');

    const stored = readStoredValue();
    const envelope: unknown = JSON.parse(stored);
    expect(envelope).toEqual({ version: 1, requests: requestsBefore });

    first.unmount();
    // A later start than the first clock, so any timestamp the reload regenerated instead of reading
    // from storage would differ from the captured one.
    const second = renderApp({ now: createFixedClock('2026-03-01T09:00:00.000Z') });

    expect(second.store.getState().requests).toEqual(requestsBefore);
    expect(readListRows()).toEqual(listBefore);
    expect(REQUEST_IDS.map((id) => readAuditRows(id))).toEqual(auditBefore);
    // The role is not persisted, so the reloaded app opens as Requester again.
    expect(second.store.getState()).toMatchObject({
      role: 'Requester',
      storageWarning: false,
      loadIssue: null,
      refusal: null,
    });
    expect(getRoleSelect().value).toBe('Requester');
    // Startup and viewing only read: the stored value is exactly what the last change wrote.
    expect(readStoredValue()).toBe(stored);
  });

  it('AC10 reload keeps Urgent priority', () => {
    const first = renderApp();

    goToHash('#/');
    createRequest({
      requesterName: 'Morgan Trial',
      requestType: 'General Question',
      description: 'Fictional question for the priority reload check.',
    });
    expect(window.location.hash).toBe('#/requests/REQ-0004');
    expect(detailsText('Priority')).toBe('Normal');
    clickAction('Edit');
    changeField('Priority', 'Urgent');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(detailsText('Priority')).toBe('Urgent');

    first.unmount();
    renderApp();

    const listRow = readListRows().find((row) => row[LIST_ID] === 'REQ-0004');
    expect(listRow?.[LIST_PRIORITY]).toBe('Urgent');
    const auditRows = readAuditRows('REQ-0004');
    expect(detailsText('Priority')).toBe('Urgent');
    expect(auditRows.slice(-1).map((row) => [row[AUDIT_ACTION], row[AUDIT_NOTE]])).toEqual([
      ['Edited', 'Priority: Normal to Urgent'],
    ]);
  });
});
