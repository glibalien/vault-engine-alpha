import { describe, expect, it } from 'vitest';
import { parseScopes, CURATOR_SCOPES } from '../src/auth/scopes.js';

describe('parseScopes', () => {
  it('applies the default scope set when given undefined', () => {
    expect(parseScopes(undefined)).toEqual(['curate:trigger', 'curate:read']);
  });

  it('applies the default scope set when given an empty string', () => {
    expect(parseScopes('')).toEqual(['curate:trigger', 'curate:read']);
  });

  it('parses an explicit csv, trimming and dropping blanks', () => {
    expect(parseScopes(' curate:read , curate:trigger ')).toEqual(['curate:read', 'curate:trigger']);
  });

  it('accepts a single valid scope', () => {
    expect(parseScopes('curate:read')).toEqual(['curate:read']);
  });

  it('dedups repeated scopes', () => {
    expect(parseScopes('curate:read,curate:read')).toEqual(['curate:read']);
  });

  it('rejects an unknown scope fail-fast', () => {
    expect(() => parseScopes('curate:read,curate:admin')).toThrow(/unknown scope.*curate:admin/i);
  });

  it('exposes the allowlist', () => {
    expect([...CURATOR_SCOPES].sort()).toEqual(['curate:read', 'curate:trigger']);
  });
});
