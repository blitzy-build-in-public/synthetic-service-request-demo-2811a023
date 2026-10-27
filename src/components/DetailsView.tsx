import { useId, useRef, useState } from 'react';
import { availableActions } from '../domain/transitions';
import { latestInformationRequest } from '../domain/audit';
import type { EditFields, ServiceRequest } from '../domain/model';
import type { FieldErrors } from '../domain/validation';
import { useAppState, useAppStore } from '../state/StoreContext';
import { ActionPanel } from './ActionPanel';
import { RequestForm } from './RequestForm';
import { hrefForList } from './useHashRoute';
import { formatBlank, formatStatusCell, formatTimestamp } from './format';

/** Props for `NotFound`. */
export interface NotFoundProps {
  /** The message to show, e.g. "Request REQ-9999 was not found." or "Page not found.". */
  message: string;
}

/** A not-found message with a link back to the request list. */
export function NotFound({ message }: NotFoundProps) {
  return (
    <>
      <h1>{message}</h1>
      <p>
        <a className="back-link" href={hrefForList()}>
          Back to list
        </a>
      </p>
    </>
  );
}

/** Props for `DetailsView`. */
export interface DetailsViewProps {
  /** Request ID decoded from the hash. */
  id: string;
}

// Submit messages describe the stored fields they were computed from, so they are tied to that exact
// request snapshot. A successful edit or submit, and also a confirmed reset that replaces this request
// while the view stays open, produces a new object, so stale messages never sit beside changed values.
interface SubmitFeedback {
  readonly request: ServiceRequest;
  readonly errors: FieldErrors;
}

type SubmitField = 'requesterName' | 'requestType' | 'description';

const NO_ERRORS: FieldErrors = {};

/**
 * One request's details: every field, the reason while information is awaited, the actions the current
 * role may perform, the inline edit form, and the full audit history in append order. An ID matching no
 * request shows `NotFound`.
 */
export function DetailsView({ id }: DetailsViewProps) {
  // Every hook runs before the not-found return, so the hook order never depends on the data.
  const { requests, role } = useAppState();
  const store = useAppStore();
  const [editing, setEditing] = useState(false);
  const [submitFeedback, setSubmitFeedback] = useState<SubmitFeedback | null>(null);
  const auditHeadingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const request = requests.find((candidate) => candidate.id === id);
  if (request === undefined) {
    return <NotFound message={`Request ${id} was not found.`} />;
  }

  // The domain alone decides whether Edit is offered; no role or status is compared here.
  const editOffered = availableActions(role, request.status).some((rule) => rule.action === 'edit');

  // A role switch withdraws Edit while the form may be open. Resetting during render, and showing the
  // form only while Edit is offered, means no frame shows "Save changes" to a role that cannot use it.
  if (editing && !editOffered) {
    setEditing(false);
  }
  const formOpen = editing && editOffered;

  const submitErrors =
    submitFeedback !== null && submitFeedback.request === request ? submitFeedback.errors : NO_ERRORS;

  const submitError = (field: SubmitField) => {
    const message = submitErrors[field];
    return message === undefined || message === '' ? null : (
      <p className="field-error">{message}</p>
    );
  };

  // Opening or closing the form unmounts the control that was clicked, which would drop focus to the
  // page body. The heading stays mounted throughout, so focus moves there and the next Tab reaches the
  // first control of the new content. A role switch closes the form without this, as focus is on the switch.
  const setEditMode = (open: boolean) => {
    setEditing(open);
    headingRef.current?.focus();
  };

  const handleEdit = (fields: EditFields): FieldErrors | null => {
    const result = store.dispatch({ type: 'edit', id: request.id, fields });
    if (result.ok) {
      setEditMode(false);
      setSubmitFeedback(null);
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
  };

  return (
    <>
      <p>
        <a className="back-link" href={hrefForList()}>
          Back to list
        </a>
      </p>
      <h1 ref={headingRef} tabIndex={-1}>
        {request.id}
      </h1>
      {formOpen ? (
        <RequestForm
          mode="edit"
          initialValues={{
            requesterName: request.requesterName,
            requestType: request.requestType,
            description: request.description,
            priority: request.priority,
          }}
          onSave={handleEdit}
          onCancel={() => {
            setEditMode(false);
          }}
        />
      ) : (
        // The three rows Submit checks are polite live regions, so a submit message inserted beside a
        // field is announced while focus stays on the Submit button. The Status row is one as well, and
        // atomic, so a transition that leaves the view open is announced as "Status <new status>"; it
        // sits outside the keyed ActionPanel, which a transition remounts.
        <dl className="field-list">
          <div>
            <dt>Requester name</dt>
            <dd aria-live="polite">
              {formatBlank(request.requesterName)}
              {submitError('requesterName')}
            </dd>
          </div>
          <div>
            <dt>Request type</dt>
            <dd aria-live="polite">
              {formatBlank(request.requestType)}
              {submitError('requestType')}
            </dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd aria-live="polite">
              {formatBlank(request.description)}
              {submitError('description')}
            </dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{request.priority}</dd>
          </div>
          <div aria-live="polite" aria-atomic="true">
            <dt>Status</dt>
            <dd>{request.status}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>
              <time dateTime={request.lastUpdated}>{formatTimestamp(request.lastUpdated)}</time>
            </dd>
          </div>
          {/* A presentation read of the status, not a permission decision: the reason is shown only
              while it is still awaited, and stays in the audit history afterwards. */}
          {request.status === 'Waiting for Information' && (
            <div>
              <dt>Reason for information request</dt>
              <dd>{formatBlank(latestInformationRequest(request))}</dd>
            </div>
          )}
        </dl>
      )}
      {/* Hidden while editing, so Submit cannot run against the stored fields mid-edit. The key remounts
          the panel on any role or status change, which closes an open note form. A remount after an
          accepted transition also removes the focused control, so focus moves to the heading, which
          stays mounted. It moves there from the action itself rather than on any status change, so a
          role switch or a confirmed reset keeps focus on the control the user is on. */}
      {!formOpen && (
        <ActionPanel
          key={`${role}:${request.status}`}
          request={request}
          role={role}
          onEdit={() => {
            setEditMode(true);
          }}
          onSubmitErrors={(errors) => {
            setSubmitFeedback({ request, errors });
          }}
          onTransition={() => {
            headingRef.current?.focus();
          }}
        />
      )}
      <h2 id={auditHeadingId}>Audit history</h2>
      {/* On narrow screens the table scrolls sideways on its own, and no cell holds a focusable control.
          Safari never focuses a scroll container, so the table takes focus itself, letting keyboard users
          scroll to the columns off screen, the Note column included. */}
      <table className="data-table" aria-labelledby={auditHeadingId} tabIndex={0}>
        <thead>
          <tr>
            <th scope="col">Timestamp</th>
            <th scope="col">Role</th>
            <th scope="col">Action</th>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {/* Stored append order is the chronological order and is never sorted. Index keys are stable
              because the history is append-only: an entry never moves or disappears. */}
          {request.auditHistory.map((entry, index) => (
            <tr key={index}>
              <td>
                <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
              </td>
              <td>{entry.role}</td>
              <td>{entry.action}</td>
              <td>{formatStatusCell(entry.fromStatus)}</td>
              <td>{formatStatusCell(entry.toStatus)}</td>
              <td>{formatBlank(entry.note)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
