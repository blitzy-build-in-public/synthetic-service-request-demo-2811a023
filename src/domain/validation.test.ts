// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { LIMITS, REQUEST_TYPES } from './model';
import type { CreateFields, EditFields, ServiceRequest } from './model';
import {
  countCharacters,
  validateFieldsOnSave,
  validateForSubmission,
  validateNote,
} from './validation';
import type {
  FieldErrors,
  NoteKind,
  NoteValidationResult,
  SaveValidationResult,
  ValidatedCreateFields,
} from './validation';

// The expected messages are written out here rather than read from validation.ts, so a changed
// message in the implementation fails these tests instead of silently passing them.
const NAME_REQUIRED = 'Requester name is required.';
const NAME_TOO_LONG = 'Requester name must be 80 characters or fewer.';
const TYPE_REQUIRED = 'Request type is required.';
const TYPE_INVALID =
  'Request type must be one of Access Request, Equipment Request, General Question.';
const DESCRIPTION_REQUIRED = 'Description is required.';
const DESCRIPTION_TOO_LONG = 'Description must be 2000 characters or fewer.';
const PRIORITY_INVALID = 'Priority must be Normal or Urgent.';

// One astral-plane character: two UTF-16 code units, one code point.
const ASTRAL = '😀';
const WHITESPACE = '  \t\n ';

const VALID_CREATE: CreateFields = {
  requesterName: 'Riley Test',
  requestType: 'Access Request',
  description: 'Fictional test description.',
};

const VALID_EDIT: EditFields = { ...VALID_CREATE, priority: 'Normal' };

type ValidationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: FieldErrors };

/** The reported errors, or `{}` for a passing result. */
function errorsOf(result: ValidationOutcome): FieldErrors {
  return result.ok ? {} : result.errors;
}

function valuesOf<T>(result: SaveValidationResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected the fields to pass, received ${JSON.stringify(result.errors)}`);
  }
  return result.values;
}

function noteValueOf(result: NoteValidationResult): string {
  if (!result.ok) {
    throw new Error(`Expected the note to pass, received ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

describe('countCharacters', () => {
  it.each([
    { label: 'an empty string', text: '', codePoints: 0, codeUnits: 0 },
    { label: 'ASCII text', text: 'abc', codePoints: 3, codeUnits: 3 },
    { label: 'one astral character', text: ASTRAL, codePoints: 1, codeUnits: 2 },
    { label: '80 astral characters', text: ASTRAL.repeat(80), codePoints: 80, codeUnits: 160 },
  ])('counts the code points in $label', ({ text, codePoints, codeUnits }) => {
    expect(text.length).toBe(codeUnits);
    expect(countCharacters(text)).toBe(codePoints);
  });
});

describe('validateFieldsOnSave', () => {
  // Create and edit apply the same name, type and description rules on save.
  const SAVE_MODES: readonly {
    mode: string;
    validate: (overrides: Partial<CreateFields>) => SaveValidationResult<ValidatedCreateFields>;
  }[] = [
    { mode: 'create', validate: (overrides) => validateFieldsOnSave({ ...VALID_CREATE, ...overrides }) },
    { mode: 'edit', validate: (overrides) => validateFieldsOnSave({ ...VALID_EDIT, ...overrides }) },
  ];

  const SAVE_FIELD_CASES: readonly {
    label: string;
    fields: Partial<CreateFields>;
    errors: FieldErrors;
  }[] = [
    { label: 'an 80-character name', fields: { requesterName: 'a'.repeat(80) }, errors: {} },
    {
      label: 'an 81-character name',
      fields: { requesterName: 'a'.repeat(81) },
      errors: { requesterName: NAME_TOO_LONG },
    },
    {
      label: 'a name of 80 astral characters (160 UTF-16 units)',
      fields: { requesterName: ASTRAL.repeat(80) },
      errors: {},
    },
    {
      label: 'a name of 81 astral characters',
      fields: { requesterName: ASTRAL.repeat(81) },
      errors: { requesterName: NAME_TOO_LONG },
    },
    {
      label: 'an 80-character name padded with spaces',
      fields: { requesterName: `   ${'a'.repeat(80)}   ` },
      errors: {},
    },
    { label: 'a 2000-character description', fields: { description: 'a'.repeat(2000) }, errors: {} },
    {
      label: 'a 2001-character description',
      fields: { description: 'a'.repeat(2001) },
      errors: { description: DESCRIPTION_TOO_LONG },
    },
    { label: 'a blank request type', fields: { requestType: '' }, errors: {} },
    ...REQUEST_TYPES.map((requestType) => ({
      label: `the request type ${requestType}`,
      fields: { requestType },
      errors: {},
    })),
    {
      label: 'an unknown request type',
      fields: { requestType: 'Other' },
      errors: { requestType: TYPE_INVALID },
    },
    {
      label: 'several invalid fields at once',
      fields: { requesterName: 'a'.repeat(81), requestType: 'Other', description: 'a'.repeat(2001) },
      errors: {
        requesterName: NAME_TOO_LONG,
        requestType: TYPE_INVALID,
        description: DESCRIPTION_TOO_LONG,
      },
    },
  ];

  describe.each(SAVE_MODES)('on $mode', ({ validate }) => {
    it.each(SAVE_FIELD_CASES)('reports exactly the expected errors for $label', ({ fields, errors }) => {
      const result = validate(fields);

      expect(result.ok).toBe(Object.keys(errors).length === 0);
      expect(errorsOf(result)).toStrictEqual(errors);
    });

    it.each([
      { label: 'empty', value: '' },
      { label: 'whitespace-only', value: WHITESPACE },
    ])('accepts an incomplete draft with $label fields and stores them blank', ({ value }) => {
      const values = valuesOf(validate({ requesterName: value, requestType: value, description: value }));

      expect(values).toMatchObject({ requesterName: '', requestType: '', description: '' });
    });

    it('trims every field before storing it', () => {
      const values = valuesOf(
        validate({
          requesterName: '  Riley Test  ',
          requestType: ' Equipment Request ',
          description: '\n Fictional test description. \t',
        }),
      );

      expect(values).toMatchObject({
        requesterName: 'Riley Test',
        requestType: 'Equipment Request',
        description: 'Fictional test description.',
      });
    });

    it('trims a name before checking its length', () => {
      const values = valuesOf(validate({ requesterName: `  ${'a'.repeat(80)}  ` }));

      expect(values.requesterName).toBe('a'.repeat(80));
    });
  });

  it('returns only the three create fields for a create save, never a priority', () => {
    expect(valuesOf(validateFieldsOnSave(VALID_CREATE))).toStrictEqual({
      requesterName: 'Riley Test',
      requestType: 'Access Request',
      description: 'Fictional test description.',
    });
  });

  it.each([{ priority: 'Normal' }, { priority: 'Urgent' }])(
    'accepts and returns the priority $priority on edit',
    ({ priority }) => {
      expect(valuesOf(validateFieldsOnSave({ ...VALID_EDIT, priority }))).toStrictEqual({
        requesterName: 'Riley Test',
        requestType: 'Access Request',
        description: 'Fictional test description.',
        priority,
      });
    },
  );

  it.each([
    { label: 'an unknown priority', priority: 'High' },
    { label: 'a blank priority', priority: '' },
  ])('rejects $label on edit', ({ priority }) => {
    expect(errorsOf(validateFieldsOnSave({ ...VALID_EDIT, priority }))).toStrictEqual({
      priority: PRIORITY_INVALID,
    });
  });

  it('reports an invalid priority together with the other failing fields on edit', () => {
    const result = validateFieldsOnSave({
      requesterName: 'a'.repeat(81),
      requestType: 'Other',
      description: 'a'.repeat(2001),
      priority: 'High',
    });

    expect(errorsOf(result)).toStrictEqual({
      requesterName: NAME_TOO_LONG,
      requestType: TYPE_INVALID,
      description: DESCRIPTION_TOO_LONG,
      priority: PRIORITY_INVALID,
    });
  });

  // A plain write to the frozen input throws, since ES modules run in strict mode; the mutable copy
  // catches writes that fail silently on a frozen object, such as Reflect.set.
  it.each([
    {
      label: 'create fields',
      input: Object.freeze({ requesterName: '  Riley Test  ', requestType: 'Other', description: ' a ' }),
    },
    {
      label: 'edit fields',
      input: Object.freeze({
        requesterName: '  Riley Test  ',
        requestType: ' General Question ',
        description: ' a ',
        priority: 'High',
      }),
    },
  ])('leaves $label unchanged, frozen or not', ({ input }) => {
    const before = { ...input };
    const mutable = { ...input };

    validateFieldsOnSave(input);
    validateFieldsOnSave(mutable);

    expect(input).toStrictEqual(before);
    expect(mutable).toStrictEqual(before);
  });
});

describe('validateForSubmission', () => {
  const VALID_CANDIDATE: CreateFields = {
    requesterName: 'Riley Test',
    requestType: 'General Question',
    description: 'Fictional test description.',
  };

  it.each<{ label: string; fields: Partial<CreateFields>; errors: FieldErrors }>([
    { label: 'a complete candidate', fields: {}, errors: {} },
    {
      label: 'values exactly at their limits',
      fields: { requesterName: 'a'.repeat(80), description: 'a'.repeat(2000) },
      errors: {},
    },
    ...REQUEST_TYPES.map((requestType) => ({
      label: `the request type ${requestType}`,
      fields: { requestType },
      errors: {},
    })),
    { label: 'a blank name', fields: { requesterName: '' }, errors: { requesterName: NAME_REQUIRED } },
    {
      label: 'a whitespace-only name',
      fields: { requesterName: WHITESPACE },
      errors: { requesterName: NAME_REQUIRED },
    },
    {
      label: 'a name of 81 spaces, which trims to blank',
      fields: { requesterName: ' '.repeat(81) },
      errors: { requesterName: NAME_REQUIRED },
    },
    { label: 'a blank request type', fields: { requestType: '' }, errors: { requestType: TYPE_REQUIRED } },
    {
      label: 'a blank description',
      fields: { description: '' },
      errors: { description: DESCRIPTION_REQUIRED },
    },
    {
      label: 'a whitespace-only description',
      fields: { description: WHITESPACE },
      errors: { description: DESCRIPTION_REQUIRED },
    },
    {
      label: 'all three fields blank',
      fields: { requesterName: '', requestType: '', description: '' },
      errors: {
        requesterName: NAME_REQUIRED,
        requestType: TYPE_REQUIRED,
        description: DESCRIPTION_REQUIRED,
      },
    },
    {
      label: 'an 81-character name',
      fields: { requesterName: 'a'.repeat(81) },
      errors: { requesterName: NAME_TOO_LONG },
    },
    {
      label: 'a 2001-character description',
      fields: { description: 'a'.repeat(2001) },
      errors: { description: DESCRIPTION_TOO_LONG },
    },
    {
      label: 'an unknown request type',
      fields: { requestType: 'Other' },
      errors: { requestType: TYPE_INVALID },
    },
  ])('reports exactly the expected errors for $label', ({ fields, errors }) => {
    expect(validateForSubmission({ ...VALID_CANDIDATE, ...fields })).toStrictEqual(errors);
  });

  it('accepts a stored Draft request and names its blank description', () => {
    const draft: ServiceRequest = {
      id: 'REQ-0004',
      requesterName: 'Riley Test',
      requestType: 'Equipment Request',
      description: '',
      priority: 'Normal',
      status: 'Draft',
      lastUpdated: '2026-02-01T09:00:00.000Z',
      auditHistory: [
        {
          timestamp: '2026-02-01T09:00:00.000Z',
          role: 'Requester',
          action: 'Created',
          fromStatus: '',
          toStatus: '',
        },
      ],
    };

    expect(validateForSubmission(draft)).toStrictEqual({ description: DESCRIPTION_REQUIRED });
  });
});

describe('validateNote', () => {
  const NOTE_KINDS: readonly { kind: NoteKind; required: string; tooLong: string }[] = [
    {
      kind: 'reason',
      required: 'Reason is required.',
      tooLong: 'Reason must be 1000 characters or fewer.',
    },
    {
      kind: 'suppliedInformation',
      required: 'Supplied information is required.',
      tooLong: 'Supplied information must be 1000 characters or fewer.',
    },
  ];

  describe.each(NOTE_KINDS)('for $kind', ({ kind, required, tooLong }) => {
    it.each([
      { label: 'empty text', text: '' },
      { label: 'whitespace-only text', text: WHITESPACE },
    ])('rejects $label as required', ({ text }) => {
      expect(errorsOf(validateNote(text, kind))).toStrictEqual({ note: required });
    });

    it.each([
      { label: '1001 characters', text: 'a'.repeat(1001) },
      { label: '1001 astral characters', text: ASTRAL.repeat(1001) },
    ])('rejects $label as too long', ({ text }) => {
      expect(errorsOf(validateNote(text, kind))).toStrictEqual({ note: tooLong });
    });

    it.each([
      { label: 'exactly 1000 characters', text: 'a'.repeat(1000), value: 'a'.repeat(1000) },
      { label: '1000 astral characters', text: ASTRAL.repeat(1000), value: ASTRAL.repeat(1000) },
      {
        label: '1000 characters padded with spaces',
        text: `  ${'a'.repeat(1000)}  `,
        value: 'a'.repeat(1000),
      },
      { label: 'text with surrounding whitespace', text: '  Please confirm.  ', value: 'Please confirm.' },
    ])('accepts $label and returns it trimmed', ({ text, value }) => {
      expect(noteValueOf(validateNote(text, kind))).toBe(value);
    });
  });
});

describe('LIMITS', () => {
  it('holds the name, description and note limits in code points', () => {
    expect(LIMITS).toStrictEqual({ requesterName: 80, description: 2000, note: 1000 });
  });
});
