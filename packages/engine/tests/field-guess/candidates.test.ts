import { describe, expect, it } from 'vitest';
import {
  ABSENT_FIELD_VALUE,
  EXPLICIT_NULL_FIELD_VALUE,
  classifyFieldGuessEligibility,
  definitionHash,
} from '../../src/field-guess/candidates.js';
import type { EffectiveField, FieldType } from '../../src/validation/types.js';

function effectiveField(overrides: Partial<EffectiveField> = {}): EffectiveField {
  return {
    field: 'status',
    global_field: {
      name: 'status',
      field_type: 'enum',
      enum_values: ['active', 'paused'],
      reference_target: null,
      description: 'Global status description',
      default_value: 'active',
      required: false,
      ai_guessable: true,
      overrides_allowed: {
        required: true,
        default_value: true,
        enum_values: true,
        ai_guessable: true,
      },
      list_item_type: null,
      ui_hints: null,
    },
    resolved_label: 'Status',
    resolved_description: 'Effective status description',
    resolved_order: 10,
    resolved_required: false,
    resolved_ai_guessable: true,
    resolved_default_value: 'paused',
    default_source: 'claim',
    claiming_types: ['Project'],
    ...overrides,
  };
}

function withType(field: EffectiveField, fieldType: FieldType, listItemType: FieldType | null = null): EffectiveField {
  return {
    ...field,
    global_field: {
      ...field.global_field,
      field_type: fieldType,
      list_item_type: listItemType,
      enum_values: fieldType === 'enum' ? field.global_field.enum_values : null,
    },
  };
}

describe('field-guess eligibility', () => {
  const optionalGuessable = effectiveField();
  const requiredGuessable = effectiveField({ resolved_required: true });

  it.each([
    ['absent optional', optionalGuessable, ABSENT_FIELD_VALUE, null],
    ['absent required', requiredGuessable, ABSENT_FIELD_VALUE, 'absent'],
    ['required explicit null', requiredGuessable, EXPLICIT_NULL_FIELD_VALUE, 'required_empty'],
    ['optional explicit null', optionalGuessable, EXPLICIT_NULL_FIELD_VALUE, null],
    ['required blank string', requiredGuessable, '   ', 'required_empty'],
    ['optional blank string', withType(optionalGuessable, 'string'), '   ', null],
    ['required empty list', withType(requiredGuessable, 'list', 'string'), [], 'required_empty'],
    ['optional empty list', withType(optionalGuessable, 'list', 'string'), [], null],
    ['optional invalid enum', optionalGuessable, 'bogus', 'invalid'],
    ['valid nonempty', optionalGuessable, 'active', null],
  ] as const)('%s', (_name, field, state, expected) => {
    expect(classifyFieldGuessEligibility(field, state)).toBe(expected);
  });

  it('never offers a field whose resolved schema disables AI guessing', () => {
    const field = effectiveField({ resolved_ai_guessable: false });

    expect(classifyFieldGuessEligibility(field, ABSENT_FIELD_VALUE)).toBeNull();
    expect(classifyFieldGuessEligibility(field, 'bogus')).toBeNull();
  });

  it('accepts an enum value allowed by any claiming type and rejects values allowed by none', () => {
    const field = effectiveField({
      claiming_types: ['Project', 'Archived'],
      per_type_enum_values: [
        { type: 'Project', values: ['active', 'paused'] },
        { type: 'Archived', values: ['done'] },
      ],
    });

    expect(classifyFieldGuessEligibility(field, 'done')).toBeNull();
    expect(classifyFieldGuessEligibility(field, 'unknown')).toBe('invalid');
  });

  it('uses ordinary list/reference validation for present values', () => {
    const field = withType(effectiveField(), 'list', 'reference');

    expect(classifyFieldGuessEligibility(field, ['Project Alpha'])).toBeNull();
    expect(classifyFieldGuessEligibility(field, [['not-a-reference']])).toBe('invalid');
  });
});

describe('field-guess definition hashes', () => {
  it('is stable under irrelevant ordering of set-like effective constraints', () => {
    const first = effectiveField({
      claiming_types: ['Project', 'Archived'],
      per_type_enum_values: [
        { type: 'Project', values: ['paused', 'active'] },
        { type: 'Archived', values: ['done', 'cancelled'] },
      ],
    });
    const reordered = {
      ...first,
      global_field: {
        ...first.global_field,
        enum_values: ['paused', 'active'],
      },
      claiming_types: ['Archived', 'Project'],
      per_type_enum_values: [
        { type: 'Archived', values: ['cancelled', 'done'] },
        { type: 'Project', values: ['active', 'paused'] },
      ],
    } satisfies EffectiveField;

    expect(definitionHash(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(definitionHash(reordered)).toBe(definitionHash(first));
  });

  it.each([
    ['field name', (field: EffectiveField) => ({ ...field, field: 'phase' })],
    ['description', (field: EffectiveField) => ({ ...field, resolved_description: 'Changed' })],
    ['field type', (field: EffectiveField) => withType(field, 'string')],
    ['list item type', (field: EffectiveField) => withType(field, 'list', 'reference')],
    ['requiredness', (field: EffectiveField) => ({ ...field, resolved_required: true })],
    ['global enum constraints', (field: EffectiveField) => ({
      ...field,
      global_field: { ...field.global_field, enum_values: ['active', 'done'] },
    })],
    ['per-type enum constraints', (field: EffectiveField) => ({
      ...field,
      per_type_enum_values: [{ type: 'Project', values: ['active'] }],
    })],
    ['reference target', (field: EffectiveField) => ({
      ...field,
      global_field: { ...field.global_field, reference_target: 'Context' },
    })],
    ['claiming types', (field: EffectiveField) => ({ ...field, claiming_types: ['Project', 'Task'] })],
    ['resolved AI-guessability', (field: EffectiveField) => ({ ...field, resolved_ai_guessable: false })],
  ])('changes when %s changes', (_name, mutate) => {
    const baseline = effectiveField({
      per_type_enum_values: [{ type: 'Project', values: ['active', 'paused'] }],
    });

    expect(definitionHash(mutate(baseline))).not.toBe(definitionHash(baseline));
  });

  it('ignores presentation ordering, labels, and creation-only defaults', () => {
    const baseline = effectiveField();
    const presentationOnly = {
      ...baseline,
      resolved_label: 'Different label',
      resolved_order: 999,
      resolved_default_value: 'different-default',
      default_source: 'global' as const,
    };

    expect(definitionHash(presentationOnly)).toBe(definitionHash(baseline));
  });
});
