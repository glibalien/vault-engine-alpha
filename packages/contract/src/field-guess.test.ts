import { describe, expect, it } from 'vitest';
import {
  FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS,
  FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS,
  fieldGuessCandidateIdentityProjectionChars,
  fieldGuessCandidateMandatoryProjectionChars,
  serializeFieldGuessCandidateIdentity,
  serializeFieldGuessCandidateMandatory,
} from './field-guess.js';

describe('field-guess candidate identity wire contract', () => {
  it('serializes the canonical identity with JSON escaping and fixed decision actions', () => {
    const serialized = serializeFieldGuessCandidateIdentity({
      field: 'phase\n"\ud83d\ude80',
      field_type: 'list',
      list_item_type: 'enum',
    });

    expect(serialized).toBe(
      '{"field":"phase\\n\\"\ud83d\ude80","field_type":"list","list_item_type":"enum","allowed_actions":["set","abstain"]}',
    );
  });

  it('counts UTF-16 JSON characters plus exactly one newline between identities', () => {
    expect(fieldGuessCandidateIdentityProjectionChars([{
      field: 'status',
      field_type: 'enum',
      list_item_type: null,
    }])).toBe(96);
    expect(fieldGuessCandidateIdentityProjectionChars([{
      field: 'status',
      field_type: 'enum',
      list_item_type: null,
    }, {
      field: 'context',
      field_type: 'string',
      list_item_type: null,
    }])).toBe(196);
  });

  it('publishes the exact Engine-to-Curator aggregate identity ceiling', () => {
    expect(FIELD_GUESS_CANDIDATE_IDENTITY_MAX_CHARS).toBe(20_000);
  });
});

describe('field-guess mandatory offered-field wire contract', () => {
  it('serializes every applicable legal constraint exactly with fixed property order', () => {
    const serialized = serializeFieldGuessCandidateMandatory({
      field: 'phase\n"\ud83d\ude80',
      field_type: 'list',
      list_item_type: 'enum',
      enum_values: ['ready\n"\ud83d\ude80', 'literal [truncated]'],
      per_type_enum_values: [{
        type: 'project\n"',
        values: ['ready\n"\ud83d\ude80'],
      }],
      reference_target: null,
    });

    expect(serialized).toBe(
      '{"field":"phase\\n\\"\ud83d\ude80","field_type":"list","list_item_type":"enum","allowed_actions":["set","abstain"],"enum_values":["ready\\n\\"\ud83d\ude80","literal [truncated]"],"per_type_enum_values":[{"type":"project\\n\\"","values":["ready\\n\\"\ud83d\ude80"]}]}',
    );
  });

  it('includes an exact nullable target for references without adding enum properties', () => {
    expect(serializeFieldGuessCandidateMandatory({
      field: 'owner',
      field_type: 'reference',
      list_item_type: null,
      enum_values: null,
      reference_target: null,
    })).toBe(
      '{"field":"owner","field_type":"reference","list_item_type":null,"allowed_actions":["set","abstain"],"reference_target":null}',
    );
  });

  it('keeps unconstrained fields byte-identical to the canonical identity', () => {
    const field = {
      field: 'context',
      field_type: 'string' as const,
      list_item_type: null,
      enum_values: null,
      reference_target: null,
    };

    expect(serializeFieldGuessCandidateMandatory(field))
      .toBe(serializeFieldGuessCandidateIdentity(field));
  });

  it('counts the single aggregate mandatory projection including record newlines', () => {
    const fields = [{
      field: 'status',
      field_type: 'enum' as const,
      list_item_type: null,
      enum_values: ['active', 'paused'],
      reference_target: null,
    }, {
      field: 'owner',
      field_type: 'reference' as const,
      list_item_type: null,
      enum_values: null,
      reference_target: 'person',
    }];
    const statusRecord = '{"field":"status","field_type":"enum","list_item_type":null,"allowed_actions":["set","abstain"],"enum_values":["active","paused"]}';
    const ownerRecord = '{"field":"owner","field_type":"reference","list_item_type":null,"allowed_actions":["set","abstain"],"reference_target":"person"}';
    const literalChars = statusRecord.length + 1 + ownerRecord.length;

    expect(fieldGuessCandidateMandatoryProjectionChars(fields)).toBe(literalChars);
    expect(fieldGuessCandidateMandatoryProjectionChars(fields)).toBe(
      fields.map(serializeFieldGuessCandidateMandatory).join('\n').length,
    );
    expect(FIELD_GUESS_CANDIDATE_MANDATORY_MAX_CHARS).toBe(20_000);
  });
});
