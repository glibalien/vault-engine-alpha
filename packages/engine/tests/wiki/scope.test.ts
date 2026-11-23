import { describe, expect, it } from 'vitest';
import {
  parseWikiScope,
  sameWikiScope,
  serializeWikiScope,
  wikiScopeComparisonKey,
} from '../../src/wiki/scope.js';

describe('wiki scope canonicalization', () => {
  it('produces identical canonical bytes from object and JSON inputs', () => {
    // Given: equivalent scope values in object and JSON forms.
    const objectInput = {
      v: 1,
      subject: 'Orbital Builder Redux',
      facet: 'ceasefire negotiations',
      entities: ['United States', 'Iran'],
    };
    const jsonInput = '{"entities":["United States","Iran"],"facet":"ceasefire negotiations","subject":"Orbital Builder Redux","v":1}';

    // When: both values are parsed at the boundary.
    const objectResult = parseWikiScope(objectInput);
    const jsonResult = parseWikiScope(jsonInput);

    // Then: successful values serialize to identical canonical bytes.
    expect(objectResult).toMatchObject({ ok: true });
    expect(jsonResult).toMatchObject({ ok: true });
    if (!objectResult.ok || !jsonResult.ok) throw new Error('Expected valid scopes');
    expect(serializeWikiScope(objectResult.scope)).toBe(serializeWikiScope(jsonResult.scope));
  });

  it('ignores property and array input order when serializing', () => {
    // Given: equivalent values with reordered properties and arrays.
    const first = parseWikiScope({
      v: 1,
      subject: 'Orbital Builder Redux',
      facet: 'energy-market effects',
      entities: ['Iran', 'United States'],
      exclusions: ['Europe', 'Asia'],
    });
    const second = parseWikiScope({
      exclusions: ['Asia', 'Europe'],
      facet: 'energy-market effects',
      entities: ['United States', 'Iran'],
      subject: 'Orbital Builder Redux',
      v: 1,
    });

    // When: their canonical forms are serialized.
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) throw new Error('Expected valid scopes');

    // Then: fixed property order makes the bytes identical.
    expect(serializeWikiScope(first.scope)).toBe(serializeWikiScope(second.scope));
  });

  it('normalizes whitespace and array entries deterministically', () => {
    // Given: whitespace-heavy strings and duplicate array entries.
    const result = parseWikiScope({
      v: 1,
      subject: '  Orbital Builder\t\nRedux  ',
      facet: '  energy   market\n effects ',
      timeframe: '  2026   Q1 ',
      entities: [' Iran ', '', 'United   States', 'iran', ' Gulf\tStates '],
      exclusions: ['  Europe ', 'Asia', ' europe ', ''],
    });

    // When: the scope is parsed.
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Expected a valid scope');

    // Then: whitespace, empties, de-duplication, and codepoint sorting are canonical.
    expect(serializeWikiScope(result.scope)).toBe(
      '{"v":1,"subject":"Orbital Builder Redux","facet":"energy market effects","timeframe":"2026 Q1","entities":["Gulf States","Iran","United States"],"exclusions":["Asia","Europe"]}',
    );
  });

  it('preserves display casing in stored bytes but ignores it in comparisons', () => {
    // Given: equivalent scopes whose display casing differs.
    const displayResult = parseWikiScope({
      v: 1,
      subject: 'Orbital Builder Redux',
      facet: 'Energy Market Effects',
      entities: ['Iran', 'UNITED STATES', 'iran'],
    });
    const normalizedResult = parseWikiScope({
      v: 1,
      subject: 'orbital builder redux',
      facet: 'energy market effects',
      entities: ['united states', 'IRAN'],
    });

    // When: stored and comparison representations are generated.
    expect(displayResult).toMatchObject({ ok: true });
    expect(normalizedResult).toMatchObject({ ok: true });
    if (!displayResult.ok || !normalizedResult.ok) throw new Error('Expected valid scopes');

    // Then: stored bytes retain first display spelling while the key equates casing.
    expect(serializeWikiScope(displayResult.scope)).toContain('"Energy Market Effects"');
    expect(serializeWikiScope(displayResult.scope)).toContain('"Iran"');
    expect(wikiScopeComparisonKey(displayResult.scope)).toBe(wikiScopeComparisonKey(normalizedResult.scope));
    expect(sameWikiScope(displayResult.scope, normalizedResult.scope)).toBe(true);
  });

  it('returns stable error codes for invalid input', () => {
    // Given: one input for every invalid parse class.
    const invalidInputs: ReadonlyArray<readonly [unknown, string]> = [
      [{ v: 2, subject: 'Orbital Builder Redux', facet: 'energy' }, 'UNSUPPORTED_VERSION'],
      [{ v: 1, subject: ' ', facet: 'energy' }, 'MISSING_SUBJECT'],
      [{ v: 1, subject: 'Orbital Builder Redux', facet: ' ' }, 'MISSING_FACET'],
      [{ v: 1, subject: 42, facet: 'energy' }, 'INVALID_SCALAR'],
      [{ v: 1, subject: 'Orbital Builder Redux', facet: 'energy', entities: 'Iran' }, 'INVALID_ARRAY'],
      [{ v: 1, subject: 'Orbital Builder Redux', facet: 'energy', entities: ['Iran', 42] }, 'INVALID_ARRAY'],
      ['{"v":1,"subject":"Orbital Builder Redux",', 'MALFORMED_JSON'],
      [42, 'INVALID_SCOPE'],
    ];

    // When: each value is parsed.
    const results = invalidInputs.map(([input]) => parseWikiScope(input));

    // Then: every failure exposes its stable machine-readable code.
    expect(results.map(result => result.ok ? null : result.code)).toEqual(invalidInputs.map(([, code]) => code));
  });

  it('omits optional values that normalize to empty', () => {
    // Given: optional strings and arrays containing only whitespace.
    const result = parseWikiScope({
      v: 1,
      subject: 'Orbital Builder Redux',
      facet: 'energy market effects',
      timeframe: '  ',
      geography: '',
      entities: ['\t'],
      exclusions: ['  '],
    });

    // When: the scope is canonicalized.
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Expected a valid scope');

    // Then: no empty optional property is stored.
    expect(serializeWikiScope(result.scope)).toBe('{"v":1,"subject":"Orbital Builder Redux","facet":"energy market effects"}');
  });

  it('does not equate scopes with different facets', () => {
    // Given: two scopes with the same subject but different facets.
    const energy = parseWikiScope({ v: 1, subject: 'Orbital Builder Redux', facet: 'energy market effects' });
    const diplomacy = parseWikiScope({ v: 1, subject: 'Orbital Builder Redux', facet: 'ceasefire negotiations' });

    // When: their canonical values are compared.
    expect(energy).toMatchObject({ ok: true });
    expect(diplomacy).toMatchObject({ ok: true });
    if (!energy.ok || !diplomacy.ok) throw new Error('Expected valid scopes');

    // Then: genuinely distinct facets remain distinct.
    expect(sameWikiScope(energy.scope, diplomacy.scope)).toBe(false);
  });
});
