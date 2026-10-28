import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
// React's SubmitEvent, not FormEvent: the pinned @types/react deprecates FormEvent and types onSubmit with SubmitEvent.
import type { ChangeEvent, MouseEvent, SubmitEvent } from 'react';
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
  /**
   * Called after the store accepts an action that changes this request's status; the parent's key then
   * remounts this panel, removing the focused control, so the parent moves focus somewhere that stays.
   */
  onTransition: () => void;
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

// The form renders after every action button, so focus left on its opener would reach the other
// actions, Complete among them, before the field. `nearest` scrolls only as far as the whole form, Send
// and Cancel included, needs; the focus then must not scroll again and undo that.
function revealNoteForm(form: HTMLFormElement | null, field: HTMLTextAreaElement | null): void {
  form?.scrollIntoView({ block: 'nearest' });
  field?.focus({ preventScroll: true });
}

/** Offers domain-permitted actions and note forms; the parent must key this panel by role and status to close stale forms. */
export function ActionPanel({ request, role, onEdit, onSubmitErrors, onTransition }: ActionPanelProps) {
  const store = useAppStore();
  // Create belongs to the list view; a details panel only offers actions on this request.
  const rules = availableActions(role, request.status).filter((rule) => rule.action !== 'create');
  const [openRule, setOpenRule] = useState<TransitionRule | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteError, setNoteError] = useState<string | undefined>(undefined);
  const [sendAttempt, setSendAttempt] = useState(0);
  const noteId = useId();
  const noteErrorId = `${noteId}-error`;
  const noteFormId = `${noteId}-form`;
  // Cancel unmounts its own focused button; the opener stays mounted, so focus returns there.
  const noteOpenerRef = useRef<HTMLButtonElement | null>(null);
  const noteFormRef = useRef<HTMLFormElement>(null);
  const noteFieldRef = useRef<HTMLTextAreaElement>(null);
  // The store changes at once but the panel re-renders only when React commits, so a second send in the
  // same task (two scripted clicks) would dispatch the note again against the new status and show a false
  // refusal. Every send commits a render: success remounts the panel through its key, a field error sets
  // `sendAttempt`, and a refusal or a missing request publishes a snapshot that re-renders the parent.
  // Releasing after each commit ignores only that second send, while a form left open by a field error
  // still accepts the next one.
  const submitPending = useRef(false);
  useLayoutEffect(() => {
    submitPending.current = false;
  });

  // The form mounts in the commit that sets `openRule`, so it can be revealed only after that commit.
  useEffect(() => {
    if (openRule !== null) {
      revealNoteForm(noteFormRef.current, noteFieldRef.current);
    }
  }, [openRule]);

  // A validation message can push Send out of view; reveal the form after each failed validation without moving focus.
  useEffect(() => {
    if (sendAttempt > 0) {
      noteFormRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [sendAttempt]);

  function handleAction(rule: TransitionRule, trigger: HTMLButtonElement) {
    if (rule.noteField !== null) {
      noteOpenerRef.current = trigger;
      // A repeated press on the open form's opener must not discard the typed note or its message.
      // `openRule` does not change, so the effect that reveals a newly opened form does not run again.
      if (openRule !== null && openRule.action === rule.action) {
        revealNoteForm(noteFormRef.current, noteFieldRef.current);
        return;
      }
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
          onTransition();
        } else if (result.error.kind === 'validation') {
          onSubmitErrors(result.error.errors);
        }
        return;
      }
      case 'startReview':
        if (store.dispatch({ type: 'startReview', id: request.id }).ok) {
          onTransition();
        }
        return;
      case 'complete':
        if (store.dispatch({ type: 'complete', id: request.id }).ok) {
          onTransition();
        }
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
    if (submitPending.current) {
      return;
    }
    submitPending.current = true;
    const result = store.dispatch(command);
    if (result.ok) {
      setOpenRule(null);
      setNoteText('');
      setNoteError(undefined);
      onTransition();
    } else if (result.error.kind === 'validation') {
      // The text stays exactly as typed so the user can correct it.
      setNoteError(result.error.errors.note);
      setSendAttempt((attempt) => attempt + 1);
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
          {rules.map((rule) => {
            // Only a note action discloses a form, so only its button reports whether that form is open.
            const expanded = rule.noteField === null ? undefined : openRule?.action === rule.action;
            return (
              <button
                type="button"
                key={rule.action}
                aria-expanded={expanded}
                aria-controls={expanded === true ? noteFormId : undefined}
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  // A transition remounts the panel with other actions in the same places, so the second
                  // click of a double-click would press whichever replaced the first. Only a first click
                  // acts; keyboard and programmatic clicks report a count of 0.
                  if (event.detail > 1) {
                    return;
                  }
                  handleAction(rule, event.currentTarget);
                }}
              >
                {rule.label}
              </button>
            );
          })}
        </div>
      )}
      {/* No maxLength: an over-length note must stay in the field and be refused with a message. */}
      {copy !== null && (
        <form ref={noteFormRef} id={noteFormId} className="note-form" noValidate onSubmit={handleNoteSubmit}>
          <div className="form-field">
            <label htmlFor={noteId}>{copy.label}</label>
            {/* A note's base direction follows its first strong character, so right-to-left text runs right to left. */}
            <textarea
              ref={noteFieldRef}
              id={noteId}
              rows={3}
              dir="auto"
              value={noteText}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                setNoteText(event.target.value);
              }}
              aria-invalid={noteError ? 'true' : undefined}
              aria-describedby={noteError ? noteErrorId : undefined}
            />
            {/* Focus stays on the send button, so the message must be announced: the live slot renders
                with the form, before any message, and holds the message alone, since around the
                textarea it would also announce typed text. The key re-inserts a repeated message, so
                every failed send is announced. */}
            <div className="field-error-slot" aria-live="polite">
              {noteError ? (
                <p key={sendAttempt} id={noteErrorId} className="field-error">
                  {noteError}
                </p>
              ) : null}
            </div>
          </div>
          {/* Opening the form can scroll Send or Cancel under the pointer, so the second click of a
              double-click on the opener would send the note or close the form. Only a first click acts,
              so Send cancels the submission a later click starts; keyboard and programmatic clicks
              report a count of 0. */}
          <div className="button-row">
            <button
              type="submit"
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                if (event.detail > 1) {
                  event.preventDefault();
                }
              }}
            >
              {copy.send}
            </button>
            <button
              type="button"
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                if (event.detail > 1) {
                  return;
                }
                setOpenRule(null);
                noteOpenerRef.current?.focus();
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
