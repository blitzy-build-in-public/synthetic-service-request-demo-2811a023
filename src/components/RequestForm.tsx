import { useId, useState } from 'react';
// React's SubmitEvent, not FormEvent: the pinned @types/react deprecates FormEvent and types onSubmit with SubmitEvent.
import type { ChangeEvent, SubmitEvent } from 'react';
import { PRIORITIES, REQUEST_TYPES } from '../domain/model';
import type { CreateFields, EditFields } from '../domain/model';
import type { FieldErrors } from '../domain/validation';
import { EM_DASH } from './format';

interface RequestFormBaseProps {
  /** Closes the form without saving. */
  onCancel: () => void;
}

/** Props for creating a draft; create carries no priority, so every new request starts Normal. */
export interface CreateRequestFormProps extends RequestFormBaseProps {
  mode: 'create';
  /** Starting values, normally all blank. */
  initialValues: CreateFields;
  /** Attempts the save; returns field errors to show, or null when there are none. */
  onSave: (fields: CreateFields) => FieldErrors | null;
}

/** Props for editing a Draft, including priority. */
export interface EditRequestFormProps extends RequestFormBaseProps {
  mode: 'edit';
  /** The Draft's current values. */
  initialValues: EditFields;
  /** Attempts the save; returns field errors to show, or null when there are none. */
  onSave: (fields: EditFields) => FieldErrors | null;
}

/** Props for `RequestForm`, discriminated on `mode`. */
export type RequestFormProps = CreateRequestFormProps | EditRequestFormProps;

/** The form's own fields; `note` belongs to the action panel's note forms. */
type FormField = Exclude<keyof FieldErrors, 'note'>;

/**
 * Create or edit form for a request. Values reach `onSave` exactly as typed: the domain trims and
 * validates them, and a blank draft is valid to save. Returned messages show below their fields, and
 * are announced, while the inputs keep their text; the parent closes the form when the save succeeds.
 */
export function RequestForm(props: RequestFormProps) {
  // `props` stays whole so `props.mode` narrows `initialValues` and `onSave` together.
  const [requesterName, setRequesterName] = useState(props.initialValues.requesterName);
  const [requestType, setRequestType] = useState(props.initialValues.requestType);
  const [description, setDescription] = useState(props.initialValues.description);
  const [priority, setPriority] = useState(props.mode === 'edit' ? props.initialValues.priority : '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveAttempt, setSaveAttempt] = useState(0);
  const baseId = useId();

  const controlId = (field: FormField): string => `${baseId}-${field}`;
  const errorId = (field: FormField): string => `${baseId}-${field}-error`;

  // A message is shown, and its control marked invalid, only when the save returned one for that field.
  const messageFor = (field: FormField): string | undefined => {
    const message = errors[field];
    return message === undefined || message === '' ? undefined : message;
  };

  const errorAttributes = (field: FormField) =>
    messageFor(field) === undefined
      ? { 'aria-invalid': undefined, 'aria-describedby': undefined }
      : { 'aria-invalid': true, 'aria-describedby': errorId(field) };

  // Focus stays on the submit button, so a message must be announced. Assistive technology announces
  // only changes inside a live region that already exists, so the slot renders with the form, before any
  // message. It holds the message alone: around a control it would also announce typed text. The key
  // re-inserts a message a later save returns again, so every failed save is announced.
  const errorMessage = (field: FormField) => {
    const message = messageFor(field);
    return (
      <div className="field-error-slot" aria-live="polite">
        {message === undefined ? null : (
          <p key={saveAttempt} id={errorId(field)} className="field-error">
            {message}
          </p>
        )}
      </div>
    );
  };

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result =
      props.mode === 'edit'
        ? props.onSave({ requesterName, requestType, description, priority })
        : props.onSave({ requesterName, requestType, description });
    setErrors(result ?? {});
    setSaveAttempt((attempt) => attempt + 1);
  }

  // No maxLength, required, pattern or minLength: an over-length value must stay in the field and be
  // refused with a message rather than silently truncated, and noValidate keeps native checks out.
  return (
    <form className="request-form" noValidate onSubmit={handleSubmit}>
      <div className="form-field">
        <label htmlFor={controlId('requesterName')}>Requester name</label>
        <input
          id={controlId('requesterName')}
          type="text"
          value={requesterName}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setRequesterName(event.target.value);
          }}
          {...errorAttributes('requesterName')}
        />
        {errorMessage('requesterName')}
      </div>
      <div className="form-field">
        <label htmlFor={controlId('requestType')}>Request type</label>
        <select
          id={controlId('requestType')}
          value={requestType}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => {
            setRequestType(event.target.value);
          }}
          {...errorAttributes('requestType')}
        >
          <option value="">{EM_DASH}</option>
          {REQUEST_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        {errorMessage('requestType')}
      </div>
      <div className="form-field">
        <label htmlFor={controlId('description')}>Description</label>
        <textarea
          id={controlId('description')}
          rows={4}
          value={description}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setDescription(event.target.value);
          }}
          {...errorAttributes('description')}
        />
        {errorMessage('description')}
      </div>
      {props.mode === 'edit' && (
        <div className="form-field">
          <label htmlFor={controlId('priority')}>Priority</label>
          <select
            id={controlId('priority')}
            value={priority}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              setPriority(event.target.value);
            }}
            {...errorAttributes('priority')}
          >
            {PRIORITIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {errorMessage('priority')}
        </div>
      )}
      <div className="button-row">
        <button type="submit">{props.mode === 'create' ? 'Create draft' : 'Save changes'}</button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
