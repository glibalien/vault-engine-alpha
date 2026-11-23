import {
  FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS,
  fieldGuessCandidateMandatoryProjectionChars,
  serializeFieldGuessCandidateMandatory,
} from '@vault/contract';
import type { FieldGuessFieldCandidate } from '../src/field-guess/types.js';

function stringAtSerializedContentChars(chars: number, pattern: string): string {
  const patternChars = JSON.stringify(pattern).length - 2;
  const repetitions = Math.floor(chars / patternChars);
  const value = pattern.repeat(repetitions)
    + 'x'.repeat(chars - repetitions * patternChars);
  if (JSON.stringify(value).length - 2 !== chars) {
    throw new Error('Could not construct exact serialized boundary fixture');
  }
  return value;
}

function candidate(
  overrides: Partial<FieldGuessFieldCandidate>,
): FieldGuessFieldCandidate {
  return {
    field: 'status',
    description: 'z'.repeat(20_000),
    field_type: 'enum',
    list_item_type: null,
    required: true,
    enum_values: ['active'],
    reference_target: null,
    claiming_types: ['Project'],
    eligibility: 'invalid',
    definition_hash: 'boundary-definition',
    ...overrides,
  };
}

/** A legal multi-field projection whose canonical mandatory core is exactly 20k UTF-16 chars. */
export function fieldGuessMandatoryBoundaryFields(): FieldGuessFieldCandidate[] {
  const fields: FieldGuessFieldCandidate[] = [
    candidate({
      field: 'labels',
      field_type: 'list',
      list_item_type: 'enum',
      enum_values: ['global-"\\\n\u0000'],
      per_type_enum_values: [
        { type: 'Note', values: null },
        { type: 'Project', values: ['project-"\\\n\u0000'] },
      ],
      definition_hash: 'boundary-labels',
    }),
    candidate({
      field: 'owner',
      field_type: 'reference',
      list_item_type: null,
      enum_values: null,
      reference_target: 'Project',
      definition_hash: 'boundary-owner',
    }),
    candidate({
      field: 'status',
      enum_values: [''],
      definition_hash: 'boundary-status',
    }),
  ];
  const fixedChars = fieldGuessCandidateMandatoryProjectionChars(fields);
  const status = fields[2];
  if (status === undefined) throw new Error('Boundary fixture is missing its fill field');
  fields[2] = {
    ...status,
    enum_values: [stringAtSerializedContentChars(
      FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS - fixedChars,
      '"\\\n\u0000',
    )],
  };
  if (fieldGuessCandidateMandatoryProjectionChars(fields)
      !== FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS) {
    throw new Error('Mandatory boundary fixture does not equal the shared cap');
  }
  return fields;
}

/** The opposite legal distribution: the entire mandatory budget is field identity. */
export function fieldGuessIdentityBoundaryFields(): FieldGuessFieldCandidate[] {
  const empty = candidate({
    field: '',
    description: null,
    field_type: 'string',
    list_item_type: null,
    enum_values: null,
    reference_target: null,
    claiming_types: ['Project'],
    eligibility: 'absent',
    definition_hash: 'boundary-identity',
  });
  const field = 'q'.repeat(
    FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS
      - serializeFieldGuessCandidateMandatory(empty).length,
  );
  const fields = [{ ...empty, field }];
  if (fieldGuessCandidateMandatoryProjectionChars(fields)
      !== FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS) {
    throw new Error('Identity boundary fixture does not equal the shared cap');
  }
  return fields;
}
