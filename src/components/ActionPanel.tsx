import { useId, useState } from 'react';
// React's SubmitEvent, not FormEvent: the pinned @types/react deprecates FormEvent and types onSubmit with SubmitEvent.
import type { ChangeEvent, SubmitEvent } from 'react';
import { availableActions, isTerminal } from '../domain/transitions';
import type { Command, TransitionRule } from '../domain/transitions';
import type { Role, ServiceRequest } from '../domain/model';
import type { FieldErrors } from '../domain/validation';
import { useAppStore } from '../state/StoreContext';

/** Props for `ActionPanel`. */
export interface ActionPanelProps {
  /** The request whose actions are offered. */
  request: ServiceRequest;
  /** The currently selected simulated role. */
  role: Role;
  /** Opens the edit form in the details view. */
  onEdit: () => void;
  /** Receives Submit validation errors, or an empty object after a successful submit. */
  onSubmitErrors: (errors: FieldErrors) => void;
}

type NoteField = NonNullable<TransitionRule['noteField']>;

interface NoteCopy {
  readonly label: string;
  readonly send: string;
}

function noteCopy(field: NoteField): NoteCopy {
  switch (field) {
    case 'reason':
      return { label: 'Reason', send: 'Send reason' };
    case 'suppliedInformation':
      return { label: 'Supplied information', send: 'Send information' };
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

// The note travels raw: the domain trims it and applies the required and length rules.
function noteCommand(rule: TransitionRule, id: string, note: string): Command | null {
  switch (rule.action) {
    case 'requestInfo':
      return { type: 'requestInfo', id, note };
    case 'supplyInfo':
      return { type: 'supplyInfo', id, note };
    case 'create':
    case 'edit':
    case 'submit':
    case 'startReview':
    case 'complete':
      return null;
    default: {
      const unreachable: never = rule.action;
      return unreachable;
    }
  }
}

/**
 * Offers one control per transition-table row `availableActions` returns for the role and status, with
 * an inline note form for rows that need one. It decides nothing itself: the store's dispatch runs every
 * command through the domain, and a refusal is shown by the app shell. The parent keys the panel by role
 * and status, so a role switch or a completed transition remounts it and closes any open note form.
 */
export function ActionPanel({ request, role, onEdit, onSubmitErrors }: ActionPanelProps) {
  const store = useAppStore();
  // Create belongs to the list view; a details panel only offers actions on this request.
  const rules = availableActions(role, request.status).filter((rule) => rule.action !== 'create');
  const [openRule, setOpenRule] = useState<TransitionRule | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteError, setNoteError] = useState<string | undefined>(undefined);
  const noteId = useId();
  const noteErrorId = `${noteId}-error`;

  function handleAction(rule: TransitionRule) {
    if (rule.noteField !== null) {
      setOpenRule(rule);
      setNoteText('');
      setNoteError(undefined);
      return;
    }
    switch (rule.action) {
      case 'edit':
        onEdit();
        return;
      case 'submit': {
        const result = store.dispatch({ type: 'submit', id: request.id });
        if (result.ok) {
          onSubmitErrors({});
        } else if (result.error.kind === 'validation') {
          onSubmitErrors(result.error.errors);
        }
        return;
      }
      case 'startReview':
        store.dispatch({ type: 'startReview', id: request.id });
        return;
      case 'complete':
        store.dispatch({ type: 'complete', id: request.id });
        return;
      // Create is filtered out above, and the note actions open their form before this switch.
      case 'create':
      case 'requestInfo':
      case 'supplyInfo':
        return;
      default: {
        const unreachable: never = rule.action;
        return unreachable;
      }
    }
  }

  function handleNoteSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (openRule === null) {
      return;
    }
    const command = noteCommand(openRule, request.id, noteText);
    if (command === null) {
      return;
    }
    const result = store.dispatch(command);
    if (result.ok) {
      setOpenRule(null);
      setNoteText('');
      setNoteError(undefined);
    } else if (result.error.kind === 'validation') {
      // The text stays exactly as typed so the user can correct it.
      setNoteError(result.error.errors.note);
    }
  }

  const openNoteField = openRule === null ? null : openRule.noteField;
  const copy = openNoteField === null ? null : noteCopy(openNoteField);

  return (
    <section className="action-panel" aria-label="Actions">
      {rules.length === 0 ? (
        <p className="hint">
          {isTerminal(request.status)
            ? 'This request is completed. No further actions are available.'
            : `No actions are available to the ${role} while the request is ${request.status}.`}
        </p>
      ) : (
        <div className="button-row">
          {rules.map((rule) => (
            <button
              type="button"
              key={rule.action}
              onClick={() => {
                handleAction(rule);
              }}
            >
              {rule.label}
            </button>
          ))}
        </div>
      )}
      {/* No maxLength: an over-length note must stay in the field and be refused with a message. */}
      {copy !== null && (
        <form className="note-form" noValidate onSubmit={handleNoteSubmit}>
          <div className="form-field">
            <label htmlFor={noteId}>{copy.label}</label>
            <textarea
              id={noteId}
              rows={3}
              value={noteText}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                setNoteText(event.target.value);
              }}
              aria-invalid={noteError ? 'true' : undefined}
              aria-describedby={noteError ? noteErrorId : undefined}
            />
            {noteError ? (
              <p id={noteErrorId} className="field-error">
                {noteError}
              </p>
            ) : null}
          </div>
          <div className="button-row">
            <button type="submit">{copy.send}</button>
            <button
              type="button"
              onClick={() => {
                setOpenRule(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
