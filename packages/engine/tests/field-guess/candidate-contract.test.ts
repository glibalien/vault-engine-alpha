import {
  FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
  FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS,
  fieldGuessCandidateIdentityProjectionChars,
  fieldGuessCandidateMandatoryProjectionChars,
  serializeFieldGuessCandidateIdentity,
  serializeFieldGuessCandidateMandatory,
} from '@vault/contract';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGlobalField,
  getGlobalField,
  renameGlobalField,
  updateGlobalField,
} from '../../src/global-fields/crud.js';
import { discoverFieldGuessCandidatePage } from '../../src/mcp/tools/list-field-guess-candidates.js';
import { readCurrentClaims } from '../../src/schema/claims.js';
import {
  loadPotentialFieldGuessCandidateMandatory,
} from '../../src/field-guess/candidate-contract.js';
import {
  createSchemaDefinition,
  getSchemaDefinition,
  patchSchemaDefinition,
  updateSchemaDefinition,
} from '../../src/schema/crud.js';
import { createTestDb } from '../helpers/db.js';

const BUDGET_ERROR = /AI field-guess candidate identity projection.*20,000/i;
const MANDATORY_BUDGET_ERROR = /AI field-guess mandatory offered projection.*20,000/i;

function stringFieldNameForProjectionChars(chars: number, prefix = 'x'): string {
  const emptyIdentityChars = serializeFieldGuessCandidateIdentity({
    field: '',
    field_type: 'string',
    list_item_type: null,
  }).length;
  return prefix.repeat(chars - emptyIdentityChars);
}

function stringAtSerializedContentChars(chars: number, pattern = 'x'): string {
  const patternChars = JSON.stringify(pattern).length - 2;
  const repetitions = Math.floor(chars / patternChars);
  const value = pattern.repeat(repetitions)
    + 'x'.repeat(chars - repetitions * patternChars);
  expect(JSON.stringify(value).length - 2).toBe(chars);
  return value;
}

function enumValueForMandatoryRecordChars(
  chars: number,
  field = 'status',
  pattern = 'x',
): string {
  const emptyChars = serializeFieldGuessCandidateMandatory({
    field,
    field_type: 'enum',
    list_item_type: null,
    enum_values: [''],
    reference_target: null,
  }).length;
  return stringAtSerializedContentChars(chars - emptyChars, pattern);
}

function createStringField(
  db: Database.Database,
  name: string,
  options: { aiGuessable?: boolean; overridesAllowed?: boolean } = {},
): void {
  createGlobalField(db, {
    name,
    field_type: 'string',
    required: true,
    ai_guessable: options.aiGuessable ?? true,
    overrides_allowed: { ai_guessable: options.overridesAllowed ?? false },
  });
}

function insertNode(db: Database.Database, id: string, type: string): void {
  db.prepare(`
    INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at, version)
    VALUES (?, ?, ?, '', ?, 100, 100, 1)
  `).run(id, `${id}.md`, id, `hash-${id}`);
  db.prepare(
    'INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, 0)',
  ).run(id, type);
}

describe('field-guess candidate aggregate contract', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('accepts the exact boundary but rolls back a schema create one character over it', () => {
    const exactField = stringFieldNameForProjectionChars(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
    );
    createStringField(db, exactField);
    expect(fieldGuessCandidateIdentityProjectionChars([{
      field: exactField,
      field_type: 'string',
      list_item_type: null,
    }])).toBe(FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS);

    expect(() => createSchemaDefinition(db, {
      name: 'Exact',
      field_claims: [{ field: exactField }],
    })).not.toThrow();

    db.close();
    db = createTestDb();
    const overField = stringFieldNameForProjectionChars(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS + 1,
      'y',
    );

    // An unclaimed global field cannot be offered to Curator and remains legal.
    expect(() => createStringField(db, overField)).not.toThrow();
    expect(() => createSchemaDefinition(db, {
      name: 'Over',
      field_claims: [{ field: overField }],
    })).toThrow(BUDGET_ERROR);
    expect(getSchemaDefinition(db, 'Over')).toBeNull();
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM schema_field_claims WHERE schema_name = ?',
    ).get('Over')).toEqual({ count: 0 });
  });

  it('uses effective true/inherit/false semantics and counts duplicate claims once', () => {
    const overField = stringFieldNameForProjectionChars(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS + 1,
    );
    createStringField(db, overField, { overridesAllowed: true });

    createSchemaDefinition(db, {
      name: 'ExplicitFalse',
      field_claims: [{ field: overField, ai_guessable: false }],
    });
    expect(() => createSchemaDefinition(db, {
      name: 'InheritedTrue',
      field_claims: [{ field: overField }],
    })).toThrow(BUDGET_ERROR);

    updateGlobalField(db, overField, { ai_guessable: false });
    expect(() => createSchemaDefinition(db, {
      name: 'InheritedFalse',
      field_claims: [{ field: overField }],
    })).not.toThrow();
    expect(() => createSchemaDefinition(db, {
      name: 'ExplicitTrue',
      field_claims: [{ field: overField, ai_guessable: true }],
    })).toThrow(BUDGET_ERROR);

    const exactField = stringFieldNameForProjectionChars(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
      'z',
    );
    createStringField(db, exactField);
    createSchemaDefinition(db, {
      name: 'FirstClaim',
      field_claims: [{ field: exactField }],
    });
    expect(() => createSchemaDefinition(db, {
      name: 'DuplicateClaim',
      field_claims: [{ field: exactField }],
    })).not.toThrow();
  });

  it('rolls back global enablement and type changes that cross the aggregate bound', () => {
    const exactField = stringFieldNameForProjectionChars(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
    );
    createStringField(db, exactField);
    createSchemaDefinition(db, {
      name: 'Exact',
      field_claims: [{ field: exactField }],
    });

    createStringField(db, 'context', { aiGuessable: false });
    createSchemaDefinition(db, {
      name: 'Context',
      field_claims: [{ field: 'context' }],
    });
    expect(() => updateGlobalField(db, 'context', { ai_guessable: true }))
      .toThrow(BUDGET_ERROR);
    expect(getGlobalField(db, 'context')?.ai_guessable).toBe(false);

    expect(() => updateGlobalField(db, exactField, {
      field_type: 'list',
      list_item_type: 'reference',
      confirm: true,
    })).toThrow(BUDGET_ERROR);
    expect(getGlobalField(db, exactField)).toMatchObject({
      field_type: 'string',
      list_item_type: null,
    });
  });

  it('rolls back a global rename whose canonical identity crosses the bound', () => {
    createStringField(db, 'context');
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'context' }],
    });
    const overField = stringFieldNameForProjectionChars(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS + 1,
    );

    expect(() => renameGlobalField(db, 'context', overField)).toThrow(BUDGET_ERROR);
    expect(getGlobalField(db, 'context')).not.toBeNull();
    expect(getGlobalField(db, overField)).toBeNull();
    expect(readCurrentClaims(db, 'Project').map(claim => claim.field)).toEqual(['context']);
  });

  it('rolls back full and patch schema updates that cross the bound', () => {
    const exactField = stringFieldNameForProjectionChars(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
    );
    createStringField(db, exactField);
    createSchemaDefinition(db, {
      name: 'Exact',
      field_claims: [{ field: exactField }],
    });
    createStringField(db, 'context', { aiGuessable: false, overridesAllowed: true });
    createSchemaDefinition(db, {
      name: 'Mutable',
      field_claims: [{ field: 'context', ai_guessable: false }],
    });

    expect(() => updateSchemaDefinition(db, 'Mutable', {
      field_claims: [{ field: 'context', ai_guessable: true }],
    })).toThrow(BUDGET_ERROR);
    expect(readCurrentClaims(db, 'Mutable')).toMatchObject([{
      field: 'context',
      ai_guessable: false,
    }]);

    expect(() => patchSchemaDefinition(db, 'Mutable', {
      update_field_claims: [{ field: 'context', ai_guessable: true }],
    })).toThrow(BUDGET_ERROR);
    expect(readCurrentClaims(db, 'Mutable')).toMatchObject([{
      field: 'context',
      ai_guessable: false,
    }]);
  });

  it('fails candidate discovery closed if legacy or direct writes violate the invariant', () => {
    const overField = stringFieldNameForProjectionChars(
      FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS + 1,
    );
    createStringField(db, overField, { overridesAllowed: true });
    createSchemaDefinition(db, {
      name: 'Legacy',
      field_claims: [{ field: overField, ai_guessable: false }],
    });
    db.prepare(`
      UPDATE schema_field_claims
      SET ai_guessable_override = NULL
      WHERE schema_name = 'Legacy' AND field = ?
    `).run(overField);

    expect(() => discoverFieldGuessCandidatePage(db, 100, null)).toThrow(BUDGET_ERROR);
  });

  it('accepts the exact mandatory enum boundary and rolls back a schema create one character over', () => {
    const exactValue = enumValueForMandatoryRecordChars(
      FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS,
      'status',
      '"\\\n\u0000',
    );
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: [exactValue],
      required: true,
      ai_guessable: true,
    });
    const exactMandatory = [{
      field: 'status',
      field_type: 'enum' as const,
      list_item_type: null,
      enum_values: [exactValue],
      reference_target: null,
    }];
    expect(exactMandatory.map(serializeFieldGuessCandidateMandatory).join('\n').length)
      .toBe(FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS);
    expect(fieldGuessCandidateMandatoryProjectionChars(exactMandatory))
      .toBe(FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS);
    expect(() => createSchemaDefinition(db, {
      name: 'ExactEnum',
      field_claims: [{ field: 'status' }],
    })).not.toThrow();

    db.close();
    db = createTestDb();
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: [`${exactValue}x`],
      required: true,
      ai_guessable: true,
    });
    expect(() => createSchemaDefinition(db, {
      name: 'OverEnum',
      field_claims: [{ field: 'status' }],
    })).toThrow(MANDATORY_BUDGET_ERROR);
    expect(getSchemaDefinition(db, 'OverEnum')).toBeNull();
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM schema_field_claims WHERE schema_name = ?',
    ).get('OverEnum')).toEqual({ count: 0 });
  });

  it('counts multiple fields and every per-type enum set in one aggregate projection', () => {
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['global'],
      required: true,
      ai_guessable: true,
      overrides_allowed: { enum_values: true },
    });
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'status', enum_values_override: ['project-only'] }],
    });
    createSchemaDefinition(db, {
      name: 'Note',
      field_claims: [{ field: 'status' }],
    });

    expect(loadPotentialFieldGuessCandidateMandatory(db)).toEqual([{
      field: 'status',
      field_type: 'enum',
      list_item_type: null,
      enum_values: ['global'],
      per_type_enum_values: [
        { type: 'Note', values: ['global'] },
        { type: 'Project', values: ['project-only'] },
      ],
      reference_target: null,
    }]);

    const currentChars = fieldGuessCandidateMandatoryProjectionChars(
      loadPotentialFieldGuessCandidateMandatory(db),
    );
    createGlobalField(db, {
      name: 'phase',
      field_type: 'enum',
      enum_values: [enumValueForMandatoryRecordChars(
        FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS - currentChars,
        'phase',
      )],
      required: true,
      ai_guessable: true,
    });
    expect(() => createSchemaDefinition(db, {
      name: 'AggregateOver',
      field_claims: [{ field: 'phase' }],
    })).toThrow(MANDATORY_BUDGET_ERROR);
    expect(getSchemaDefinition(db, 'AggregateOver')).toBeNull();
  });

  it('includes only claims which can participate when global AI guessing is false', () => {
    const disabledOnlyValue = enumValueForMandatoryRecordChars(
      FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS + 1,
    );
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['global'],
      required: true,
      ai_guessable: false,
      overrides_allowed: { ai_guessable: true, enum_values: true },
    });
    createSchemaDefinition(db, {
      name: 'Disabled',
      field_claims: [{
        field: 'status',
        ai_guessable: false,
        enum_values_override: [disabledOnlyValue],
      }],
    });
    createSchemaDefinition(db, {
      name: 'Inherited',
      field_claims: [{ field: 'status', enum_values_override: ['inherited'] }],
    });

    expect(() => createSchemaDefinition(db, {
      name: 'Enabled',
      field_claims: [{ field: 'status', ai_guessable: true }],
    })).not.toThrow();
    expect(loadPotentialFieldGuessCandidateMandatory(db)).toEqual([{
      field: 'status',
      field_type: 'enum',
      list_item_type: null,
      enum_values: ['global'],
      per_type_enum_values: [
        { type: 'Enabled', values: ['global'] },
        { type: 'Inherited', values: ['inherited'] },
      ],
      reference_target: null,
    }]);

    insertNode(db, 'eligible-combination', 'Enabled');
    db.prepare(
      'INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, 1)',
    ).run('eligible-combination', 'Inherited');
    expect(discoverFieldGuessCandidatePage(db, 100, null).candidates[0].fields[0])
      .toMatchObject({
        field: 'status',
        claiming_types: ['Enabled', 'Inherited'],
        per_type_enum_values: [
          { type: 'Enabled', values: ['global'] },
          { type: 'Inherited', values: ['inherited'] },
        ],
      });
  });

  it('counts an inherited claim with global false when an explicit-true claim can enable it', () => {
    const inheritedValue = enumValueForMandatoryRecordChars(
      FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS + 1,
    );
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['global'],
      required: true,
      ai_guessable: false,
      overrides_allowed: { ai_guessable: true, enum_values: true },
    });
    createSchemaDefinition(db, {
      name: 'Inherited',
      field_claims: [{ field: 'status', enum_values_override: [inheritedValue] }],
    });

    expect(() => createSchemaDefinition(db, {
      name: 'Enabled',
      field_claims: [{ field: 'status', ai_guessable: true }],
    })).toThrow(MANDATORY_BUDGET_ERROR);
    expect(getSchemaDefinition(db, 'Enabled')).toBeNull();
  });

  it('counts explicit-false constraints when global true conflict fallback can enable them', () => {
    const conflictingValue = enumValueForMandatoryRecordChars(
      FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS + 1,
    );
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['global'],
      required: true,
      ai_guessable: true,
      overrides_allowed: { ai_guessable: true, enum_values: true },
    });
    createSchemaDefinition(db, {
      name: 'Disabled',
      field_claims: [{
        field: 'status',
        ai_guessable: false,
        enum_values_override: [conflictingValue],
      }],
    });

    expect(() => createSchemaDefinition(db, {
      name: 'Enabled',
      field_claims: [{ field: 'status', ai_guessable: true }],
    })).toThrow(MANDATORY_BUDGET_ERROR);
    expect(getSchemaDefinition(db, 'Enabled')).toBeNull();
  });

  it('excludes explicit-false constraints with global true when no true claim can conflict', () => {
    const disabledOnlyValue = enumValueForMandatoryRecordChars(
      FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS + 1,
    );
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['global'],
      required: true,
      ai_guessable: true,
      overrides_allowed: { ai_guessable: true, enum_values: true },
    });
    createSchemaDefinition(db, {
      name: 'Disabled',
      field_claims: [{
        field: 'status',
        ai_guessable: false,
        enum_values_override: [disabledOnlyValue],
      }],
    });

    expect(() => createSchemaDefinition(db, {
      name: 'Inherited',
      field_claims: [{ field: 'status' }],
    })).not.toThrow();
    expect(loadPotentialFieldGuessCandidateMandatory(db)).toEqual([{
      field: 'status',
      field_type: 'enum',
      list_item_type: null,
      enum_values: ['global'],
      reference_target: null,
    }]);
  });

  it.each([
    { globalAiGuessable: false, expectedTypes: ['Enabled'], candidateExpected: false },
    { globalAiGuessable: true, expectedTypes: ['Disabled', 'Enabled'], candidateExpected: true },
  ])(
    'matches true/false conflict fallback when global AI guessing is $globalAiGuessable',
    ({ globalAiGuessable, expectedTypes, candidateExpected }) => {
      createGlobalField(db, {
        name: 'status',
        field_type: 'enum',
        enum_values: ['global'],
        required: true,
        ai_guessable: globalAiGuessable,
        overrides_allowed: { ai_guessable: true, enum_values: true },
      });
      createSchemaDefinition(db, {
        name: 'Disabled',
        field_claims: [{
          field: 'status',
          ai_guessable: false,
          enum_values_override: ['disabled'],
        }],
      });
      createSchemaDefinition(db, {
        name: 'Enabled',
        field_claims: [{
          field: 'status',
          ai_guessable: true,
          enum_values_override: ['enabled'],
        }],
      });

      expect(loadPotentialFieldGuessCandidateMandatory(db)[0]?.per_type_enum_values)
        .toEqual(expectedTypes.map(type => ({
          type,
          values: [type === 'Disabled' ? 'disabled' : 'enabled'],
        })));

      insertNode(db, 'conflicting-overrides', 'Disabled');
      db.prepare(
        'INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, 1)',
      ).run('conflicting-overrides', 'Enabled');
      const candidates = discoverFieldGuessCandidatePage(db, 100, null).candidates;
      expect(candidates.length > 0).toBe(candidateExpected);
      if (candidateExpected) {
        expect(candidates[0].fields[0]).toMatchObject({
          claiming_types: ['Disabled', 'Enabled'],
          per_type_enum_values: [
            { type: 'Disabled', values: ['disabled'] },
            { type: 'Enabled', values: ['enabled'] },
          ],
        });
      }
    },
  );

  it('rolls back global enum updates and schema enum overrides which cross the mandatory bound', () => {
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['active', 'paused'],
      required: true,
      ai_guessable: true,
      overrides_allowed: { enum_values: true },
    });
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'status' }],
    });
    const overValue = enumValueForMandatoryRecordChars(
      FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS + 1,
    );

    expect(() => updateGlobalField(db, 'status', { enum_values: [overValue] }))
      .toThrow(MANDATORY_BUDGET_ERROR);
    expect(getGlobalField(db, 'status')?.enum_values).toEqual(['active', 'paused']);

    expect(() => patchSchemaDefinition(db, 'Project', {
      update_field_claims: [{ field: 'status', enum_values_override: [overValue] }],
    })).toThrow(MANDATORY_BUDGET_ERROR);
    expect(readCurrentClaims(db, 'Project')).toMatchObject([{
      field: 'status',
      enum_values_override: null,
    }]);
  });

  it('keeps oversized constraints legal outside AI guessing and fails legacy discovery closed', () => {
    const overValue = enumValueForMandatoryRecordChars(
      FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS + 1,
    );
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: [overValue],
      required: true,
      ai_guessable: false,
      overrides_allowed: { ai_guessable: true },
    });
    expect(() => createSchemaDefinition(db, {
      name: 'ManualOnly',
      field_claims: [{ field: 'status', ai_guessable: false }],
    })).not.toThrow();
    expect(() => patchSchemaDefinition(db, 'ManualOnly', {
      update_field_claims: [{ field: 'status', ai_guessable: true }],
    })).toThrow(MANDATORY_BUDGET_ERROR);

    db.prepare(`
      UPDATE schema_field_claims
      SET ai_guessable_override = 1
      WHERE schema_name = 'ManualOnly' AND field = 'status'
    `).run();
    expect(() => discoverFieldGuessCandidatePage(db, 100, null))
      .toThrow(MANDATORY_BUDGET_ERROR);
  });

  it('includes exact reference targets in the same scoped mandatory budget', () => {
    const emptyReferenceChars = serializeFieldGuessCandidateMandatory({
      field: 'owner',
      field_type: 'reference',
      list_item_type: null,
      enum_values: null,
      reference_target: '',
    }).length;
    const overTarget = 't'.repeat(
      FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS + 1 - emptyReferenceChars,
    );
    createGlobalField(db, {
      name: 'owner',
      field_type: 'reference',
      reference_target: overTarget,
      required: true,
      ai_guessable: true,
    });

    expect(() => createSchemaDefinition(db, {
      name: 'Owned',
      field_claims: [{ field: 'owner' }],
    })).toThrow(MANDATORY_BUDGET_ERROR);
    expect(getSchemaDefinition(db, 'Owned')).toBeNull();
  });

  it('keeps the existing 101-field candidate shape within the shared bound', () => {
    const fields = [
      'l'.repeat(507),
      ...Array.from({ length: 100 }, (_, index) => `field_${String(index).padStart(3, '0')}`),
    ];
    for (const field of fields) createStringField(db, field);
    createSchemaDefinition(db, {
      name: 'ManyFields',
      field_claims: fields.map((field, sortOrder) => ({ field, sort_order: sortOrder })),
    });
    insertNode(db, 'many-fields', 'ManyFields');

    const page = discoverFieldGuessCandidatePage(db, 100, null);
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0].fields).toHaveLength(101);
    expect(fieldGuessCandidateIdentityProjectionChars(page.candidates[0].fields))
      .toBeLessThanOrEqual(FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS);
  });
});
