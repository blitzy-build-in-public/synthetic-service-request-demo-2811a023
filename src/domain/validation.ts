import { LIMITS, REQUEST_TYPES, isPriority, isRequestType } from './model';
import type { CreateFields, EditFields, Priority, RequestType } from './model';

/** A form field that can carry a validation message; `note` is the reason or supplied-information text. */
export type FieldName = 'requesterName' | 'requestType' | 'description' | 'priority' | 'note';

/** Display-ready messages keyed by field; a key is present only when that field failed. */
export type FieldErrors = Partial<Record<FieldName, string>>;

/** Trimmed create values that passed the save rules; blanks are allowed while the request is a Draft. */
export interface ValidatedCreateFields {
  /** Trimmed requester name, possibly `''`. */
  readonly requesterName: string;
  /** One of `REQUEST_TYPES`, or `''` when none is chosen yet. */
  readonly requestType: RequestType | '';
  /** Trimmed description, possibly `''`. */
  readonly description: string;
}

/** Trimmed edit values that passed the save rules, including a known priority. */
export interface ValidatedEditFields extends ValidatedCreateFields {
  /** Normal or Urgent. */
  readonly priority: Priority;
}

/** Outcome of a create or edit save check: the trimmed values, or every failing field's message. */
export type SaveValidationResult<T> =
  | { readonly ok: true; readonly values: T }
  | { readonly ok: false; readonly errors: FieldErrors };

/** Which free-text note an action requires; matches a transition rule's `noteField`. */
export type NoteKind = 'reason' | 'suppliedInformation';

/** Outcome of a note check: the trimmed text, or a message under the `note` key. */
export type NoteValidationResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly errors: FieldErrors };

const REQUEST_TYPE_REQUIRED = 'Request type is required.';
const REQUEST_TYPE_INVALID = `Request type must be one of ${REQUEST_TYPES.join(', ')}.`;
const PRIORITY_INVALID = 'Priority must be Normal or Urgent.';

/** Counts Unicode code points, so a character outside the Basic Multilingual Plane counts once. */
export function countCharacters(text: string): number {
  return Array.from(text).length;
}

// `value` is already trimmed. Blank reports the required message only where `required` holds;
// otherwise the length limit is the field's single rule.
function textFieldError(
  value: string,
  label: string,
  limit: number,
  required: boolean,
): string | undefined {
  if (value === '') {
    return required ? `${label} is required.` : undefined;
  }
  return countCharacters(value) > limit ? `${label} must be ${limit} characters or fewer.` : undefined;
}

function requestTypeError(value: string, required: boolean): string | undefined {
  if (value === '') {
    return required ? REQUEST_TYPE_REQUIRED : undefined;
  }
  return isRequestType(value) ? undefined : REQUEST_TYPE_INVALID;
}

// One message per field, every failing field reported together. Only failing keys are set,
// so an empty object means the values are valid.
function collectFieldErrors(trimmed: CreateFields, required: boolean): FieldErrors {
  const errors: FieldErrors = {};
  const requesterName = textFieldError(
    trimmed.requesterName,
    'Requester name',
    LIMITS.requesterName,
    required,
  );
  if (requesterName !== undefined) {
    errors.requesterName = requesterName;
  }
  const requestType = requestTypeError(trimmed.requestType, required);
  if (requestType !== undefined) {
    errors.requestType = requestType;
  }
  const description = textFieldError(
    trimmed.description,
    'Description',
    LIMITS.description,
    required,
  );
  if (description !== undefined) {
    errors.description = description;
  }
  return errors;
}

function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

function trimFields(fields: CreateFields): CreateFields {
  return {
    requesterName: fields.requesterName.trim(),
    requestType: fields.requestType.trim(),
    description: fields.description.trim(),
  };
}

// Save rules for the three create fields: limits and type membership, but no required checks,
// because an incomplete Draft may be saved and is only held to the required rules at Submit.
function validateCreateFields(fields: CreateFields): SaveValidationResult<ValidatedCreateFields> {
  const trimmed = trimFields(fields);
  const errors = collectFieldErrors(trimmed, false);
  const { requesterName, requestType, description } = trimmed;
  // The membership test repeats requestTypeError's so the compiler narrows `requestType` without a cast.
  if (hasErrors(errors) || (requestType !== '' && !isRequestType(requestType))) {
    return { ok: false, errors };
  }
  return { ok: true, values: { requesterName, requestType, description } };
}

/** Checks edit-form values on save: name and description limits, type membership (blank allowed) and priority membership. */
export function validateFieldsOnSave(fields: EditFields): SaveValidationResult<ValidatedEditFields>;
/** Checks create-form values on save: name and description limits and type membership (blank allowed). */
export function validateFieldsOnSave(fields: CreateFields): SaveValidationResult<ValidatedCreateFields>;
export function validateFieldsOnSave(
  fields: CreateFields | EditFields,
): SaveValidationResult<ValidatedCreateFields> | SaveValidationResult<ValidatedEditFields> {
  const base = validateCreateFields(fields);
  if (!('priority' in fields)) {
    return base;
  }
  const priority = fields.priority.trim();
  if (!isPriority(priority)) {
    return { ok: false, errors: { ...(base.ok ? {} : base.errors), priority: PRIORITY_INVALID } };
  }
  return base.ok ? { ok: true, values: { ...base.values, priority } } : base;
}

/** Checks stored values before Submit: each field required after trimming, then its limit or type membership; `{}` when valid. */
export function validateForSubmission(candidate: {
  readonly requesterName: string;
  readonly requestType: string;
  readonly description: string;
}): FieldErrors {
  return collectFieldErrors(trimFields(candidate), true);
}

function noteLabel(kind: NoteKind): string {
  switch (kind) {
    case 'reason':
      return 'Reason';
    case 'suppliedInformation':
      return 'Supplied information';
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** Checks a reason or supplied-information note: required after trimming and at most `LIMITS.note` code points. */
export function validateNote(text: string, kind: NoteKind): NoteValidationResult {
  const value = text.trim();
  const message = textFieldError(value, noteLabel(kind), LIMITS.note, true);
  return message === undefined ? { ok: true, value } : { ok: false, errors: { note: message } };
}
