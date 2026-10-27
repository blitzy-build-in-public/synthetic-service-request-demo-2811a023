import { useId, useState } from 'react';
import { availableActions } from '../domain/transitions';
import type { CreateFields } from '../domain/model';
import type { FieldErrors } from '../domain/validation';
import { useAppState, useAppStore } from '../state/StoreContext';
import { RequestForm } from './RequestForm';
import { hrefForRequest, navigate } from './useHashRoute';
import { formatBlank, formatTimestamp } from './format';

const BLANK_CREATE_FIELDS: CreateFields = { requesterName: '', requestType: '', description: '' };

/** The request list: every request in store order, the inline create form, and the empty state. */
export function ListView() {
  const { requests, role } = useAppState();
  const store = useAppStore();
  const [creating, setCreating] = useState(false);
  const headingId = useId();

  // The domain alone decides whether this role may create; no role name is compared here.
  const createOffered = availableActions(role, null).some((rule) => rule.action === 'create');

  // A role switch can withdraw Create while the form is open. Resetting during render, and rendering the
  // form only while Create is offered, means no frame shows "Create draft" to a role that cannot use it,
  // and the unmounted form discards its unsaved input. It stays closed when Create is offered again.
  if (creating && !createOffered) {
    setCreating(false);
  }
  const formOpen = creating && createOffered;

  function handleCreate(fields: CreateFields): FieldErrors | null {
    const result = store.dispatch({ type: 'create', fields });
    if (result.ok) {
      setCreating(false);
      navigate(hrefForRequest(result.request.id));
      return null;
    }
    switch (result.error.kind) {
      case 'validation':
        return result.error.errors;
      // The shell shows the store's refusal alert; the form has no field to attach it to.
      case 'refused':
      case 'notFound':
        return null;
      default: {
        const unreachable: never = result.error;
        return unreachable;
      }
    }
  }

  // Exactly one create affordance is on screen at a time; the open form replaces the button.
  const createAffordance = createOffered ? (
    formOpen ? null : (
      <button
        type="button"
        onClick={() => {
          setCreating(true);
        }}
      >
        New request
      </button>
    )
  ) : (
    <p className="hint">Switch to Requester to create a request.</p>
  );

  const isEmpty = requests.length === 0;

  return (
    <>
      <h1 id={headingId}>Service requests</h1>
      {/* An empty flex child would still add a gap in the view, so the row renders only with content. */}
      {!isEmpty && createAffordance !== null && <div className="button-row">{createAffordance}</div>}
      {formOpen && (
        <RequestForm
          mode="create"
          initialValues={BLANK_CREATE_FIELDS}
          onSave={handleCreate}
          onCancel={() => {
            setCreating(false);
          }}
        />
      )}
      {isEmpty ? (
        <div className="empty-state">
          <p>No requests yet</p>
          {createAffordance}
        </div>
      ) : (
        <table className="data-table" aria-labelledby={headingId}>
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Requester name</th>
              <th scope="col">Request type</th>
              <th scope="col">Priority</th>
              <th scope="col">Status</th>
              <th scope="col">Last updated</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <td>
                  <a href={hrefForRequest(request.id)}>{request.id}</a>
                </td>
                <td>{formatBlank(request.requesterName)}</td>
                <td>{formatBlank(request.requestType)}</td>
                <td>{request.priority}</td>
                <td>{request.status}</td>
                <td>
                  <time dateTime={request.lastUpdated}>{formatTimestamp(request.lastUpdated)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
