import { describe, expect, it } from 'vitest';
import { inferFieldDefinition, shouldInferEnum } from '../../src/analyzer/field-inference.js';
import { sanitizeAnalyzerMapping } from '../../src/analyzer/json-safety.js';
import { parseFrontmatterMapping } from '../../src/parser/frontmatter.js';
import type { YamlValue } from '../../src/parser/types.js';
import { coerceValue } from '../../src/validation/coerce.js';

function observations(values: YamlValue[]): YamlValue[] {
  return values;
}

describe('field type options for review', () => {
  it.each([
    ['mixed scalars, as text or the first of the tied shapes', ['text', 4], [
      { option: 'text', field_type: 'string', unconverted: 0 },
      { option: 'dominant', field_type: 'number', unconverted: 1 },
    ]],
    ['numbers with a numeric string', ['3', 4, 5], [
      { option: 'text', field_type: 'string', unconverted: 0 },
      { option: 'dominant', field_type: 'number', unconverted: 0 },
    ]],
    // Engine strips the brackets, then wraps a single reference into a list.
    ['a reference among reference lists', ['[[Alice]]', ['[[Bob]]', '[[Carol]]'], ['[[Dan]]']], [
      { option: 'text', field_type: 'string', unconverted: 2 },
      { option: 'dominant', field_type: 'list', list_item_type: 'reference', unconverted: 0 },
    ]],
    ['an unquoted reference among reference lists', [[['Alice']], ['[[Bob]]'], ['[[Carol]]']], [
      { option: 'text', field_type: 'string', unconverted: 2 },
      { option: 'dominant', field_type: 'list', list_item_type: 'reference', unconverted: 0 },
    ]],
    ['strings and dates, where the strings are the most common shape', ['soon', 'later', '2026-08-30'], [
      { option: 'text', field_type: 'string', unconverted: 0 },
    ]],
    ['an object', [{ nested: true }, null], [
      { option: 'text', field_type: 'string', unconverted: 1 },
    ]],
    ['empty-only lists', [[], []], [
      { option: 'text', field_type: 'string', unconverted: 2 },
    ]],
  ] as const)('offers %s', (_label, values, options) => {
    const result = inferFieldDefinition('field', observations(values as unknown as YamlValue[]));

    expect(result).toMatchObject({ status: 'needs_review', options });
  });
});

describe('a chosen field type', () => {
  it('replaces inference when every value converts, without inferring an enum', () => {
    expect(inferFieldDefinition('rating', observations(['text', 4, 'text', 'text', 'text', 'text']), { field_type: 'string' }))
      .toMatchObject({ status: 'apply_ready', field_type: 'string' });
    expect(inferFieldDefinition('owners', observations(['[[Alice]]', ['[[Bob]]']]), { field_type: 'list', list_item_type: 'reference' }))
      .toMatchObject({ status: 'apply_ready', field_type: 'list', list_item_type: 'reference' });
  });

  it('keeps the field in review when a value does not convert, with its options', () => {
    const result = inferFieldDefinition('rating', observations(['text', 4]), { field_type: 'number' });

    expect(result).toMatchObject({
      status: 'needs_review',
      reasons: ['1 value does not convert to the chosen number', 'conflicting scalar shapes'],
      options: [{ option: 'text', unconverted: 0 }, { option: 'dominant', field_type: 'number', unconverted: 1 }],
    });
  });

  it('resolves a date token before converting, as Engine validation does', () => {
    const values = observations(['2026-08-30', '$mtime:YYYY-MM-DD']);

    expect(inferFieldDefinition('reviewed', values)).toMatchObject({
      status: 'needs_review',
      options: [{ option: 'text', unconverted: 0 }, { option: 'dominant', field_type: 'date', unconverted: 0 }],
    });
    expect(inferFieldDefinition('reviewed', values, { field_type: 'date' })).toMatchObject({ status: 'apply_ready', field_type: 'date' });
  });

  it('applies to a field that inference would have typed', () => {
    expect(inferFieldDefinition('code', observations(['a', 'b']), { field_type: 'number' }))
      .toMatchObject({ status: 'needs_review', reasons: ['2 values do not convert to the chosen number'] });
  });
});

describe('inferFieldDefinition', () => {
  it.each([
    ['count', [1, 2], { field_type: 'number' }],
    ['active', [true, false], { field_type: 'boolean' }],
    ['date', ['2026-08-30', '2026-09-01'], { field_type: 'date' }],
    ['project', ['[[Alpha]]', '[[Beta|B]]'], { field_type: 'reference' }],
    ['tags', [['one', 'two'], ['three']], { field_type: 'list', list_item_type: 'string' }],
  ] as const)('infers %s conservatively', (name, values, expected) => {
    expect(inferFieldDefinition(name, observations(values as unknown as YamlValue[])))
      .toMatchObject({ status: 'apply_ready', ...expected });
  });

  it.each([
    ['mixed scalar', ['text', 4]],
    ['object', [{ nested: true }]],
    ['nested list', [[['one', 'two']]]],
    ['mixed list', [['[[Alpha]]', 'plain']]],
    ['empty-only lists', [[], []]],
  ] as const)('marks %s as needs_review', (_label, values) => {
    const result = inferFieldDefinition('field', observations(values as unknown as YamlValue[]));
    expect(result.status).toBe('needs_review');
    if (result.status === 'needs_review') expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('treats YAML nulls as missing evidence without letting them decide shape', () => {
    expect(inferFieldDefinition('count', observations([null, 1, null, 2])))
      .toMatchObject({
        status: 'apply_ready',
        field_type: 'number',
        evidence: { observations: 4, null_or_missing: 2 },
      });
  });

  it('uses non-empty list evidence to type compatible empty lists', () => {
    expect(inferFieldDefinition('tags', observations([[], ['one']])))
      .toMatchObject({ status: 'apply_ready', field_type: 'list', list_item_type: 'string' });
  });

  it('keeps filename matches and prose containing links as plain strings', () => {
    expect(inferFieldDefinition('owner', observations(['Alice', 'See [[Alice]]'])))
      .toMatchObject({ status: 'apply_ready', field_type: 'string' });
  });

  it('keeps ISO-shaped strings with impossible times as strings', () => {
    expect(inferFieldDefinition('when', observations(['2026-08-30T99:99'])))
      .toMatchObject({ status: 'apply_ready', field_type: 'string' });
  });

  it('recognizes the parser representation of an unquoted whole wiki-link', () => {
    const parsed = parseFrontmatterMapping('---\nproject: [[target]]\n---\n');
    expect(parsed.data.project).toEqual([['target']]);
    expect(inferFieldDefinition('project', observations([parsed.data.project])))
      .toMatchObject({ status: 'apply_ready', field_type: 'reference' });
  });

  it('infers parsed negative zero as ordinary numeric evidence', () => {
    const parsed = parseFrontmatterMapping('---\nbalance: -0\n---\n');
    const sanitized = sanitizeAnalyzerMapping(parsed.data);

    expect(sanitized.balance).toBe(0);
    expect(inferFieldDefinition('balance', observations([sanitized.balance])))
      .toMatchObject({
        status: 'apply_ready',
        field_type: 'number',
        evidence: {
          shape_distribution: { number: 1 },
          sample_values: [0],
        },
      });
  });

  it('promotes eligible strings to an enum and orders values by count then exact value', () => {
    const result = inferFieldDefinition(
      'status',
      observations(['beta', 'alpha', 'gamma', 'beta', 'alpha', 'beta', 'gamma', 'beta', 'alpha', 'beta']),
    );
    expect(result).toMatchObject({
      status: 'apply_ready',
      field_type: 'enum',
      enum_values: ['beta', 'alpha', 'gamma'],
    });
  });

  it('normalizes whitespace variants before inferring enum values accepted by coercion', () => {
    const result = inferFieldDefinition(
      'status',
      observations([' open ', 'open', 'closed', ' closed', 'open', 'closed', 'open']),
    );

    expect(result).toMatchObject({
      status: 'apply_ready',
      field_type: 'enum',
      enum_values: ['open', 'closed'],
    });
    if (result.status !== 'apply_ready' || result.field_type !== 'enum') return;
    expect(coerceValue(' open ', 'enum', { enum_values: result.enum_values })).toMatchObject({
      ok: true,
      value: 'open',
    });
  });

  it('caps distinct evidence samples in stable first-observation order', () => {
    const result = inferFieldDefinition(
      'value',
      observations(Array.from({ length: 12 }, (_, index) => `value-${index}`)),
    );
    expect(result.evidence).toMatchObject({
      distinct_values: 12,
      sample_values: Array.from({ length: 10 }, (_, index) => `value-${index}`),
      samples_truncated: true,
    });
  });
});

describe('shouldInferEnum', () => {
  it.each([
    ['four string observations', 4, 4, 1, false],
    ['five string observations', 5, 5, 1, true],
    ['ten distinct values', 34, 34, 10, true],
    ['eleven distinct values', 37, 37, 11, false],
    ['exactly 0.30 distinct ratio', 10, 10, 3, true],
    ['over 0.30 distinct ratio', 10, 10, 4, false],
  ])('handles %s', (_label, stringObservationCount, totalObservationCount, distinctValueCount, expected) => {
    expect(shouldInferEnum({
      stringObservationCount,
      totalObservationCount,
      distinctValueCount,
    })).toBe(expected);
  });
});
