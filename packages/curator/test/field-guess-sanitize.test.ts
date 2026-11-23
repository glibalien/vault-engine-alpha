import { describe, expect, it } from 'vitest';
import {
  parseGuessValue,
  sanitizeFieldGuessOutput,
} from '../src/field-guess/sanitize.js';
import {
  FIELD_GUESS_REASON_MAX_CHARS,
  type FieldGuessFieldCandidate,
} from '../src/field-guess/types.js';

function field(overrides: Partial<FieldGuessFieldCandidate> = {}): FieldGuessFieldCandidate {
  return {
    field: 'status',
    description: null,
    field_type: 'enum',
    list_item_type: null,
    required: true,
    enum_values: ['active', 'paused'],
    reference_target: null,
    claiming_types: ['project'],
    eligibility: 'absent',
    definition_hash: 'definition-1',
    ...overrides,
  };
}

describe('parseGuessValue', () => {
  it('parses JSON first and otherwise returns the raw string', () => {
    expect(parseGuessValue('true')).toBe(true);
    expect(parseGuessValue('42')).toBe(42);
    expect(parseGuessValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseGuessValue('plain text')).toBe('plain text');
    expect(parseGuessValue(' yes ')).toBe(' yes ');
  });
});

describe('sanitizeFieldGuessOutput', () => {
  it.each([
    ['explicit abstain', { field: 'status', action: 'abstain', reason: ' unclear ' }, 'abstained', undefined],
    ['bad enum', { field: 'status', action: 'set', value: 'bogus', reason: 'x' }, 'rejected_value', undefined],
    ['canonical enum', { field: 'status', action: 'set', value: ' ACTIVE ', reason: 'x' }, 'accepted', 'active'],
  ] as const)('%s', (_name, decision, kind, value) => {
    const result = sanitizeFieldGuessOutput({ decisions: [decision] }, [field()]);
    expect(result.byField.get('status')?.kind).toBe(kind);
    expect(result.byField.get('status')?.value).toEqual(value);
  });

  it.each([
    'null',
    '{"kind":"manual"}',
    '["manual"]',
    'true',
    '1e3',
  ])('accepts the JSON-shaped scalar enum string %s before JSON coercion', value => {
    const result = sanitizeFieldGuessOutput({ decisions: [{
      field: 'status', action: 'set', value, reason: 'exact offered value',
    }] }, [field({ enum_values: [value] })]);

    expect(result.byField.get('status')).toMatchObject({ kind: 'accepted', value });
    expect(result.patch).toEqual({ status: value });
  });

  it.each([
    ['JSON null text', 'null'],
    ['JSON object text', '{"kind":"manual"}'],
    ['JSON array text', '["draft"]'],
    ['bracketed non-JSON text', '[draft]'],
    ['JSON boolean text', 'true'],
    ['JSON number text', '1e3'],
    ['JSON-quoted text', '"draft"'],
    ['JSON empty-string text', '""'],
    ['ordinary text', 'manual draft'],
    ['surrounding whitespace', '  manual draft  '],
  ])('preserves %s verbatim for an unrestricted scalar string', (_case, value) => {
    const result = sanitizeFieldGuessOutput({ decisions: [{
      field: 'notes', action: 'set', value, reason: 'exact note text',
    }] }, [field({ field: 'notes', field_type: 'string', enum_values: null })]);

    expect(result.byField.get('notes')).toMatchObject({ kind: 'accepted', value });
    expect(result.patch).toEqual({ notes: value });
  });

  it('keeps JSON coercion for list enums and non-string scalars', () => {
    const offered = [
      field({
        field: 'labels',
        field_type: 'list',
        list_item_type: 'enum',
        enum_values: ['null', '{"kind":"manual"}'],
      }),
      field({ field: 'flag', field_type: 'boolean', enum_values: null }),
      field({ field: 'estimate', field_type: 'number', enum_values: null }),
      field({ field: 'owner', field_type: 'reference', enum_values: null }),
    ];
    const result = sanitizeFieldGuessOutput({ decisions: [
      {
        field: 'labels',
        action: 'set',
        value: '["null","{\\"kind\\":\\"manual\\"}"]',
        reason: 'exact offered values',
      },
      { field: 'flag', action: 'set', value: 'true', reason: 'boolean evidence' },
      { field: 'estimate', action: 'set', value: '1e3', reason: 'numeric evidence' },
      { field: 'owner', action: 'set', value: 'null', reason: 'exact reference title' },
    ] }, offered);

    expect(result.patch).toEqual({
      labels: ['null', '{"kind":"manual"}'],
      flag: true,
      estimate: 1000,
      owner: 'null',
    });
  });

  it('parses and validates booleans, finite numbers, dates, references, and lists', () => {
    const offered = [
      field({ field: 'flag', field_type: 'boolean', enum_values: null }),
      field({ field: 'estimate', field_type: 'number', enum_values: null }),
      field({ field: 'due', field_type: 'date', enum_values: null }),
      field({ field: 'owner', field_type: 'reference', enum_values: null, reference_target: 'person' }),
      field({ field: 'tags', field_type: 'list', list_item_type: 'string', enum_values: null }),
    ];
    const result = sanitizeFieldGuessOutput({ decisions: [
      { field: 'flag', action: 'set', value: 'yes', reason: 'evidence' },
      { field: 'estimate', action: 'set', value: '4.5', reason: 'evidence' },
      { field: 'due', action: 'set', value: '2026-08-25', reason: 'evidence' },
      { field: 'owner', action: 'set', value: '[[Ada Lovelace|Ada]]', reason: 'evidence' },
      { field: 'tags', action: 'set', value: '["alpha",2,true]', reason: 'evidence' },
    ] }, offered);

    expect(result.patch).toEqual({
      flag: true,
      estimate: 4.5,
      due: '2026-08-25',
      owner: 'Ada Lovelace',
      tags: ['alpha', '2', 'true'],
    });
    expect([...result.byField.values()].every(decision => decision.kind === 'accepted')).toBe(true);
  });

  it.each(['2026', 'true', 'null'])(
    'preserves the JSON-literal scalar reference title %s as text',
    value => {
      const result = sanitizeFieldGuessOutput({ decisions: [{
        field: 'owner', action: 'set', value, reason: 'exact title',
      }] }, [field({
        field: 'owner', field_type: 'reference', enum_values: null, reference_target: 'person',
      })]);

      expect(result.byField.get('owner')).toMatchObject({ kind: 'accepted', value });
      expect(result.patch).toEqual({ owner: value });
    },
  );

  it('rejects list/non-string scalar mismatches, non-finite numbers, impossible dates, and wrong reference shapes', () => {
    const offered = [
      field({ field: 'scalar', field_type: 'boolean', enum_values: null }),
      field({ field: 'list', field_type: 'list', list_item_type: 'string', enum_values: null }),
      field({ field: 'count', field_type: 'number', enum_values: null }),
      field({ field: 'due', field_type: 'date', enum_values: null }),
      field({ field: 'owner', field_type: 'reference', enum_values: null }),
    ];
    const result = sanitizeFieldGuessOutput({ decisions: [
      { field: 'scalar', action: 'set', value: '["x"]', reason: 'x' },
      { field: 'list', action: 'set', value: 'x', reason: 'x' },
      { field: 'count', action: 'set', value: 'Infinity', reason: 'x' },
      { field: 'due', action: 'set', value: '2026-02-30', reason: 'x' },
      { field: 'owner', action: 'set', value: '{"title":"Ada"}', reason: 'x' },
    ] }, offered);

    for (const candidate of offered) {
      expect(result.byField.get(candidate.field)?.kind).toBe('rejected_value');
    }
    expect(result.patch).toEqual({});
  });

  it.each([
    '2026-08-25T24:00',
    '2026-08-25T23:60',
    '2026-08-25T23:59:60',
    '2026-08-25T23:59:59.',
    '2026-08-25T23:59:59.x',
    '2026-08-25T23:59+24:00',
    '2026-08-25T23:59+23:60',
    '2026-08-25T23:59+01',
  ])('rejects an ISO-shaped date with an invalid component: %s', value => {
    const result = sanitizeFieldGuessOutput({ decisions: [
      { field: 'due', action: 'set', value, reason: 'evidence' },
    ] }, [field({ field: 'due', field_type: 'date', enum_values: null })]);

    expect(result.byField.get('due')?.kind).toBe('rejected_value');
    expect(result.patch).toEqual({});
  });

  it.each([
    '2024-02-29',
    '2026-08-25T00:00',
    '2026-08-25 23:59:59',
    '2026-08-25T23:59:59.0000000001Z',
    '2026-08-25T23:59:59+23:59',
    '2026-08-25T23:59:59-00:00',
  ])('accepts a calendar-valid ISO date with bounded components: %s', value => {
    const result = sanitizeFieldGuessOutput({ decisions: [
      { field: 'due', action: 'set', value, reason: 'evidence' },
    ] }, [field({ field: 'due', field_type: 'date', enum_values: null })]);

    expect(result.byField.get('due')?.kind).toBe('accepted');
    expect(result.patch.due).toBe(value);
  });

  it('requires a list enum value to satisfy one complete claiming-type set', () => {
    const offered = [field({
      field: 'labels',
      field_type: 'list',
      list_item_type: 'enum',
      enum_values: ['global-only'],
      per_type_enum_values: [
        { type: 'project', values: ['alpha', 'beta'] },
        { type: 'task', values: ['gamma', 'delta'] },
      ],
    })];

    const firstSet = sanitizeFieldGuessOutput({ decisions: [
      { field: 'labels', action: 'set', value: '["ALPHA","beta"]', reason: 'x' },
    ] }, offered);
    const secondSet = sanitizeFieldGuessOutput({ decisions: [
      { field: 'labels', action: 'set', value: '["gamma","DELTA"]', reason: 'x' },
    ] }, offered);
    const mixedSets = sanitizeFieldGuessOutput({ decisions: [
      { field: 'labels', action: 'set', value: '["alpha","delta"]', reason: 'x' },
    ] }, offered);
    const globalOnly = sanitizeFieldGuessOutput({ decisions: [
      { field: 'labels', action: 'set', value: '["global-only"]', reason: 'x' },
    ] }, offered);

    expect(firstSet.patch.labels).toEqual(['alpha', 'beta']);
    expect(secondSet.patch.labels).toEqual(['gamma', 'delta']);
    expect(mixedSets.byField.get('labels')?.kind).toBe('rejected_value');
    expect(globalOnly.byField.get('labels')?.kind).toBe('rejected_value');
  });

  it('accepts a scalar enum that is valid for any one claiming-type set', () => {
    const candidate = field({
      per_type_enum_values: [
        { type: 'project', values: ['active'] },
        { type: 'note', values: ['archived'] },
      ],
    });

    expect(sanitizeFieldGuessOutput({ decisions: [
      { field: 'status', action: 'set', value: 'ARCHIVED', reason: 'x' },
    ] }, [candidate]).patch.status).toBe('archived');
  });

  it.each(['', '   '])('never patches an empty scalar-string replacement: %j', value => {
    const result = sanitizeFieldGuessOutput({ decisions: [
      { field: 'status', action: 'set', value, reason: 'x' },
    ] }, [field({ field_type: 'string', enum_values: null })]);
    expect(result.byField.get('status')?.kind).toBe('rejected_value');
    expect(result.patch).toEqual({});
  });

  it('never patches an empty list replacement', () => {
    const result = sanitizeFieldGuessOutput({ decisions: [
      { field: 'status', action: 'set', value: '[]', reason: 'x' },
    ] }, [field({ field_type: 'list', list_item_type: 'string', enum_values: null })]);
    expect(result.byField.get('status')?.kind).toBe('rejected_value');
    expect(result.patch).toEqual({});
  });

  it('turns omissions and unknown-only output into abstentions and never patches unknown fields', () => {
    const result = sanitizeFieldGuessOutput({ decisions: [
      { field: 'invented', action: 'set', value: 'owned', reason: 'x' },
    ] }, [field(), field({ field: 'context', field_type: 'string', enum_values: null })]);

    expect(result.byField.get('status')?.kind).toBe('abstained');
    expect(result.byField.get('context')?.kind).toBe('abstained');
    expect(result.byField.has('invented')).toBe(false);
    expect(result.patch).toEqual({});
  });

  it('rejects duplicate or identifiable malformed decisions instead of choosing one', () => {
    const duplicate = sanitizeFieldGuessOutput({ decisions: [
      { field: 'status', action: 'set', value: 'active', reason: 'x' },
      { field: 'status', action: 'abstain', reason: 'y' },
    ] }, [field()]);
    const malformed = sanitizeFieldGuessOutput({ decisions: [
      { field: 'status', action: 'invented', value: 'active', reason: 'x' },
    ] }, [field()]);
    const missingReason = sanitizeFieldGuessOutput({ decisions: [
      { field: 'status', action: 'set', value: 'active' },
    ] }, [field()]);

    expect(duplicate.byField.get('status')?.kind).toBe('rejected_value');
    expect(malformed.byField.get('status')?.kind).toBe('rejected_value');
    expect(missingReason.byField.get('status')?.kind).toBe('rejected_value');
    expect(duplicate.patch).toEqual({});
  });

  it('rejects malformed whole envelopes before synthesizing field omissions', () => {
    const inheritedRoot = Object.create({
      decisions: [{ field: 'status', action: 'set', value: 'active', reason: 'inherited root' }],
    }) as Record<string, unknown>;
    const extraRoot = {
      decisions: [{ field: 'status', action: 'set', value: 'active', reason: 'extra root' }],
      extra: true,
    };
    const hiddenExtraRoot = {
      decisions: [{ field: 'status', action: 'set', value: 'active', reason: 'hidden extra root' }],
    };
    Object.defineProperty(hiddenExtraRoot, 'extra', { value: true });
    const classRoot = new class {
      decisions = [{ field: 'status', action: 'set', value: 'active', reason: 'class root' }];
    }();
    const accessorRoot: Record<string, unknown> = {};
    Object.defineProperty(accessorRoot, 'decisions', {
      configurable: true,
      enumerable: true,
      get: () => [{ field: 'status', action: 'set', value: 'active', reason: 'SECRET accessor root' }],
    });

    for (const raw of [
      null,
      inheritedRoot,
      extraRoot,
      hiddenExtraRoot,
      classRoot,
      accessorRoot,
      { decisions: 'not-an-array' },
    ]) {
      expect(() => sanitizeFieldGuessOutput(raw, [field()]))
        .toThrow('Malformed field guess output envelope.');
    }
  });

  it('accepts only an exact own-property closed decision contract', () => {
    const inheritedDecision = Object.create({
      field: 'status', action: 'set', value: 'active', reason: 'inherited decision',
    }) as Record<string, unknown>;
    const partlyInheritedDecision = Object.create({
      action: 'set', value: 'active', reason: 'partly inherited',
    }) as Record<string, unknown>;
    Object.defineProperty(partlyInheritedDecision, 'field', {
      configurable: true,
      enumerable: true,
      value: 'status',
    });
    const extraDecision = {
      field: 'status', action: 'set', value: 'active', reason: 'extra decision', extra: true,
    };
    const hiddenExtraDecision: Record<string, unknown> = {
      field: 'status', action: 'set', value: 'active', reason: 'hidden extra decision',
    };
    Object.defineProperty(hiddenExtraDecision, 'extra', { value: true });
    const nullPrototypeRoot = Object.assign(Object.create(null) as Record<string, unknown>, {
      decisions: [Object.assign(Object.create(null) as Record<string, unknown>, {
        field: 'status', action: 'set', value: 'active', reason: 'null prototype',
      })],
    });

    expect(sanitizeFieldGuessOutput({ decisions: [inheritedDecision] }, [field()])
      .byField.get('status')?.kind).toBe('abstained');
    for (const decision of [partlyInheritedDecision, extraDecision, hiddenExtraDecision]) {
      expect(sanitizeFieldGuessOutput({ decisions: [decision] }, [field()])
        .byField.get('status')?.kind).toBe('rejected_value');
    }
    expect(sanitizeFieldGuessOutput(nullPrototypeRoot, [field()]).patch.status).toBe('active');
  });

  it('never patches reserved prototype-sensitive candidate names', () => {
    const offered = ['__proto__', 'prototype', 'constructor'].map(name => field({
      field: name,
      field_type: 'string',
      enum_values: null,
    }));
    const result = sanitizeFieldGuessOutput({ decisions: offered.map(candidate => ({
      field: candidate.field,
      action: 'set',
      value: 'owned',
      reason: 'model evidence',
    })) }, offered);

    expect(Object.getPrototypeOf(result.patch)).toBeNull();
    expect(Object.keys(result.patch)).toEqual([]);
    for (const name of ['__proto__', 'prototype', 'constructor']) {
      expect(result.byField.get(name)).toMatchObject({
        field: name,
        kind: 'rejected_value',
        reason: 'Reserved field name cannot be mutated.',
        error: 'reserved field name',
      });
    }
  });

  it('treats a valid empty decisions array as one omission abstention per offered field', () => {
    const offered = [field(), field({ field: 'context', field_type: 'string', enum_values: null })];
    const result = sanitizeFieldGuessOutput({ decisions: [] }, offered);
    expect([...result.byField.entries()].map(([name, decision]) => [name, decision.kind])).toEqual([
      ['status', 'abstained'],
      ['context', 'abstained'],
    ]);
  });

  it('trims and bounds model reasons by Unicode code points', () => {
    const reason = `  ${'r'.repeat(FIELD_GUESS_REASON_MAX_CHARS - 1)}🙂tail  `;
    const result = sanitizeFieldGuessOutput({ decisions: [
      { field: 'status', action: 'abstain', reason },
    ] }, [field()]);
    const stored = result.byField.get('status')?.reason;

    expect(stored).toBe(`${'r'.repeat(FIELD_GUESS_REASON_MAX_CHARS - 1)}🙂`);
    expect(Array.from(stored ?? '')).toHaveLength(FIELD_GUESS_REASON_MAX_CHARS);
  });
});
