import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReferenceIndex,
  resolveReference,
  type ReferenceDocument,
} from '../../src/analyzer/reference-index.js';

function doc(
  relativePath: string,
  types: string[],
  title = basename(relativePath, '.md'),
): ReferenceDocument {
  return { relativePath, title, types };
}

describe('reference index', () => {
  it('uses exact path, exact title, basename, case-fold, then NFC case-fold tiers', () => {
    const index = buildReferenceIndex([
      doc('Notes/Alice.md', ['person']),
      doc('Projects/Café.md', ['project']),
    ]);
    expect(resolveReference(index, 'Notes/Alice.md')).toEqual({
      status: 'resolved', path: 'Notes/Alice.md', types: ['person'],
    });
    expect(resolveReference(index, 'Alice').status).toBe('resolved');
    expect(resolveReference(index, 'alice').status).toBe('resolved');
    expect(resolveReference(index, 'cafe\u0301').status).toBe('resolved');
  });

  it('returns ambiguity instead of selecting the shortest path', () => {
    const index = buildReferenceIndex([
      doc('Archive/Meeting.md', ['meeting']),
      doc('Notes/Meeting.md', ['meeting']),
    ]);
    expect(resolveReference(index, 'Meeting')).toEqual({
      status: 'ambiguous',
    });
  });

  it('stops at an ambiguous earlier tier instead of guessing from a later unique tier', () => {
    const index = buildReferenceIndex([
      doc('A/One.md', ['one'], 'Match'),
      doc('B/Two.md', ['two'], 'Match'),
      doc('C/Match.md', ['three'], 'Other'),
    ]);
    expect(resolveReference(index, 'Match')).toEqual({
      status: 'ambiguous',
    });
  });

  it('lets an exact path disambiguate duplicate titles and returns sorted unique types', () => {
    const index = buildReferenceIndex([
      doc('A/Thing.md', ['zeta', 'alpha', 'zeta'], 'Thing'),
      doc('B/Thing.md', ['other'], 'Thing'),
    ]);
    expect(resolveReference(index, 'A/Thing.md')).toEqual({
      status: 'resolved',
      path: 'A/Thing.md',
      types: ['alpha', 'zeta'],
    });
  });

  it('strips a trailing .md from a nested-path target for basename resolution', () => {
    const index = buildReferenceIndex([doc('Notes/Alice.md', ['person'])]);
    expect(resolveReference(index, 'Alice.md')).toEqual({
      status: 'resolved',
      path: 'Notes/Alice.md',
      types: ['person'],
    });
  });

  it('strips a trailing Markdown suffix case-insensitively for basename resolution', () => {
    const index = buildReferenceIndex([doc('Notes/Alice.MD', ['person'], 'Different title')]);
    expect(resolveReference(index, 'Alice.md')).toEqual({
      status: 'resolved',
      path: 'Notes/Alice.MD',
      types: ['person'],
    });
  });

  it('returns unresolved when no tier matches', () => {
    const index = buildReferenceIndex([doc('Notes/Alice.md', ['person'])]);
    expect(resolveReference(index, 'Missing')).toEqual({ status: 'unresolved' });
  });
});
