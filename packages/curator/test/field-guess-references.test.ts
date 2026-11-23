import { describe, expect, it, vi } from 'vitest';
import { EngineError } from '../src/engine.js';
import { resolveFieldGuessReferences } from '../src/field-guess/references.js';
import type {
  FieldGuessFieldCandidate,
  SanitizedFieldGuessDecision,
} from '../src/field-guess/types.js';
import type { EngineNode, EngineNodeSummary } from '../src/types.js';

function field(overrides: Partial<FieldGuessFieldCandidate> = {}): FieldGuessFieldCandidate {
  return {
    field: 'owner',
    description: null,
    field_type: 'reference',
    list_item_type: null,
    required: true,
    enum_values: null,
    reference_target: 'person',
    claiming_types: ['project'],
    eligibility: 'absent',
    definition_hash: 'definition-1',
    ...overrides,
  };
}

function node(id: string, title: string | null = `Title ${id}`, types = ['person']): EngineNode {
  return {
    id,
    title,
    file_path: `People/${title ?? id}.md`,
    types,
    version: 2,
    fields: {},
    relationships: { incoming: {}, outgoing: {} },
    body: '',
    metadata: { content_hash: `hash-${id}` },
  };
}

function summary(id: string, title = `Title ${id}`, types = ['person']): EngineNodeSummary {
  return {
    id,
    title,
    file_path: `People/${title}.md`,
    version: 2,
    types,
    field_count: 0,
  };
}

function accepted(value: unknown): SanitizedFieldGuessDecision {
  return { field: 'owner', kind: 'accepted', value, reason: 'Supported by the note.' };
}

function engine(matches: Record<string, EngineNodeSummary[]>, canonical: Record<string, EngineNode>) {
  return {
    findNodesByExactTitle: vi.fn(async (title: string, _limit: number) => matches[title] ?? []),
    getNode: vi.fn(async (id: string, _options: { includeEmbeds: false }) => {
      const found = canonical[id];
      if (found === undefined) throw new Error('not found');
      return found;
    }),
  };
}

describe('resolveFieldGuessReferences', () => {
  it.each([
    ['missing', []],
    ['ambiguous unique ids', [summary('a'), summary('b')]],
  ])('keeps %s references distinct from malformed values', async (_name, matches) => {
    const fake = engine({ Ada: matches }, { a: node('a'), b: node('b') });
    const result = await resolveFieldGuessReferences(accepted('Ada'), field(), fake);

    expect(result.kind).toBe('rejected_reference');
    expect(result.field).toBe('owner');
    expect(fake.findNodesByExactTitle).toHaveBeenCalledWith('Ada', 2);
    expect(fake.getNode).not.toHaveBeenCalled();
  });

  it('accepts duplicate query rows only when they identify one unique node id', async () => {
    const querySummary = summary('a', 'Ada');
    const canonical = node('a', 'Ada Lovelace');
    const fake = engine({ Ada: [querySummary, { ...querySummary }] }, { a: canonical });

    await expect(resolveFieldGuessReferences(accepted('Ada'), field(), fake)).resolves.toMatchObject({
      kind: 'accepted',
      value: 'Ada Lovelace',
      reference_targets: [{ node_id: 'a', title: 'Ada Lovelace', required_type: 'person' }],
    });
    expect(fake.getNode).toHaveBeenCalledWith('a', { includeEmbeds: false });
  });

  it.each([
    ['alias delimiter', 'A|B'],
    ['backslash before alias delimiter', String.raw`A\|B`],
    ['embedded closing delimiter', 'A]]B'],
    ['nested complete link', 'A[[B]]C'],
    ['backslash before embedded closing delimiter', String.raw`A\]]B`],
    ['already bracket-wrapped title', '[[A]]'],
    ['single closing bracket', 'A]B'],
    ['terminal closing bracket', 'A[B]'],
    ['terminal closing delimiter', 'A]]'],
    ['leading closing delimiter', ']]A'],
    ['leading whitespace', ' A'],
    ['trailing whitespace', 'A '],
  ])('rejects a canonical title that cannot preserve its Engine field and relationship round-trip: %s', async (_name, title) => {
    const fake = engine({ Guess: [summary('a', 'Guess')] }, { a: node('a', title) });

    await expect(resolveFieldGuessReferences(accepted('Guess'), field(), fake)).resolves.toEqual({
      field: 'owner',
      kind: 'rejected_reference',
      reason: 'Supported by the note.',
      error: 'Canonical reference title cannot round-trip through Engine wiki-link storage.',
    });
  });

  it.each([
    ['warning-level parentheses', 'A(B)'],
    ['warning-level opening bracket', 'A[B'],
    ['opening delimiter only', 'A[[B'],
    ['warning-level hash', 'A#B'],
    ['warning-level caret', 'A^B'],
    ['embedded newline', 'A\nB'],
    ['embedded carriage return', 'A\rB'],
    ['embedded tab', 'A\tB'],
    ['literal backslash', String.raw`A\B`],
  ])('accepts a canonical title that preserves its Engine field and relationship round-trip: %s', async (_name, title) => {
    const fake = engine({ Guess: [summary('a', 'Guess')] }, { a: node('a', title) });

    await expect(resolveFieldGuessReferences(accepted('Guess'), field(), fake)).resolves.toMatchObject({
      kind: 'accepted',
      value: title,
      reference_targets: [{ node_id: 'a', title }],
    });
  });

  it('rejects a reference list atomically when one canonical title cannot round-trip', async () => {
    const candidate = field({ field: 'reviewers', field_type: 'list', list_item_type: 'reference' });
    const decision = { ...accepted(['Ada', 'Unsafe']), field: 'reviewers' };
    const fake = engine({
      Ada: [summary('a', 'Ada')],
      Unsafe: [summary('u', 'Unsafe')],
    }, {
      a: node('a', 'Ada Lovelace'),
      u: node('u', 'A]B'),
    });

    const result = await resolveFieldGuessReferences(decision, candidate, fake);

    expect(result).toEqual({
      field: 'reviewers',
      kind: 'rejected_reference',
      reason: 'Supported by the note.',
      error: 'Canonical reference title cannot round-trip through Engine wiki-link storage.',
    });
    expect(JSON.stringify(result)).not.toContain('Ada Lovelace');
  });

  it('enforces reference_target against the freshly fetched canonical node', async () => {
    const fake = engine({ Ada: [summary('a', 'Ada', ['person'])] }, {
      a: node('a', 'Ada', ['organization']),
    });
    const result = await resolveFieldGuessReferences(accepted('Ada'), field(), fake);

    expect(result.kind).toBe('rejected_reference');
    expect(result.error).toBe('Reference target has the wrong type.');
  });

  it('returns retryable reference_error when a target disappears during canonical refetch', async () => {
    const fake = engine({ Ada: [summary('a', 'Ada')] }, {});
    const result = await resolveFieldGuessReferences(accepted('Ada'), field(), fake);

    expect(result).toMatchObject({
      kind: 'reference_error',
      error: 'Canonical reference fetch failed.',
    });
    expect(fake.getNode).toHaveBeenCalledWith('a', { includeEmbeds: false });
  });

  it.each([
    ['exact-title lookup', 'lookup', new Error('SECRET-TRANSPORT lookup detail')],
    ['canonical NOT_FOUND race', 'canonical', new EngineError('NOT_FOUND', 'SECRET-NOT-FOUND detail')],
    ['canonical transport', 'canonical', new Error('SECRET-TRANSPORT canonical detail')],
  ] as const)('projects %s failures to a closed retryable outcome', async (_label, stage, failure) => {
    const fake = engine({ Ada: [summary('a', 'Ada')] }, { a: node('a', 'Ada') });
    if (stage === 'lookup') fake.findNodesByExactTitle.mockRejectedValueOnce(failure);
    else fake.getNode.mockRejectedValueOnce(failure);

    const result = await resolveFieldGuessReferences(accepted('Ada'), field(), fake);

    expect(result.kind).toBe('reference_error');
    expect(result.error).toBe(
      stage === 'lookup' ? 'Exact-title reference lookup failed.' : 'Canonical reference fetch failed.',
    );
    expect(JSON.stringify(result)).not.toContain('SECRET-');
  });

  it.each([
    ['null title', node('a', null)],
    ['non-string title', { ...node('a', 'Ada'), title: 42 } as unknown as EngineNode],
    ['non-array types', { ...node('a', 'Ada'), types: null } as unknown as EngineNode],
  ])('converts a malformed canonical refetch with %s into reference_error', async (_name, canonical) => {
    const fake = engine({ Ada: [summary('a', 'Ada')] }, { a: canonical });

    await expect(resolveFieldGuessReferences(accepted('Ada'), field(), fake)).resolves.toMatchObject({
      kind: 'reference_error',
      field: 'owner',
    });
  });

  it('canonicalizes every list item and applies all-or-nothing resolution', async () => {
    const candidate = field({ field: 'reviewers', field_type: 'list', list_item_type: 'reference' });
    const decision = { ...accepted(['Ada', 'Grace']), field: 'reviewers' };
    const complete = engine({
      Ada: [summary('a', 'Ada')],
      Grace: [summary('g', 'Grace')],
    }, {
      a: node('a', 'Ada Lovelace'),
      g: node('g', 'Grace Hopper'),
    });
    const partial = engine({
      Ada: [summary('a', 'Ada')],
      Grace: [],
    }, {
      a: node('a', 'Ada Lovelace'),
    });

    await expect(resolveFieldGuessReferences(decision, candidate, complete)).resolves.toMatchObject({
      kind: 'accepted',
      field: 'reviewers',
      value: ['Ada Lovelace', 'Grace Hopper'],
      reference_targets: [
        { node_id: 'a', title: 'Ada Lovelace', required_type: 'person' },
        { node_id: 'g', title: 'Grace Hopper', required_type: 'person' },
      ],
    });
    const rejected = await resolveFieldGuessReferences(decision, candidate, partial);
    expect(rejected.kind).toBe('rejected_reference');
    expect(rejected.value).toBeUndefined();
  });

  it('returns reference_error for a list item operational failure without exposing prior values', async () => {
    const candidate = field({ field: 'reviewers', field_type: 'list', list_item_type: 'reference' });
    const decision = { ...accepted(['Ada', 'Grace']), field: 'reviewers' };
    const fake = engine({
      Ada: [summary('a', 'Ada')],
      Grace: [summary('g', 'Grace')],
    }, {
      a: node('a', 'Ada Lovelace'),
      g: node('g', 'Grace Hopper'),
    });
    fake.getNode.mockResolvedValueOnce(node('a', 'Ada Lovelace'))
      .mockRejectedValueOnce(new Error('SECRET-LIST-TRANSPORT'));

    const result = await resolveFieldGuessReferences(decision, candidate, fake);

    expect(result).toMatchObject({ kind: 'reference_error', field: 'reviewers' });
    expect(result.value).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/Ada Lovelace|SECRET-LIST/);
  });

  it('passes non-reference and already-terminal decisions through without Engine calls', async () => {
    const fake = engine({}, {});
    const nonReference = field({ field_type: 'string', reference_target: null });
    const rejected: SanitizedFieldGuessDecision = {
      field: 'owner', kind: 'rejected_value', reason: 'bad', error: 'malformed',
    };

    await expect(resolveFieldGuessReferences(accepted('Ada'), nonReference, fake)).resolves.toEqual(accepted('Ada'));
    await expect(resolveFieldGuessReferences(rejected, field(), fake)).resolves.toEqual(rejected);
    expect(fake.findNodesByExactTitle).not.toHaveBeenCalled();
    expect(fake.getNode).not.toHaveBeenCalled();
  });
});
